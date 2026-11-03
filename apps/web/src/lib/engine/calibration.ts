/**
 * Acoustic tune (calibration v3, docs/CALIBRATION.md). Every device: play its slots of a CALIBRATION_PLAN, scheduled
 * lazily against the live clock. Every device with a mic on an all-recorders plan: record, analyze locally, send its
 * rows to the listener. The listener: gather rows, solve (distances → positions, listener-row timing, levels, EQ),
 * apply. Browser-only.
 */
import {
  analyzeRecording,
  analyzeSyncMeasurement,
  buildSyncMeasurementSlots,
  buildTuneSlots,
  calibrationRecordingMs,
  calibrationSignal,
  classPresetEq,
  clockSettled,
  encodeWav,
  expectedArrivalMs,
  frozenRoomMap,
  headOffsetFor,
  heldAtHead,
  indexMap,
  mergeTuneRounds,
  nextRoundEmitters,
  runValidity,
  solveTune,
  SYNC_SEARCH_LATE_MS,
  SYNC_STAGGER_MS,
  TUNE_CONFIRM_BLUETOOTH,
  TUNE_PERIOD_MS,
  tuneProgress,
  VERIFY_CLICKS,
  verifyTune,
  type RecordingAnalysis,
  type RoomClock,
  type RowsByRecorder,
  type RunSnapshot,
  type SettleVerdict,
  type TimeMap,
  type TuneProgress,
  type TuneRound,
  type TuneVerification,
} from '@syncsound/audio-core';
import {
  CALIBRATION_PREPARE_DEADLINE_MS,
  TUNE_MAX_ROUNDS,
  type CalibrationDeviceResult,
  type CalibrationPlan,
  type CalibrationRow,
  type ClientMessage,
  type Device,
  type DevicePatch,
  type SceneUpdate,
  type TuneStatusEntry,
} from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
import { setAudioSession } from '../audioSession';
import { chooseCalibrationInput, defaultOutputLabel, isBluetoothLabel } from '../device';
import type { CalibrationDeviceUi } from '../../store/types';
import type { AudioEngine } from './audioEngine';

const RECORDER_CODE = `
class SyncSoundRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(8192);
    this.n = 0;
    this.started = false;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
      else if (e.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (this.n) { this.port.postMessage({ frames: this.buf.slice(0, this.n) }); this.n = 0; }
  }
  process(inputs) {
    if (!this.on) return false;
    if (!this.started) { this.started = true; this.port.postMessage({ start: currentTime }); }
    // An inactive input (e.g. silent source node) delivers no channels: record zeros so the timeline stays
    // contiguous — sample index ↔ context time must hold for every block.
    const ch = inputs[0] && inputs[0][0];
    const n = ch && ch.length ? ch.length : 128;
    for (let i = 0; i < n; i++) {
      this.buf[this.n++] = ch && ch.length ? ch[i] : 0;
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('syncsound-recorder', SyncSoundRecorder);
`;

/** how long calibration waits for clocks to converge before giving up, ms */
const TIMING_WAIT_MS = 10_000;
/** emissions are scheduled this far ahead (like real playback), so a late output step is already in the mapping, ms */
const EMIT_AHEAD_MS = 1500;
/** recorders freeze their clock map this long before the first slot (after the lead let mic-open steps settle), ms */
const FREEZE_BEFORE_MS = 300;
/** the listener waits this long for the other recorders' rows after its own analysis, ms */
const ROWS_WAIT_MS = 4000;
/** longest plan a device follows (a tune of 32 devices is ~50 s; anything longer is malformed), ms */
const MAX_PLAN_MS = 60_000;
/** the listener waits this long for its clocks to settle (hard criteria) before giving up, ms */
const SETTLE_WAIT_MS = 30_000;
/** …and this long for the soft criteria (rate estimates, jitter) before proceeding with a warning, ms */
const SETTLE_SOFT_WAIT_MS = 20_000;
const SETTLING_WARNING = 'The clocks were still settling; tune again in a minute for the best accuracy.';
/** a prepared recorder lets its output settle this long after opening the mic before answering READY, ms */
const PREPARE_SETTLE_MS = 1500;
/** test hook `?slowMic=<ms>`: a recorder takes this long to open its mic (a slow phone, a locked screen) */
const slowMicMs = (): number => {
  if (typeof location === 'undefined') return 0;
  const v = Number(new URLSearchParams(location.search).get('slowMic'));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
/** test hook `?dropChimes=<n>`: this device stays silent for its first n tune chimes (a muted speaker, turned up later) */
let droppedChimes = 0;
const dropChime = (): boolean => {
  if (typeof location === 'undefined') return false;
  const n = Number(new URLSearchParams(location.search).get('dropChimes'));
  if (!(Number.isFinite(n) && droppedChimes < n)) return false;
  droppedChimes++;
  return true;
};
const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** what the calibration controller needs to know about the clock path (from the room store) */
export interface CalibrationEnv {
  /** the clock path in use ('wan' or 'lan:<master>'): a change mid-run invalidates it */
  clockPath: () => string;
  /** the in-room clock link as the settle gate sees it */
  linkState: () => 'none' | 'ready' | 'not-ready';
}
const HOST_ONLY = 'Only the host can tune this room (it is set to host-only control).';
/** this device is playing or recording for another device's run: say so now instead of after the settle wait */
const BUSY = 'Another device is tuning the room right now. Wait for it to finish.';
/** this device may start a run (the server checks too) */
function mayControl(): boolean {
  const st = useRoomStore.getState();
  const me = st.room?.devices.find((d) => d.id === st.deviceId);
  return !!st.room && (!st.room.settings.hostOnlyControl || !!me?.isHost);
}

const registered = new WeakSet<BaseAudioContext>();

interface Recorder {
  /** ctx time of the first recorded sample (null until the worklet ran) */
  startCtx(): number | null;
  stop(): Promise<{ samples: Float32Array; startCtx: number }>;
  /** everything recorded so far; the recorder keeps running (a tune's rounds share one recording) */
  take(): Promise<{ samples: Float32Array; startCtx: number }>;
  abort(): void;
}

async function startRecorder(ctx: AudioContext, input: MediaStream | AudioNode): Promise<Recorder> {
  if (!registered.has(ctx)) {
    const url = URL.createObjectURL(new Blob([RECORDER_CODE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    registered.add(ctx);
  }
  const src = input instanceof MediaStream ? ctx.createMediaStreamSource(input) : input;
  const node = new AudioWorkletNode(ctx, 'syncsound-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the node pulled by the graph without making sound
  src.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  const chunks: Float32Array[] = [];
  let startCtx: number | null = null;
  let done: (() => void) | null = null;
  let flushed: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent<{ frames?: Float32Array; start?: number; done?: boolean; flushed?: boolean }>) => {
    if (e.data.start !== undefined) startCtx = e.data.start;
    if (e.data.frames) chunks.push(e.data.frames);
    if (e.data.done) done?.();
    if (e.data.flushed) flushed?.();
  };
  const joined = () => {
    if (startCtx === null) throw new Error('The microphone produced no audio.');
    const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      samples.set(c, o);
      o += c.length;
    }
    return { samples, startCtx };
  };
  const teardown = () => {
    if (input instanceof MediaStream) src.disconnect();
    else src.disconnect(node);
    node.disconnect();
    sink.disconnect();
  };
  return {
    startCtx: () => startCtx,
    async stop() {
      await new Promise<void>((resolve) => {
        done = resolve;
        node.port.postMessage('stop');
        setTimeout(resolve, 1000);
      });
      teardown();
      return joined();
    },
    async take() {
      await new Promise<void>((resolve) => {
        flushed = resolve;
        node.port.postMessage('flush');
        setTimeout(resolve, 1000);
      });
      return joined();
    },
    abort() {
      node.port.postMessage('stop');
      teardown();
    },
  };
}

const MIC_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

const BT_MIC_ONLY_ERROR =
  "This device's only microphone is its Bluetooth speaker or headset. It would record at the speaker, not where " +
  'you listen. Disconnect Bluetooth on this device, or run calibration from another phone or laptop.';
const BT_SELF_WARNING =
  "This device plays through Bluetooth or headphones, so its own speaker wasn't measured (opening the mic " +
  "switches Bluetooth into call mode, which has a different delay). Run calibration from another device to measure it.";

const HELD_MUTED_NOTE =
  "This phone was the microphone at your seat, so it's now muted as a speaker (it would play right at your ear). " +
  'Put it down somewhere else and unmute it in Devices if you want it to play too.';

const HIDDEN_ERROR =
  'The tune stopped because this screen locked or you switched apps (phones pause the microphone and sound in the ' +
  'background). Keep this screen on and open, then run it again.';

/**
 * Open a calibration mic, avoiding a Bluetooth headset mic (which would flip the headset into its hands-free
 * profile). `outputBluetooth`: this device's own output is (or was just switched to) Bluetooth. `release()` stops
 * the mic and puts the iOS audio session back to loudspeaker playback; safe to call more than once.
 */
async function openCalibrationMic(): Promise<{ stream: MediaStream; outputBluetooth: boolean; release: () => void }> {
  setAudioSession('play-and-record');
  try {
    const mic = await openMicStream();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      mic.stream.getTracks().forEach((t) => t.stop());
      setAudioSession('playback');
    };
    return { ...mic, release };
  } catch (e) {
    setAudioSession('playback');
    throw e;
  }
}

/** call `onHidden` once if this page is hidden (screen locked, app switched); returns the unsubscribe */
function onPageHidden(onHidden: () => void): () => void {
  const check = () => {
    if (document.visibilityState === 'hidden') onHidden();
  };
  document.addEventListener('visibilitychange', check);
  return () => document.removeEventListener('visibilitychange', check);
}

async function openMicStream(): Promise<{ stream: MediaStream; outputBluetooth: boolean }> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  } catch (e) {
    throw new Error(micError(e));
  }
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices(); // labels are readable now that the mic is granted
  } catch {
    /* labels unknown: keep the default mic */
  }
  const choice = chooseCalibrationInput(stream.getAudioTracks()[0]?.label ?? '', devices);
  if (choice.kind !== 'keep') {
    stream.getTracks().forEach((t) => t.stop());
    if (choice.kind === 'bluetooth-only') throw new Error(BT_MIC_ONLY_ERROR);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS, deviceId: { exact: choice.deviceId } } });
    } catch (e) {
      throw new Error(micError(e));
    }
  }
  return { stream, outputBluetooth: choice.kind !== 'keep' || isBluetoothLabel(defaultOutputLabel(devices)) };
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was denied. Allow the microphone for this site in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found on this device. Run calibration from a phone or laptop that has a mic.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Microphone access needs a secure (https) page in this browser.';
  return `Couldn't open the microphone: ${errMsg(e)}`;
}

class Cancelled extends Error {}

/** the mic recording of the last failed calibration, so it can be saved and replayed offline */
let failedRecording: { samples: Float32Array; sampleRate: number } | null = null;
export const hasFailedRecording = () => failedRecording !== null;
export function downloadFailedRecording(): void {
  if (!failedRecording) return;
  const wav = encodeWav([failedRecording.samples], failedRecording.sampleRate);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' }));
  a.download = `syncsound-calibration-${Date.now()}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** why nobody was heard, from the recording level and the best (sub-threshold) matches */
function explainNotHeard(a: RecordingAnalysis): string {
  const mic = `mic peak ${a.recordingPeakDb.toFixed(0)} dBFS`;
  if (a.recordingPeakDb < -80)
    return `The microphone recorded silence (${mic}). Check the browser's microphone permission, that the mic isn't muted, and the selected input device.`;
  if (a.recordingRmsDb > -35) return 'The room is too noisy to measure. Pause the music, turn off fans/TV and try again.';
  const best = Math.max(...a.rows.map((r) => r.snrDb ?? -Infinity));
  const detail = Number.isFinite(best) ? `${mic}; best match ${best.toFixed(0)} dB above the noise (needs 20)` : mic;
  return `No speakers were heard (${detail}). Turn every device's volume up, unmute them, and keep this device within a few meters.`;
}

/** a tune round's line: "Round 2 of up to 5: Kitchen and Desk play again…" (the anchor plays every round, unnamed) */
function roundMessage(k: number, emitters: string[], anchorId: string | null): string {
  const names = emitters.filter((id) => id !== anchorId).map(nameOfDevice);
  return `Round ${k + 1} of up to ${TUNE_MAX_ROUNDS}: ${names.length ? `${list(names)} ${names.length === 1 ? 'plays' : 'play'} again` : 'checking again'}…`;
}

/** a device's tune progress as the result rows show it */
function progressUi(p: TuneProgress['devices'][number] | undefined): Pick<CalibrationDeviceUi, 'state' | 'hint' | 'readings' | 'spreadMs'> {
  return p ? { state: p.state, hint: p.hint, readings: p.measurementsMs.length, spreadMs: p.spreadMs } : {};
}

const prepareOf = (run: Run): Run['prepare'] => run.prepare;
const nameOfDevice = (id: string) => useRoomStore.getState().room?.devices.find((d) => d.id === id)?.name ?? 'a speaker';

/** class preset (no-mic fallback) for a device */
export function presetPatch(device: Device): DevicePatch {
  const p = classPresetEq(device.caps.deviceClass);
  return { eq: { ...p.eq, source: 'preset' }, bassCapable: p.bassCapable, rolloffHz: p.rolloffHz };
}

const isDetached = (d: Device) => d.caps.deviceClass === 'bluetooth' || isBluetoothLabel(d.caps.outputLabel);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRun = (): Run => ({
  cancelled: false,
  cleanup: [],
  planWaiter: null,
  interrupt: null,
  awaitingRound: false,
  finishing: false,
  roundsDone: 0,
  rows: {},
  bluetooth: new Set(),
  faults: {},
  roundFaults: {},
  planId: null,
  prepare: null,
  reason: null,
});
/** "Finish now" interrupted the round being played */
class Finishing extends Error {}

/** what the listener records a run through: its mic (or the loopback), one recorder for every round */
interface Listening {
  recorder: Recorder;
  release: () => void;
  selfExcluded: boolean;
  /** the devices the run plays (without this device when it can't measure itself) */
  ids: string[];
  settleWarnings: string[];
}

interface Run {
  cancelled: boolean;
  cleanup: Array<() => void>;
  planWaiter: ((p: CalibrationPlan) => void) | null;
  /** fails the plan being waited for (finish now; the server refused a tune's next round) */
  interrupt: ((e: Error) => void) | null;
  /** waiting for a tune's next round (a refusal from the server answers it) */
  awaitingRound: boolean;
  /** "Finish now": no further rounds; the round playing is dropped */
  finishing: boolean;
  /** tune rounds recorded and analysed so far */
  roundsDone: number;
  /** rows from the other recorders of this run's plan */
  rows: RowsByRecorder;
  /** recorders that reported a Bluetooth output */
  bluetooth: Set<string>;
  /** devices whose clocks moved while they played their slot of round 0 (left out of ranging), by id → reason */
  faults: Record<string, string>;
  /** …and of every round, by round (a tune's progress leaves those readings out) */
  roundFaults: Record<number, Record<string, string>>;
  planId: string | null;
  /** the prepare phase of this run: who was asked to open a mic, and who answered what ('ok' or the reason) */
  prepare: { planId: string; expected: string[]; answered: Record<string, string> } | null;
  /** why the run was stopped from outside (e.g. the page was hidden); null = the user cancelled */
  reason: string | null;
}

/** this device recording for someone else's plan (all-recorders tune) */
interface Remote {
  planId: string;
  cancelled: boolean;
  cleanup: Array<() => void>;
  /** the mic opened ahead of the plan (CALIBRATION_PREPARE), waiting for it */
  prepared: { recorder: Recorder; stopTracks: () => void; outputBluetooth: boolean } | null;
  /** why this device could not prepare (answered READY ok:false; repeated when the plan arrives) */
  failed: string | null;
  /** the plan arrived and is being captured */
  capturing: boolean;
}

/** the clocks at the start of a run, to check at its end that they stayed put */
interface ClockSnapshot extends RunSnapshot {
  frozen: TimeMap;
}

export class CalibrationController {
  private run: Run | null = null;
  private remote: Remote | null = null;
  private planTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly send: (m: ClientMessage) => boolean,
    private readonly clock: () => RoomClock | null,
    /** apply measured positions / listener locally (and to the room) */
    private readonly applyScene: (p: Omit<SceneUpdate, 'type'>) => void,
    private readonly env: CalibrationEnv,
  ) {}

  /** the clocks as they are now, for a run-validity check later */
  private snapshot(): ClockSnapshot {
    const clock = this.clock()!;
    return { path: this.env.clockPath(), resets: clock.estimate().resets, steps: this.engine.audioClock.steps, frozen: clock.frozenAt(performance.now()) };
  }

  /** did the clocks stay put since `before`? */
  private validity(before: ClockSnapshot) {
    const clock = this.clock();
    if (!clock) return { valid: false, reason: 'the room clock went away during the run' };
    const now = performance.now();
    const moved = clock.toRoomTime(now) - before.frozen.toRoomTime(now);
    return runValidity(before, { path: this.env.clockPath(), resets: clock.estimate().resets, steps: this.engine.audioClock.steps }, moved);
  }

  private settleVerdict(): SettleVerdict {
    const e = this.clock()!.estimate();
    return clockSettled({
      converged: e.converged,
      ageMs: e.ageMs,
      jitterMs: e.jitterMs,
      pendingSlewMs: e.pendingSlewMs,
      driftSePpm: e.driftSePpm,
      link: this.env.linkState(),
      audioRateSePpm: this.engine.audioClock.longRate()?.sePpm ?? null,
    });
  }

  /**
   * Wait until this device's clocks are steady enough to time a run (see clockSettled): the hard criteria up to
   * SETTLE_WAIT_MS (then an error), the soft ones up to SETTLE_SOFT_WAIT_MS (then a warning). Returns the warnings.
   */
  private async waitForSettled(run: { cancelled: boolean }, onProgress: (message: string) => void): Promise<string[]> {
    const t0 = performance.now();
    for (;;) {
      if (run.cancelled) throw new Cancelled();
      const v = this.settleVerdict();
      if (v.ok) return [];
      const waited = performance.now() - t0;
      if (v.hard && waited > SETTLE_WAIT_MS) throw new Error(`The room clock hasn't settled yet (${v.reason}). Wait a moment and tune again.`);
      if (!v.hard && waited > SETTLE_SOFT_WAIT_MS) {
        console.info('[calibration] proceeding with an unsettled clock:', v.reason);
        return [SETTLING_WARNING];
      }
      onProgress(`Letting the clocks settle… (${Math.round(waited / 1000)} s)`);
      await sleep(250);
    }
  }

  /** every device receives the plan: play my slots (lazily); record for the listener if asked to */
  onPlan(plan: CalibrationPlan): void {
    const myId = useRoomStore.getState().deviceId;
    if (plan.listenerId === myId && this.run?.planWaiter) this.run.planWaiter(plan);
    const ctx = this.engine.ctx;
    // Not synced/running → emitAt would play "now" (seconds before the slot) and nobody could match it.
    const recorder = plan.recorders === 'all' && plan.listenerId !== myId;
    const skip = (reason: string) => {
      if (recorder) this.send({ type: 'CALIBRATION_ROWS', planId: plan.id, rows: [], valid: false, reason }); // don't keep the listener waiting
    };
    if (!ctx || ctx.state !== 'running' || !this.engine.timingReady()) return skip('audio or clock not ready');
    if (calibrationRecordingMs(plan.slots) > MAX_PLAN_MS) return skip('plan too long');
    this.followPlan(plan, myId);
    if (recorder) void this.recordFor(plan, myId, skip);
  }

  /**
   * A run is about to start: the named recorders open their mics now and answer READY (so the plan can follow with
   * a short lead and nobody is prompted mid-run); the listener learns whom it is waiting for.
   */
  onPrepare(msg: { planId: string; listenerId: string; recorderIds: string[]; deadlineRoomTime: number }): void {
    const myId = useRoomStore.getState().deviceId;
    if (msg.listenerId === myId) {
      const run = this.run;
      if (run && !run.planId) {
        run.prepare = { planId: msg.planId, expected: msg.recorderIds, answered: {} };
        this.publishWaiting(run);
      }
      return;
    }
    if (msg.recorderIds.includes(myId)) void this.prepareFor(msg, myId);
  }

  /** a recorder of this device's run answered the prepare request */
  onReady(msg: { planId: string; recorderId: string; ok: boolean; reason?: string }): void {
    const run = this.run;
    if (!run?.prepare || run.prepare.planId !== msg.planId) return;
    run.prepare.answered[msg.recorderId] = msg.ok ? 'ok' : (msg.reason ?? 'could not open its microphone');
    this.publishWaiting(run);
  }

  private publishWaiting(run: Run) {
    const p = run.prepare!;
    const names = p.expected.filter((id) => !(id in p.answered)).map((id) => nameOfDevice(id));
    patch('calibration', { step: 'preparing', waitingFor: names, message: names.length ? `Waiting for ${list(names)}’s microphone…` : 'Starting…' });
  }

  /** this device was asked to open its mic for someone else's run: do it now, settle, answer READY, wait for the plan */
  private async prepareFor(msg: { planId: string; deadlineRoomTime: number }, myId: string) {
    const ready = (ok: boolean, reason?: string) =>
      this.send({ type: 'CALIBRATION_READY', planId: msg.planId, ok, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
    if (this.run) return ready(false, 'busy with its own measurement');
    if (this.remote) this.releaseRemote(this.remote); // a newer run wins
    const remote: Remote = { planId: msg.planId, cancelled: false, cleanup: [], prepared: null, failed: null, capturing: false };
    this.remote = remote;
    patch('calibration', { recorderStep: 'preparing' });
    let answered = false;
    // phones stop the mic in the background: a recorder that locks before the plan answers (or will answer, when
    // the plan comes) that it can't listen, and lets the mic go
    const unhide = onPageHidden(() => {
      if (remote.capturing || remote.failed) return; // capturing: captureFor reports it
      remote.failed = 'its screen locked or it switched apps';
      if (!answered) {
        answered = true;
        ready(false, remote.failed);
      }
      this.cancelRun(remote); // keeps `this.remote`, so the plan's arrival repeats the reason as invalid rows
      patch('calibration', { recorderStep: 'idle' });
    });
    remote.cleanup.push(unhide);
    try {
      const ctx = this.engine.ctx;
      const me = useRoomStore.getState().room?.devices.find((d) => d.id === myId);
      if (!ctx || ctx.state !== 'running' || !this.engine.timingReady()) throw new Error('its audio or clock was not ready');
      if (!this.engine.loopback() && me && !me.caps.hasMic) throw new Error('it has no microphone');
      const slow = slowMicMs();
      if (slow) await sleep(slow);
      if (remote.cancelled) return;
      const input = await this.openInput(remote);
      const recorder = await startRecorder(ctx, input.input);
      remote.cleanup.push(() => recorder.abort());
      // opening a mic can re-open the output path (a step in the audio-clock map): let it settle before anything is timed
      await sleep(PREPARE_SETTLE_MS);
      if (remote.cancelled) return;
      remote.prepared = { recorder, stopTracks: input.stopTracks, outputBluetooth: input.outputBluetooth };
      patch('calibration', { recorderStep: 'ready' });
      answered = true;
      ready(true);
      // the plan never came (the run was cancelled, or the listener gave up): let the mic go
      const clock = this.clock();
      const waitMs = clock ? Math.max(1000, msg.deadlineRoomTime - clock.toRoomTime(performance.now())) + 4000 : CALIBRATION_PREPARE_DEADLINE_MS + 4000;
      const t = setTimeout(() => {
        if (this.remote === remote && !remote.capturing) this.releaseRemote(remote);
      }, waitMs);
      remote.cleanup.push(() => clearTimeout(t));
    } catch (e) {
      if (e instanceof Cancelled || remote.cancelled) return;
      remote.failed = errMsg(e);
      patch('calibration', { recorderStep: 'idle' });
      answered = true;
      ready(false, remote.failed);
    }
  }

  /** stop recording for someone else's plan and forget it */
  private releaseRemote(remote: Remote) {
    this.cancelRun(remote);
    if (this.remote === remote) this.remote = null;
    patch('calibration', { recorderStep: 'idle' });
  }

  /** the recorder's input: the loopback test node, or a calibration mic (stopped with the run) */
  private async openInput(remote: { cleanup: Array<() => void> }): Promise<{ input: MediaStream | AudioNode; stopTracks: () => void; outputBluetooth: boolean }> {
    const lb = this.engine.loopback();
    if (lb) return { input: lb, stopTracks: () => {}, outputBluetooth: false };
    const mic = await openCalibrationMic();
    // release() stops the mic and, on iOS, puts the audio session back to loudspeaker playback
    remote.cleanup.push(mic.release);
    return { input: mic.stream, stopTracks: mic.release, outputBluetooth: mic.outputBluetooth };
  }

  /** rows from another recorder of this device's run */
  onRows(msg: {
    planId: string;
    recorderId: string;
    rows: CalibrationRow[];
    valid: boolean;
    reason?: string;
    outputBluetooth?: boolean;
    emissionValid?: boolean;
    round?: number;
  }): void {
    const run = this.run;
    if (!run || run.planId !== msg.planId) return;
    const round = msg.round ?? 0;
    const reason = msg.reason ?? 'its clock moved during the run';
    if (msg.emissionValid === false) (run.roundFaults[round] ??= {})[msg.recorderId] = reason;
    // a later round is listener-only: an emitter's fault report is all it can bring
    if (round > 0) return;
    if (msg.outputBluetooth) run.bluetooth.add(msg.recorderId);
    console.info('[calibration] rows from', msg.recorderId, `${msg.rows.filter((r) => r.mMs !== null).length} heard`, msg.valid ? '' : msg.reason);
    if (msg.emissionValid === false) run.faults[msg.recorderId] = reason;
    if (msg.valid) run.rows[msg.recorderId] = msg.rows;
    else if (msg.rows.length || !(msg.recorderId in run.rows)) run.rows[msg.recorderId] = [];
  }

  /** the listener gave up (or left): stop playing and recording for its plan */
  onCancelled(planId: string): void {
    if (useRoomStore.getState().calibration.selfStatus?.planId === planId) patch('calibration', { selfStatus: null });
    if (this.remote?.planId === planId) this.releaseRemote(this.remote);
    if (this.emittingPlanId === planId) this.stopEmitting();
  }

  private emittingPlanId: string | null = null;

  private stopEmitting() {
    if (this.planTimer) clearInterval(this.planTimer);
    this.planTimer = null;
    this.emittingPlanId = null;
    patch('calibration', { emitting: false, nowPlaying: null });
  }

  /**
   * For the plan's duration (every device): schedule my emissions EMIT_AHEAD_MS ahead on the live clock — a tune
   * with only the browser-reported compensation (so the residual is measured), a sync check with full compensation
   * through the playback chain (so it measures what playback does) — and publish who is playing for the banner.
   */
  private followPlan(plan: CalibrationPlan, myId: string) {
    const ctx = this.engine.ctx!;
    const measure = plan.purpose === 'measure';
    const pending = plan.slots
      .filter((s) => s.deviceId === myId)
      .flatMap((slot) =>
        Array.from({ length: slot.repeat ?? 1 }, (_, k) => ({ roomMs: plan.startRoomTime + slot.offsetMs + k * (slot.periodMs ?? 0), slot })),
      )
      .sort((a, b) => a.roomMs - b.roomMs);
    const endRoom = plan.startRoomTime + calibrationRecordingMs(plan.slots) + 300;
    if (this.planTimer) clearInterval(this.planTimer);
    this.emittingPlanId = plan.id;
    patch('calibration', { emitting: true, nowPlaying: null });
    // an emitter that neither listens nor records reports a clock that moved while it played (recorders fold the
    // same check into their rows; the listener checks its own run)
    const emitterOnly = !measure && plan.listenerId !== myId && !(plan.recorders === 'all' && this.canRecord(myId));
    let snap: ClockSnapshot | null = null;
    const tick = () => {
      const clock = this.clock();
      if (!clock || !this.engine.ctx) return;
      const now = clock.toRoomTime(performance.now());
      while (pending.length && pending[0]!.roomMs < now + EMIT_AHEAD_MS) {
        const { roomMs, slot } = pending.shift()!;
        // without a ready clock emitAt would play "now", inside another device's window: drop the slot instead
        if (roomMs > now + 50 && this.engine.timingReady()) {
          if (!snap) snap = this.snapshot();
          if (!measure && dropChime()) continue;
          this.engine.emitAt(calibrationSignal(slot.signal, slot.deviceIndex, ctx.sampleRate), roomMs, measure ? 'full' : 'auto', measure, clock);
        }
      }
      const playing = measure
        ? null
        : (plan.slots.find((s) => now >= plan.startRoomTime + s.offsetMs - 100 && now < plan.startRoomTime + s.offsetMs + TUNE_PERIOD_MS - 100)?.deviceId ?? null);
      if (useRoomStore.getState().calibration.nowPlaying !== playing) patch('calibration', { nowPlaying: playing });
      if (now > endRoom && this.planTimer) {
        this.stopEmitting();
        if (emitterOnly && snap) {
          const v = this.validity(snap);
          if (!v.valid)
            this.send({ type: 'CALIBRATION_ROWS', planId: plan.id, rows: [], valid: false, emissionValid: false, reason: v.reason, ...(plan.round ? { round: plan.round } : {}) });
        }
      }
    };
    tick();
    this.planTimer = setInterval(tick, 250);
  }

  /** this device records for an all-recorders plan (a mic, or the loopback test input) */
  private canRecord(myId: string): boolean {
    const me = useRoomStore.getState().room?.devices.find((d) => d.id === myId);
    return !!this.engine.loopback() || !!me?.caps.hasMic;
  }

  /**
   * A linear room-time map for one recording, frozen now: sample idx → room ms through the audio clock (so ppm error
   * is included) and the room clock. Frozen, an output-latency step or clock slew mid-run can't move the input
   * timeline; whatever offset it has is common to everything this recorder hears.
   */
  private freezeMap(startCtx: number, sampleRate: number, frozen: TimeMap): (idx: number) => number {
    // analytic: the audio clock's long-baseline rate and the room clock's drift slope (frozen: never its pending
    // slew, which a finite difference would read as up to ±1000 ppm), anchored at the first recorded sample
    const ac = this.engine.audioClock;
    return frozenRoomMap({ startCtx, sampleRate, audio: { perfAtStartCtx: ac.ctxToPerf(startCtx), ctxPerPerfMs: ac.slope() }, clock: frozen });
  }

  /** resolve once room time passes `roomMs` (or the run is cancelled) */
  private async untilRoom(roomMs: number, run: { cancelled: boolean }, onProgress?: (now: number) => void) {
    for (;;) {
      if (run.cancelled) throw new Cancelled();
      const clock = this.clock();
      const now = clock ? clock.toRoomTime(performance.now()) : -Infinity;
      onProgress?.(now);
      if (now >= roomMs) return;
      await sleep(100);
    }
  }

  /**
   * Recorder role for someone else's all-recorders tune: record the run with the mic opened at the prepare step
   * (or open it now, as older runs do), send my rows.
   */
  private async recordFor(plan: CalibrationPlan, myId: string, skip: (reason: string) => void) {
    if (this.run) return skip('busy with its own measurement');
    const existing = this.remote;
    if (existing?.planId === plan.id) {
      if (existing.failed) {
        this.releaseRemote(existing);
        return skip(existing.failed);
      }
      if (existing.prepared) {
        existing.capturing = true;
        console.info('[calibration] recording through the mic prepared for plan', plan.id);
        return void this.captureFor(plan, existing, existing.prepared);
      }
    }
    if (existing) this.releaseRemote(existing); // a newer plan wins (the old one was cancelled or superseded)
    const me = useRoomStore.getState().room?.devices.find((d) => d.id === myId);
    if (!this.engine.loopback() && me && !me.caps.hasMic) return skip('no microphone');
    const clock = this.clock();
    if (!clock || clock.toRoomTime(performance.now()) > plan.startRoomTime - FREEZE_BEFORE_MS) return skip('plan arrived too late');
    const remote: Remote = { planId: plan.id, cancelled: false, cleanup: [], prepared: null, failed: null, capturing: true };
    this.remote = remote;
    try {
      const input = await this.openInput(remote);
      const recorder = await startRecorder(this.engine.ctx!, input.input);
      remote.cleanup.push(() => recorder.abort());
      await this.captureFor(plan, remote, { recorder, stopTracks: input.stopTracks, outputBluetooth: input.outputBluetooth });
    } catch (e) {
      if (!(e instanceof Cancelled)) skip(errMsg(e)); // so the listener doesn't wait for us
      this.releaseRemote(remote);
    }
  }

  /** record the plan through an open recorder, analyse, send the rows to the listener */
  private async captureFor(plan: CalibrationPlan, remote: Remote, p: { recorder: Recorder; stopTracks: () => void; outputBluetooth: boolean }) {
    const sendRows = (rows: CalibrationRow[], valid: boolean, reason?: string) =>
      this.send({ type: 'CALIBRATION_ROWS', planId: plan.id, rows, valid, outputBluetooth: p.outputBluetooth, ...(reason ? { reason: reason.slice(0, 200) } : {}) });
    // phones stop the mic in the background: tell the listener at once instead of sending a broken recording
    remote.cleanup.push(
      onPageHidden(() => {
        sendRows([], false, 'its screen locked or it switched apps');
        this.cancelRun(remote);
      }),
    );
    try {
      const ctx = this.engine.ctx!;
      patch('calibration', { recorderStep: 'recording' });
      await this.untilRoom(plan.startRoomTime - FREEZE_BEFORE_MS, remote);
      const startCtx = p.recorder.startCtx();
      if (startCtx === null) throw new Error('The microphone produced no audio.');
      // a recorder whose clock is still being re-acquired can't time anything (its rate estimates only cost ranging accuracy)
      const settled = this.settleVerdict();
      const snap = this.snapshot();
      const toRoomMs = this.freezeMap(startCtx, ctx.sampleRate, snap.frozen);
      await this.untilRoom(plan.startRoomTime + calibrationRecordingMs(plan.slots) + 300, remote);
      const rec = await p.recorder.stop();
      p.stopTracks();
      const v = settled.ok || !settled.hard ? this.validity(snap) : { valid: false, reason: `its clock had not settled (${settled.reason})` };
      const a = analyzeRecording({ plan, recording: rec.samples, sampleRate: ctx.sampleRate, toRoomMs });
      this.send({ type: 'CALIBRATION_ROWS', planId: plan.id, rows: a.rows, valid: v.valid, emissionValid: v.valid, outputBluetooth: p.outputBluetooth, ...(v.valid ? {} : { reason: v.reason!.slice(0, 200) }) });
    } catch (e) {
      if (!(e instanceof Cancelled)) sendRows([], false, errMsg(e)); // so the listener doesn't wait for us
    } finally {
      this.releaseRemote(remote);
    }
  }

  /**
   * Tune with this device as the listener, in rounds (docs/CALIBRATION.md "Rounds"). Round 0, full: every device
   * with a mic records too (distances → positions, head placed behind this device), then timing, levels and EQ;
   * quick: only this device records, timing only (after a Bluetooth/route change), positions and level/EQ
   * untouched. Later rounds replay, listener-only, the devices not yet confirmed (two readings that agree) until
   * every device is confirmed, varies or is given up on — or "Finish now". Pauses playback for the duration if
   * this device may control it, and resumes afterwards.
   */
  async start(opts: { quick?: boolean } = {}): Promise<void> {
    if (this.run) return;
    const run = newRun();
    this.run = run;
    const check = () => {
      if (run.cancelled) throw new Cancelled();
    };
    patch('calibration', {
      running: true,
      step: 'place',
      progress: 0,
      message: heldAtHead(useRoomStore.getState().room?.devices.find((d) => d.id === useRoomStore.getState().deviceId)?.caps.deviceClass ?? 'unknown')
        ? 'Hold this phone at your head where you listen, keep still and keep the room quiet.'
        : 'Sit where you listen with this device and keep the room quiet.',
      freqs: null,
      targetDb: null,
      devices: [],
      warnings: [],
      quick: !!opts.quick,
      waitingFor: [],
      round: 0,
      finishing: false,
    });
    try {
      const ctx = this.engine.ctx;
      const st = useRoomStore.getState();
      const room = st.room;
      if (!ctx || !this.clock() || !room) throw new Error('Join the speaker array first.');
      if (!mayControl()) throw new Error(HOST_ONLY);
      if (this.remote || this.emittingPlanId) throw new Error(BUSY);
      const myId = st.deviceId;
      const myClass = room.devices.find((d) => d.id === myId)?.caps.deviceClass ?? 'unknown';
      const deviceIds = room.devices.filter((d) => d.connected).map((d) => d.id);
      this.pauseDuring(run);

      patch('calibration', { step: 'mic', message: 'Allow microphone access…' });
      const lis = await this.openListener(run, deviceIds, (message) => patch('calibration', { message }));
      const { selfExcluded, settleWarnings } = lis;
      const rounds: TuneRound[] = [];
      let plan0: CalibrationPlan | null = null;
      let first: { analysis: RecordingAnalysis; samples: Float32Array } | null = null;
      let emitters = lis.ids;
      let elapsed = 0;
      let lastReason: string | undefined;
      let anchorId: string | null = null;
      for (let k = 0; ; k++) {
        check();
        const slots = buildTuneSlots(emitters);
        let plan: CalibrationPlan;
        let rec: Awaited<ReturnType<typeof this.recordPlan>>;
        try {
          if (k === 0) {
            // a full tune asks the other recorders to open their mics first (CALIBRATION_PREPARE → READY), so the
            // plan can start sooner and nobody is prompted mid-run; the server plans at the last answer or its deadline
            const all = !opts.quick;
            plan = await this.requestPlan(
              run,
              { type: 'CALIBRATION_START', slots, purpose: 'calibrate', recorders: all ? 'all' : 'listener', ...(all ? { prepare: true } : {}) },
              all ? CALIBRATION_PREPARE_DEADLINE_MS + 6000 : 8000,
            );
            plan0 = plan;
          } else {
            plan = await this.requestPlan(run, { type: 'CALIBRATION_NEXT_ROUND', planId: plan0!.id, slots }, 8000);
          }
          check();
          patch('calibration', { step: 'recording', round: k, progress: 0, message: k === 0 ? 'Listen: each speaker plays one chime in turn.' : roundMessage(k, emitters, anchorId) });
          rec = await this.recordPlan(run, lis.recorder, plan, (progress) => patch('calibration', { progress }));
        } catch (e) {
          if (run.cancelled || k === 0) throw e;
          // "Finish now" (the round playing is dropped: stop its chimes), or a round the server wouldn't plan (an
          // older server, the run lost): keep what the finished rounds measured
          if (e instanceof Finishing) this.send({ type: 'CALIBRATION_CANCEL', planId: plan0!.id });
          else console.warn('[calibration] no further round:', errMsg(e));
          break;
        }
        patch('calibration', { step: 'analyzing', progress: 1, message: 'Analyzing…' });
        await sleep(0); // let the UI paint before the heavy analysis
        const own = analyzeRecording({ plan, recording: rec.samples, sampleRate: ctx.sampleRate, toRoomMs: rec.toRoomMs });
        check();
        if (k === 0) first = { analysis: own, samples: rec.samples };
        if (!rec.valid) console.warn('[calibration] round discarded:', rec.reason);
        lastReason = rec.reason;
        rounds.push({ round: k, emitters, rows: own.rows, valid: rec.valid, faults: (run.roundFaults[k] ??= {}), responses: own.responses, broadbandSnrDb: own.broadbandSnrDb });
        elapsed += calibrationRecordingMs(plan.slots);
        run.roundsDone++;
        const progress = this.progressOf(run, rounds, lis.ids, myId);
        anchorId = progress.anchorId;
        this.publishProgress(plan0!.id, k, progress, false);
        if (progress.discardedInARow >= 2) {
          // the listener's own clocks keep moving: nothing it records can be compared
          if (!progress.usable.length && rounds.every((r) => !r.valid)) throw new Error(`This device's clocks moved during the run (${lastReason}). Run it again.`);
          break;
        }
        if (run.finishing) break;
        const next = nextRoundEmitters(progress, k + 1, elapsed);
        if (!next) break;
        emitters = next;
      }
      const plan = plan0!;

      const emitted = plan.slots.map((s) => s.deviceId);
      // (read through a call: TS narrows `run.prepare` to the null assigned at the start)
      const prep = prepareOf(run);
      // asked to prepare but never answered (a locked phone): not waited for, named in the result
      const stragglers = prep ? prep.expected.filter((id) => !(id in prep.answered)) : [];
      const declined = prep ? Object.entries(prep.answered).filter(([, v]) => v !== 'ok') : [];
      if (!opts.quick) {
        // the other recorders sent their rows when round 0's recording ended (usually long ago): those that answered
        // READY, and tabs on older code (not asked) that open their mic when the plan arrives
        patch('calibration', { message: 'Collecting the other devices’ measurements…' });
        const expected = (useRoomStore.getState().room?.devices ?? []).filter(
          (d) =>
            d.id !== myId &&
            emitted.includes(d.id) &&
            d.connected &&
            d.caps.hasMic &&
            (!prep || prep.answered[d.id] === 'ok' || (!prep.expected.includes(d.id) && d.caps.micPermission === undefined)),
        );
        const deadline = performance.now() + ROWS_WAIT_MS;
        while (performance.now() < deadline && !expected.every((d) => run.rows[d.id])) {
          check();
          await sleep(100);
        }
      }
      // ranging: round 0's own cells (every device's output as it was while the recorders listened), unless this
      // device's clocks moved during round 0
      const rows: RowsByRecorder = { ...run.rows, ...(rounds[0]!.valid ? { [myId]: rounds[0]!.rows.map((r) => ({ ...r })) } : {}) };
      for (const [id, r] of Object.entries(rows)) if (!r.length) delete rows[id];
      // devices whose clocks moved while they played round 0: their cells say nothing about their distances
      const faulted = Object.keys(run.faults);
      if (faulted.length) for (const r of Object.values(rows)) for (const row of r) if (faulted.includes(row.emitterId)) row.mMs = null;
      // timing, levels and EQ: every device's confirmed reading (late fault reports included)
      const progress = this.progressOf(run, rounds, lis.ids, myId);
      const merged = mergeTuneRounds(rounds, progress);

      const scene = useRoomStore.getState().room?.scene ?? room.scene;
      const devices = useRoomStore.getState().room?.devices ?? room.devices;
      const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
      const report = solveTune({
        rows,
        timingRow: merged.row,
        names: Object.fromEntries(devices.map((d) => [d.id, d.name])),
        listenerId: myId,
        responses: merged.responses,
        broadbandSnrDb: merged.broadbandSnrDb,
        sampleRate: ctx.sampleRate,
        scene,
        deviceIds: lis.ids,
        placeHead: !opts.quick,
        headOffsetM: headOffsetFor(myClass),
        detached: [...devices.filter(isDetached).map((d) => d.id), ...run.bluetooth],
      });
      check();

      const heard = report.devices.filter((d) => d.heard);
      if (!heard.length) {
        failedRecording = first ? { samples: first.samples, sampleRate: ctx.sampleRate } : null;
        if (first) {
          console.table(first.analysis.rows);
          console.warn('[calibration] nobody heard', { recordingPeakDb: first.analysis.recordingPeakDb, recordingRmsDb: first.analysis.recordingRmsDb });
        }
        throw new Error(first ? explainNotHeard(first.analysis) : 'No speakers were heard.');
      }
      failedRecording = null;

      const nudged = devices.filter((d) => heard.some((h) => h.deviceId === d.id) && d.latencyMs !== 0);
      if (!opts.quick) {
        const grown = growRoom(scene.room, [...Object.values(report.positions), report.listener]);
        this.applyScene({ devices: report.positions, listener: report.listener, ...(grown ? { room: grown } : {}) });
      }
      const results: CalibrationDeviceResult[] = report.devices.map((d) => {
        const fit = report.eq[d.deviceId];
        const trim = report.trims[d.deviceId];
        return {
          deviceId: d.deviceId,
          heard: d.heard,
          // the geometry-free invariant; the server derives the compensation from it and the current positions
          ...(d.heard && d.arrivalMs !== null ? { tuneArrivalMs: Math.max(0, Math.min(5000, d.arrivalMs)) } : {}),
          // a quick (timing-only) pass leaves EQ and level results alone; a full pass also clears an old hint
          ...(opts.quick
            ? {}
            : {
                ...(fit ? { eq: fit.eq } : {}),
                ...(d.rolloffHz !== null ? { rolloffHz: Math.max(10, Math.min(2000, d.rolloffHz)) } : {}),
                ...(d.bassCapable !== null ? { bassCapable: d.bassCapable } : {}),
                ...(trim !== undefined ? { trimDb: Math.max(-24, Math.min(12, trim)) } : {}),
                ...(d.levelDb !== null ? { levelDb: d.levelDb } : {}),
                volumeUpDb: report.volumeUp[d.deviceId] ?? null,
              }),
        };
      });
      const tune = {
        mic: report.positions[myId] ?? scene.listener,
        quick: !!opts.quick,
        ranged: report.devices.filter((d) => d.ranged).map((d) => d.deviceId),
        // where each heard device was when its arrival was measured
        positions: Object.fromEntries(
          results.filter((r) => r.tuneArrivalMs !== undefined && report.positions[r.deviceId]).map((r) => [r.deviceId, report.positions[r.deviceId]!]),
        ),
      };
      if (!this.send({ type: 'CALIBRATION_RESULT', planId: plan.id, results, tune })) throw new Error('Lost the connection before the results could be saved.');
      this.publishProgress(plan.id, rounds.length - 1, progress, true);
      // the check: every timed speaker clicks through its new compensation; one that lands off is corrected once
      const check0 = await this.checkTune(run, lis, plan.id, results, tune);
      lis.recorder.abort();
      lis.release(); // mic off now (and, on iOS, the audio session back to playback)
      // the manual nudge compensated exactly what was just measured: keeping it would double-count
      for (const d of nudged) this.send({ type: 'DEVICE_UPDATE', targetDeviceId: d.id, patch: { latencyMs: 0 } });
      // a phone held at the head would play right at the listener's ear: mute it as a speaker (others carry the sound)
      const mutedSelf = !opts.quick && heldAtHead(myClass) && heard.some((h) => h.deviceId !== myId) && !devices.find((d) => d.id === myId)?.muted;
      if (mutedSelf) this.send({ type: 'DEVICE_UPDATE', patch: { muted: true } });

      const stateOf = (id: string) => progress.devices.find((p) => p.deviceId === id);
      const ui: CalibrationDeviceUi[] = report.devices.map((d) => ({
        deviceId: d.deviceId,
        heard: d.heard,
        relativeLatencyMs: d.relativeLatencyMs,
        snrDb: d.snrDb,
        levelDb: d.levelDb,
        rolloffHz: d.rolloffHz,
        distanceM: d.distanceM,
        ranged: d.ranged,
        beforeDb: d.response?.db ?? null,
        afterDb: report.eq[d.deviceId]?.predictedDb ?? null,
        ...progressUi(stateOf(d.deviceId)),
        checkMs: check0.verification?.offsetMs[d.deviceId] ?? null,
        wobbleMs: check0.verification?.wobble[d.deviceId] ?? null,
      }));
      const missing = report.devices.length - heard.length;
      const unconfirmed = progress.devices.filter((p) => p.valueMs !== null && (p.state === 'checking' || p.state === 'too-loud'));
      const varies = progress.devices.filter((p) => p.state === 'varies');
      const gone = progress.devices.filter((p) => p.state === 'skipped' && (p.hint === 'clock' || p.hint === 'left') && p.valueMs === null);
      const notes = [
        ...(selfExcluded ? [BT_SELF_WARNING] : []),
        ...(mutedSelf ? [HELD_MUTED_NOTE] : []),
        ...(nudged.length ? [`Reset the manual delay nudge on ${nudged.map((d) => d.name).join(', ')}: the tune measures it now.`] : []),
        ...gone.map((p) =>
          p.hint === 'left'
            ? `${nameOf(p.deviceId)} left the room during the tune.`
            : `${nameOf(p.deviceId)} wasn't timed: its clock kept moving while it played. Tune again to include it.`,
        ),
        ...varies.map(
          (p) =>
            `${nameOf(p.deviceId)}'s timing varies by about ±${(p.spreadMs ?? 0).toFixed(1)} ms from one chime to the next (Bluetooth often does), so it can drift slightly from the others.`,
        ),
        ...unconfirmed.map((p) => `${nameOf(p.deviceId)} was measured once and couldn't be confirmed${run.finishing ? ' (finished early)' : ''}. Tune again to check it.`),
        ...check0.notes,
        ...stragglers.map((id) => `${nameOf(id)} didn't answer in time, so it didn't listen (skipped). Keep its screen on and tune again to measure its position.`),
        ...declined.map(([id, why]) => `${nameOf(id)} couldn't listen: ${why}.`),
        ...settleWarnings,
        ...report.warnings.filter((w) => !gone.some((p) => w.includes(`hear ${nameOf(p.deviceId)} `))),
      ];
      const roundsNote = rounds.length > 1 ? ` in ${rounds.length} rounds` : '';
      patch('calibration', {
        step: 'done',
        message: missing
          ? `Tuned ${heard.length} of ${report.devices.length} devices${roundsNote}; ${missing} not heard.`
          : `Tuned ${heard.length} device${heard.length === 1 ? '' : 's'}${roundsNote}.`,
        freqs: report.devices.find((d) => d.response)?.response?.freqs ?? null,
        targetDb: report.targetDb,
        devices: ui,
        warnings: notes,
      });
      // the listener's own output wasn't measured, so its route-change prompt still stands
      if (!selfExcluded) useRoomStore.setState({ routeChanged: false });
    } catch (e) {
      if ((e instanceof Cancelled || run.cancelled) && run.reason) patch('calibration', { step: 'error', message: run.reason });
      else if (e instanceof Cancelled || run.cancelled) patch('calibration', { step: 'idle', message: 'Calibration cancelled.', progress: 0 });
      else patch('calibration', { step: 'error', message: errMsg(e) });
    } finally {
      for (const c of run.cleanup) {
        try {
          c();
        } catch {
          /* best effort */
        }
      }
      if (this.run === run) this.run = null;
      patch('calibration', { running: false, finishing: false });
    }
  }

  /**
   * The check after a tune: once the room carries the result, every timed speaker clicks VERIFY_CLICKS times through
   * its full compensation (a short sync check) and `verifyTune` finds one that lands off at the head (an output step
   * the tune couldn't see, a compensation that didn't apply). It is corrected by resending the result with its
   * arrival moved, and checked once more. Never fails the tune: a check that can't run says so in a note.
   */
  private async checkTune(
    run: Run,
    lis: Listening,
    tuneId: string,
    results: CalibrationDeviceResult[],
    tune: Extract<ClientMessage, { type: 'CALIBRATION_RESULT' }>['tune'],
  ): Promise<{ verification: TuneVerification | null; notes: string[] }> {
    const arrivals = Object.fromEntries(results.flatMap((r) => (r.tuneArrivalMs !== undefined ? [[r.deviceId, r.tuneArrivalMs] as const] : [])));
    const ids = Object.keys(arrivals);
    if (ids.length < 2 || run.finishing) return { verification: null, notes: [] };
    const nameOf = (id: string) => nameOfDevice(id);
    let current = results;
    let verification: TuneVerification | null = null;
    const notes: string[] = [];
    try {
      for (let pass = 0; pass < 2; pass++) {
        patch('calibration', { step: 'checking', progress: 0, message: pass ? 'Checking the correction…' : 'Checking the result: every speaker clicks a few times…' });
        // the room must carry this result first (the server derives each speaker's compensation from it)
        const want = Object.fromEntries(current.flatMap((r) => (r.tuneArrivalMs !== undefined ? [[r.deviceId, r.tuneArrivalMs] as const] : [])));
        const t0 = performance.now();
        const applied = () => {
          const devs = useRoomStore.getState().room?.devices ?? [];
          return ids.every((id) => {
            const d = devs.find((x) => x.id === id);
            return d?.tuneId === tuneId && d.tuneArrivalMs !== null && Math.abs((d.tuneArrivalMs ?? 0) - want[id]!) < 1e-6;
          });
        };
        while (!applied()) {
          if (run.cancelled) throw new Cancelled();
          if (performance.now() - t0 > 5000) throw new Error("the room didn't take the result in time");
          await sleep(100);
        }
        await sleep(1000); // every speaker's engine picks up its new compensation
        const period = Math.max(1000, ids.length * SYNC_STAGGER_MS);
        const slots = buildSyncMeasurementSlots(ids, { durationSec: (VERIFY_CLICKS * period) / 1000 });
        const plan = await this.requestPlan(run, { type: 'CALIBRATION_START', slots, purpose: 'measure', recorders: 'listener' }, 8000);
        const rec = await this.recordPlan(run, lis.recorder, plan, (progress) => patch('calibration', { progress }));
        // free the room at once (a second check follows within the run's tail)
        this.send({ type: 'CALIBRATION_CANCEL', planId: plan.id });
        if (!rec.valid) throw new Error(`this device's clocks moved during the check (${rec.reason})`);
        const room = useRoomStore.getState().room!;
        const myId = useRoomStore.getState().deviceId;
        const sync = analyzeSyncMeasurement({
          plan,
          recording: rec.samples,
          sampleRate: this.engine.ctx!.sampleRate,
          toRoomMs: rec.toRoomMs,
          // playback aligns at the head (or at emission), not at this mic: score against that expectation
          expectedMs: expectedArrivalMs(room.scene, room.scene.devices[myId] ?? room.scene.listener, myId, ids),
        });
        verification = verifyTune(sync.devices, want);
        console.info('[calibration] check', pass, verification);
        if (!verification.corrected) break;
        const off = Object.entries(verification.offsetMs).filter(([id]) => verification!.corrected![id] !== want[id]);
        if (pass === 1) {
          notes.push(...off.map(([id, ms]) => `${nameOf(id)} still lands ${Math.abs(ms).toFixed(1)} ms ${ms > 0 ? 'late' : 'early'} after a correction. Tune again.`));
          break;
        }
        const corrected = verification.corrected;
        current = current.map((r) => (r.tuneArrivalMs !== undefined && corrected[r.deviceId] !== undefined ? { ...r, tuneArrivalMs: corrected[r.deviceId] } : r));
        if (!this.send({ type: 'CALIBRATION_RESULT', planId: tuneId, results: current, tune })) throw new Error('lost the connection');
        notes.push(
          ...off.map(([id, ms]) => `${nameOf(id)} landed ${Math.abs(ms).toFixed(1)} ms ${ms > 0 ? 'late' : 'early'} through its speaker; corrected.`),
        );
      }
    } catch (e) {
      if (e instanceof Cancelled && run.cancelled) throw e;
      console.warn('[calibration] check skipped:', errMsg(e));
      notes.push(e instanceof Finishing ? 'The result was applied without its check (finished early).' : `The result couldn't be checked (${errMsg(e)}); it is applied as measured.`);
      return { verification, notes };
    }
    if (verification)
      notes.push(
        ...Object.entries(verification.wobble).map(
          ([id, ms]) => `${nameOf(id)}'s clicks varied by about ±${ms.toFixed(1)} ms in the check (Bluetooth often does), so it can drift slightly from the others.`,
        ),
        ...verification.unverified.map((id) => `${nameOf(id)} wasn't heard in the check; its timing is as the tune measured it.`),
      );
    return { verification, notes };
  }

  /** where every device of this run stands (a Bluetooth output confirms on three readings: its latency jitters) */
  private progressOf(run: Run, rounds: TuneRound[], ids: string[], myId: string): TuneProgress {
    const devices = useRoomStore.getState().room?.devices ?? [];
    const bt = new Set([...devices.filter(isDetached).map((d) => d.id), ...run.bluetooth]);
    return tuneProgress(rounds, {
      listenerId: myId,
      deviceIds: ids,
      connected: devices.filter((d) => d.connected).map((d) => d.id),
      confirm: Object.fromEntries(ids.filter((id) => bt.has(id)).map((id) => [id, TUNE_CONFIRM_BLUETOOTH])),
    });
  }

  /** show every device's line here and tell the room (each device shows its own) */
  private publishProgress(planId: string, round: number, progress: TuneProgress, done: boolean) {
    const entries: TuneStatusEntry[] = progress.devices.map((p) => ({
      deviceId: p.deviceId,
      state: p.state,
      ...(p.hint ? { hint: p.hint } : {}),
      ...(p.spreadMs !== null ? { spreadMs: Math.min(10000, p.spreadMs) } : {}),
    }));
    this.send({ type: 'CALIBRATION_STATUS', planId, round, devices: entries, ...(done ? { done: true } : {}) });
    if (done) return;
    patch('calibration', {
      round,
      devices: progress.devices.map((p) => ({
        deviceId: p.deviceId,
        heard: p.valueMs !== null,
        relativeLatencyMs: null,
        snrDb: null,
        levelDb: null,
        rolloffHz: null,
        distanceM: null,
        ranged: false,
        beforeDb: null,
        afterDb: null,
        ...progressUi(p),
      })),
    });
  }

  /** "Finish now": no further rounds (the one playing is dropped); what the finished rounds measured is applied */
  finishNow(): void {
    const run = this.run;
    if (!run || run.finishing || run.roundsDone < 1) return;
    run.finishing = true;
    patch('calibration', { finishing: true, message: 'Finishing with what’s measured…' });
    if (run.awaitingRound) run.interrupt?.(new Finishing());
  }

  /** a refusal from the server while a tune waits for its next round (an older server, the run lost): finish */
  onError(code: string): boolean {
    const run = this.run;
    if (!run?.awaitingRound || !['unknown_plan', 'bad_plan', 'bad_message', 'forbidden'].includes(code)) return false;
    run.interrupt?.(new Error(`the server refused another round (${code})`));
    return true;
  }

  /** the room's tune status (any listener's): keep this device's own line for its banner */
  onStatus(msg: { planId: string; listenerId: string; round: number; devices: TuneStatusEntry[]; done?: boolean }): void {
    const myId = useRoomStore.getState().deviceId;
    if (msg.listenerId === myId) return; // the listener shows every line itself
    const me = msg.devices.find((d) => d.deviceId === myId);
    patch('calibration', {
      selfStatus: me ? { planId: msg.planId, state: me.state, hint: me.hint ?? null, done: !!msg.done, round: msg.round, at: Date.now() } : null,
    });
  }

  /** poll until the room clock + audio clock are usable; give up after TIMING_WAIT_MS */
  private async waitForTiming(run: { cancelled: boolean }): Promise<void> {
    const deadline = performance.now() + TIMING_WAIT_MS;
    while (!this.engine.timingReady()) {
      if (run.cancelled) throw new Cancelled();
      if (performance.now() > deadline) {
        throw new Error("Couldn't sync this device's clock with the room. Check your connection and try again.");
      }
      await sleep(100);
    }
  }

  /**
   * The listener's side of a run: open the mic (or loopback) and one recorder that runs until the run ends (every
   * round of a tune shares it, so its output never steps between rounds), let the output settle, wait for the clocks.
   */
  private async openListener(run: Run, deviceIds: string[], onWaiting: (message: string) => void): Promise<Listening> {
    const check = () => {
      if (run.cancelled) throw new Cancelled();
    };
    const ctx = this.engine.ctx!;
    const lb = this.engine.loopback();
    let stream: MediaStream | null = null;
    let release = () => {};
    let selfExcluded = false;
    // a locked screen / switched app stops the mic and the sweeps on phones: stop with a reason, not garbage
    run.cleanup.push(
      onPageHidden(() => {
        run.reason = HIDDEN_ERROR;
        this.cancelRun(run);
      }),
    );
    if (!lb) {
      const mic = await openCalibrationMic();
      run.cleanup.push(mic.release);
      stream = mic.stream;
      release = mic.release;
      const { room, deviceId } = useRoomStore.getState();
      selfExcluded = mic.outputBluetooth || room?.devices.find((d) => d.id === deviceId)?.caps.deviceClass === 'bluetooth';
    }
    check();
    const myId = useRoomStore.getState().deviceId;
    const ids = selfExcluded ? deviceIds.filter((id) => id !== myId) : deviceIds;
    if (!ids.length) throw new Error(`${BT_SELF_WARNING} No other speakers are connected yet.`);
    const recorder = await startRecorder(ctx, stream ?? lb!);
    run.cleanup.push(() => recorder.abort());
    check();
    // Opening an input can re-open/resize the output path (Bluetooth switching to its headset profile; Chromium
    // adds ~44 ms of output buffering when a recorder graph starts). Let it settle so the audio-clock map has
    // re-converged (step confirmation needs ~0.75 s) before anything is scheduled.
    await sleep(1500);
    check();
    // The clock/audio-clock mapping may still be converging (it needs ~1 s after joining). The mic is already
    // open (so the permission prompt stayed tied to the user's tap), so wait here instead of failing.
    if (!this.engine.timingReady()) {
      onWaiting('Syncing clocks…');
      await this.waitForTiming(run);
    }
    // …and steady: a clock still catching up would time every chime against a moving reference
    const settleWarnings = await this.waitForSettled(run, onWaiting);
    check();
    return { recorder, release, selfExcluded, ids, settleWarnings };
  }

  /** send what makes the server plan (a run's start, or a tune's next round) and wait for that plan */
  private requestPlan(run: Run, msg: ClientMessage, timeoutMs: number): Promise<CalibrationPlan> {
    return new Promise<CalibrationPlan>((resolve, reject) => {
      const done = () => {
        clearTimeout(t);
        run.planWaiter = null;
        run.interrupt = null;
        run.awaitingRound = false;
      };
      const t = setTimeout(() => {
        done();
        reject(new Error("The server didn't start the run. Try again."));
      }, timeoutMs);
      run.planWaiter = (p) => {
        done();
        run.planId = p.id;
        resolve(p);
      };
      run.interrupt = (e) => {
        done();
        reject(e);
      };
      run.awaitingRound = msg.type === 'CALIBRATION_NEXT_ROUND';
      run.cleanup.push(() => {
        done();
        reject(new Cancelled());
      });
      if (!this.send(msg)) {
        done();
        reject(new Error('Not connected to the room.'));
      }
    });
  }

  /**
   * Record one plan through the running recorder: freeze its room-time map just before the first slot, take the
   * samples once the plan has ended (from just before its start), check that the clocks stayed put. "Finish now"
   * interrupts it (Finishing).
   */
  private async recordPlan(run: Run, recorder: Recorder, plan: CalibrationPlan, onProgress: (p: number) => void) {
    const guard = {
      get cancelled() {
        return run.cancelled || run.finishing;
      },
    };
    const wait = async (roomMs: number, progress?: (now: number) => void) => {
      try {
        await this.untilRoom(roomMs, guard, progress);
      } catch (e) {
        if (e instanceof Cancelled && !run.cancelled && run.finishing) throw new Finishing();
        throw e;
      }
    };
    const sampleRate = this.engine.ctx!.sampleRate;
    const late = plan.purpose === 'measure' ? SYNC_SEARCH_LATE_MS : undefined;
    const endRoom = plan.startRoomTime + calibrationRecordingMs(plan.slots, late) + 300;
    await wait(plan.startRoomTime - FREEZE_BEFORE_MS);
    const startCtx = recorder.startCtx();
    if (startCtx === null) throw new Error('The microphone produced no audio.');
    const snap = this.snapshot();
    const map = this.freezeMap(startCtx, sampleRate, snap.frozen);
    await wait(endRoom, (now) => onProgress(Math.min(1, Math.max(0, (now - plan.startRoomTime) / (endRoom - plan.startRoomTime)))));
    const all = await recorder.take();
    const v = this.validity(snap);
    // this plan's part of the recording: from just before its start (the lead-in silence is the noise reference)
    const i0 = Math.max(0, Math.floor(indexMap(map, all.samples.length)(plan.startRoomTime - FREEZE_BEFORE_MS)));
    return {
      samples: all.samples.subarray(i0),
      toRoomMs: (i: number) => map(i0 + i),
      valid: v.valid,
      ...(v.valid ? {} : { reason: v.reason }),
    };
  }

  /** one plan with this device listening (a sync check): mic → recorder → CALIBRATION_START → plan → record it */
  private async record(
    run: Run,
    deviceIds: string[],
    buildSlots: (deviceIds: string[]) => CalibrationPlan['slots'],
    purpose: 'calibrate' | 'measure',
    recorders: 'listener' | 'all',
    onWaiting: (message: string) => void,
    onRecording: () => void,
    onProgress: (p: number) => void,
  ) {
    const lis = await this.openListener(run, deviceIds, onWaiting);
    const prepare = purpose === 'calibrate' && recorders === 'all';
    const plan = await this.requestPlan(
      run,
      { type: 'CALIBRATION_START', slots: buildSlots(lis.ids), purpose, recorders, ...(prepare ? { prepare: true } : {}) },
      prepare ? CALIBRATION_PREPARE_DEADLINE_MS + 6000 : 8000,
    );
    if (run.cancelled) throw new Cancelled();
    onRecording();
    const r = await this.recordPlan(run, lis.recorder, plan, onProgress);
    lis.recorder.abort();
    lis.release(); // mic off now (and, on iOS, the audio session back to playback), not after the analysis
    return { plan, rec: { samples: r.samples }, toRoomMs: r.toRoomMs, valid: r.valid, reason: r.reason, selfExcluded: lis.selfExcluded, settleWarnings: lis.settleWarnings };
  }

  /** pause playback for this run if this device may control it; resume the same track when the run ends */
  private pauseDuring(run: { cleanup: Array<() => void> }) {
    const st = useRoomStore.getState();
    const room = st.room;
    const me = room?.devices.find((d) => d.id === st.deviceId);
    if (!room || room.playback.status !== 'playing' || !(me?.isHost || !room.settings.hostOnlyControl)) return;
    const trackId = room.playback.trackId;
    this.send({ type: 'CONTROL', command: { type: 'pause' } });
    run.cleanup.push(() => {
      const pb = useRoomStore.getState().room?.playback;
      if (pb?.status === 'paused' && pb.trackId === trackId) this.send({ type: 'CONTROL', command: { type: 'play' } });
    });
  }

  /** Sync check: every device clicks (time-staggered wideband chirps) through normal compensation; this device listens. */
  async measureSync(durationSec = 60): Promise<void> {
    if (this.run) return;
    const run = newRun();
    this.run = run;
    patch('syncMeasure', { running: true, step: 'recording', progress: 0, message: 'Allow microphone access…', durationSec, devices: [], histogram: null, overall: null, warnings: [] });
    try {
      const ctx = this.engine.ctx;
      const room = useRoomStore.getState().room;
      if (!ctx || !this.clock() || !room) throw new Error('Join the speaker array first.');
      if (!mayControl()) throw new Error(HOST_ONLY);
      if (this.remote || this.emittingPlanId) throw new Error(BUSY);
      const deviceIds = room.devices.filter((d) => d.connected).map((d) => d.id);
      this.pauseDuring(run);
      const { plan, rec, toRoomMs, selfExcluded, valid, reason, settleWarnings } = await this.record(
        run,
        deviceIds,
        (ids) => buildSyncMeasurementSlots(ids, { durationSec }),
        'measure',
        'listener',
        (message) => patch('syncMeasure', { message }),
        () => patch('syncMeasure', { message: `Measuring for ${durationSec} s: every speaker clicks in turn, once a second.` }),
        (progress) => patch('syncMeasure', { progress }),
      );
      if (!valid) throw new Error(`This device's clocks moved during the measurement (${reason}). Run it again.`);
      patch('syncMeasure', { step: 'analyzing', progress: 1, message: 'Analyzing…' });
      await sleep(0);
      const scene = useRoomStore.getState().room?.scene ?? room.scene;
      const myId = useRoomStore.getState().deviceId;
      const ids = plan.slots.map((s) => s.deviceId);
      const report = analyzeSyncMeasurement({
        plan,
        recording: rec.samples,
        sampleRate: ctx.sampleRate,
        toRoomMs,
        // playback aligns at the head (or at emission), not at this mic: score against that expectation
        expectedMs: expectedArrivalMs(scene, scene.devices[myId] ?? scene.listener, myId, ids),
      });
      if (!report.overall.samples && !report.devices.some((d) => d.detected)) throw new Error(report.warnings[0] ?? 'No clicks detected.');
      patch('syncMeasure', {
        step: 'done',
        message:
          report.devices.length > 1
            ? `Inter-device sync error: p50 ${report.overall.p50AbsMs.toFixed(2)} ms, p95 ${report.overall.p95AbsMs.toFixed(2)} ms over ${report.overall.samples} clicks.`
            : `Single device: click timing jitter ${report.devices[0]?.stdMs.toFixed(2)} ms rms (${report.devices[0]?.detected}/${report.devices[0]?.total} clicks).`,
        devices: report.devices.map(({ deviceId, detected, total, meanMs, stdMs, p95AbsMs, maxAbsMs }) => ({ deviceId, detected, total, meanMs, stdMs, p95AbsMs, maxAbsMs })),
        histogram: { edgesMs: report.histogram.edgesMs, counts: report.histogram.counts },
        overall: report.overall,
        warnings: [...(selfExcluded ? [BT_SELF_WARNING] : []), ...settleWarnings, ...report.warnings],
      });
    } catch (e) {
      if ((e instanceof Cancelled || run.cancelled) && run.reason) patch('syncMeasure', { step: 'error', message: run.reason });
      else if (e instanceof Cancelled || run.cancelled) patch('syncMeasure', { step: 'idle', message: 'Measurement cancelled.', progress: 0 });
      else patch('syncMeasure', { step: 'error', message: errMsg(e) });
    } finally {
      for (const c of run.cleanup) {
        try {
          c();
        } catch {
          /* best effort */
        }
      }
      if (this.run === run) this.run = null;
      patch('syncMeasure', { running: false });
    }
  }

  cancel(): void {
    const planId = this.run?.planId;
    if (this.run) this.cancelRun(this.run);
    if (this.remote) this.releaseRemote(this.remote);
    if (this.run) this.run.planWaiter = null;
    // tell the room: the other devices stop their chimes and recordings, and the room is free for the next tune
    if (planId) this.send({ type: 'CALIBRATION_CANCEL', planId });
    if (planId && this.emittingPlanId === planId) this.stopEmitting();
  }

  private cancelRun(r: { cancelled: boolean; cleanup: Array<() => void> }) {
    r.cancelled = true;
    for (const c of r.cleanup) {
      try {
        c();
      } catch {
        /* best effort */
      }
    }
    r.cleanup = [];
  }

  dispose(): void {
    this.cancel();
    if (this.planTimer) clearInterval(this.planTimer);
  }
}

/** a room size that holds every point with a 0.5 m margin, or null when the current one already does */
function growRoom(room: { width: number; depth: number }, pts: Array<{ x: number; y: number }>): { width: number; depth: number } | null {
  const need = (k: 'x' | 'y') => Math.min(100, Math.ceil((2 * Math.max(0, ...pts.map((p) => Math.abs(p[k]))) + 1) * 2) / 2);
  const width = Math.max(room.width, need('x'));
  const depth = Math.max(room.depth, need('y'));
  return width > room.width || depth > room.depth ? { width, depth } : null;
}
