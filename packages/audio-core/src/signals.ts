import type { CalibrationSignal } from '@syncsound/protocol';
import { fft, nextPow2 } from './fft';

export interface SweepSpec {
  f1: number;
  f2: number;
  durationSec: number;
  sampleRate: number;
  /** fade in/out seconds (default 0.01) */
  fadeSec?: number;
}

/** Raised-cosine fade in/out, in place. */
export function applyFades(x: Float32Array, fadeSamples: number): Float32Array {
  const n = Math.min(fadeSamples, Math.floor(x.length / 2));
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    x[i] = x[i]! * g;
    x[x.length - 1 - i] = x[x.length - 1 - i]! * g;
  }
  return x;
}

/** Seeded PRNG (mulberry32), uniform [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Farina exponential sine sweep + its amplitude-compensated time-reversed inverse filter.
 * The inverse is scaled so that signal ⊛ inverse has unit gain in-band (a delayed, band-limited delta
 * peaking at index signal.length − 1), so deconvolving a recording yields the IR at its true gain.
 */
export function logSweep(spec: SweepSpec): { signal: Float32Array; inverse: Float32Array } {
  const { f1, f2, durationSec, sampleRate } = spec;
  const n = Math.round(durationSec * sampleRate);
  const L = durationSec / Math.log(f2 / f1);
  const signal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    signal[i] = Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
  }
  applyFades(signal, Math.round((spec.fadeSec ?? 0.01) * sampleRate));
  // time-reversed sweep with −6 dB/octave envelope (amplitude ∝ instantaneous frequency)
  const inverse = new Float32Array(n);
  for (let i = 0; i < n; i++) inverse[i] = signal[n - 1 - i]! * Math.exp(-i / sampleRate / L);
  // normalize to unit in-band gain: mean |S·Inv| over [2·f1, f2/2]
  const nfft = nextPow2(2 * n);
  const sr = new Float64Array(nfft);
  const si = new Float64Array(nfft);
  const ir = new Float64Array(nfft);
  const ii = new Float64Array(nfft);
  sr.set(signal);
  ir.set(inverse);
  fft(sr, si);
  fft(ir, ii);
  const k1 = Math.ceil((2 * f1 * nfft) / sampleRate);
  const k2 = Math.floor(((f2 / 2) * nfft) / sampleRate);
  let sum = 0;
  for (let k = k1; k <= k2; k++) {
    sum += Math.hypot(sr[k]! * ir[k]! - si[k]! * ii[k]!, sr[k]! * ii[k]! + si[k]! * ir[k]!);
  }
  const scale = (k2 - k1 + 1) / sum;
  for (let i = 0; i < n; i++) inverse[i] = inverse[i]! * scale;
  return { signal, inverse };
}

/** Linear-in-log chirp between f1 and f2 with Hann window (for arrival detection). */
export function chirp(f1: number, f2: number, durationSec: number, sampleRate: number): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const L = durationSec / Math.log(f2 / f1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = w * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
  }
  return out;
}

/** Deterministic pink noise (Paul Kellet filter over seeded white noise), peak-normalized to `peak`. */
export function pinkNoise(n: number, seed: number, peak = 1): Float32Array {
  const rnd = mulberry32(seed);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  const warmup = 4096; // let the slow poles settle so the start isn't bass-light
  const out = new Float32Array(n);
  let max = 0;
  for (let i = -warmup; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    if (i >= 0) {
      out[i] = p;
      max = Math.max(max, Math.abs(p));
    }
  }
  const g = max > 0 ? peak / max : 0;
  for (let i = 0; i < n; i++) out[i] = out[i]! * g;
  return out;
}

function addClick(out: Float32Array, at: number, sampleRate: number, freq: number, amp: number) {
  const len = Math.round(0.03 * sampleRate);
  for (let i = 0; i < len && at + i < out.length; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, i / (0.0005 * sampleRate));
    out[at + i] = out[at + i]! + amp * attack * Math.exp(-t / 0.004) * Math.sin(2 * Math.PI * freq * t);
  }
}

/** Click track: short 1 kHz-ish clicks at `bpm` (accent on beat 1 of 4: 1.5 kHz, louder). */
export function clickTrack(bpm: number, durationSec: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(durationSec * sampleRate));
  const beat = (60 / bpm) * sampleRate;
  for (let k = 0; k * beat < out.length; k++) {
    const accent = k % 4 === 0;
    addClick(out, Math.round(k * beat), sampleRate, accent ? 1500 : 1000, accent ? 0.9 : 0.6);
  }
  return out;
}

const CHIRP_F_LO = 500;
const CHIRP_F_HI = 8000;
const CHIRP_BANDS = 16;

/**
 * Device-unique chirp band (Hz) for calibration ID: 16 adjacent quarter-octave bands spanning 500 Hz–8 kHz,
 * reused cyclically beyond 16 devices (slots also separate devices in time).
 */
export function chirpBand(deviceIndex: number): { f1: number; f2: number } {
  const k = ((deviceIndex % CHIRP_BANDS) + CHIRP_BANDS) % CHIRP_BANDS;
  const ratio = CHIRP_F_HI / CHIRP_F_LO;
  return {
    f1: CHIRP_F_LO * Math.pow(ratio, k / CHIRP_BANDS),
    f2: CHIRP_F_LO * Math.pow(ratio, (k + 1) / CHIRP_BANDS),
  };
}

/** Durations (ms) of each calibration signal. */
export const CALIBRATION_SIGNAL_MS: Record<CalibrationSignal, number> = {
  chirp: 400,
  sweep: 2000,
  noise: 1000,
  click: 50,
};

/** Sweep range used for frequency-response measurement. */
export const CALIBRATION_SWEEP = { f1: 40, f2: 16000 } as const;

/** Peak amplitude of every calibration signal. */
export const CALIBRATION_PEAK = 0.5;

function calibrationSweep(sampleRate: number) {
  return logSweep({
    f1: CALIBRATION_SWEEP.f1,
    f2: CALIBRATION_SWEEP.f2,
    durationSec: CALIBRATION_SIGNAL_MS.sweep / 1000,
    sampleRate,
  });
}

/** Deterministic calibration signal; speaker and listener generate identical samples. */
export function calibrationSignal(
  kind: CalibrationSignal,
  deviceIndex: number,
  sampleRate: number,
): Float32Array {
  const n = Math.round((CALIBRATION_SIGNAL_MS[kind] / 1000) * sampleRate);
  switch (kind) {
    case 'chirp': {
      const { f1, f2 } = chirpBand(deviceIndex);
      return chirp(f1, f2, n / sampleRate, sampleRate).map((v) => v * CALIBRATION_PEAK);
    }
    case 'sweep':
      return calibrationSweep(sampleRate).signal.map((v) => v * CALIBRATION_PEAK);
    case 'noise':
      return applyFades(pinkNoise(n, 1000 + deviceIndex, CALIBRATION_PEAK), Math.round(0.01 * sampleRate));
    case 'click': {
      const out = new Float32Array(n);
      addClick(out, 0, sampleRate, 1500, CALIBRATION_PEAK);
      return out;
    }
  }
}

/** Inverse filter matching calibrationSignal('sweep'): deconvolving a recording with it gives the IR at unit gain. */
export function calibrationSweepInverse(sampleRate: number): Float32Array {
  return calibrationSweep(sampleRate).inverse.map((v) => v / CALIBRATION_PEAK);
}
