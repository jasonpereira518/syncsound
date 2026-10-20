/**
 * Acoustic calibration. Speaker side: emit this device's slots of a CALIBRATION_PLAN at the planned room
 * times. Listener side: record the mic through an AudioWorklet, analyze, send CALIBRATION_RESULT.
 * Browser-only.
 */
import {
  analyzeCalibration,
  buildCalibrationSlots,
  calibrationRecordingMs,
  calibrationSignal,
  classPresetEq,
  type ClockSync,
} from '@syncsound/audio-core';
import type { CalibrationDeviceResult, CalibrationPlan, ClientMessage, Device, DevicePatch } from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
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
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      if (!this.started) { this.started = true; this.port.postMessage({ start: currentTime }); }
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('syncsound-recorder', SyncSoundRecorder);
`;

/** same value for slot building and analysis (guard gaps + search windows) */
const MAX_LATENCY_MS = 500;

const registered = new WeakSet<BaseAudioContext>();

interface Recorder {
  stop(): Promise<{ samples: Float32Array; startCtx: number }>;
  abort(): void;
}

async function startRecorder(ctx: AudioContext, stream: MediaStream): Promise<Recorder> {
  if (!registered.has(ctx)) {
    const url = URL.createObjectURL(new Blob([RECORDER_CODE], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    registered.add(ctx);
  }
  const src = ctx.createMediaStreamSource(stream);
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
    src.disconnect();
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
      if (!this.engine.timingReady()) throw new Error('Still syncing clocks. Try again in a second.');
      const deviceIds = room.devices.filter((d) => d.connected).map((d) => d.id);

      patch('calibration', { step: 'mic', message: 'Allow microphone access…' });
      let stream: MediaStream;
      try {
        const lb = this.engine.loopback();
        stream = lb
          ? lb.dest.stream.clone()
          : await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
      } catch (e) {
        throw new Error(micError(e));
      }
      run.cleanup.push(() => stream.getTracks().forEach((t) => t.stop()));
      check();
      const recorder = await startRecorder(ctx, stream);
      run.cleanup.push(() => recorder.abort());
      check();

      patch('calibration', { step: 'recording', message: 'Listen: each speaker will chirp and sweep in turn.' });
      const plan = await new Promise<CalibrationPlan>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("The server didn't start the calibration run. Try again.")), 8000);
        run.planWaiter = (p) => {
          clearTimeout(t);
          resolve(p);
        };
        run.cleanup.push(() => {
          clearTimeout(t);
          reject(new Cancelled());
        });
        if (!this.send({ type: 'CALIBRATION_START', slots: buildCalibrationSlots(deviceIds, { maxLatencyMs: MAX_LATENCY_MS }) })) {
          clearTimeout(t);
          reject(new Error('Not connected to the room.'));
        }
      });
      run.planWaiter = null;
      check();

      const endRoom = plan.startRoomTime + calibrationRecordingMs(plan.slots, MAX_LATENCY_MS) + 300;
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          const now = clock.toRoomTime(performance.now());
          patch('calibration', { progress: Math.min(1, Math.max(0, (now - plan.startRoomTime) / (endRoom - plan.startRoomTime))) });
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

      const rec = await recorder.stop();
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
        warnings: report.warnings,
      });
      useRoomStore.setState({ routeChanged: false });
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
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }
}
