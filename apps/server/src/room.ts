/**
 * Transport-free authoritative room. No ws/http/node imports so it can move into a Durable Object:
 * the transport feeds it parsed messages + arrival times and fans out the returned Outbound list.
 */
import {
  AUTO_ADVANCE_MARGIN_MS,
  QUEUE_END_STOP_MS,
  defaultEq,
  defaultScene,
  defaultSettings,
  CALIBRATION_PREPARE_DEADLINE_MS,
  type CalibrationPlan,
  type CalibrationSlot,
  type ClientMessage,
  type Device,
  type DevicePatch,
  type RoomSettings,
  type RoomState,
  type Scene,
  type ServerMessage,
  type ServerMessageBody,
  type Track,
} from '@syncsound/protocol';
import {
  calibrationRecordingMs,
  clampToRoom,
  deriveCalibratedLatency,
  isRoutedLayout,
  minScheduleLeadMs,
  nextFreeSlot,
  slotPositions,
  SYNC_SEARCH_LATE_MS,
  syncStateOf,
} from '@syncsound/audio-core';

export type Target = 'all' | 'others' | string[];
/** `msg` already carries the room-assigned seq; broadcast copies share one seq. */
export interface Outbound {
  to: Target;
  msg: ServerMessage;
}

type JoinMsg = Extract<ClientMessage, { type: 'JOIN' }>;
export type ControlCmd = Extract<ClientMessage, { type: 'CONTROL' }>['command'];

export const PROFILE_KEYS = [
  'name',
  'role',
  'trimDb',
  'latencyMs',
  'tuneArrivalMs',
  'tuneId',
  'tuneStale',
  'eq',
  'bassCapable',
  'rolloffHz',
  'volume',
] as const;
export type Profile = Pick<Device, (typeof PROFILE_KEYS)[number]>;

/** config a persistent (home) room writes back to its store on every change */
export interface RoomConfig {
  scene: Scene;
  settings: RoomSettings;
  passwordHash: string | null;
}

export interface RoomDeps {
  code: string;
  /** temporary rooms: the raw host key; home rooms pass `isHostKey` (owner-key check) instead */
  hostKey?: string;
  isHostKey?: (key: string) => boolean;
  createdAt: number;
  /** initial config of a stored room */
  scene?: Scene;
  settings?: RoomSettings;
  /** set for persistent rooms; called with a snapshot after scene/settings change */
  onConfig?: (cfg: RoomConfig) => void;
  /** opaque stored password hash, null = no password */
  passwordHash?: string | null;
  passwords: { hash(pw: string): string; verify(pw: string, stored: string): boolean };
  profiles?: { get(deviceId: string): Profile | undefined; set(deviceId: string, p: Profile): void };
  /** how long a prepared run waits for its recorders (tests shorten it) */
  prepareDeadlineMs?: number;
  /** used only for PONG ts_send; defaults to performance time */
  clock?: () => number;
}

export const perfClock = () => performance.timeOrigin + performance.now();
export const AUTO_PLACE_RADIUS_M = 2.2;
export const STATS_BROADCAST_INTERVAL_MS = 1000;
/** Calibration start lead, ms (the listener has already opened its mic and settled). */
export const CALIBRATION_MIN_LEAD_MS = 1500;
/**
 * …for an all-recorders tune: the other recorders open their mics when the plan arrives, and the output-latency step
 * that can cause must settle into each device's audio-clock mapping before its slot is scheduled.
 */
export const CALIBRATION_ALL_LEAD_MS = 3500;
/** an all-recorders plan must end within this, ms (32 devices × 1.55 s fit) */
export const CALIBRATION_ALL_MAX_MS = 60_000;
/** a run holds the room (no second CALIBRATION_START) until its recording ends plus this (the listener's rows wait + analysis), ms */
export const CALIBRATION_ACTIVE_TAIL_MS = 5000;
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

interface ActiveRun {
  id: string;
  listenerId: string;
  /** room time until which the room is busy with this run */
  endsAt: number;
  /** set while the run waits for its recorders' mics */
  prepare?: {
    expected: Set<string>;
    ready: Set<string>;
    deadline: number;
    slots: CalibrationSlot[];
    purpose: CalibrationPlan['purpose'];
    recorders: CalibrationPlan['recorders'];
    /** a connected recorder on older code (no `micPermission`) will open its mic when the plan arrives */
    legacy: boolean;
  };
}

export class Room {
  readonly state: RoomState;
  private readonly isHostKey: (key: string) => boolean;
  private passwordHash: string | null;
  private readonly deps: RoomDeps;
  private readonly clock: () => number;
  private seq = 0;
  /** connId → deviceId, and the reverse for the live connection of each device */
  private readonly connDevice = new Map<string, string>();
  private readonly deviceConn = new Map<string, string>();
  private readonly disconnectedAt = new Map<string, number>();
  /** recent calibration plans → their listener (only it may submit results; recorders' rows go to it) */
  private readonly plans: Array<{ id: string; listenerId: string }> = [];
  /** the run in progress: one at a time, since every device plays every plan it receives */
  private activeRun: ActiveRun | null = null;
  private lastStatsBroadcast = -Infinity;
  private placed = 0;
  /** room ms since which no device is connected (null while someone is connected) */
  emptySince: number | null;

  constructor(deps: RoomDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? perfClock;
    const { hostKey } = deps;
    this.isHostKey = deps.isHostKey ?? ((k) => hostKey !== undefined && safeEqual(k, hostKey));
    this.passwordHash = deps.passwordHash ?? null;
    this.emptySince = deps.createdAt;
    const scene = deps.scene ? structuredClone(deps.scene) : defaultScene();
    this.placed = Object.keys(scene.devices).length;
    this.state = {
      code: deps.code,
      hostId: null,
      createdAt: deps.createdAt,
      settings: { ...defaultSettings(), ...deps.settings, hasPassword: this.passwordHash !== null },
      devices: [],
      scene,
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

  /**
   * schedule lead: ≥ max over connected devices of (RTT + output compensation) + safety margin, never below
   * MIN_SCHEDULE_LEAD_MS. Output compensation = manual + calibrated + browser-reported latency, so a Bluetooth
   * device that starts its source ~250 ms early still gets the message in time.
   */
  lead(): number {
    return minScheduleLeadMs(
      this.state.devices
        .filter((d) => d.connected)
        .map((d) => ({
          rttMs: d.stats?.rttMs ?? 0,
          outputLatencyMs: d.latencyMs + (d.calibratedLatencyMs ?? 0) + (d.stats?.autoLatencyMs ?? 0),
        })),
    );
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
    const isHost = msg.hostKey !== undefined && this.isHostKey(msg.hostKey);
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
        tuneArrivalMs: null,
        tuneId: null,
        tuneStale: null,
        syncState: 'untuned',
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
    if (!this.state.scene.devices[dev.id]) {
      const layout = this.state.scene.layout;
      if (isRoutedLayout(layout) && dev.role === 'Full') {
        // a late joiner in a laid-out room takes a free slot and that slot's spot; nobody else moves
        const roles = Object.fromEntries(this.state.devices.filter((d) => d.connected && d.id !== dev.id).map((d) => [d.id, d.role]));
        dev.role = nextFreeSlot(layout, roles);
        const pos = slotPositions(layout, { ...roles, [dev.id]: dev.role }, this.state.scene)[dev.id];
        if (pos) this.state.scene.devices[dev.id] = pos;
      }
      if (!this.state.scene.devices[dev.id]) this.autoPlace(dev.id);
      this.persist();
    }
    if (isHost) {
      for (const d of this.state.devices) d.isHost = d.id === dev.id;
      this.state.hostId = dev.id;
    }
    this.syncDerived();

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
    if (this.activeRun?.listenerId === deviceId) {
      // nobody is listening any more: stop the chimes and free the room for the next tune
      out.push(this.out('all', { type: 'CALIBRATION_CANCELLED', planId: this.activeRun.id }));
      this.activeRun = null;
    }
    return out;
  }

  /** room time at which `calibrationTick()` has something to do (a prepared run's deadline), or null */
  calibrationDue(): number | null {
    return this.activeRun?.prepare?.deadline ?? null;
  }

  /** time-driven calibration work (the transport calls it once `calibrationDue()` has passed): plan a prepared run */
  calibrationTick(now: number): Outbound[] {
    const run = this.activeRun;
    if (!run?.prepare || now < run.prepare.deadline) return [];
    return [this.planPrepared(run, now)];
  }

  /** the plan of a prepared run: broadcast once every expected recorder answered, or at the deadline */
  private planPrepared(run: ActiveRun, now: number): Outbound {
    const { slots, purpose, recorders, legacy } = run.prepare!;
    // a recorder that opens its mic only when the plan arrives (an older tab) still needs the long lead
    const plan = this.makePlan(run, slots, purpose, recorders, now, legacy ? CALIBRATION_ALL_LEAD_MS : CALIBRATION_MIN_LEAD_MS);
    delete run.prepare;
    return this.out('all', { type: 'CALIBRATION_PLAN', plan });
  }

  private makePlan(run: ActiveRun, slots: CalibrationSlot[], purpose: CalibrationPlan['purpose'], recorders: CalibrationPlan['recorders'], now: number, minLead: number): CalibrationPlan {
    const plan: CalibrationPlan = {
      id: run.id,
      listenerId: run.listenerId,
      startRoomTime: now + Math.max(this.lead(), minLead),
      slots,
      ...(purpose ? { purpose } : {}),
      ...(recorders ? { recorders } : {}),
    };
    const recordingMs = calibrationRecordingMs(slots, purpose === 'measure' ? SYNC_SEARCH_LATE_MS : undefined);
    run.endsAt = plan.startRoomTime + recordingMs + CALIBRATION_ACTIVE_TAIL_MS;
    return plan;
  }

  /** drop devices disconnected longer than maxAgeMs; returns the DEVICE_LIST broadcast if anything changed */
  prune(now: number, maxAgeMs: number): Outbound[] {
    const gone = [...this.disconnectedAt].filter(([, t]) => now - t > maxAgeMs).map(([id]) => id);
    if (gone.length === 0) return [];
    for (const id of gone) {
      this.disconnectedAt.delete(id);
      // home rooms keep a returning speaker's spot (the mix ignores positions of absent devices)
      if (!this.deps.onConfig) delete this.state.scene.devices[id];
      if (this.state.hostId === id) this.state.hostId = null;
    }
    this.state.devices = this.state.devices.filter((d) => !gone.includes(d.id));
    this.syncDerived();
    return [
      this.deviceList('all'),
      this.out('all', { type: 'SCENE', scene: structuredClone(this.state.scene) }),
    ];
  }

  /**
   * Re-derive every device's output compensation (`calibratedLatencyMs`) and `syncState` from the room's tune and
   * the current positions (audio-core `deriveCalibratedLatency`); true when anything changed. Called wherever a
   * position, a tune field or the device set changes, so a layout edit or a drag keeps the room aligned.
   */
  private syncDerived(): boolean {
    const tune = this.state.scene.tune;
    const cal = deriveCalibratedLatency(this.state.devices, tune, this.state.scene.devices, this.state.scene.listener);
    let changed = false;
    for (const d of this.state.devices) {
      const c = cal[d.id] ?? null;
      const s = syncStateOf(d, tune);
      if (d.calibratedLatencyMs !== c || d.syncState !== s) {
        d.calibratedLatencyMs = c;
        d.syncState = s;
        changed = true;
      }
    }
    return changed;
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
        return this.control(msg.command, sender, connId, now, now + this.lead());
      case 'SCENE_UPDATE': {
        const { type: _t, devices, ...rest } = msg;
        Object.assign(this.state.scene, rest);
        for (const [id, pos] of Object.entries(devices ?? {}))
          if (this.device(id)) this.state.scene.devices[id] = pos;
        this.persist();
        const out = [this.out('others', { type: 'SCENE', scene: structuredClone(this.state.scene) })];
        if ((devices || rest.listener) && this.syncDerived()) out.push(this.deviceList('all')); // moved speakers: new compensation
        return out;
      }
      case 'DEVICE_UPDATE': {
        const target = this.device(msg.targetDeviceId ?? sender.id);
        if (!target) throw new RoomError('unknown_target', 'no such device');
        if (target.id !== sender.id && !this.canControl(sender))
          throw new RoomError('forbidden', 'only the host may change other devices');
        this.patchDevice(target, msg.patch);
        this.syncDerived();
        return [this.deviceList('all')];
      }
      case 'SETTINGS_UPDATE': {
        if (!sender.isHost) throw new RoomError('forbidden', 'host only');
        const s = this.state.settings;
        if (msg.hostOnlyControl !== undefined) s.hostOnlyControl = msg.hostOnlyControl;
        if (msg.videoBufferMs !== undefined) s.videoBufferMs = msg.videoBufferMs;
        if (msg.lipSyncNudgeMs !== undefined) s.lipSyncNudgeMs = msg.lipSyncNudgeMs;
        if (msg.crossfadeSec !== undefined) s.crossfadeSec = msg.crossfadeSec;
        if (msg.password !== undefined) {
          this.passwordHash = msg.password ? this.deps.passwords.hash(msg.password) : null;
          s.hasPassword = this.passwordHash !== null;
        }
        this.persist();
        return [this.stateMsg('all', now)];
      }
      case 'STATS': {
        sender.stats = msg.stats;
        if (now - this.lastStatsBroadcast < STATS_BROADCAST_INTERVAL_MS) return [];
        this.lastStatsBroadcast = now;
        return [this.deviceList('all')];
      }
      case 'CALIBRATION_START': {
        // a run plays on every device (and a tune rewrites their latency/EQ): a playback-control action
        if (!this.canControl(sender)) throw new RoomError('forbidden', 'only the host may calibrate');
        if (msg.recorders === 'all') {
          // every device opens its mic and buffers the whole run: keep it a tune — one chime per known device, short
          const ids = msg.slots.map((s) => s.deviceId);
          const endMs = Math.max(...msg.slots.map((s) => s.offsetMs + s.durationMs));
          if (msg.purpose === 'measure' || msg.slots.some((s) => s.repeat !== undefined) || new Set(ids).size !== ids.length || ids.some((id) => !this.device(id)) || endMs > CALIBRATION_ALL_MAX_MS)
            throw new RoomError('bad_plan', 'an all-recorders plan must be one short slot per device');
        }
        const active = this.activeRun;
        if (active && now < active.endsAt && this.deviceConn.has(active.listenerId))
          throw new RoomError('calibration_busy', 'another device is tuning the room right now');
        const id = crypto.randomUUID();
        this.plans.push({ id, listenerId: sender.id });
        if (this.plans.length > 16) this.plans.shift();
        const run: ActiveRun = { id, listenerId: sender.id, endsAt: 0 };
        this.activeRun = run;
        if (msg.prepare && msg.recorders === 'all') {
          // prepare phase: the recorders that can answer open their mics now; the plan follows the last answer or
          // the deadline, with a short lead (nobody opens a mic when it arrives — unless an older tab is in the room)
          const others = this.state.devices.filter((d) => d.connected && d.id !== sender.id && d.caps.hasMic);
          const expected = others.filter((d) => d.caps.micPermission !== undefined && d.caps.micPermission !== 'denied' && d.caps.deviceClass !== 'bluetooth');
          const deadline = now + (this.deps.prepareDeadlineMs ?? CALIBRATION_PREPARE_DEADLINE_MS);
          run.prepare = {
            expected: new Set(expected.map((d) => d.id)),
            ready: new Set(),
            deadline,
            slots: msg.slots,
            purpose: msg.purpose,
            recorders: msg.recorders,
            legacy: others.some((d) => d.caps.micPermission === undefined),
          };
          run.endsAt = deadline + CALIBRATION_ALL_LEAD_MS; // until the plan sets the real end
          if (!expected.length) return [this.planPrepared(run, now)];
          return [this.out('all', { type: 'CALIBRATION_PREPARE', planId: id, listenerId: sender.id, recorderIds: [...run.prepare.expected], deadlineRoomTime: deadline })];
        }
        const plan = this.makePlan(run, msg.slots, msg.purpose, msg.recorders, now, msg.recorders === 'all' ? CALIBRATION_ALL_LEAD_MS : CALIBRATION_MIN_LEAD_MS);
        return [this.out('all', { type: 'CALIBRATION_PLAN', plan })];
      }
      case 'CALIBRATION_READY': {
        const run = this.activeRun;
        if (!run?.prepare || run.id !== msg.planId || !run.prepare.expected.has(sender.id)) return [];
        run.prepare.ready.add(sender.id);
        const to = this.deviceConn.get(run.listenerId);
        const out: Outbound[] = [];
        if (to !== undefined) out.push(this.out([to], { type: 'CALIBRATION_READY', planId: run.id, recorderId: sender.id, ok: msg.ok, ...(msg.reason ? { reason: msg.reason } : {}) }));
        if ([...run.prepare.expected].every((id) => run.prepare!.ready.has(id))) out.push(this.planPrepared(run, now));
        return out;
      }
      case 'CAPS_UPDATE': {
        sender.caps = msg.caps;
        return [this.deviceList('all')];
      }
      case 'CALIBRATION_CANCEL': {
        const plan = this.plans.find((p) => p.id === msg.planId);
        if (!plan) throw new RoomError('unknown_plan', 'no such calibration plan');
        if (plan.listenerId !== sender.id) throw new RoomError('forbidden', "only the run's listener may cancel it");
        if (this.activeRun?.id === msg.planId) this.activeRun = null;
        return [this.out('all', { type: 'CALIBRATION_CANCELLED', planId: msg.planId })];
      }
      case 'CALIBRATION_ROWS': {
        const plan = this.plans.find((p) => p.id === msg.planId);
        if (!plan) throw new RoomError('unknown_plan', 'no such calibration plan');
        const to = this.deviceConn.get(plan.listenerId);
        if (to === undefined) return [];
        const { type: _t, ...rows } = msg;
        return [this.out([to], { type: 'CALIBRATION_ROWS', recorderId: sender.id, ...rows })];
      }
      case 'CALIBRATION_RESULT': {
        const plan = this.plans.find((p) => p.id === msg.planId);
        if (!plan) throw new RoomError('unknown_plan', 'no such calibration plan');
        if (plan.listenerId !== sender.id) throw new RoomError('forbidden', "only the run's listener may submit its results");
        if (this.activeRun?.id === msg.planId) this.activeRun = null;
        // every run is a new tune: devices it heard join it, the others become untuned (their old value could only
        // be compared to a reference that no longer exists); a timing-only run keeps the previous run's ranging
        const prev = this.state.scene.tune;
        this.state.scene.tune = {
          id: msg.planId,
          listenerId: sender.id,
          mic: msg.tune.mic,
          at: now,
          quick: msg.tune.quick,
          ranged: (msg.tune.quick ? (prev?.ranged ?? []) : msg.tune.ranged).filter((id) => this.device(id)),
          positions: Object.fromEntries(Object.entries(msg.tune.positions).filter(([id]) => this.device(id))),
        };
        for (const r of msg.results) {
          const dev = this.device(r.deviceId);
          if (!dev) continue;
          const patch: DevicePatch = {};
          if (r.tuneArrivalMs !== undefined) {
            patch.tuneArrivalMs = r.tuneArrivalMs;
            patch.tuneId = msg.planId;
            patch.tuneStale = null;
          }
          if (r.eq !== undefined) patch.eq = r.eq;
          if (r.rolloffHz !== undefined) patch.rolloffHz = r.rolloffHz;
          if (r.bassCapable !== undefined) patch.bassCapable = r.bassCapable;
          if (r.trimDb !== undefined) patch.trimDb = r.trimDb;
          this.patchDevice(dev, patch);
          if (r.volumeUpDb !== undefined) dev.volumeUpDb = r.volumeUpDb;
        }
        this.syncDerived();
        this.persist();
        return [this.deviceList('all'), this.out('all', { type: 'SCENE', scene: structuredClone(this.state.scene) })];
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
          // the stream plays on every device: a playback-control action
          if (!this.canControl(sender)) throw new RoomError('forbidden', 'only the host may share audio');
          if (cur !== null && cur !== sender.id && this.deviceConn.has(cur))
            throw new RoomError('capture_busy', 'another device is already capturing');
          this.state.captureHostId = sender.id;
          // a file track can't share the output chain with a live stream (it would be shifted by the alignment
          // delay, differently on every device): pause it at the next schedulable instant
          if (this.state.playback.status === 'playing')
            return this.control({ type: 'pause' }, sender, connId, now, now + this.lead());
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

  private persist() {
    this.deps.onConfig?.({
      scene: structuredClone(this.state.scene),
      settings: { ...this.state.settings },
      passwordHash: this.passwordHash,
    });
  }

  /**
   * Home group command: apply `cmd` with a caller-chosen start time T shared by every room in the group
   * (all rooms run on the server's perfClock, so equal T = the same instant everywhere).
   */
  controlAt(cmd: ControlCmd, T: number, now: number): { out: Outbound[] } | { error: string } {
    try {
      return { out: this.control(cmd, undefined, undefined, now, T) };
    } catch (e) {
      if (e instanceof RoomError) return { error: e.code };
      throw e;
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

  /** room ms at which the current track ends under the current playback; null unless a rendered track with a known duration is playing */
  endRoomTime(): number | null {
    const p = this.state.playback;
    if (p.status !== 'playing') return null;
    const track = this.state.queue.find((q) => q.id === p.trackId);
    if (!track || track.sourceClass !== 'rendered' || !track.durationSec) return null;
    return p.startRoomTime + Math.max(0, track.durationSec - p.trackOffset) * 1000;
  }

  /** what the end of the current track leads to: the next track (crossfaded when both are rendered) or a stop */
  private transition(): { targetRoomTime: number; end: number; next: Track | null } | null {
    const end = this.endRoomTime();
    if (end === null) return null;
    const p = this.state.playback;
    const i = this.state.queue.findIndex((t) => t.id === p.trackId);
    const next = this.state.queue[i + 1] ?? null;
    if (!next) return { targetRoomTime: end + QUEUE_END_STOP_MS, end, next };
    const remainingMs = Math.max(0, this.state.queue[i]!.durationSec! - p.trackOffset) * 1000;
    const nextMs = next.durationSec ? next.durationSec * 1000 : Infinity;
    // a fade never covers more than half of either track (a short track is still heard on its own, and its
    // fade-in has ended before its fade-out starts); sync-only (SDK-owned) tracks can't overlap: plain hand-over
    const fadeMs =
      next.sourceClass === 'rendered' ? Math.min(this.state.settings.crossfadeSec * 1000, remainingMs / 2, nextMs / 2) : 0;
    return { targetRoomTime: end - fadeMs, end, next };
  }

  /** room ms at which the transport should call `tick`: early enough for the transition's SCHEDULE to carry the full lead */
  nextDueAt(): number | null {
    const t = this.transition();
    return t && t.targetRoomTime - this.lead() - AUTO_ADVANCE_MARGIN_MS;
  }

  /**
   * Auto-advance at the end of the current track; a no-op before `nextDueAt`. Schedules the next track to start
   * `settings.crossfadeSec` before the current one ends (0 = gapless join), or a stop just past the end of the
   * last track. The start is never earlier than now + lead; a late tick shortens the crossfade instead.
   */
  tick(now: number): Outbound[] {
    const due = this.nextDueAt();
    const t = this.transition();
    if (due === null || !t || now < due) return [];
    const T = Math.max(t.targetRoomTime, now + this.lead());
    const p = this.state.playback;
    p.startRoomTime = T;
    p.trackOffset = 0;
    if (!t.next) {
      // end of the queue: stop on the last track, like `next` past the end
      p.status = 'stopped';
      delete p.crossfadeSec;
      return this.scheduleOut('stop', now);
    }
    p.trackId = t.next.id;
    p.status = 'playing';
    p.crossfadeSec = Math.max(0, t.end - T) / 1000;
    return this.scheduleOut('play', now);
  }

  private scheduleOut(action: 'play' | 'pause' | 'seek' | 'stop', now: number): Outbound[] {
    const p = this.state.playback;
    return [
      this.out('all', {
        type: 'SCHEDULE',
        action,
        startRoomTime: p.startRoomTime,
        trackOffset: p.trackOffset,
        trackId: p.trackId,
        ...(p.crossfadeSec !== undefined && { crossfadeSec: p.crossfadeSec }),
      }),
      this.stateMsg('all', now),
    ];
  }

  private control(
    cmd: ControlCmd,
    sender: Device | undefined,
    connId: string | undefined,
    now: number,
    T: number,
  ): Outbound[] {
    const p = this.state.playback;
    const schedule = (action: 'play' | 'pause' | 'seek' | 'stop') => this.scheduleOut(action, now);
    const startAt = (trackId: string | null, offset: number, status: 'playing' | 'paused' | 'stopped') => {
      p.trackId = trackId;
      p.trackOffset = offset;
      p.startRoomTime = T;
      p.status = status;
      delete p.crossfadeSec; // user-driven: no transition from a previous track
    };
    const idx = () => this.state.queue.findIndex((t) => t.id === p.trackId);

    switch (cmd.type) {
      case 'play': {
        const capturing = this.state.captureHostId;
        if (capturing !== null && this.deviceConn.has(capturing))
          throw new RoomError('capture_active', 'stop sharing audio first');
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
        if (p.status !== 'playing') return connId === undefined ? [] : [this.stateMsg([connId], now)];
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
        const existing = this.state.queue.find((t) => t.id === cmd.track.id);
        if (existing) {
          // re-queueing a known track only fills in what the first queue didn't know yet (learned when decoded)
          if (existing.durationSec === undefined && cmd.track.durationSec !== undefined) existing.durationSec = cmd.track.durationSec;
          if (existing.channels === undefined && cmd.track.channels !== undefined) existing.channels = cmd.track.channels;
        } else {
          if (this.state.queue.length >= 200) throw new RoomError('queue_full', 'queue is full');
          this.state.queue.push({ ...cmd.track, ...(sender && { addedBy: sender.id }) });
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
