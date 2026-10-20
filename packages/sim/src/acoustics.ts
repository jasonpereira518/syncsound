/**
 * Synthetic acoustics for calibration sims: speakers = known biquad filters + gain + output latency, placed in
 * the room; the listener's mono recording = Σ each device's filtered calibration signals arriving at
 * scheduled time + latency + propagation + listener input latency, plus noise.
 */
import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import {
  calibrationSignal,
  designBiquad,
  mulberry32,
  pinkNoise,
  processCascade,
  SPEED_OF_SOUND,
  type BiquadCoeffs,
} from '@syncsound/audio-core';

export interface SimSpeaker {
  id: string;
  /** true transfer function of the speaker */
  filters: BiquadCoeffs[];
  /** linear gain at 1 m */
  gain: number;
  /** output latency (hidden from the analysis), ms */
  latencyMs: number;
  position: Vec2;
  /** false = unplugged/silent: contributes nothing to the recording */
  audible?: boolean;
}

export const SIM_SR = 48000;

/** The four reference devices of the calibration spec (48 kHz filters). */
export function referenceSpeakers(sr = SIM_SR): SimSpeaker[] {
  return [
    {
      id: 'phone',
      filters: [
        designBiquad('highpass', 300, Math.SQRT1_2, 0, sr),
        designBiquad('peaking', 4000, 1.2, 6, sr),
      ],
      gain: 0.5,
      latencyMs: 25,
      position: { x: -1, y: -0.2 },
    },
    {
      id: 'laptop',
      filters: [designBiquad('lowshelf', 200, 1, -8, sr)],
      gain: 0.7,
      latencyMs: 40,
      position: { x: 1.5, y: -1 },
    },
    {
      id: 'bt',
      filters: [designBiquad('highshelf', 5000, 0.8, -6, sr)],
      gain: 1,
      latencyMs: 210,
      position: { x: -3, y: -2 },
    },
    {
      id: 'desktop',
      filters: [designBiquad('highpass', 35, Math.SQRT1_2, 0, sr)],
      gain: 0.9,
      latencyMs: 15,
      position: { x: 2.5, y: 2.2 },
    },
  ];
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

export interface RecordingSpec {
  plan: CalibrationPlan;
  speakers: SimSpeaker[];
  listener: Vec2;
  sampleRate: number;
  durationMs: number;
  /** the listener's own (unknown to analysis) input latency, ms */
  inputLatencyMs: number;
  /** white mic/electrical noise RMS, dBFS */
  noiseDb: number;
  /** optional pink room noise RMS, dBFS */
  roomNoiseDb?: number;
  seed?: number;
  /** extra timing error (ms) of repetition k of a repeated slot (sync-measurement jitter model) */
  clickJitterMs?: (deviceId: string, k: number) => number;
}

/** Listener recording starting exactly at plan.startRoomTime. */
export function renderListenerRecording(spec: RecordingSpec): Float32Array {
  const { plan, sampleRate: sr } = spec;
  const out = new Float32Array(Math.round((spec.durationMs / 1000) * sr));
  for (const sp of spec.speakers) {
    if (sp.audible === false) continue;
    const d = dist(sp.position, spec.listener);
    const amp = sp.gain / Math.max(d, 0.1); // 1/r spreading re 1 m
    for (const slot of plan.slots.filter((s) => s.deviceId === sp.id)) {
      const sig = processCascade(sp.filters, calibrationSignal(slot.signal, slot.deviceIndex, sr));
      for (let k = 0; k < (slot.repeat ?? 1); k++) {
        const atMs =
          slot.offsetMs +
          k * (slot.periodMs ?? 0) +
          sp.latencyMs +
          (spec.clickJitterMs?.(sp.id, k) ?? 0) +
          (d / SPEED_OF_SOUND) * 1000 +
          spec.inputLatencyMs;
        const at = Math.round((atMs / 1000) * sr);
        for (let i = 0; i < sig.length && at + i < out.length; i++) out[at + i] = out[at + i]! + amp * sig[i]!;
      }
    }
  }
  // Gaussian white noise (Box–Muller) at noiseDb RMS
  const rnd = mulberry32(spec.seed ?? 7);
  const sigma = Math.pow(10, spec.noiseDb / 20);
  for (let i = 0; i < out.length; i++) {
    const g = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    out[i] = out[i]! + sigma * g;
  }
  if (spec.roomNoiseDb !== undefined) {
    const pn = pinkNoise(out.length, (spec.seed ?? 7) + 1, 1);
    let e = 0;
    for (const v of pn) e += v * v;
    const k = Math.pow(10, spec.roomNoiseDb / 20) / Math.sqrt(e / pn.length);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + k * pn[i]!;
  }
  return out;
}
