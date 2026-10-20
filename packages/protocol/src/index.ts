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

export const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const Name = z.string().trim().min(1).max(40);
const finite = () => z.number().finite();

export const Vec2 = z.object({ x: finite().min(-50).max(50), y: finite().min(-50).max(50) });
export type Vec2 = z.infer<typeof Vec2>;

export const DeviceRole = z.enum(['L', 'R', 'C', 'SL', 'SR', 'Sub', 'Full']);
export type DeviceRole = z.infer<typeof DeviceRole>;

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
  /** manual fine-tune, ms, +ve = this device plays earlier */
  latencyMs: finite().min(-500).max(500),
  /** acoustic calibration result (relative output latency), ms, +ve = this device plays earlier */
  calibratedLatencyMs: finite().min(-1000).max(1000).nullable(),
  eq: DeviceEq,
  bassCapable: z.boolean(),
  rolloffHz: finite().min(10).max(2000).nullable(),
  stats: DeviceStats.nullable(),
  remote: z.object({ spotify: RemoteServiceStatus, apple: RemoteServiceStatus }),
  joinedAt: finite(),
});
export type Device = z.infer<typeof Device>;

export const ObjectChannel = z.enum(['L', 'R', 'C', 'LFE', 'SL', 'SR', 'MONO', 'AMB', 'STEM']);
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
});
export type Playback = z.infer<typeof Playback>;

export const RoomSettings = z.object({
  hostOnlyControl: z.boolean(),
  hasPassword: z.boolean(),
  /** capture-mode target playout buffer, ms */
  videoBufferMs: finite().min(40).max(1000),
  /** lip-sync nudge, ms (+ve = audio later) */
  lipSyncNudgeMs: finite().min(-300).max(300),
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

export const CalibrationSignal = z.enum(['chirp', 'sweep', 'noise', 'click']);
export type CalibrationSignal = z.infer<typeof CalibrationSignal>;

export const CalibrationSlot = z.object({
  deviceId: Id,
  /** index used to derive the device-unique chirp band */
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
});
export type CalibrationPlan = z.infer<typeof CalibrationPlan>;

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
    calibratedLatencyMs: Device.shape.calibratedLatencyMs,
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
});
export type SceneUpdate = z.infer<typeof SceneUpdate>;

export const CalibrationDeviceResult = z.object({
  deviceId: Id,
  heard: z.boolean(),
  calibratedLatencyMs: Device.shape.calibratedLatencyMs.optional(),
  eq: DeviceEq.optional(),
  rolloffHz: Device.shape.rolloffHz.optional(),
  bassCapable: z.boolean().optional(),
  trimDb: Device.shape.trimDb.optional(),
  levelDb: finite().optional(),
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
    password: z.string().max(100).nullable().optional(),
  }),
  z.object({ type: z.literal('STATS'), stats: DeviceStats }),
  /** sent by the listening device: request a calibration run; server assigns id + startRoomTime and broadcasts */
  z.object({
    type: z.literal('CALIBRATION_START'),
    slots: z.array(CalibrationSlot).min(1).max(256),
    purpose: CalibrationPlan.shape.purpose,
  }),
  z.object({
    type: z.literal('CALIBRATION_RESULT'),
    planId: Id,
    results: z.array(CalibrationDeviceResult).max(64),
  }),
  z.object({ type: z.literal('IDENTIFY'), targetDeviceId: Id }),
  z.object({ type: z.literal('CAPTURE'), active: z.boolean() }),
  z.object({ type: z.literal('RTC_SIGNAL'), to: Id, data: RtcData }),
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
  }),
  z.object({ type: z.literal('SCENE'), scene: Scene }),
  z.object({ type: z.literal('DEVICE_LIST'), devices: z.array(Device) }),
  z.object({ type: z.literal('CALIBRATION_PLAN'), plan: CalibrationPlan }),
  z.object({ type: z.literal('IDENTIFY'), targetDeviceId: Id, startRoomTime: finite() }),
  z.object({ type: z.literal('RTC_SIGNAL'), from: Id, data: RtcData }),
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
// GET  /assets/:id           asset bytes (Range supported)
// GET  /api/demo             → DemoAsset[] (with absolute url added)
// GET  /health               → { ok: true }

export const CreateRoomRequest = z.object({ password: z.string().max(100).optional() });
export const CreateRoomResponse = z.object({ code: RoomCode, hostKey: z.string() });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;
export const RoomInfoResponse = z.object({ exists: z.boolean(), hasPassword: z.boolean() });
export type RoomInfoResponse = z.infer<typeof RoomInfoResponse>;
export const UploadResponse = z.object({
  id: Id,
  url: z.string().url(),
  title: z.string(),
  mime: z.string(),
  size: z.number().int(),
});
export type UploadResponse = z.infer<typeof UploadResponse>;
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

// ---------- defaults / constants ----------

export const SERVER_PORT_DEFAULT = 8787;
/** every scheduled action must be at least max(device RTT) + this far in the future */
export const SCHEDULE_SAFETY_MARGIN_MS = 150;
export const MIN_SCHEDULE_LEAD_MS = 250;
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
