/**
 * Acoustic calibration. Speaker side: emit this device's slots of a CALIBRATION_PLAN at the planned room
 * times. Listener side: record the mic through an AudioWorklet, analyze, send CALIBRATION_RESULT.
 * Browser-only.
 */
import {
  analyzeCalibration,
  analyzeSyncMeasurement,
  buildSyncMeasurementSlots,
  buildCalibrationSlots,
  calibrationRecordingMs,
  calibrationSignal,
  classPresetEq,
  type ClockSync,
} from '@syncsound/audio-core';
import type { CalibrationDeviceResult, CalibrationPlan, ClientMessage, Device, DevicePatch } from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
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

/** same value for slot building and analysis (guard gaps + search windows) */
const MAX_LATENCY_MS = 500;
/** how long calibration waits for clocks to converge before giving up, ms */
const TIMING_WAIT_MS = 10_000;
/** sync measurement runs after calibration: residuals are small */
const SYNC_MAX_LATENCY_MS = 300;

const registered = new WeakSet<BaseAudioContext>();

interface Recorder {
  stop(): Promise<{ samples: Float32Array; startCtx: number }>;
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
  node.port.onmessage = (e: MessageEvent<{ frames?: Float32Array; start?: number; done?: boolean }>) => {
    if (e.data.start !== undefined) startCtx = e.data.start;
    if (e.data.frames) chunks.push(e.data.frames);
    if (e.data.done) done?.();
  };
  const teardown = () => {
    if (input instanceof MediaStream) src.disconnect();
    else src.disconnect(node);
    node.disconnect();
    sink.disconnect();
  };
  return {
    async stop() {
      await new Promise<void>((resolve) => {
        done = resolve;
        node.port.postMessage('stop');
        setTimeout(resolve, 1000);
      });
      teardown();
      if (startCtx === null) throw new Error('The microphone produced no audio.');
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const samples = new Float32Array(total);
      let o = 0;
      for (const c of chunks) {
        samples.set(c, o);
        o += c.length;
      }
      return { samples, startCtx };
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

/**
 * Open the listener mic, avoiding a Bluetooth headset mic. `outputBluetooth`: this device's own output is (or was
 * just switched to) Bluetooth, so measuring it from here would capture the hands-free profile, not music playback.
 */
async function openCalibrationMic(): Promise<{ stream: MediaStream; outputBluetooth: boolean }> {
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

/** class preset (no-mic fallback) for a device */
export function presetPatch(device: Device): DevicePatch {
  const p = classPresetEq(device.caps.deviceClass);
  return { eq: { ...p.eq, source: 'preset' }, bassCapable: p.bassCapable, rolloffHz: p.rolloffHz };
}

export class CalibrationController {
  private run: { cancelled: boolean; cleanup: Array<() => void>; planWaiter: ((p: CalibrationPlan) => void) | null } | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly send: (m: ClientMessage) => boolean,
    private readonly clock: () => ClockSync | null,
  ) {}

  /** every device receives the plan: emit my slots; the listener's waiter also picks it up */
  onPlan(plan: CalibrationPlan): void {
    const myId = useRoomStore.getState().deviceId;
    if (plan.listenerId === myId && this.run?.planWaiter) this.run.planWaiter(plan);
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (plan.purpose === 'measure') {
      this.emitRepeated(plan, myId);
      return;
    }
    try {
      let end = 0;
      for (const slot of plan.slots) {
        if (slot.deviceId !== myId) continue;
        const r = this.engine.emitAt(calibrationSignal(slot.signal, slot.deviceIndex, ctx.sampleRate), plan.startRoomTime + slot.offsetMs);
        if (r) end = Math.max(end, r.endCtx);
      }
      if (!end) return;
      patch('calibration', { emitting: true });
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = setTimeout(() => patch('calibration', { emitting: false }), (end - ctx.currentTime) * 1000 + 200);
    } catch (e) {
      patch('calibration', { emitting: false, message: `Couldn't play the calibration signal: ${errMsg(e)}` });
    }
  }

  private measureTimer: ReturnType<typeof setInterval> | null = null;

  /** schedule repeated measurement clicks ~1.5 s ahead (so drift/clock corrections apply like real playback) */
  private emitRepeated(plan: CalibrationPlan, myId: string) {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const mine = plan.slots.filter((s) => s.deviceId === myId);
    if (!mine.length) return;
    const pending = mine.flatMap((slot) =>
      Array.from({ length: slot.repeat ?? 1 }, (_, k) => ({
        roomMs: plan.startRoomTime + slot.offsetMs + k * (slot.periodMs ?? 0),
        samples: () => calibrationSignal(slot.signal, slot.deviceIndex, ctx.sampleRate),
      })),
    );
    pending.sort((a, b) => a.roomMs - b.roomMs);
    if (this.measureTimer) clearInterval(this.measureTimer);
    patch('calibration', { emitting: true });
    const tick = () => {
      const clock = this.clock();
      if (!clock || !this.engine.ctx) return;
      const now = clock.toRoomTime(performance.now());
      while (pending.length && pending[0]!.roomMs < now + 1500) {
        const p = pending.shift()!;
        if (p.roomMs > now + 50) this.engine.emitAt(p.samples(), p.roomMs, 'full');
      }
      if (!pending.length && this.measureTimer) {
        clearInterval(this.measureTimer);
        this.measureTimer = null;
        setTimeout(() => patch('calibration', { emitting: false }), 1000);
      }
    };
    tick();
    this.measureTimer = setInterval(tick, 250);
  }

  async start(): Promise<void> {
    if (this.run) return;
    const run = { cancelled: false, cleanup: [] as Array<() => void>, planWaiter: null as ((p: CalibrationPlan) => void) | null };
    this.run = run;
    const check = () => {
      if (run.cancelled) throw new Cancelled();
    };
    patch('calibration', {
      running: true,
      step: 'place',
      progress: 0,
      message: 'Hold this device at your listening position and keep the room quiet.',
      freqs: null,
      targetDb: null,
      devices: [],
      warnings: [],
    });
    try {
      const ctx = this.engine.ctx;
      const clock = this.clock();
      const room = useRoomStore.getState().room;
      if (!ctx || !clock || !room) throw new Error('Join the speaker array first.');
      const deviceIds = room.devices.filter((d) => d.connected).map((d) => d.id);

      patch('calibration', { step: 'mic', message: 'Allow microphone access…' });
      const { plan, rec, selfExcluded } = await this.record(run, deviceIds, (ids) => buildCalibrationSlots(ids, { maxLatencyMs: MAX_LATENCY_MS }), 'calibrate', MAX_LATENCY_MS,
        () => patch('calibration', { message: 'Syncing clocks…' }),
        () => patch('calibration', { step: 'recording', message: 'Listen: each speaker will chirp and sweep in turn.' }),
        (progress) => patch('calibration', { progress }),
      );
      patch('calibration', { step: 'analyzing', progress: 1, message: 'Analyzing…' });
      await new Promise((r) => setTimeout(r, 0)); // let the UI paint before the heavy analysis
      const scene = useRoomStore.getState().room?.scene ?? room.scene;
      const report = analyzeCalibration({
        plan,
        recording: rec.samples,
        sampleRate: ctx.sampleRate,
        // mic input latency (and the output-timestamp offset) is common-mode → cancels in relative latency
        recordingStartRoomTime: clock.toRoomTime(this.engine.audioClock.ctxToPerf(rec.startCtx)),
        devicePositions: scene.devices,
        listener: scene.listener,
        maxLatencyMs: MAX_LATENCY_MS,
      });
      check();

      const heard = report.devices.filter((d) => d.heard);
      if (!heard.length) {
        const floors = report.devices.map((d) => d.noiseFloorDb).filter((x): x is number => x !== null);
        const noisy = floors.length > 0 && Math.max(...floors) > -40;
        throw new Error(
          noisy
            ? 'The room is too noisy to measure. Pause the music, turn off fans/TV and try again.'
            : "No speakers were heard. Turn every device's volume up, unmute them, and keep this device within a few meters.",
        );
      }

      const results: CalibrationDeviceResult[] = report.devices.map((d) => {
        const fit = report.eq[d.deviceId];
        const trim = report.trims[d.deviceId];
        return {
          deviceId: d.deviceId,
          heard: d.heard,
          ...(d.heard && d.relativeLatencyMs !== null
            ? { calibratedLatencyMs: Math.max(-1000, Math.min(1000, d.relativeLatencyMs)) }
            : {}),
          ...(fit ? { eq: fit.eq } : {}),
          ...(d.rolloffHz !== null ? { rolloffHz: Math.max(10, Math.min(2000, d.rolloffHz)) } : {}),
          ...(d.bassCapable !== null ? { bassCapable: d.bassCapable } : {}),
          ...(trim !== undefined ? { trimDb: Math.max(-24, Math.min(12, trim)) } : {}),
          ...(d.levelDb !== null ? { levelDb: d.levelDb } : {}),
        };
      });
      if (!this.send({ type: 'CALIBRATION_RESULT', planId: plan.id, results })) throw new Error('Lost the connection before the results could be saved.');

      const ui: CalibrationDeviceUi[] = report.devices.map((d) => ({
        deviceId: d.deviceId,
        heard: d.heard,
        relativeLatencyMs: d.relativeLatencyMs,
        snrDb: d.snrDb,
        levelDb: d.levelDb,
        rolloffHz: d.rolloffHz,
        beforeDb: d.response?.db ?? null,
        afterDb: report.eq[d.deviceId]?.predictedDb ?? null,
      }));
      const missing = report.devices.length - heard.length;
      patch('calibration', {
        step: 'done',
        message: missing ? `Calibrated ${heard.length} of ${report.devices.length} devices; ${missing} not heard.` : `Calibrated ${heard.length} devices.`,
        freqs: report.devices.find((d) => d.response)?.response?.freqs ?? null,
        targetDb: report.targetDb,
        devices: ui,
        warnings: selfExcluded ? [BT_SELF_WARNING, ...report.warnings] : report.warnings,
      });
      // the listener's own output wasn't measured, so its route-change prompt still stands
      if (!selfExcluded) useRoomStore.setState({ routeChanged: false });
    } catch (e) {
      if (e instanceof Cancelled || run.cancelled) patch('calibration', { step: 'idle', message: 'Calibration cancelled.', progress: 0 });
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
      patch('calibration', { running: false });
    }
  }

  /** poll until the room clock + audio clock are usable; give up after TIMING_WAIT_MS */
  private async waitForTiming(run: { cancelled: boolean }): Promise<void> {
    const deadline = performance.now() + TIMING_WAIT_MS;
    while (!this.engine.timingReady()) {
      if (run.cancelled) throw new Cancelled();
      if (performance.now() > deadline) {
        throw new Error("Couldn't sync this device's clock with the room. Check your connection and try again.");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** mic (or loopback) → recorder → CALIBRATION_START → wait for the plan → record until the plan ends */
  private async record(
    run: NonNullable<CalibrationController['run']>,
    deviceIds: string[],
    buildSlots: (deviceIds: string[]) => CalibrationPlan['slots'],
    purpose: 'calibrate' | 'measure',
    maxLatencyMs: number,
    onWaiting: () => void,
    onRecording: () => void,
    onProgress: (p: number) => void,
  ): Promise<{ plan: CalibrationPlan; rec: { samples: Float32Array; startCtx: number }; selfExcluded: boolean }> {
    const check = () => {
      if (run.cancelled) throw new Cancelled();
    };
    const ctx = this.engine.ctx!;
    const clock = this.clock()!;
    const lb = this.engine.loopback();
    let stream: MediaStream | null = null;
    let selfExcluded = false;
    if (!lb) {
      const mic = await openCalibrationMic();
      const s = mic.stream;
      run.cleanup.push(() => s.getTracks().forEach((t) => t.stop()));
      stream = s;
      const { room, deviceId } = useRoomStore.getState();
      selfExcluded = mic.outputBluetooth || room?.devices.find((d) => d.id === deviceId)?.caps.deviceClass === 'bluetooth';
    }
    check();
    const myId = useRoomStore.getState().deviceId;
    const ids = selfExcluded ? deviceIds.filter((id) => id !== myId) : deviceIds;
    if (!ids.length) throw new Error(`${BT_SELF_WARNING} No other speakers are connected yet.`);
    const slots = buildSlots(ids);
    const recorder = await startRecorder(ctx, stream ?? lb!);
    run.cleanup.push(() => recorder.abort());
    check();
    // Opening an input can re-open/resize the output path (Bluetooth switching to its headset profile; Chromium
    // adds ~44 ms of output buffering when a recorder graph starts). Let it settle so the audio-clock map has
    // re-converged (step confirmation needs ~0.75 s) before anything is scheduled.
    await new Promise((r) => setTimeout(r, 1500));
    check();
    // The clock/audio-clock mapping may still be converging (it needs ~1 s after joining). The mic is already
    // open (so the permission prompt stayed tied to the user's tap), so wait here instead of failing.
    if (!this.engine.timingReady()) {
      onWaiting();
      await this.waitForTiming(run);
    }
    onRecording();
    const plan = await new Promise<CalibrationPlan>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The server didn't start the run. Try again.")), 8000);
      run.planWaiter = (p) => {
        clearTimeout(t);
        resolve(p);
      };
      run.cleanup.push(() => {
        clearTimeout(t);
        reject(new Cancelled());
      });
      if (!this.send({ type: 'CALIBRATION_START', slots, purpose })) {
        clearTimeout(t);
        reject(new Error('Not connected to the room.'));
      }
    });
    run.planWaiter = null;
    check();
    const endRoom = plan.startRoomTime + calibrationRecordingMs(plan.slots, maxLatencyMs) + 300;
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        const now = clock.toRoomTime(performance.now());
        onProgress(Math.min(1, Math.max(0, (now - plan.startRoomTime) / (endRoom - plan.startRoomTime))));
        if (now >= endRoom || run.cancelled) {
          clearInterval(iv);
          resolve();
        }
      }, 200);
      run.cleanup.push(() => {
        clearInterval(iv);
        resolve();
      });
    });
    check();
    return { plan, rec: await recorder.stop(), selfExcluded };
  }

  /** Sync-measurement tool: every device clicks (device-unique chirp) once per second through normal compensation. */
  async measureSync(durationSec = 60): Promise<void> {
    if (this.run) return;
    const run = { cancelled: false, cleanup: [] as Array<() => void>, planWaiter: null as ((p: CalibrationPlan) => void) | null };
    this.run = run;
    patch('syncMeasure', { running: true, step: 'recording', progress: 0, message: 'Allow microphone access…', durationSec, devices: [], histogram: null, overall: null, warnings: [] });
    try {
      const ctx = this.engine.ctx;
      const clock = this.clock();
      const room = useRoomStore.getState().room;
      if (!ctx || !clock || !room) throw new Error('Join the speaker array first.');
      const deviceIds = room.devices.filter((d) => d.connected).map((d) => d.id);
      const { plan, rec, selfExcluded } = await this.record(
        run,
        deviceIds,
        (ids) => buildSyncMeasurementSlots(ids, { durationSec }),
        'measure',
        SYNC_MAX_LATENCY_MS,
        () => patch('syncMeasure', { message: 'Syncing clocks…' }),
        () => patch('syncMeasure', { message: `Measuring for ${durationSec} s: every speaker clicks once per second.` }),
        (progress) => patch('syncMeasure', { progress }),
      );
      patch('syncMeasure', { step: 'analyzing', progress: 1, message: 'Analyzing…' });
      await new Promise((r) => setTimeout(r, 0));
      const scene = useRoomStore.getState().room?.scene ?? room.scene;
      const report = analyzeSyncMeasurement({
        plan,
        recording: rec.samples,
        sampleRate: ctx.sampleRate,
        recordingStartRoomTime: clock.toRoomTime(this.engine.audioClock.ctxToPerf(rec.startCtx)),
        // time alignment is part of playback compensation, so measure arrival at the listener as heard
        devicePositions: scene.propagationComp ? {} : scene.devices,
        listener: scene.listener,
        maxLatencyMs: SYNC_MAX_LATENCY_MS,
      });
      if (!report.overall.samples && !report.devices.some((d) => d.detected)) throw new Error(report.warnings[0] ?? 'No clicks detected.');
      patch('syncMeasure', {
        step: 'done',
        message:
          report.devices.length > 1
            ? `Inter-device sync error: p50 ${report.overall.p50AbsMs.toFixed(1)} ms, p95 ${report.overall.p95AbsMs.toFixed(1)} ms over ${report.overall.samples} clicks.`
            : `Single device: click timing jitter ${report.devices[0]?.stdMs.toFixed(2)} ms rms (${report.devices[0]?.detected}/${report.devices[0]?.total} clicks).`,
        devices: report.devices.map(({ deviceId, detected, total, meanMs, stdMs, p95AbsMs, maxAbsMs }) => ({ deviceId, detected, total, meanMs, stdMs, p95AbsMs, maxAbsMs })),
        histogram: { edgesMs: report.histogram.edgesMs, counts: report.histogram.counts },
        overall: report.overall,
        warnings: selfExcluded ? [BT_SELF_WARNING, ...report.warnings] : report.warnings,
      });
    } catch (e) {
      if (e instanceof Cancelled || run.cancelled) patch('syncMeasure', { step: 'idle', message: 'Measurement cancelled.', progress: 0 });
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
    if (!this.run) return;
    this.run.cancelled = true;
    this.run.planWaiter = null;
    for (const c of this.run.cleanup) {
      try {
        c();
      } catch {
        /* best effort */
      }
    }
    this.run.cleanup = [];
  }

  dispose(): void {
    this.cancel();
    if (this.measureTimer) clearInterval(this.measureTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }
}
