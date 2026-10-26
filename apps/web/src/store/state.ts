/**
 * The zustand store itself (no actions). Split from roomStore.ts so engine modules in src/lib can read and
 * patch state without importing the action layer (avoids an import cycle).
 */
import { batterySaver } from '../lib/power';
import { create } from 'zustand';
import type { RoomStoreState } from './types';

export const initialState = (): RoomStoreState => ({
  conn: 'idle',
  error: null,
  deviceId: '',
  isHost: false,
  room: null,
  clock: null,
  engine: {
    unlocked: false,
    ctxState: 'none',
    sampleRate: null,
    autoLatencyMs: null,
    usingOutputTimestamp: false,
    bufferState: 'idle',
    loadedTrackId: null,
    syncErrorMs: 0,
    playbackRate: 1,
    corrections: { rate: 0, reschedule: 0 },
    compensationMs: 0,
    tickGapMs: 0,
    audioSteps: 0,
    eqBypassed: false,
    clickTest: false,
    wakeLock: false,
    batterySaver: batterySaver(),
  },
  calibration: {
    running: false,
    step: 'idle',
    progress: 0,
    message: '',
    freqs: null,
    targetDb: null,
    devices: [],
    warnings: [],
    emitting: false,
    nowPlaying: null,
    quick: false,
    waitingFor: [],
    recorderStep: 'idle',
  },
  syncMeasure: {
    running: false,
    step: 'idle',
    progress: 0,
    message: '',
    durationSec: 60,
    devices: [],
    histogram: null,
    overall: null,
    warnings: [],
  },
  capture: {
    active: false,
    receiving: false,
    silent: false,
    error: null,
    peers: 0,
    pipelineDelayMs: null,
    surface: null,
    monitoring: false,
    hostPlayback: null,
    jitterTargetMs: null,
    appliedDelayMs: null,
    delayChanges: 0,
    shortfallMs: null,
  },
  remote: {
    spotify: 'unconfigured',
    apple: 'unconfigured',
    errorMs: null,
    meanAbsErrorMs: null,
    seeks: 0,
    message: null,
    needsTap: false,
    elsewhere: false,
  },
  mix: null,
  identifyFlash: null,
  routeChanged: false,
  routeRestored: null,
  demoAssets: [],
  canUndo: false,
  canRedo: false,
});

export const useRoomStore = create<RoomStoreState>(() => initialState());

type Sub = 'engine' | 'calibration' | 'syncMeasure' | 'capture' | 'remote';
/** shallow-merge into one sub-state object, skipping no-op updates */
export function patch<K extends Sub>(key: K, p: Partial<RoomStoreState[K]>): void {
  const cur = useRoomStore.getState()[key];
  if ((Object.keys(p) as Array<keyof RoomStoreState[K]>).every((k) => Object.is(cur[k], p[k]))) return;
  useRoomStore.setState({ [key]: { ...cur, ...p } } as Partial<RoomStoreState>);
}

let lastError = '';
/** user-facing error (deduped so interval loops don't spam renders) */
export function setError(msg: string | null): void {
  if (msg && msg === lastError && useRoomStore.getState().error === msg) return;
  lastError = msg ?? '';
  useRoomStore.setState({ error: msg });
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const me = () => {
  const s = useRoomStore.getState();
  return s.room?.devices.find((d) => d.id === s.deviceId) ?? null;
};
