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
  /** where the sound comes from when it isn't the device itself (a Bluetooth speaker across the room) */
  speakerPosition?: Vec2;
  /** stereo laptop: two point sources ±this far apart along x, each at half amplitude, m */
  stereoHalfWidthM?: number;
  /** direct-path gain factor (< 1: side/down-firing speaker whose first reflection is louder than the direct sound) */
  directGain?: number;
}

/** Speaker → own mic distance of a built-in speaker (laptop/phone), m. */
export const SIM_SELF_DISTANCE_M = 0.1;

/** First-order image sources: the 4 walls of a room centred on the origin, plus the floor (same height for all). */
export interface SimReflections {
  room: { width: number; depth: number };
  /** wall reflection amplitude (1 = perfectly hard) */
  wallGain: number;
  /** source/mic height above the floor, m (omit: no floor bounce) */
  heightM?: number;
  floorGain?: number;
}

/** path lengths (m) and amplitude factors of the direct sound + first-order reflections from `src` to `mic` */
function paths(src: Vec2, mic: Vec2, direct: number, refl?: SimReflections): Array<{ len: number; g: number }> {
  const out = [{ len: Math.max(dist(src, mic), 0.01), g: direct }];
  if (!refl) return out;
  const { width: w, depth: d } = refl.room;
  for (const img of [
    { x: w - src.x, y: src.y },
    { x: -w - src.x, y: src.y },
    { x: src.x, y: d - src.y },
    { x: src.x, y: -d - src.y },
  ])
    out.push({ len: dist(img, mic), g: refl.wallGain });
  if (refl.heightM !== undefined) out.push({ len: Math.hypot(out[0]!.len, 2 * refl.heightM), g: refl.floorGain ?? 0.5 });
  return out;
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
  /** the recording device: its own built-in speaker reaches its mic from SIM_SELF_DISTANCE_M */
  selfId?: string;
  reflections?: SimReflections;
  /** recorder audio clock rate vs room time, ppm: room ms t lands at index t·sr·(1 + ppm·1e-6) */
  ppm?: number;
}

/**
 * The recording at one mic (`listener`), starting exactly at plan.startRoomTime: every speaker's signals at
 * scheduled time + output latency + path length/c + the recorder's input latency, over the direct path and the
 * first-order reflections, with 1/r spreading. Arrivals are rounded to the sample (≤ 10 µs).
 */
export function renderListenerRecording(spec: RecordingSpec): Float32Array {
  const { plan, sampleRate: sr } = spec;
  const rate = 1 + (spec.ppm ?? 0) * 1e-6;
  const out = new Float32Array(Math.round((spec.durationMs / 1000) * sr * rate));
  for (const sp of spec.speakers) {
    if (sp.audible === false) continue;
    const self = sp.id === spec.selfId && !sp.speakerPosition;
    const c = sp.speakerPosition ?? sp.position;
    const w = sp.stereoHalfWidthM ?? 0;
    const sources = w ? [{ x: c.x - w, y: c.y }, { x: c.x + w, y: c.y }] : [c];
    const legs = self
      ? [{ len: SIM_SELF_DISTANCE_M, g: 1 }]
      : sources.flatMap((s) => paths(s, spec.listener, sp.directGain ?? 1, spec.reflections).map((p) => ({ ...p, g: p.g / sources.length })));
    for (const slot of plan.slots.filter((s) => s.deviceId === sp.id)) {
      const sig = processCascade(sp.filters, calibrationSignal(slot.signal, slot.deviceIndex, sr));
      for (let k = 0; k < (slot.repeat ?? 1); k++) {
        const t0 = slot.offsetMs + k * (slot.periodMs ?? 0) + sp.latencyMs + (spec.clickJitterMs?.(sp.id, k) ?? 0) + spec.inputLatencyMs;
        for (const leg of legs) {
          const at = Math.round((((t0 + (leg.len / SPEED_OF_SOUND) * 1000) / 1000) * sr) * rate);
          const amp = (sp.gain * leg.g) / Math.max(leg.len, 0.05); // 1/r spreading re 1 m
          for (let i = 0; i < sig.length && at + i < out.length; i++) if (at + i >= 0) out[at + i] = out[at + i]! + amp * sig[i]!;
        }
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
