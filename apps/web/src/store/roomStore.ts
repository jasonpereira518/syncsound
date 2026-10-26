/**
 * Room store: zustand state (see state.ts) + `roomActions` (the RoomActions contract in types.ts).
 * Import only from client components. Actions that need a user gesture (call directly from a click
 * handler, before any await): join, startCapture, connectSpotify, connectApple, startCalibration (mic).
 */
import { dueNow, setBatterySaverFlag } from '../lib/power';
import { autoAssign, defaultObjectsFor, isRoutedLayout, presetLayout, slotPositions, type RoomClock } from '@syncsound/audio-core';
import {
  DemoAsset,
  MAX_UPLOAD_BYTES,
  UploadResponse,
  isValidRoomCode,
  type ClientMessage,
  type DeviceCaps,
  type Playback,
  type RoomState,
  type Scene,
  type SceneUpdate,
  type ServerMessage,
  type Track,
} from '@syncsound/protocol';
import { serverUrl } from '../lib/config';
import { batteryLevel, buildCaps, getDeviceId, randomId, rememberName, storage } from '../lib/device';
import { recallOutputCalibration, rememberOutputCalibration, routeChangeAction } from '../lib/outputMemory';
import { AudioEngine } from '../lib/engine/audioEngine';
import { CalibrationController, presetPatch } from '../lib/engine/calibration';
import { CaptureController } from '../lib/engine/capture';
import { VideoDriver } from '../lib/engine/videoSync';
import { History, restoreScene } from '../lib/history';
import { installInstrumentation } from '../lib/instrumentation';
import { ClockLink, pickClockMaster } from '../lib/clockLink';
import { RoomClient } from '../lib/roomClient';
import { RemoteSyncManager } from '../lib/sources/remoteSync';
import { loginSpotify } from '../lib/sources/spotify';
import { normalizeRemoteId } from '../lib/sources/types';
import { mergingThrottle } from '../lib/throttle';
import { errMsg, initialState, patch, setError, useRoomStore } from './state';
import type { RoomActions } from './types';

export { initialState, useRoomStore };

type ScenePatch = Omit<SceneUpdate, 'type'>;

interface Session {
  code: string;
  client: RoomClient;
  /** LAN clock master link; used instead of the server clock while ready */
  link: ClockLink;
  engine: AudioEngine;
  calibration: CalibrationController;
  capture: CaptureController;
  remote: RemoteSyncManager;
  video: VideoDriver;
  history: History<Scene>;
  scene: ReturnType<typeof mergingThrottle<ScenePatch>>;
  lastLocalSceneEdit: number;
  autoObjectsKey: string;
  /** sent on every (re)JOIN; refreshed when the output route changes */
  caps: DeviceCaps;
  /** current output label (undefined when the browser hides it) → per-output calibration memory key */
  outputLabel: string | undefined;
  /** clock path ('lan:<master>' | 'wan') during this session's last tune; a later change means re-tune */
  tunedClockPath: string | null;
  cleanup: Array<() => void>;
}

let session: Session | null = null;

/** the clock every timing path uses: the LAN link when ready, else the server clock */
const activeClock = (s: Session): RoomClock => (s.link.ready ? s.link : s.client.clock);
let joining: string | null = null;

const SCENE_KEYS = ['objects', 'devices', 'listener', 'room', 'propagationComp', 'rolloff', 'blur', 'crossoverHz', 'upmix', 'layout'] as const;
const fin = (x: number) => (Number.isFinite(x) ? x : 0);
const newTrackId = () => `t_${randomId(12)}`;

function send(msg: ClientMessage): boolean {
  return session?.client.send(msg) ?? false;
}

function sendOrWarn(msg: ClientMessage) {
  if (!send(msg)) setError('Not connected to the room right now. Reconnecting…');
}

function setRoom(fn: (r: RoomState) => RoomState) {
  const { room, deviceId } = useRoomStore.getState();
  if (!room) return;
  const next = fn(room);
  useRoomStore.setState({ room: next, isHost: next.hostId === deviceId });
}

const recentLocalSceneEdit = () => !!session && performance.now() - session.lastLocalSceneEdit < 400;

const FRIENDLY: Record<string, string> = {
  bad_password: 'Wrong room password.',
  wrong_password: 'Wrong room password.',
  password_required: 'This room needs a password.',
  not_found: "That room doesn't exist (it may have expired).",
  room_not_found: "That room doesn't exist (it may have expired).",
  room_full: 'This room is full.',
  forbidden: 'Only the host can do that in this room.',
  host_only: 'Only the host can do that in this room.',
  rate_limited: 'Too many requests. Slow down a little.',
  capture_busy: 'Another device is already sharing audio.',
  capture_active: 'Stop sharing audio first.',
};

function handleMessage(msg: ServerMessage) {
  const s = session;
  if (!s) return;
  switch (msg.type) {
    case 'WELCOME':
      useRoomStore.setState({ deviceId: msg.deviceId, isHost: msg.isHost, room: msg.roomState, error: null });
      s.remote.publish();
      break;
    case 'STATE': {
      const keepScene = recentLocalSceneEdit() ? useRoomStore.getState().room?.scene : undefined;
      const room = keepScene ? { ...msg.roomState, scene: keepScene } : msg.roomState;
      useRoomStore.setState({ room, isHost: room.hostId === useRoomStore.getState().deviceId });
      break;
    }
    case 'SCHEDULE':
      setRoom((r) => {
        const status: Playback['status'] = msg.action === 'pause' ? 'paused' : msg.action === 'stop' ? 'stopped' : 'playing';
        const playback: Playback = {
          status,
          trackId: msg.trackId ?? r.playback.trackId,
          startRoomTime: msg.startRoomTime,
          trackOffset: msg.trackOffset,
        };
        return { ...r, playback };
      });
      break;
    case 'SCENE':
      if (!recentLocalSceneEdit()) setRoom((r) => ({ ...r, scene: msg.scene }));
      break;
    case 'DEVICE_LIST':
      setRoom((r) => ({ ...r, devices: msg.devices }));
      break;
    case 'CALIBRATION_PLAN':
      s.calibration.onPlan(msg.plan);
      break;
    case 'CALIBRATION_ROWS':
      s.calibration.onRows(msg);
      break;
    case 'IDENTIFY': {
      useRoomStore.setState({ identifyFlash: msg.targetDeviceId });
      const t = setTimeout(() => {
        if (useRoomStore.getState().identifyFlash === msg.targetDeviceId) useRoomStore.setState({ identifyFlash: null });
      }, 1500);
      s.cleanup.push(() => clearTimeout(t));
      if (msg.targetDeviceId === useRoomStore.getState().deviceId) s.engine.identifyBeep(msg.startRoomTime);
      break;
    }
    case 'RTC_SIGNAL':
      if (msg.ch === 'clock') void s.link.onSignal(msg.from, msg.data);
      else s.capture.onSignal(msg.from, msg.data);
      break;
    case 'ERROR':
      setError(FRIENDLY[msg.code] ?? msg.msg);
      break;
    case 'PONG':
      break;
  }
}

/**
 * A track queued before anyone knew its length (a web link, a file too big to decode before upload) gets its
 * duration and channel count from the first device that decodes it, so the room can auto-advance at its end.
 * Re-queueing a known track only fills in those fields on the server.
 */
function learnTrackInfo(trackId: string, info: { durationSec: number; channels: number }) {
  const st = useRoomStore.getState();
  const t = st.room?.queue.find((q) => q.id === trackId);
  if (!t || (t.durationSec !== undefined && t.channels !== undefined)) return;
  if (!st.isHost && st.room?.settings.hostOnlyControl) return; // CONTROL would be refused
  if (!Number.isFinite(info.durationSec) || info.durationSec <= 0) return;
  const track: Track = {
    ...t,
    durationSec: t.durationSec ?? info.durationSec,
    channels: t.channels ?? Math.min(8, Math.max(1, Math.round(info.channels))),
  };
  session?.client.send({ type: 'CONTROL', command: { type: 'queue', track } });
}

/**
 * Give multichannel / upmixed sources matching objects once per (source, channels, upmix): the host for the playing
 * track, the sharing device for a live capture (always stereo: a leftover mono or 5.1 layout would mute it).
 */
function maybeAutoObjects(s: Session, room: RoomState) {
  const { isHost, deviceId } = useRoomStore.getState();
  let channels: number;
  let key: string;
  if (room.captureHostId === deviceId) {
    channels = 2;
    key = `capture|2|${room.scene.upmix}`;
  } else {
    if (!isHost) return;
    const track = room.queue.find((t) => t.id === room.playback.trackId);
    if (!track?.channels || track.sourceClass !== 'rendered') return;
    channels = track.channels;
    key = `${track.id}|${track.channels}|${room.scene.upmix}`;
  }
  if (key === s.autoObjectsKey) return;
  s.autoObjectsKey = key;
  try {
    const desired = defaultObjectsFor(channels, room.scene.upmix);
    const chans = (os: { channel: string }[]) => os.map((o) => o.channel).sort().join();
    if (chans(desired) === chans(room.scene.objects)) return;
    const objects = desired.map((d) => {
      const ex = room.scene.objects.find((o) => o.channel === d.channel);
      return ex ? { ...d, id: ex.id, label: ex.label, position: ex.position, gainDb: ex.gainDb, muted: ex.muted } : d;
    });
    roomActions.updateScene({ objects }, { commit: true });
  } catch {
    /* audio-core not ready: keep the scene as is */
  }
}

// ---------- per-output calibration memory (Bluetooth / headphones / built-in each keep their own latency) ----------

const selfDevice = (room: RoomState | null, id: string) => room?.devices.find((d) => d.id === id) ?? null;

function restoreOutputCalibration(label: string, calibratedLatencyMs: number) {
  roomActions.updateDevice({ calibratedLatencyMs });
  useRoomStore.setState({ routeChanged: false, routeRestored: { label, calibratedLatencyMs } });
}

/** re-read caps + output label; returns the new label (undefined when hidden) */
async function refreshOutput(s: Session): Promise<string | undefined> {
  const caps = await buildCaps(s.engine.ctx);
  if (session !== s) return undefined;
  s.caps = caps;
  return caps.outputLabel;
}

/** devicechange: restore that output's calibration, clear one that belonged to the previous output, or prompt */
async function onRouteChange(s: Session) {
  let next: string | undefined;
  try {
    next = await refreshOutput(s);
  } catch {
    next = undefined;
  }
  if (session !== s) return;
  const action = routeChangeAction(s.outputLabel, next, recallOutputCalibration(storage(), next));
  if (next) s.outputLabel = next;
  switch (action.kind) {
    case 'none':
      return;
    case 'unknown':
      useRoomStore.setState({ routeChanged: true, routeRestored: null });
      return;
    case 'restore':
      restoreOutputCalibration(next!, action.calibratedLatencyMs);
      return;
    case 'clear':
      roomActions.updateDevice({ calibratedLatencyMs: null });
      useRoomStore.setState({ routeChanged: true, routeRestored: null });
  }
}

/** keep the memory current: own calibrated latency changed in-session, or this device just calibrated itself */
function watchOutputCalibration(s: Session): () => void {
  return useRoomStore.subscribe((st, prev) => {
    if (session !== s) return;
    const me = selfDevice(st.room, st.deviceId);
    const before = selfDevice(prev.room, st.deviceId);
    if (me && !before && s.outputLabel) {
      // first room state: the server profile may hold another output's calibration
      const r = recallOutputCalibration(storage(), s.outputLabel);
      const label = s.outputLabel;
      if (r !== undefined && r !== me.calibratedLatencyMs) queueMicrotask(() => restoreOutputCalibration(label, r));
    } else if (me && before && me.calibratedLatencyMs !== before.calibratedLatencyMs) {
      rememberOutputCalibration(storage(), s.outputLabel, me.calibratedLatencyMs);
    }
    if (prev.calibration.running && !st.calibration.running && st.calibration.step === 'done') {
      // the mic grant makes the output label readable; once the route settles back from the hands-free
      // profile, file this device's fresh result under it (only if this run measured this device)
      const measured = st.calibration.devices.some((d) => d.deviceId === st.deviceId && d.heard);
      setTimeout(() => {
        void refreshOutput(s)
          .then((label) => {
            if (session !== s || !label) return;
            s.outputLabel = label;
            const now = selfDevice(useRoomStore.getState().room, st.deviceId);
            if (measured && now) rememberOutputCalibration(storage(), label, now.calibratedLatencyMs);
          })
          .catch(() => {});
      }, 1500);
    }
  });
}

/**
 * A tune absorbs this device's clock error on the path it used (LAN master vs server clock). Switching path moves
 * that error by up to a few ms, so prompt a quick re-tune — only against a tune from this session.
 */
function watchClockPath(s: Session) {
  const st = useRoomStore.getState();
  const path = activeClock(s) === s.link ? `lan:${st.room ? pickClockMaster(st.room.devices, st.room.hostId) : ''}` : 'wan';
  if (st.calibration.nowPlaying !== null) s.tunedClockPath = path;
  else if (s.tunedClockPath !== null && path !== s.tunedClockPath) {
    s.tunedClockPath = path;
    useRoomStore.setState({ routeChanged: true, routeRestored: null });
  }
}

const lastStats = { t: 0 };
function sendStats(s: Session) {
  if (!dueNow(lastStats, 10_000)) return;
  if (!s.client.synced) return;
  try {
    const est = s.client.clock.estimate();
    const e = useRoomStore.getState().engine;
    s.client.send({
      type: 'STATS',
      stats: {
        // display value: server clock − this device's wall clock (ClockSync's offset is relative to performance.now())
        offsetMs: fin(est.offsetMs - performance.timeOrigin),
        rttMs: fin(est.rttMs),
        jitterMs: fin(est.jitterMs),
        driftPpm: fin(est.driftPpm),
        syncErrorMs: fin(e.syncErrorMs),
        bufferState: e.bufferState,
        loadedTrackId: e.loadedTrackId?.slice(0, 64) ?? null,
        remoteErrorMs: s.remote.errorMs(),
        autoLatencyMs: e.autoLatencyMs === null ? null : fin(e.autoLatencyMs),
        battery: batteryLevel(),
      },
    });
  } catch {
    /* clock not ready */
  }
}

function applyFullScene(s: Session, snapshot: Scene) {
  const current = useRoomStore.getState().room?.scene;
  const scene = current ? restoreScene(snapshot, current) : snapshot;
  s.scene.cancel();
  setRoom((r) => ({ ...r, scene }));
  s.lastLocalSceneEdit = performance.now();
  const update: ScenePatch = {};
  for (const k of SCENE_KEYS) (update as Record<string, unknown>)[k] = scene[k];
  send({ type: 'SCENE_UPDATE', ...update });
  useRoomStore.setState({ canUndo: s.history.canUndo, canRedo: s.history.canRedo });
}

async function httpError(res: Response, what: string): Promise<Error> {
  let detail = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { error?: string; msg?: string };
    detail = j.error ?? j.msg ?? detail;
  } catch {
    /* not json */
  }
  return new Error(`${what}: ${detail}`);
}

/** setError + throw, for actions that return a value */
function fail(msg: string): never {
  setError(msg);
  throw new Error(msg);
}

/** current room time (ms), or null until the clock burst after (re)connect has finished */
export function roomNowMs(): number | null {
  const s = session;
  if (!s?.client.synced) return null;
  try {
    return activeClock(s).toRoomTime(performance.now());
  } catch {
    return null;
  }
}

export const roomActions: RoomActions & Required<Pick<RoomActions, 'clearError'>> = {
  async join({ code, name, password }) {
    const roomCode = code.trim().toUpperCase();
    const displayName = name.trim().slice(0, 40);
    if (!isValidRoomCode(roomCode)) return setError("That room code doesn't look right (6 letters/numbers).");
    if (!displayName) return setError('Enter a name for this device.');
    if (joining === roomCode) return;
    if (session) {
      if (session.code === roomCode) {
        session.engine.unlock();
        return;
      }
      roomActions.leave();
    }
    const deviceId = getDeviceId();
    useRoomStore.setState({ ...initialState(), deviceId, conn: 'connecting', demoAssets: useRoomStore.getState().demoAssets });
    const engine = new AudioEngine({
      clock: () => (session ? activeClock(session) : null),
      clockReady: () => !!session?.client.synced,
      onRouteChange: () => {
        if (session) void onRouteChange(session);
      },
      onDecoded: learnTrackInfo,
    });
    try {
      engine.unlock(); // synchronous: must stay inside the click's user activation
    } catch (e) {
      useRoomStore.setState({ conn: 'error' });
      return setError(errMsg(e));
    }
    rememberName(displayName);
    joining = roomCode;
    let caps: DeviceCaps;
    try {
      caps = await buildCaps(engine.ctx);
    } catch (e) {
      engine.dispose();
      useRoomStore.setState({ conn: 'error' });
      return setError(`Couldn't read device capabilities: ${errMsg(e)}`);
    } finally {
      joining = null;
    }

    const nowRoom = roomNowMs;
    let resolveJoin: () => void = () => {};
    const joined = new Promise<void>((r) => (resolveJoin = r));
    const client = new RoomClient({
      code: roomCode,
      deviceId,
      name: displayName,
      ...(password ? { password } : {}),
      caps: () => session?.caps ?? caps,
      onMessage: (m) => {
        handleMessage(m);
        if (m.type === 'WELCOME') resolveJoin();
      },
      onStatus: (conn) => useRoomStore.setState({ conn }),
      onSynced: (reason) => {
        session?.engine.reconcile(reason === 'resync');
        session?.remote.onRoomChanged();
      },
      onFatal: (code, msg) => {
        setError(FRIENDLY[code] ?? msg);
        resolveJoin();
      },
    });
    const link = new ClockLink({
      selfId: deviceId,
      send: (to, data) => client.send({ type: 'RTC_SIGNAL', to, data, ch: 'clock' }),
      serverClock: () => client.clock,
    });
    const s: Session = {
      code: roomCode,
      client,
      link,
      engine,
      calibration: new CalibrationController(engine, send, () => activeClock(s), (p) => roomActions.updateScene(p, { commit: true })),
      capture: new CaptureController(engine, send),
      remote: new RemoteSyncManager({ nowRoom, send, outputGain: () => engine.mix?.outputGain ?? useRoomStore.getState().room?.volume ?? 1 }),
      video: new VideoDriver(engine, nowRoom),
      history: new History<Scene>(),
      scene: mergingThrottle<ScenePatch>((p) => send({ type: 'SCENE_UPDATE', ...p }), 1000 / 30),
      // not 0: performance.now() starts near 0, so 0 would drop every SCENE in the page's first 400 ms
      lastLocalSceneEdit: -Infinity,
      autoObjectsKey: '',
      caps,
      outputLabel: caps.outputLabel,
      tunedClockPath: null,
      cleanup: [],
    };
    session = s;
    s.cleanup.push(watchOutputCalibration(s));

    s.cleanup.push(
      useRoomStore.subscribe((st, prev) => {
        if (st.room === prev.room || session !== s) return;
        s.link.setMaster(st.room ? pickClockMaster(st.room.devices, st.room.hostId) : null);
        s.engine.onRoomChanged();
        s.capture.onRoomChanged(st.room);
        s.remote.onRoomChanged();
        if (st.room) maybeAutoObjects(s, st.room);
      }),
    );
    const statsTimer = setInterval(() => sendStats(s), 2000);
    const clockTimer = setInterval(() => {
      try {
        const est = activeClock(s).estimate();
        if (est.samples > 0) useRoomStore.setState({ clock: est });
      } catch {
        /* not ready */
      }
      watchClockPath(s);
    }, 1000);
    link.start();
    s.cleanup.push(() => clearInterval(statsTimer), () => clearInterval(clockTimer), () => link.dispose());
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      s.engine.onVisible();
      s.client.resync(); // → onSynced('resync') → reconcile(true)
    };
    document.addEventListener('visibilitychange', onVisibility);
    s.cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility));

    client.connect();
    const slow = setTimeout(() => {
      if (useRoomStore.getState().conn !== 'open') setError("Can't reach the SyncSound server yet. Still trying…");
      resolveJoin();
    }, 10_000);
    s.cleanup.push(() => clearTimeout(slow));
    await joined;
    clearTimeout(slow);
  },

  leave() {
    const s = session;
    if (!s) return;
    session = null;
    for (const c of s.cleanup) {
      try {
        c();
      } catch {
        /* best effort */
      }
    }
    s.scene.cancel();
    s.calibration.dispose();
    s.capture.dispose();
    s.remote.dispose();
    s.video.attach(null);
    s.client.close();
    s.engine.dispose();
    useRoomStore.setState({ ...initialState(), deviceId: useRoomStore.getState().deviceId, demoAssets: useRoomStore.getState().demoAssets });
  },

  control(cmd) {
    sendOrWarn({ type: 'CONTROL', command: cmd });
  },

  updateScene(p, opts) {
    const s = session;
    const room = useRoomStore.getState().room;
    if (!s || !room) return;
    s.history.beginEdit(room.scene);
    const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as ScenePatch;
    const scene: Scene = { ...room.scene, ...clean };
    setRoom((r) => ({ ...r, scene }));
    s.lastLocalSceneEdit = performance.now();
    s.scene.push(clean);
    if (opts?.commit) {
      s.history.commit(scene);
      s.scene.flush();
    }
    useRoomStore.setState({ canUndo: s.history.canUndo, canRedo: s.history.canRedo });
  },

  undo() {
    const s = session;
    const room = useRoomStore.getState().room;
    if (!s || !room) return;
    const prev = s.history.undo(room.scene);
    if (prev) applyFullScene(s, prev);
  },

  redo() {
    const s = session;
    const room = useRoomStore.getState().room;
    if (!s || !room) return;
    const next = s.history.redo(room.scene);
    if (next) applyFullScene(s, next);
  },

  updateDevice(p, targetDeviceId) {
    const target = targetDeviceId ?? useRoomStore.getState().deviceId;
    setRoom((r) => ({ ...r, devices: r.devices.map((d) => (d.id === target ? { ...d, ...p } : d)) }));
    sendOrWarn({ type: 'DEVICE_UPDATE', ...(targetDeviceId ? { targetDeviceId } : {}), patch: p });
  },

  setLayout(layout) {
    const room = useRoomStore.getState().room;
    if (!room) return;
    const live = room.devices.filter((d) => d.connected);
    const roles = autoAssign(layout, live);
    for (const d of live) if (roles[d.id] && roles[d.id] !== d.role) roomActions.updateDevice({ role: roles[d.id] }, d.id);
    const devices = isRoutedLayout(layout)
      ? slotPositions(layout, roles, room.scene)
      : layout === 'party'
        ? presetLayout('party', [...live].sort((a, b) => a.joinedAt - b.joinedAt).map((d) => d.id), room.scene).devices
        : {};
    roomActions.updateScene({ layout, devices }, { commit: true });
  },

  assignSlot(deviceId, role) {
    const room = useRoomStore.getState().room;
    if (!room) return;
    roomActions.updateDevice({ role }, deviceId);
    const layout = room.scene.layout;
    if (!isRoutedLayout(layout)) return;
    // re-place everyone so devices sharing a slot fan out around it
    const roles = Object.fromEntries(room.devices.filter((d) => d.connected).map((d) => [d.id, d.id === deviceId ? role : d.role]));
    roomActions.updateScene({ devices: slotPositions(layout, roles, room.scene) }, { commit: true });
  },

  updateSettings(p) {
    setRoom((r) => {
      const { password: _pw, ...rest } = p;
      return { ...r, settings: { ...r.settings, ...rest } };
    });
    sendOrWarn({ type: 'SETTINGS_UPDATE', ...p });
  },

  identify(targetDeviceId) {
    sendOrWarn({ type: 'IDENTIFY', targetDeviceId });
  },

  async loadDemoAssets() {
    try {
      const base = serverUrl();
      const res = await fetch(`${base}/api/demo`);
      if (!res.ok) throw await httpError(res, "Couldn't load demo tracks");
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error("Couldn't load demo tracks: unexpected response.");
      const assets = body.flatMap((x) => {
        const r = DemoAsset.safeParse(x);
        return r.success ? [r.data] : [];
      });
      useRoomStore.setState({
        demoAssets: assets.map((a) => ({ ...a, ...(a.url ? { url: new URL(a.url, base).toString() } : {}) })),
      });
    } catch (e) {
      setError(e instanceof TypeError ? "Can't reach the SyncSound server to load demo tracks." : errMsg(e));
    }
  },

  queueDemo(asset) {
    if (!asset.url) return setError(`Demo "${asset.title}" has no URL. Run \`pnpm demo\` on the server.`);
    const track: Track = {
      id: newTrackId(),
      title: asset.title.slice(0, 200) || asset.file,
      kind: 'demo',
      sourceClass: 'rendered',
      url: asset.url,
      mime: asset.mime,
      durationSec: asset.durationSec,
      channels: Math.min(8, Math.max(1, asset.channels)),
      addedBy: useRoomStore.getState().deviceId,
    };
    sendOrWarn({ type: 'CONTROL', command: { type: 'queue', track } });
  },

  async uploadFile(file) {
    if (file.size > MAX_UPLOAD_BYTES) fail(`"${file.name}" is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
    if (file.type && !/^(audio|video)\//.test(file.type)) fail(`"${file.name}" isn't an audio or video file.`);
    let res: Response;
    try {
      res = await fetch(`${serverUrl()}/api/assets`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      return fail("Upload failed: can't reach the SyncSound server.");
    }
    if (!res.ok) fail((await httpError(res, 'Upload failed')).message);
    const up = UploadResponse.safeParse(await res.json().catch(() => null));
    if (!up.success) return fail('Upload failed: the server sent an unexpected response.');
    const id = newTrackId();
    let durationSec: number | undefined;
    let channels: number | undefined;
    const engine = session?.engine;
    if (engine?.ctx && file.size < 80 * 1024 * 1024) {
      try {
        const buf = await engine.decode(await file.arrayBuffer());
        durationSec = buf.duration;
        channels = Math.min(8, buf.numberOfChannels);
        engine.primeBuffer(id, buf); // no re-download for this device
      } catch {
        if (!(up.data.mime || file.type).startsWith('video/')) fail(`This browser can't decode "${file.name}" (unsupported audio format).`);
      }
    }
    const mime = up.data.mime || file.type;
    const track: Track = {
      id,
      title: (up.data.title || file.name).slice(0, 200),
      kind: mime.startsWith('video/') ? 'video' : 'file',
      sourceClass: 'rendered',
      url: up.data.url,
      mime,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(channels !== undefined ? { channels } : {}),
      addedBy: useRoomStore.getState().deviceId,
    };
    sendOrWarn({ type: 'CONTROL', command: { type: 'queue', track } });
    return track;
  },

  async queueUrl(url, title) {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return fail("That doesn't look like a valid link.");
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('Only http(s) links are supported.');
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname))
      fail("YouTube audio can't be downloaded. Play the video in a tab and use tab capture instead.");
    if (location.protocol === 'https:' && u.protocol === 'http:') fail("This page is served over HTTPS, so it can't load an http:// link.");
    let res: Response;
    try {
      res = await fetch(u, { method: 'HEAD', mode: 'cors' });
      if (res.status === 405 || res.status === 501) res = await fetch(u, { mode: 'cors', headers: { Range: 'bytes=0-1' } });
    } catch {
      return fail(
        "This link can't be read by the browser: its server doesn't allow cross-origin access (CORS). Download the file and upload it instead.",
      );
    }
    if (!res.ok) fail(`The link returned an error (HTTP ${res.status}).`);
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (/^text\/html/.test(mime)) fail('That link is a web page, not an audio or video file.');
    const name = decodeURIComponent(u.pathname.split('/').pop() ?? '') || u.hostname;
    const track: Track = {
      id: newTrackId(),
      title: (title?.trim() || name).slice(0, 200),
      kind: 'url',
      sourceClass: 'rendered',
      url: u.toString(),
      ...(mime ? { mime: mime.slice(0, 100) } : {}),
      addedBy: useRoomStore.getState().deviceId,
    };
    sendOrWarn({ type: 'CONTROL', command: { type: 'queue', track } });
    return track;
  },

  async startCalibration(opts) {
    if (!session) return setError('Join the room first.');
    // one chime per device and done: Bluetooth wobble ("±X ms") comes from the manual sync check
    await session.calibration.start(opts);
  },

  async startSyncMeasurement(durationSec = 60) {
    if (!session) return setError('Join the room first.');
    await session.calibration.measureSync(durationSec);
  },

  cancelCalibration() {
    session?.calibration.cancel();
  },

  applyPresetEq(targetDeviceId) {
    const d = useRoomStore.getState().room?.devices.find((x) => x.id === targetDeviceId);
    if (!d) return;
    try {
      roomActions.updateDevice(presetPatch(d), targetDeviceId);
    } catch (e) {
      setError(`Couldn't apply the preset EQ: ${errMsg(e)}`);
    }
  },

  setEqBypass(bypass) {
    session?.engine.setEqBypass(bypass);
  },

  setBatterySaver(on) {
    setBatterySaverFlag(on);
    patch('engine', { batterySaver: on });
  },

  setClickTest(on) {
    session?.engine.setClickTest(on);
  },

  dismissRouteChange() {
    useRoomStore.setState({ routeChanged: false, routeRestored: null });
  },

  async startCapture() {
    if (!session) return setError('Join the room first.');
    await session.capture.start();
  },

  stopCapture() {
    session?.capture.stop();
  },

  async connectSpotify() {
    const s = session;
    if (!s) return setError('Join the room first.');
    try {
      if (!s.remote.spotifySignedIn && useRoomStore.getState().remote.spotify !== 'unconfigured') await loginSpotify(); // popup opens synchronously
      await s.remote.connect('spotify');
    } catch (e) {
      patch('remote', { message: errMsg(e) });
    }
  },

  async connectApple() {
    const s = session;
    if (!s) return setError('Join the room first.');
    await s.remote.connect('apple');
  },

  queueRemote(kind, remoteId, title) {
    const id = normalizeRemoteId(kind, remoteId);
    if (!id) return setError(kind === 'spotify' ? "That doesn't look like a Spotify track link or URI." : "That doesn't look like an Apple Music song link or id.");
    const track: Track = {
      id: newTrackId(),
      title: (title?.trim() || (kind === 'spotify' ? 'Spotify track' : 'Apple Music song')).slice(0, 200),
      kind,
      sourceClass: 'remote',
      remoteId: id,
      addedBy: useRoomStore.getState().deviceId,
    };
    sendOrWarn({ type: 'CONTROL', command: { type: 'queue', track } });
  },

  attachVideo(el) {
    session?.video.attach(el);
  },

  clearError() {
    setError(null);
  },
};

installInstrumentation({
  getState: () => useRoomStore.getState(),
  clock: () => {
    try {
      return session?.client.clock.estimate() ?? null;
    } catch {
      return null;
    }
  },
  mix: () => useRoomStore.getState().mix,
  tap: () => session?.engine.readTaps() ?? null,
  liveDelay: () => session?.capture.liveDelayInfo() ?? null,
});
