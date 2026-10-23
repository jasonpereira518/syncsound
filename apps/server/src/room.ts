/**
 * Transport-free authoritative room. No ws/http/node imports so it can move into a Durable Object:
 * the transport feeds it parsed messages + arrival times and fans out the returned Outbound list.
 */
import {
  MIN_SCHEDULE_LEAD_MS,
  SCHEDULE_SAFETY_MARGIN_MS,
  defaultEq,
  defaultScene,
  defaultSettings,
  type ClientMessage,
  type Device,
  type DevicePatch,
  type RoomState,
  type ServerMessage,
  type ServerMessageBody,
} from '@syncsound/protocol';
import { clampToRoom } from '@syncsound/audio-core';

export type Target = 'all' | 'others' | string[];
/** `msg` already carries the room-assigned seq; broadcast copies share one seq. */
export interface Outbound {
  to: Target;
  msg: ServerMessage;
}

type JoinMsg = Extract<ClientMessage, { type: 'JOIN' }>;
type ControlCmd = Extract<ClientMessage, { type: 'CONTROL' }>['command'];

export const PROFILE_KEYS = [
  'name',
  'role',
  'trimDb',
  'latencyMs',
  'calibratedLatencyMs',
  'eq',
  'bassCapable',
  'rolloffHz',
  'volume',
] as const;
export type Profile = Pick<Device, (typeof PROFILE_KEYS)[number]>;

export interface RoomDeps {
  code: string;
  hostKey: string;
  createdAt: number;
  /** opaque stored password hash, null = no password */
  passwordHash?: string | null;
  passwords: { hash(pw: string): string; verify(pw: string, stored: string): boolean };
  profiles?: { get(deviceId: string): Profile | undefined; set(deviceId: string, p: Profile): void };
  /** used only for PONG ts_send; defaults to performance time */
  clock?: () => number;
}

export const perfClock = () => performance.timeOrigin + performance.now();
export const AUTO_PLACE_RADIUS_M = 2.2;
export const STATS_BROADCAST_INTERVAL_MS = 1000;
export const CALIBRATION_MIN_LEAD_MS = 1500;
const BASS_CLASSES = new Set(['laptop', 'desktop', 'bluetooth']);

/** constant-time string compare (pure JS, Worker-safe) */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}


class RoomError extends Error {
  constructor(
    readonly code: string,
    msg: string,
  ) {
    super(msg);
  }
}

export class Room {
  readonly state: RoomState;
  private readonly hostKey: string;
  private passwordHash: string | null;
  private readonly deps: RoomDeps;
  private readonly clock: () => number;
  private seq = 0;
  /** connId → deviceId, and the reverse for the live connection of each device */
  private readonly connDevice = new Map<string, string>();
  private readonly deviceConn = new Map<string, string>();
  private readonly disconnectedAt = new Map<string, number>();
  private readonly planIds: string[] = [];
  private lastStatsBroadcast = -Infinity;
  private placed = 0;
  /** room ms since which no device is connected (null while someone is connected) */
  emptySince: number | null;

  constructor(deps: RoomDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? perfClock;
    this.hostKey = deps.hostKey;
    this.passwordHash = deps.passwordHash ?? null;
    this.emptySince = deps.createdAt;
    this.state = {
      code: deps.code,
      hostId: null,
      createdAt: deps.createdAt,
      settings: { ...defaultSettings(), hasPassword: this.passwordHash !== null },
      devices: [],
      scene: defaultScene(),
      queue: [],
      playback: { status: 'stopped', trackId: null, startRoomTime: deps.createdAt, trackOffset: 0 },
      volume: 1,
      captureHostId: null,
    };
  }

  get code() {
    return this.state.code;
  }
  connIds(): string[] {
    return [...this.connDevice.keys()];
  }
  get connectedCount() {
    return this.deviceConn.size;
  }
  device(id: string) {
    return this.state.devices.find((d) => d.id === id);
  }

  /** resolve an Outbound target into connection ids */
  resolve(to: Target, senderConnId?: string): string[] {
    if (Array.isArray(to)) return to;
    const ids = this.connIds();
    return to === 'all' ? ids : ids.filter((id) => id !== senderConnId);
  }

  /** schedule lead: ≥ max connected RTT + safety margin, never below MIN_SCHEDULE_LEAD_MS */
  lead(): number {
    let maxRtt = 0;
    for (const d of this.state.devices) if (d.connected && d.stats) maxRtt = Math.max(maxRtt, d.stats.rttMs);
    return Math.max(MIN_SCHEDULE_LEAD_MS, maxRtt + SCHEDULE_SAFETY_MARGIN_MS);
  }

  private out(to: Target, body: ServerMessageBody): Outbound {
    return { to, msg: { ...body, seq: this.seq++ } as ServerMessage };
  }
  private stateMsg(to: Target, now: number) {
    return this.out(to, { type: 'STATE', roomState: structuredClone(this.state), serverTime: now });
  }
  private deviceList(to: Target) {
    return this.out(to, { type: 'DEVICE_LIST', devices: structuredClone(this.state.devices) });
  }
  error(connId: string, code: string, msg: string): Outbound[] {
    return [this.out([connId], { type: 'ERROR', code, msg })];
  }

  join(connId: string, msg: JoinMsg, now: number): { ok: boolean; out: Outbound[]; replacedConnId?: string } {
    const existingDev = this.connDevice.get(connId);
    if (existingDev !== undefined && existingDev !== msg.deviceId)
      return {
        ok: false,
        out: this.error(connId, 'already_joined', 'connection already joined as another device'),
      };
    const isHost = msg.hostKey !== undefined && safeEqual(msg.hostKey, this.hostKey);
    if (!isHost && this.passwordHash !== null) {
      if (msg.password === undefined || !this.deps.passwords.verify(msg.password, this.passwordHash))
        return { ok: false, out: this.error(connId, 'bad_password', 'wrong or missing room password') };
    }

    let replacedConnId: string | undefined;
    const prevConn = this.deviceConn.get(msg.deviceId);
    if (prevConn !== undefined && prevConn !== connId) {
      this.connDevice.delete(prevConn);
      replacedConnId = prevConn;
    }
    this.connDevice.set(connId, msg.deviceId);
    this.deviceConn.set(msg.deviceId, connId);
    this.disconnectedAt.delete(msg.deviceId);
    this.emptySince = null;

    let dev = this.device(msg.deviceId);
    if (!dev) {
      dev = {
        id: msg.deviceId,
        name: msg.name,
        role: 'Full',
        isHost: false,
        connected: true,
        caps: msg.caps,
        volume: 1,
        trimDb: 0,
        muted: false,
        solo: false,
        latencyMs: 0,
        calibratedLatencyMs: null,
        eq: defaultEq(),
        bassCapable: BASS_CLASSES.has(msg.caps.deviceClass),
        rolloffHz: null,
        stats: null,
        remote: { spotify: 'unconfigured', apple: 'unconfigured' },
        joinedAt: now,
        ...this.deps.profiles?.get(msg.deviceId),
      };
      this.state.devices.push(dev);
    } else {
      dev.caps = msg.caps;
      dev.connected = true;
    }
    if (!this.state.scene.devices[dev.id]) this.autoPlace(dev.id);
    if (isHost) {
      for (const d of this.state.devices) d.isHost = d.id === dev.id;
      this.state.hostId = dev.id;
    }

    return {
      ok: true,
      replacedConnId,
      out: [
        this.out([connId], {
          type: 'WELCOME',
          deviceId: dev.id,
          isHost: dev.isHost,
          roomState: structuredClone(this.state),
          serverTime: now,
        }),
        this.deviceList('others'),
        this.out('others', { type: 'SCENE', scene: structuredClone(this.state.scene) }),
      ],
    };
  }

  private autoPlace(deviceId: string) {
    // golden-angle spiral on a circle so successive devices never stack
    const angle = this.placed++ * 2.399963 - Math.PI / 2;
    const { listener, room } = this.state.scene;
    // a listener near a wall would otherwise put new speakers outside the room (and off the stage map)
    const p = clampToRoom(
      { x: listener.x + AUTO_PLACE_RADIUS_M * Math.cos(angle), y: listener.y + AUTO_PLACE_RADIUS_M * Math.sin(angle) },
      room,
    );
    this.state.scene.devices[deviceId] = { x: +p.x.toFixed(3), y: +p.y.toFixed(3) };
  }

  leave(connId: string, now: number): Outbound[] {
    const deviceId = this.connDevice.get(connId);
    if (deviceId === undefined) return [];
    this.connDevice.delete(connId);
    if (this.deviceConn.get(deviceId) !== connId) return []; // already replaced by a newer connection
    this.deviceConn.delete(deviceId);
    this.disconnectedAt.set(deviceId, now);
    if (this.deviceConn.size === 0) this.emptySince = now;
    const dev = this.device(deviceId);
    if (dev) dev.connected = false;
    const out = [this.deviceList('all')];
    if (this.state.captureHostId === deviceId) {
      this.state.captureHostId = null;
      out.push(this.stateMsg('all', now));
    }
    return out;
  }

  /** drop devices disconnected longer than maxAgeMs; returns the DEVICE_LIST broadcast if anything changed */
  prune(now: number, maxAgeMs: number): Outbound[] {
    const gone = [...this.disconnectedAt].filter(([, t]) => now - t > maxAgeMs).map(([id]) => id);
    if (gone.length === 0) return [];
    for (const id of gone) {
      this.disconnectedAt.delete(id);
      delete this.state.scene.devices[id];
      if (this.state.hostId === id) this.state.hostId = null;
    }
    this.state.devices = this.state.devices.filter((d) => !gone.includes(d.id));
    return [
      this.deviceList('all'),
      this.out('all', { type: 'SCENE', scene: structuredClone(this.state.scene) }),
    ];
  }

  handle(connId: string, msg: ClientMessage, now: number): Outbound[] {
    const senderId = this.connDevice.get(connId);
    const sender = senderId === undefined ? undefined : this.device(senderId);
    if (!sender) return this.error(connId, 'not_joined', 'send JOIN first');
    try {
      return this.dispatch(connId, sender, msg, now);
    } catch (e) {
      if (e instanceof RoomError) return this.error(connId, e.code, e.message);
      throw e;
    }
  }

  private canControl(sender: Device) {
    return !this.state.settings.hostOnlyControl || sender.isHost;
  }

  private dispatch(connId: string, sender: Device, msg: ClientMessage, now: number): Outbound[] {
    switch (msg.type) {
      case 'JOIN':
        throw new RoomError('bad_message', 'already joined');
      case 'PING':
        return [this.out([connId], { type: 'PONG', t0: msg.t0, ts_recv: now, ts_send: this.clock() })];
      case 'CONTROL':
        if (!this.canControl(sender)) throw new RoomError('forbidden', 'only the host may control playback');
        return this.control(msg.command, sender, connId, now);
      case 'SCENE_UPDATE': {
        const { type: _t, devices, ...rest } = msg;
        Object.assign(this.state.scene, rest);
        for (const [id, pos] of Object.entries(devices ?? {}))
          if (this.device(id)) this.state.scene.devices[id] = pos;
        return [this.out('others', { type: 'SCENE', scene: structuredClone(this.state.scene) })];
      }
      case 'DEVICE_UPDATE': {
        const target = this.device(msg.targetDeviceId ?? sender.id);
        if (!target) throw new RoomError('unknown_target', 'no such device');
        if (target.id !== sender.id && !this.canControl(sender))
          throw new RoomError('forbidden', 'only the host may change other devices');
        this.patchDevice(target, msg.patch);
        return [this.deviceList('all')];
      }
      case 'SETTINGS_UPDATE': {
        if (!sender.isHost) throw new RoomError('forbidden', 'host only');
        const s = this.state.settings;
        if (msg.hostOnlyControl !== undefined) s.hostOnlyControl = msg.hostOnlyControl;
        if (msg.videoBufferMs !== undefined) s.videoBufferMs = msg.videoBufferMs;
        if (msg.lipSyncNudgeMs !== undefined) s.lipSyncNudgeMs = msg.lipSyncNudgeMs;
        if (msg.password !== undefined) {
          this.passwordHash = msg.password ? this.deps.passwords.hash(msg.password) : null;
          s.hasPassword = this.passwordHash !== null;
        }
        return [this.stateMsg('all', now)];
      }
      case 'STATS': {
        sender.stats = msg.stats;
        if (now - this.lastStatsBroadcast < STATS_BROADCAST_INTERVAL_MS) return [];
        this.lastStatsBroadcast = now;
        return [this.deviceList('all')];
      }
      case 'CALIBRATION_START': {
        const id = crypto.randomUUID();
        this.planIds.push(id);
        if (this.planIds.length > 16) this.planIds.shift();
        const plan = {
          id,
          listenerId: sender.id,
          startRoomTime: now + Math.max(this.lead(), CALIBRATION_MIN_LEAD_MS),
          slots: msg.slots,
          ...(msg.purpose ? { purpose: msg.purpose } : {}),
        };
        return [this.out('all', { type: 'CALIBRATION_PLAN', plan })];
      }
      case 'CALIBRATION_RESULT': {
        if (!this.planIds.includes(msg.planId))
          throw new RoomError('unknown_plan', 'no such calibration plan');
        for (const r of msg.results) {
          const dev = this.device(r.deviceId);
          if (!dev) continue;
          const patch: DevicePatch = {};
          if (r.calibratedLatencyMs !== undefined) patch.calibratedLatencyMs = r.calibratedLatencyMs;
          if (r.eq !== undefined) patch.eq = r.eq;
          if (r.rolloffHz !== undefined) patch.rolloffHz = r.rolloffHz;
          if (r.bassCapable !== undefined) patch.bassCapable = r.bassCapable;
          if (r.trimDb !== undefined) patch.trimDb = r.trimDb;
          this.patchDevice(dev, patch);
          if (r.volumeUpDb !== undefined) dev.volumeUpDb = r.volumeUpDb;
        }
        return [this.deviceList('all')];
      }
      case 'IDENTIFY':
        if (!this.device(msg.targetDeviceId)) throw new RoomError('unknown_target', 'no such device');
        return [
          this.out('all', {
            type: 'IDENTIFY',
            targetDeviceId: msg.targetDeviceId,
            startRoomTime: now + this.lead(),
          }),
        ];
      case 'CAPTURE': {
        const cur = this.state.captureHostId;
        if (msg.active) {
          if (cur !== null && cur !== sender.id && this.deviceConn.has(cur))
            throw new RoomError('capture_busy', 'another device is already capturing');
          this.state.captureHostId = sender.id;
        } else if (cur === sender.id) {
          this.state.captureHostId = null;
        }
        return [this.stateMsg('all', now)];
      }
      case 'RTC_SIGNAL': {
        const to = this.deviceConn.get(msg.to);
        if (to === undefined) throw new RoomError('unknown_target', 'target device is not connected');
        return [this.out([to], { type: 'RTC_SIGNAL', from: sender.id, data: msg.data, ...(msg.ch ? { ch: msg.ch } : {}) })];
      }
    }
  }

  private patchDevice(dev: Device, patch: DevicePatch) {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (dev as Record<string, unknown>)[k] = v;
    if (this.deps.profiles) {
      const p = {} as Record<string, unknown>;
      for (const k of PROFILE_KEYS) p[k] = dev[k];
      this.deps.profiles.set(dev.id, p as Profile);
    }
  }

  /** track position (s) at room time t under the current playback */
  positionAt(t: number): number {
    const p = this.state.playback;
    if (p.status !== 'playing') return p.trackOffset;
    let pos = p.trackOffset + Math.max(0, t - p.startRoomTime) / 1000;
    const dur = this.state.queue.find((q) => q.id === p.trackId)?.durationSec;
    if (dur !== undefined && dur > 0) pos = Math.min(pos, dur);
    return pos;
  }

  private control(cmd: ControlCmd, sender: Device, connId: string, now: number): Outbound[] {
    const p = this.state.playback;
    const T = now + this.lead();
    const schedule = (action: 'play' | 'pause' | 'seek' | 'stop') => [
      this.out('all', {
        type: 'SCHEDULE',
        action,
        startRoomTime: p.startRoomTime,
        trackOffset: p.trackOffset,
        trackId: p.trackId,
      }),
      this.stateMsg('all', now),
    ];
    const startAt = (trackId: string | null, offset: number, status: 'playing' | 'paused' | 'stopped') => {
      p.trackId = trackId;
      p.trackOffset = offset;
      p.startRoomTime = T;
      p.status = status;
    };
    const idx = () => this.state.queue.findIndex((t) => t.id === p.trackId);

    switch (cmd.type) {
      case 'play': {
        const trackId = cmd.trackId ?? p.trackId ?? this.state.queue[0]?.id;
        if (trackId === undefined || trackId === null) throw new RoomError('no_track', 'queue is empty');
        if (!this.state.queue.some((t) => t.id === trackId))
          throw new RoomError('unknown_track', 'track not queued');
        const same = trackId === p.trackId;
        // repeated play on the running track keeps the timeline (idempotent)
        if (same && p.status === 'playing' && cmd.position === undefined) return schedule('play');
        startAt(trackId, cmd.position ?? (same ? p.trackOffset : 0), 'playing');
        return schedule('play');
      }
      case 'pause': {
        if (p.status !== 'playing') return [this.stateMsg([connId], now)];
        startAt(p.trackId, Math.max(p.trackOffset, this.positionAt(T)), 'paused');
        return schedule('pause');
      }
      case 'stop':
        startAt(p.trackId, 0, 'stopped');
        return schedule('stop');
      case 'seek':
        startAt(p.trackId, cmd.position, p.status);
        return schedule('seek');
      case 'next':
      case 'previous': {
        const i = idx();
        const j = cmd.type === 'next' ? i + 1 : Math.max(0, i - 1);
        const track = this.state.queue[j];
        if (!track) {
          startAt(p.trackId, 0, 'stopped');
          return schedule('stop');
        }
        const wasPlaying = p.status === 'playing';
        startAt(track.id, 0, wasPlaying ? 'playing' : p.status === 'paused' ? 'paused' : 'stopped');
        return wasPlaying ? schedule('play') : [this.stateMsg('all', now)];
      }
      case 'queue': {
        if (!this.state.queue.some((t) => t.id === cmd.track.id)) {
          if (this.state.queue.length >= 200) throw new RoomError('queue_full', 'queue is full');
          this.state.queue.push({ ...cmd.track, addedBy: sender.id });
        }
        if (p.trackId === null) startAt(cmd.track.id, 0, 'stopped');
        return [this.stateMsg('all', now)];
      }
      case 'remove': {
        const i = this.state.queue.findIndex((t) => t.id === cmd.trackId);
        if (i < 0) return [this.stateMsg('all', now)];
        this.state.queue.splice(i, 1);
        if (p.trackId !== cmd.trackId) return [this.stateMsg('all', now)];
        startAt(this.state.queue[i]?.id ?? this.state.queue[i - 1]?.id ?? null, 0, 'stopped');
        return schedule('stop');
      }
      case 'volume':
        this.state.volume = cmd.volume;
        return [this.stateMsg('all', now)];
    }
  }
}
