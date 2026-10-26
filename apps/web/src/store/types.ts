/**
 * Contract between the client engine (src/lib, src/store) and the UI (src/app, src/components).
 * UI reads state via `useRoomStore(selector)` and calls `roomActions.*`.
 */
import type {
  BufferState,
  ControlCommand,
  DemoAsset,
  DevicePatch,
  DeviceRole,
  LayoutId,
  RemoteServiceStatus,
  RoomSettings,
  RoomState,
  Scene,
  SceneUpdate,
  Track,
} from '@syncsound/protocol';
import type { DeviceMix } from '@syncsound/audio-core';
import type { HostPlayback } from '../lib/engine/capturePolicy';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

export interface ClockStats {
  offsetMs: number;
  rttMs: number;
  jitterMs: number;
  driftPpm: number;
  samples: number;
  converged: boolean;
}

export interface EngineStats {
  unlocked: boolean;
  ctxState: 'none' | 'suspended' | 'running' | 'closed' | 'interrupted';
  sampleRate: number | null;
  /** browser-reported output latency (baseLatency+outputLatency or outputTimestamp-derived), ms */
  autoLatencyMs: number | null;
  /** true when the roomTime→ctx mapping uses getOutputTimestamp (latency already included) */
  usingOutputTimestamp: boolean;
  bufferState: BufferState;
  loadedTrackId: string | null;
  /** latest |actual − expected| position error, ms */
  syncErrorMs: number;
  playbackRate: number;
  corrections: { rate: number; reschedule: number };
  /** total start compensation currently applied, ms */
  compensationMs: number;
  eqBypassed: boolean;
  clickTest: boolean;
  wakeLock: boolean;
  /** battery-friendly mode: slower pings/drift loop/stats once synced (this device only) */
  batterySaver: boolean;
}

export type CalibrationStep = 'idle' | 'place' | 'mic' | 'recording' | 'analyzing' | 'done' | 'error';

export interface CalibrationDeviceUi {
  deviceId: string;
  heard: boolean;
  relativeLatencyMs: number | null;
  snrDb: number | null;
  levelDb: number | null;
  rolloffHz: number | null;
  /** distance to the tuning device's mic, m (null = no position) */
  distanceM: number | null;
  /** position measured this run (false = placed by hand) */
  ranged: boolean;
  /** response curves for plotting (shared freq grid in CalibrationUi.freqs) */
  beforeDb: number[] | null;
  afterDb: number[] | null;
}

export interface CalibrationUi {
  /** true when this device is the listening device running the wizard */
  running: boolean;
  step: CalibrationStep;
  progress: number; // 0..1
  message: string;
  freqs: number[] | null;
  targetDb: number[] | null;
  devices: CalibrationDeviceUi[];
  warnings: string[];
  /** a calibration / sync-check plan is playing on this device (any role) */
  emitting: boolean;
  /** device whose tune chime is playing right now (every device shows it), or null */
  nowPlaying: string | null;
}

export interface SyncMeasureDeviceUi {
  deviceId: string;
  detected: number;
  total: number;
  /** mean / std / p95|·| / max|·| inter-device error, ms (single device: click jitter around its mean) */
  meanMs: number;
  stdMs: number;
  p95AbsMs: number;
  maxAbsMs: number;
}

/** Sync-measurement tool (listener records every device's synchronized clicks for ~60 s) */
export interface SyncMeasureUi {
  running: boolean;
  step: 'idle' | 'recording' | 'analyzing' | 'done' | 'error';
  progress: number;
  message: string;
  durationSec: number;
  devices: SyncMeasureDeviceUi[];
  histogram: { edgesMs: number[]; counts: number[] } | null;
  overall: { p50AbsMs: number; p95AbsMs: number; maxAbsMs: number; samples: number } | null;
  warnings: string[];
}

export interface CaptureUi {
  /** this device is capturing tab/system audio and sending it */
  active: boolean;
  /** this device is receiving a capture stream */
  receiving: boolean;
  /** captured stream has been silent for > 3 s (likely DRM) */
  silent: boolean;
  error: string | null;
  peers: number;
  /** estimated network+jitter-buffer delay of the received stream (median-filtered), ms */
  pipelineDelayMs: number | null;
  /** what the host shared: 'browser' (a tab), 'window', 'monitor' (whole screen) */
  surface: string | null;
  /** the host plays the stream through its own chain (only for a shared tab: anything else could loop back) */
  monitoring: boolean;
  hostPlayback: HostPlayback | null;
  /** receiver's WebRTC jitter-buffer target, ms */
  jitterTargetMs: number | null;
  /** alignment delay currently applied to the output chain, ms */
  appliedDelayMs: number | null;
  /** how many times the alignment delay was switched (rare after the first) */
  delayChanges: number;
  /** ms this device plays late because its output latency doesn't fit the stream buffer (null = fits) */
  shortfallMs: number | null;
}

export interface RemoteUi {
  spotify: RemoteServiceStatus;
  apple: RemoteServiceStatus;
  /** latest measured position error of the Class B player, ms */
  errorMs: number | null;
  meanAbsErrorMs: number | null;
  seeks: number;
  message: string | null;
}

export interface RoomStoreState {
  conn: ConnStatus;
  error: string | null;
  deviceId: string;
  isHost: boolean;
  room: RoomState | null;
  clock: ClockStats | null;
  engine: EngineStats;
  calibration: CalibrationUi;
  syncMeasure: SyncMeasureUi;
  capture: CaptureUi;
  remote: RemoteUi;
  /** this device's computed mix (gains etc.) */
  mix: DeviceMix | null;
  /** device id currently flashing because of an IDENTIFY */
  identifyFlash: string | null;
  /** output route changed (devicechange) since last calibration → prompt to recalibrate */
  routeChanged: boolean;
  /** a previously calibrated output came back and its remembered calibration was re-applied */
  routeRestored: { label: string; calibratedLatencyMs: number } | null;
  demoAssets: DemoAsset[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface RoomActions {
  /** Connects, JOINs and unlocks audio. MUST be called from a user gesture (click). */
  join(p: { code: string; name: string; password?: string }): Promise<void>;
  leave(): void;
  control(cmd: ControlCommand): void;
  /** Throttled scene update. `commit: true` (e.g. on drag end / button) records an undo step. */
  updateScene(patch: Omit<SceneUpdate, 'type'>, opts?: { commit?: boolean }): void;
  undo(): void;
  redo(): void;
  updateDevice(patch: DevicePatch, targetDeviceId?: string): void;
  /** pick a speaker layout: auto-assigns every device's slot, places them, sets scene.layout */
  setLayout(layout: LayoutId): void;
  /** move one device to a slot ('Full' = unassigned) */
  assignSlot(deviceId: string, role: DeviceRole): void;
  updateSettings(patch: Partial<Pick<RoomSettings, 'hostOnlyControl' | 'videoBufferMs' | 'lipSyncNudgeMs' | 'crossfadeSec'>> & {
    password?: string | null;
  }): void;
  identify(targetDeviceId: string): void;
  loadDemoAssets(): Promise<void>;
  queueDemo(asset: DemoAsset): void;
  uploadFile(file: File): Promise<Track>;
  queueUrl(url: string, title?: string): Promise<Track>;
  /** Runs the acoustic calibration wizard with this device as the listener (quick = timing-only re-sync). */
  startCalibration(opts?: { quick?: boolean }): Promise<void>;
  cancelCalibration(): void;
  /** Sync-measurement tool with this device as the listener (mic → user gesture). Cancel with cancelCalibration. */
  startSyncMeasurement(durationSec?: number): Promise<void>;
  /** Apply class-preset EQ (no-mic fallback) to a device */
  applyPresetEq(targetDeviceId: string): void;
  setEqBypass(bypass: boolean): void;
  setClickTest(on: boolean): void;
  setBatterySaver(on: boolean): void;
  dismissRouteChange(): void;
  /** Capture this tab / system audio and send it to every device (video mode 1). */
  startCapture(): Promise<void>;
  stopCapture(): void;
  connectSpotify(): Promise<void>;
  connectApple(): Promise<void>;
  queueRemote(kind: 'spotify' | 'apple', remoteId: string, title?: string): void;
  /** Mode 2: register the <video> element to be driven by the room clock (muted; audio is rendered). */
  attachVideo(el: HTMLVideoElement | null): void;
  /** clear store.error (always implemented by roomActions) */
  clearError?(): void;
}

export type { Scene };
