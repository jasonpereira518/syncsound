// CONTRACT STUB — replaced by the engine workstream. Keeps the UI compiling.
import { create } from 'zustand';
import type { RoomActions, RoomStoreState } from './types';

const notReady = () => {
  throw new Error('room engine not implemented yet');
};

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
    eqBypassed: false,
    clickTest: false,
    wakeLock: false,
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
  },
  capture: { active: false, receiving: false, silent: false, error: null, peers: 0, pipelineDelayMs: null },
  remote: { spotify: 'unconfigured', apple: 'unconfigured', errorMs: null, meanAbsErrorMs: null, seeks: 0, message: null },
  mix: null,
  identifyFlash: null,
  routeChanged: false,
  demoAssets: [],
  canUndo: false,
  canRedo: false,
});

export const useRoomStore = create<RoomStoreState>(() => initialState());

export const roomActions: RoomActions = {
  join: notReady,
  leave: notReady,
  control: notReady,
  updateScene: notReady,
  undo: notReady,
  redo: notReady,
  updateDevice: notReady,
  updateSettings: notReady,
  identify: notReady,
  loadDemoAssets: notReady,
  queueDemo: notReady,
  uploadFile: notReady,
  queueUrl: notReady,
  startCalibration: notReady,
  cancelCalibration: notReady,
  applyPresetEq: notReady,
  setEqBypass: notReady,
  setClickTest: notReady,
  dismissRouteChange: notReady,
  startCapture: notReady,
  stopCapture: notReady,
  connectSpotify: notReady,
  connectApple: notReady,
  queueRemote: notReady,
  attachVideo: notReady,
};
