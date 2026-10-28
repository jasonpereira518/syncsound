/**
 * SyncSound wire protocol. Every WebSocket message is JSON validated by these schemas.
 *
 * Units (do not mix):
 *  - room/server/local clock times: milliseconds (float). Room time = server `performance.timeOrigin + performance.now()`.
 *  - track positions/offsets (`trackOffset`, `position`): seconds.
 *  - room coordinates: meters. x → right, y → back of room (front stage is negative y). Origin = room centre.
 */
import { z } from 'zod';

// ---------- primitives ----------

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const RoomCode = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`));
export const isValidRoomCode = (s: string) => RoomCode.safeParse(s).success;
/** manual latency slider range, ±ms (same span as the calibrated offset) */
export const MAX_MANUAL_LATENCY_MS = 1000;

export const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const Name = z.string().trim().min(1).max(40);
const finite = () => z.number().finite();
/** longest crossfade between tracks, s (room setting and the per-playback value derived from it) */
export const MAX_CROSSFADE_SEC = 12;

export const Vec2 = z.object({ x: finite().min(-50).max(50), y: finite().min(-50).max(50) });
export type Vec2 = z.infer<typeof Vec2>;

/** a device's slot in the room layout; 'Full' = unassigned (custom/party layouts pan by position instead) */
export const DeviceRole = z.enum(['L', 'R', 'C', 'SL', 'SR', 'RL', 'RR', 'Sub', 'Full']);
export type DeviceRole = z.infer<typeof DeviceRole>;

/**
 * Speaker layout. Standard layouts route each content channel to the device(s) in its slot (device.role);
 * 'party' and 'custom' pan every object by position (DBAP). A Sub slot can be added to any layout (→ "x.1").
 */
export const LayoutId = z.enum(['mono', 'stereo', 'lcr', 'quad', 'surround5', 'surround7', 'party', 'custom']);
export type LayoutId = z.infer<typeof LayoutId>;

export const DeviceClass = z.enum(['phone', 'tablet', 'laptop', 'desktop', 'bluetooth', 'unknown']);
export type DeviceClass = z.infer<typeof DeviceClass>;

export const EqBand = z.object({
  type: z.enum(['peaking', 'lowshelf', 'highshelf', 'highpass', 'lowpass']),
  freq: finite().min(10).max(24000),
  gainDb: finite().min(-24).max(12),
  q: finite().min(0.1).max(20),
});
export type EqBand = z.infer<typeof EqBand>;

export const DeviceEq = z.object({
  enabled: z.boolean(),
  bands: z.array(EqBand).max(10),
  /** protective high-pass for small speakers (null = none) */
  highpassHz: finite().min(10).max(1000).nullable(),
  preampDb: finite().min(-24).max(6),
  source: z.enum(['none', 'measured', 'preset']),
});
export type DeviceEq = z.infer<typeof DeviceEq>;

export const DeviceCaps = z.object({
  userAgent: z.string().max(400),
  platform: z.string().max(80),
  deviceClass: DeviceClass,
  sampleRate: finite().min(8000).max(192000),
  baseLatencyMs: finite().nullable(),
  outputLatencyMs: finite().nullable(),
  hasOutputTimestamp: z.boolean(),
  hasMic: z.boolean(),
  outputLabel: z.string().max(120).optional(),
  /** the browser's microphone permission for this page (asked at join; absent on older tabs) */
  micPermission: z.enum(['granted', 'prompt', 'denied', 'unknown']).optional(),
});
export type DeviceCaps = z.infer<typeof DeviceCaps>;

export const BufferState = z.enum(['idle', 'loading', 'ready', 'playing', 'error']);
export type BufferState = z.infer<typeof BufferState>;

export const DeviceStats = z.object({
  offsetMs: finite(),
  rttMs: finite(),
  jitterMs: finite(),
  driftPpm: finite(),
  /** estimated |playback position error| vs the room timeline, ms */
  syncErrorMs: finite(),
  bufferState: BufferState,
  loadedTrackId: z.string().max(64).nullable(),
  /** Class B (Spotify/Apple) measured position error, ms */
  remoteErrorMs: finite().nullable(),
  autoLatencyMs: finite().nullable(),
  battery: finite().min(0).max(1).nullable(),
});
export type DeviceStats = z.infer<typeof DeviceStats>;

export const RemoteServiceStatus = z.enum(['unconfigured', 'signed-out', 'ready', 'needs-premium', 'error']);
export type RemoteServiceStatus = z.infer<typeof RemoteServiceStatus>;

export const Device = z.object({
  id: Id,
  name: Name,
  role: DeviceRole,
  isHost: z.boolean(),
  connected: z.boolean(),
  caps: DeviceCaps,
  /** linear 0..1 per-device volume */
  volume: finite().min(0).max(1),
  trimDb: finite().min(-24).max(12),
  muted: z.boolean(),
  solo: z.boolean(),
  /** manual fine-tune, ms, +ve = this device plays earlier (slow Bluetooth speakers can need > 500 ms) */
  latencyMs: finite().min(-MAX_MANUAL_LATENCY_MS).max(MAX_MANUAL_LATENCY_MS),
  /**
   * Output compensation from the latest tune, ms, +ve = this device plays earlier. SERVER-DERIVED from
   * `tuneArrivalMs` and the current scene positions (see `deriveCalibratedLatency`): clients never set it.
   */
  calibratedLatencyMs: finite().min(-1000).max(1000).nullable(),
  /**
   * The tune's invariant for this device: its chime's arrival at the listener's mic minus its scheduled time,
   * relative to the earliest device of that run, ms. Geometry-free; the compensation is derived from it whenever
   * positions change. Null until heard by a tune.
   */
  tuneArrivalMs: finite().min(0).max(5000).nullable(),
  /** the run (`scene.tune.id`) that measured `tuneArrivalMs`; a value from another run is not used for timing */
  tuneId: Id.nullable(),
  /** this device reported that its timing may be off since the tune: a new output route, a clock-path change, an audio-output step */
  tuneStale: z.enum(['route', 'clock', 'output']).nullable(),
  /** server-derived: in the room's current tune and steady; in it but flagged stale; or not in it */
  syncState: z.enum(['tuned', 'stale', 'untuned']),
  eq: DeviceEq,
  bassCapable: z.boolean(),
  rolloffHz: finite().min(10).max(2000).nullable(),
  stats: DeviceStats.nullable(),
  remote: z.object({ spotify: RemoteServiceStatus, apple: RemoteServiceStatus }),
  joinedAt: finite(),
  /** last calibration: this device is this many dB too quiet; raise its own volume and re-tune (null/absent = fine) */
  volumeUpDb: finite().min(0).max(60).nullable().optional(),
});
export type Device = z.infer<typeof Device>;

export const ObjectChannel = z.enum(['L', 'R', 'C', 'LFE', 'SL', 'SR', 'RL', 'RR', 'MONO', 'AMB', 'STEM']);
export type ObjectChannel = z.infer<typeof ObjectChannel>;

export const AudioObject = z.object({
  id: Id,
  label: z.string().min(1).max(40),
  channel: ObjectChannel,
  position: Vec2,
  gainDb: finite().min(-60).max(12),
  muted: z.boolean(),
});
export type AudioObject = z.infer<typeof AudioObject>;

/** the room's latest tune: where the listener's mic was, so each device's compensation can be re-derived from its arrival */
export const TuneRef = z.object({
  id: Id,
  listenerId: Id,
  /** the tuning device's mic (its position at the time) */
  mic: Vec2,
  /** room time of the run */
  at: finite(),
  /** timing only (positions, levels and EQ untouched) */
  quick: z.boolean(),
  /** devices whose positions were measured by ranging in this run (layout edits keep them where they are) */
  ranged: z.array(Id).max(64),
  /** where each heard device was when its arrival was measured (the compensation tracks later picture edits) */
  positions: z.record(z.string(), Vec2),
});
export type TuneRef = z.infer<typeof TuneRef>;

export const SceneMotion = z.object({
  periodSec: finite().min(1).max(120),
  startRoomTime: finite(),
});
export type SceneMotion = z.infer<typeof SceneMotion>;

export const Scene = z.object({
  room: z.object({ width: finite().min(1).max(100), depth: finite().min(1).max(100) }),
  objects: z.array(AudioObject).max(32),
  /** device positions keyed by device id */
  devices: z.record(z.string(), Vec2),
  listener: Vec2,
  /** delay nearer speakers so all arrive at the listener together */
  propagationComp: z.boolean(),
  /** DBAP rolloff exponent a (1 = 6 dB per distance doubling) */
  rolloff: finite().min(0.1).max(4),
  /** DBAP spatial blur, meters */
  blur: finite().min(0.01).max(5),
  crossoverHz: finite().min(40).max(250),
  /** stereo → surround upmix for 2-channel sources */
  upmix: z.boolean(),
  /** absent = 'custom' (scenes saved before layouts existed) */
  layout: LayoutId.optional(),
  /** set by the server from CALIBRATION_RESULT; never by SCENE_UPDATE */
  tune: TuneRef.optional(),
  /** 8D: the whole mix circles the listener, one lap per periodSec, angle 0 at startRoomTime; null/absent = still */
  motion: SceneMotion.nullable().optional(),
});
export type Scene = z.infer<typeof Scene>;

export const TrackKind = z.enum(['demo', 'file', 'url', 'video', 'capture', 'youtube', 'spotify', 'apple']);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z.object({
  id: Id,
  title: z.string().min(1).max(200),
  kind: TrackKind,
  /** rendered = decoded into Web Audio (Class A); remote = SDK-owned audio path (Class B, sync-only) */
  sourceClass: z.enum(['rendered', 'remote']),
  /** http(s) URL of the asset for file/url/demo/video */
  url: z.string().url().max(2000).optional(),
  mime: z.string().max(100).optional(),
  durationSec: finite().min(0).optional(),
  channels: z.number().int().min(1).max(8).optional(),
  /** spotify:track:… or Apple Music catalog song id */
  remoteId: z.string().max(200).optional(),
  youtubeId: z.string().max(20).optional(),
  addedBy: z.string().max(64).optional(),
});
export type Track = z.infer<typeof Track>;

export const Playback = z.object({
  status: z.enum(['stopped', 'playing', 'paused']),
  trackId: z.string().nullable(),
  /** room ms at which `trackOffset` is (was) heard; meaningful while playing */
  startRoomTime: finite(),
  /** seconds into the track at startRoomTime (or the paused position) */
  trackOffset: finite().min(0),
  /**
   * set when the server advanced to this track at the end of the previous one: the previous track ends
   * `crossfadeSec` after startRoomTime (0 = gapless join); absent for user-started playback
   */
  crossfadeSec: finite().min(0).max(MAX_CROSSFADE_SEC).optional(),
});
export type Playback = z.infer<typeof Playback>;

export const RoomSettings = z.object({
  hostOnlyControl: z.boolean(),
  hasPassword: z.boolean(),
  /** capture-mode target playout buffer, ms */
  videoBufferMs: finite().min(40).max(1000),
  /** lip-sync nudge, ms (+ve = audio later) */
  lipSyncNudgeMs: finite().min(-300).max(300),
  /** blend each track into the next over this many seconds at its end; 0 = gapless */
  crossfadeSec: finite().min(0).max(MAX_CROSSFADE_SEC),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const RoomState = z.object({
  code: RoomCode,
  hostId: z.string().nullable(),
  createdAt: finite(),
  settings: RoomSettings,
  devices: z.array(Device),
  scene: Scene,
  queue: z.array(Track).max(200),
  playback: Playback,
  /** master volume 0..1 */
  volume: finite().min(0).max(1),
  /** device currently capturing tab audio (capture mode), if any */
  captureHostId: z.string().nullable(),
});
export type RoomState = z.infer<typeof RoomState>;

// ---------- calibration ----------

/** tune: the tune's swoosh → chime (current); sweep: the plain sweep of older tunes */
export const CalibrationSignal = z.enum(['chirp', 'sweep', 'noise', 'click', 'tune']);
export type CalibrationSignal = z.infer<typeof CalibrationSignal>;

export const CalibrationSlot = z.object({
  deviceId: Id,
  /** device's index in the plan (seeds per-device signals) */
  deviceIndex: z.number().int().min(0).max(63),
  signal: CalibrationSignal,
  /** ms after plan.startRoomTime */
  offsetMs: finite().min(0).max(600000),
  durationMs: finite().min(1).max(20000),
  /** repeat the signal this many times (sync measurement), every periodMs */
  repeat: z.number().int().min(1).max(600).optional(),
  periodMs: finite().min(100).max(10000).optional(),
});
export type CalibrationSlot = z.infer<typeof CalibrationSlot>;

export const CalibrationPlan = z.object({
  id: Id,
  listenerId: Id,
  startRoomTime: finite(),
  slots: z.array(CalibrationSlot).max(256),
  /** calibrate = measure latency/response/level and apply; measure = sync-measurement run (full compensation, no changes) */
  purpose: z.enum(['calibrate', 'measure']).optional(),
  /** who records: only the listener (default), or every device with a mic (ranging: distances between devices) */
  recorders: z.enum(['listener', 'all']).optional(),
});
export type CalibrationPlan = z.infer<typeof CalibrationPlan>;

/** One recorder's measurement of one emitter's tune signal. */
export const CalibrationRow = z.object({
  emitterId: Id,
  /** arrival (on the recorder's room clock) − scheduled emission, ms; null = not heard */
  mMs: finite().min(-10000).max(10000).nullable(),
  /** loudness of the measured response (K-weighted power mean, 200 Hz–8 kHz), dB (relative: includes this recorder's mic gain) */
  levelDb: finite().min(-400).max(200).nullable(),
  /** direct-path level (no room reverb), dB, same relative scale (co-location test) */
  directDb: finite().min(-400).max(200).nullable(),
  /** best match's envelope peak / median, dB, also when below the "heard" gate (diagnostics) */
  snrDb: finite().min(-100).max(400).nullable(),
  clipped: z.boolean(),
});
export type CalibrationRow = z.infer<typeof CalibrationRow>;
/** a recorder's rows; valid = false: its clocks moved mid-run (rows unusable), reason says why */
const CalibrationRows = {
  planId: Id,
  rows: z.array(CalibrationRow).max(64),
  valid: z.boolean(),
  reason: z.string().max(200).optional(),
  /** the recorder plays through Bluetooth: its speaker isn't at its mic, so it is never ranged */
  outputBluetooth: z.boolean().optional(),
  /** this device's own emissions were timed on a steady clock (its clock path, room clock and audio output did
   * not move while it played); absent = yes. False: the listener leaves its timing out of the result. */
  emissionValid: z.boolean().optional(),
};

// ---------- WebRTC signaling ----------

export const RtcData = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().max(20000) }),
  z.object({ kind: z.literal('answer'), sdp: z.string().max(20000) }),
  z.object({
    kind: z.literal('ice'),
    candidate: z.string().max(2000),
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal('hangup') }),
]);
export type RtcData = z.infer<typeof RtcData>;
/** which peer connection a signal belongs to: capture audio (default) or the LAN clock-master DataChannel */
export const RtcChannel = z.enum(['capture', 'clock']);
export type RtcChannel = z.infer<typeof RtcChannel>;

// ---------- client → server ----------

export const DevicePatch = z
  .object({
    name: Name,
    role: DeviceRole,
    volume: Device.shape.volume,
    trimDb: Device.shape.trimDb,
    muted: z.boolean(),
    solo: z.boolean(),
    latencyMs: Device.shape.latencyMs,
    tuneArrivalMs: Device.shape.tuneArrivalMs,
    tuneId: Device.shape.tuneId,
    tuneStale: Device.shape.tuneStale,
    eq: DeviceEq,
    bassCapable: z.boolean(),
    rolloffHz: Device.shape.rolloffHz,
    remote: Device.shape.remote,
  })
  .partial();
export type DevicePatch = z.infer<typeof DevicePatch>;

export const ControlCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play'), trackId: z.string().optional(), position: finite().min(0).optional() }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('seek'), position: finite().min(0) }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('previous') }),
  z.object({ type: z.literal('queue'), track: Track }),
  z.object({ type: z.literal('remove'), trackId: z.string() }),
  z.object({ type: z.literal('volume'), volume: finite().min(0).max(1) }),
]);
export type ControlCommand = z.infer<typeof ControlCommand>;

export const SceneUpdate = z.object({
  type: z.literal('SCENE_UPDATE'),
  objects: Scene.shape.objects.optional(),
  devices: Scene.shape.devices.optional(),
  listener: Vec2.optional(),
  room: Scene.shape.room.optional(),
  propagationComp: z.boolean().optional(),
  rolloff: Scene.shape.rolloff.optional(),
  blur: Scene.shape.blur.optional(),
  crossoverHz: Scene.shape.crossoverHz.optional(),
  upmix: z.boolean().optional(),
  layout: LayoutId.optional(),
  motion: Scene.shape.motion,
});
export type SceneUpdate = z.infer<typeof SceneUpdate>;

export const CalibrationDeviceResult = z.object({
  deviceId: Id,
  heard: z.boolean(),
  /** the device's arrival invariant (see Device.tuneArrivalMs); absent = not timed by this run */
  tuneArrivalMs: finite().min(0).max(5000).optional(),
  eq: DeviceEq.optional(),
  rolloffHz: Device.shape.rolloffHz.optional(),
  bassCapable: z.boolean().optional(),
  trimDb: Device.shape.trimDb.optional(),
  levelDb: finite().optional(),
  volumeUpDb: Device.shape.volumeUpDb,
});
export type CalibrationDeviceResult = z.infer<typeof CalibrationDeviceResult>;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('JOIN'),
    roomCode: RoomCode,
    deviceId: Id,
    name: Name,
    caps: DeviceCaps,
    password: z.string().max(100).optional(),
    hostKey: z.string().max(100).optional(),
  }),
  z.object({ type: z.literal('PING'), t0: finite() }),
  z.object({ type: z.literal('CONTROL'), command: ControlCommand }),
  SceneUpdate,
  /** targetDeviceId defaults to the sender; changing other devices requires host (or open control) */
  z.object({ type: z.literal('DEVICE_UPDATE'), targetDeviceId: Id.optional(), patch: DevicePatch }),
  z.object({
    type: z.literal('SETTINGS_UPDATE'),
    hostOnlyControl: z.boolean().optional(),
    videoBufferMs: RoomSettings.shape.videoBufferMs.optional(),
    lipSyncNudgeMs: RoomSettings.shape.lipSyncNudgeMs.optional(),
    crossfadeSec: RoomSettings.shape.crossfadeSec.optional(),
    password: z.string().max(100).nullable().optional(),
  }),
  z.object({ type: z.literal('STATS'), stats: DeviceStats }),
  /** sent by the listening device: request a calibration run; server assigns id + startRoomTime and broadcasts */
  z.object({
    type: z.literal('CALIBRATION_START'),
    slots: z.array(CalibrationSlot).min(1).max(256),
    purpose: CalibrationPlan.shape.purpose,
    recorders: CalibrationPlan.shape.recorders,
    /** all-recorders runs: ask every recorder to open its mic first (CALIBRATION_PREPARE → READY), then plan */
    prepare: z.boolean().optional(),
  }),
  /** a recorder answering CALIBRATION_PREPARE: its mic is open and settled (or why not) */
  z.object({ type: z.literal('CALIBRATION_READY'), planId: Id, ok: z.boolean(), reason: z.string().max(200).optional() }),
  /** this device's capabilities changed (the mic permission was answered, the output label became readable) */
  z.object({ type: z.literal('CAPS_UPDATE'), caps: DeviceCaps }),
  /** every recorder of an all-recorders plan → the server forwards them to the plan's listener */
  z.object({ type: z.literal('CALIBRATION_ROWS'), ...CalibrationRows }),
  z.object({
    type: z.literal('CALIBRATION_RESULT'),
    planId: Id,
    results: z.array(CalibrationDeviceResult).max(64),
    /** the run itself: the listener's mic position, whether it was timing-only, which devices were ranged, where they were */
    tune: z.object({ mic: Vec2, quick: z.boolean(), ranged: z.array(Id).max(64), positions: z.record(z.string(), Vec2) }),
  }),
  /** the listener gave up on its run: every device stops playing / recording for it */
  z.object({ type: z.literal('CALIBRATION_CANCEL'), planId: Id }),
  z.object({ type: z.literal('IDENTIFY'), targetDeviceId: Id }),
  z.object({ type: z.literal('CAPTURE'), active: z.boolean() }),
  z.object({ type: z.literal('RTC_SIGNAL'), to: Id, data: RtcData, ch: RtcChannel.optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- server → client ----------

export const ScheduleAction = z.enum(['play', 'pause', 'seek', 'stop']);
export type ScheduleAction = z.infer<typeof ScheduleAction>;

export const ServerMessageBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('WELCOME'),
    deviceId: Id,
    isHost: z.boolean(),
    roomState: RoomState,
    serverTime: finite(),
  }),
  z.object({ type: z.literal('STATE'), roomState: RoomState, serverTime: finite() }),
  z.object({ type: z.literal('PONG'), t0: finite(), ts_recv: finite(), ts_send: finite() }),
  z.object({
    type: z.literal('SCHEDULE'),
    action: ScheduleAction,
    startRoomTime: finite(),
    trackOffset: finite().min(0),
    trackId: z.string().nullable(),
    /** auto-advance: the previous track ends this many seconds after startRoomTime (0 = gapless) */
    crossfadeSec: Playback.shape.crossfadeSec,
  }),
  z.object({ type: z.literal('SCENE'), scene: Scene }),
  z.object({ type: z.literal('DEVICE_LIST'), devices: z.array(Device) }),
  z.object({ type: z.literal('CALIBRATION_PLAN'), plan: CalibrationPlan }),
  /** a run is about to start: the named recorders open their mics now and answer CALIBRATION_READY by the deadline */
  z.object({ type: z.literal('CALIBRATION_PREPARE'), planId: Id, listenerId: Id, recorderIds: z.array(Id).max(64), deadlineRoomTime: finite() }),
  /** forwarded to the run's listener: a recorder answered */
  z.object({ type: z.literal('CALIBRATION_READY'), planId: Id, recorderId: Id, ok: z.boolean(), reason: z.string().max(200).optional() }),
  z.object({ type: z.literal('CALIBRATION_ROWS'), recorderId: Id, ...CalibrationRows }),
  z.object({ type: z.literal('CALIBRATION_CANCELLED'), planId: Id }),
  z.object({ type: z.literal('IDENTIFY'), targetDeviceId: Id, startRoomTime: finite() }),
  z.object({ type: z.literal('RTC_SIGNAL'), from: Id, data: RtcData, ch: RtcChannel.optional() }),
  z.object({ type: z.literal('ERROR'), code: z.string().max(64), msg: z.string().max(500) }),
]);
export type ServerMessageBody = z.infer<typeof ServerMessageBody>;

export const ServerMessage = z.intersection(ServerMessageBody, z.object({ seq: z.number().int().min(0) }));
export type ServerMessage = ServerMessageBody & { seq: number };

export function parseClientMessage(raw: unknown) {
  return ClientMessage.safeParse(raw);
}
export function parseServerMessage(raw: unknown) {
  return ServerMessage.safeParse(raw);
}

// ---------- HTTP API ----------
// POST /api/rooms            CreateRoomRequest → CreateRoomResponse
// GET  /api/rooms/:code      → RoomInfoResponse
// POST /api/assets           raw body, headers content-type + x-filename → UploadResponse
// POST /api/assets/init      UploadInitRequest → UploadInitResponse (404 unless the server has bucket storage)
// POST /api/assets/:id/complete  UploadInitRequest → UploadResponse (verifies the object the browser PUT)
// GET  /assets/:id           asset bytes (Range supported)
// GET  /api/demo             → DemoAsset[] (with absolute url added)
// GET  /health               → { ok: true }

export const CreateRoomRequest = z.object({ password: z.string().max(100).optional() });
export const CreateRoomResponse = z.object({ code: RoomCode, hostKey: z.string() });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;
/** name: set for rooms saved in a home (never the home id: that link is a capability, a room code isn't) */
export const RoomInfoResponse = z.object({ exists: z.boolean(), hasPassword: z.boolean(), name: Name.optional() });
export type RoomInfoResponse = z.infer<typeof RoomInfoResponse>;
export const UploadResponse = z.object({
  id: Id,
  url: z.string().url(),
  title: z.string(),
  mime: z.string(),
  size: z.number().int(),
});
export type UploadResponse = z.infer<typeof UploadResponse>;
/** direct-to-bucket upload: init → browser PUTs `uploadUrl` with content-type `mime` → complete (same body) */
export const UploadInitRequest = z.object({
  filename: z.string().min(1).max(300),
  mime: z.string().max(100),
  size: z.number().int().positive(),
});
export type UploadInitRequest = z.infer<typeof UploadInitRequest>;
export const UploadInitResponse = z.object({ id: Id, uploadUrl: z.string().url(), mime: z.string() });
export type UploadInitResponse = z.infer<typeof UploadInitResponse>;
export const DemoAsset = z.object({
  id: Id,
  title: z.string(),
  file: z.string(),
  channels: z.number().int(),
  durationSec: z.number(),
  mime: z.string(),
  url: z.string().optional(),
});
export type DemoAsset = z.infer<typeof DemoAsset>;

// ---------- Home API (persistent home of rooms; no accounts) ----------
// The home id is a capability link (anyone with it can see the rooms and join them by code). The owner key,
// sent as the `x-owner-key` header (and as JOIN.hostKey to be host in a home room), grants changes.
// HTTP rather than WS: a joined socket only accepts room-sequenced messages, and the home page joins no room.
// POST   /api/homes                         → HomeCreateResponse
// GET    /api/homes/:homeId                 → HomeView
// POST   /api/homes/:homeId/rooms           HomeRoomRequest → HomeRoom            (owner)
// PATCH  /api/homes/:homeId/rooms/:roomId   HomeRoomRequest → HomeRoom            (owner)
// DELETE /api/homes/:homeId/rooms/:roomId   → 204                                 (owner)
// POST   /api/homes/:homeId/group           HomeGroupRequest → HomeGroupResponse  (owner)

export const OWNER_KEY_HEADER = 'x-owner-key';
export const MAX_HOME_ROOMS = 16;

export const HomeCreateResponse = z.object({ homeId: Id, ownerKey: z.string() });
export type HomeCreateResponse = z.infer<typeof HomeCreateResponse>;
export const HomeRoom = z.object({ id: RoomCode, name: Name });
export type HomeRoom = z.infer<typeof HomeRoom>;
export const HomeView = z.object({
  id: Id,
  rooms: z.array(HomeRoom.extend({ connected: z.number().int().min(0) })),
});
export type HomeView = z.infer<typeof HomeView>;
export const HomeRoomRequest = z.object({ name: Name });
export type HomeRoomRequest = z.infer<typeof HomeRoomRequest>;
/** one transport command to several rooms: every room gets a SCHEDULE with the same startRoomTime */
export const HomeGroupRequest = z.object({
  roomIds: z.array(RoomCode).min(1).max(MAX_HOME_ROOMS),
  command: ControlCommand,
});
export type HomeGroupRequest = z.infer<typeof HomeGroupRequest>;
export const HomeGroupResponse = z.object({
  startRoomTime: finite(),
  /** room id → error code for rooms that rejected the command (e.g. unknown_track) */
  errors: z.record(z.string(), z.string()),
});
export type HomeGroupResponse = z.infer<typeof HomeGroupResponse>;

// ---------- defaults / constants ----------

export const SERVER_PORT_DEFAULT = 8787;
/** every scheduled action must be at least max(device RTT) + this far in the future */
export const SCHEDULE_SAFETY_MARGIN_MS = 150;
/** a prepared tune waits this long for every recorder's CALIBRATION_READY before planning without the stragglers, ms */
export const CALIBRATION_PREPARE_DEADLINE_MS = 8000;

export const MIN_SCHEDULE_LEAD_MS = 250;
/** auto-advance SCHEDULEs are sent this much earlier than the lead requires (lead may grow before it fires) */
export const AUTO_ADVANCE_MARGIN_MS = 300;
/** at the end of the queue the stop is scheduled this far past the last track's end (its source has ended by then) */
export const QUEUE_END_STOP_MS = 100;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export const defaultEq = (): DeviceEq => ({
  enabled: true,
  bands: [],
  highpassHz: null,
  preampDb: 0,
  source: 'none',
});

export const defaultSettings = (): RoomSettings => ({
  hostOnlyControl: false,
  hasPassword: false,
  videoBufferMs: 150,
  lipSyncNudgeMs: 0,
  crossfadeSec: 0,
});

export const defaultScene = (): Scene => ({
  room: { width: 8, depth: 6 },
  objects: [
    { id: 'obj-L', label: 'Left', channel: 'L', position: { x: -2, y: -1.5 }, gainDb: 0, muted: false },
    { id: 'obj-R', label: 'Right', channel: 'R', position: { x: 2, y: -1.5 }, gainDb: 0, muted: false },
  ],
  devices: {},
  listener: { x: 0, y: 1 },
  propagationComp: true,
  rolloff: 1,
  blur: 0.5,
  crossoverHz: 100,
  upmix: false,
});
