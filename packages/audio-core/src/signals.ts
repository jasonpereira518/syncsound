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

/**
 * Durations (ms) of each calibration signal. chirp: the short wideband tick of the sync check. tune: the tune's
 * swoosh that lands on a chime (TUNE_SWOOSH_MS of sweep, then the chime).
 */
export const CALIBRATION_SIGNAL_MS: Record<CalibrationSignal, number> = {
  chirp: 100,
  sweep: 700,
  noise: 1000,
  click: 50,
  tune: 1100,
};
/** The tune signal's swoosh (the part every arrival is matched against), ms. */
export const TUNE_SWOOSH_MS = 600;

/**
 * Tune sweep range. Starts an octave below the 40 Hz response grid so a short sweep still measures 40–80 Hz (bass
 * capability: rolloff ≤ 80 Hz) accurately; reaches 20 kHz because the arrival estimate lives in the highs (wideband →
 * sharp, reflection-resolving correlation peak).
 */
export const CALIBRATION_SWEEP = { f1: 20, f2: 20000 } as const;
/** Upper edge of the short sync-check chirp, Hz (lower edge 300 Hz, where every laptop speaker plays). */
const CHIRP_F2 = 20000;
/** keep sweep/chirp tops below Nyquist on 32/44.1 kHz contexts */
const top = (f: number, sampleRate: number) => Math.min(f, 0.45 * sampleRate);

/** Peak amplitude of every calibration signal. */
export const CALIBRATION_PEAK = 0.25;

function calibrationSweep(sampleRate: number) {
  return logSweep({
    f1: CALIBRATION_SWEEP.f1,
    f2: top(CALIBRATION_SWEEP.f2, sampleRate),
    durationSec: CALIBRATION_SIGNAL_MS.sweep / 1000,
    sampleRate,
  });
}

/** The swoosh's top octave-and-a-bit is tapered (raised cosine, in log frequency) from here… */
const SWOOSH_TAPER_HZ = 14000;
/** …down to this gain at 20 kHz: softens the shrill end, leaves the 1–12 kHz arrival band untouched */
const SWOOSH_TOP_GAIN = Math.pow(10, -10 / 20);
/** chime partials [Hz, relative amplitude, decay τ s]: C6 with its G6 fifth and two harmonics (integer ratios, so a
 * speaker's harmonic distortion lands on frequencies the signal already holds) */
const CHIME_PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1046.5, 1, 0.22],
  [1568, 0.5, 0.18],
  [2093, 0.35, 0.12],
  [3139.5, 0.15, 0.07],
];
const CHIME_PEAK = 0.15;

/**
 * The tune signal, in two parts: a rising swoosh (exponential sweep 20 Hz → 20 kHz over TUNE_SWOOSH_MS, 30 ms
 * fade-in, top tapered by up to −10 dB) that lands on a short bell chime. The swoosh carries timing (it alone is the
 * matched-filter reference) and, deconvolved together with the chime by `calibrationInverse`, the response.
 */
export function tuneSignalParts(sampleRate: number): { swoosh: Float32Array; full: Float32Array } {
  const nSwoosh = Math.round((TUNE_SWOOSH_MS / 1000) * sampleRate);
  const n = Math.round((CALIBRATION_SIGNAL_MS.tune / 1000) * sampleRate);
  const f1 = CALIBRATION_SWEEP.f1;
  const f2 = top(CALIBRATION_SWEEP.f2, sampleRate);
  const T = nSwoosh / sampleRate;
  const L = T / Math.log(f2 / f1);
  const fadeIn = Math.round(0.03 * sampleRate);
  const fadeOut = Math.round(0.005 * sampleRate);
  const full = new Float32Array(n);
  const taperOct = Math.log2(20000 / SWOOSH_TAPER_HZ);
  for (let i = 0; i < nSwoosh; i++) {
    const t = i / sampleRate;
    const f = f1 * Math.exp(t / L);
    const x = f <= SWOOSH_TAPER_HZ ? 0 : Math.min(1, Math.log2(f / SWOOSH_TAPER_HZ) / taperOct);
    let g = 1 - (1 - SWOOSH_TOP_GAIN) * (0.5 - 0.5 * Math.cos(Math.PI * x));
    if (i < fadeIn) g *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    const j = nSwoosh - 1 - i;
    if (j < fadeOut) g *= 0.5 - 0.5 * Math.cos((Math.PI * j) / fadeOut);
    full[i] = CALIBRATION_PEAK * g * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
  }
  const nChime = n - nSwoosh;
  const attack = Math.round(0.004 * sampleRate);
  const end = Math.round(0.03 * sampleRate);
  const chime = new Float32Array(nChime);
  let max = 0;
  for (let i = 0; i < nChime; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const [f, a, tau] of CHIME_PARTIALS) v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t);
    if (i < attack) v *= 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
    const j = nChime - 1 - i;
    if (j < end) v *= 0.5 - 0.5 * Math.cos((Math.PI * j) / end);
    chime[i] = v;
    max = Math.max(max, Math.abs(v));
  }
  for (let i = 0; i < nChime; i++) full[nSwoosh + i] = (chime[i]! * CHIME_PEAK) / max;
  return { swoosh: full.slice(0, nSwoosh), full };
}

/** Deterministic calibration signal; speaker and listener generate identical samples (`deviceIndex` seeds the noise). */
export function calibrationSignal(
  kind: CalibrationSignal,
  deviceIndex: number,
  sampleRate: number,
): Float32Array {
  const n = Math.round((CALIBRATION_SIGNAL_MS[kind] / 1000) * sampleRate);
  switch (kind) {
    case 'chirp':
      return chirp(300, top(CHIRP_F2, sampleRate), n / sampleRate, sampleRate).map((v) => v * CALIBRATION_PEAK);
    case 'sweep':
      return calibrationSweep(sampleRate).signal.map((v) => v * CALIBRATION_PEAK);
    case 'tune':
      return tuneSignalParts(sampleRate).full;
    case 'noise':
      return applyFades(pinkNoise(n, 1000 + deviceIndex, CALIBRATION_PEAK), Math.round(0.01 * sampleRate));
    case 'click': {
      const out = new Float32Array(n);
      addClick(out, 0, sampleRate, 1500, CALIBRATION_PEAK);
      return out;
    }
  }
}

/**
 * Matched-filter reference for arrivals: the tune's swoosh alone (the chime's tonal autocorrelation would put
 * near-peak sidelobes before the direct path), every other signal itself.
 */
export function calibrationArrivalRef(kind: CalibrationSignal, deviceIndex: number, sampleRate: number): Float32Array {
  return kind === 'tune' ? tuneSignalParts(sampleRate).swoosh : calibrationSignal(kind, deviceIndex, sampleRate);
}

const inverses = new Map<string, Float32Array>();
/**
 * Inverse filter for a sweep-based calibration signal ('sweep' | 'tune'): deconvolving a recording with it gives the
 * IR at unit gain over [sweep start, 0.95 · sweep top]. Regularized (not Farina's): the tune's chime would otherwise
 * deconvolve into tones inside the IR window. Cached per kind and rate.
 */
export function calibrationInverse(kind: 'sweep' | 'tune', sampleRate: number): Float32Array {
  const key = `${kind}:${sampleRate}`;
  let inv = inverses.get(key);
  if (!inv) {
    inv = regularizedInverse(calibrationSignal(kind, 0, sampleRate), sampleRate, {
      lo: CALIBRATION_SWEEP.f1,
      hi: 0.95 * top(CALIBRATION_SWEEP.f2, sampleRate),
    });
    inverses.set(key, inv);
  }
  return inv;
}

/** Spread (each side) the regularized inverse keeps beyond the signal's own length, s. */
const INVERSE_SPREAD_SEC = 0.15;

/**
 * Regularized inverse of a known signal x: H = X* / (|X|² + λ(f)), λ = 1e-6 · max|X|² in [lo, hi] rising to max|X|²
 * outside (half-octave raised-cosine edges, in log λ). Laid out like a Farina inverse (x ⊛ inv peaks one spread after
 * index x.length − 1), keeping INVERSE_SPREAD_SEC on both sides for the zero-phase part, with tapered ends.
 */
export function regularizedInverse(x: Float32Array, sampleRate: number, band: { lo: number; hi: number }): Float32Array {
  const spread = Math.round(INVERSE_SPREAD_SEC * sampleRate);
  const len = x.length + 2 * spread;
  const n = nextPow2(2 * len);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  let maxP = 0;
  for (let k = 0; k <= n / 2; k++) maxP = Math.max(maxP, re[k]! * re[k]! + im[k]! * im[k]!);
  const lamIn = 1e-6 * maxP;
  const edge = (f: number) => {
    // 0 in band, 1 half an octave or more outside it
    const o = f < band.lo ? Math.log2(band.lo / Math.max(f, 1e-9)) : f > band.hi ? Math.log2(f / band.hi) : 0;
    const t = Math.min(1, o / 0.5);
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  };
  // H(k) · e^{−j2πk·d/n}, d = x.length − 1 + spread: the time-reversed part lands in [spread, spread + x.length)
  const d = x.length - 1 + spread;
  const hr = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let k = 0; k <= n / 2; k++) {
    const f = (k * sampleRate) / n;
    const p = re[k]! * re[k]! + im[k]! * im[k]!;
    const lam = lamIn * Math.pow(maxP / lamIn, edge(f));
    const gr = re[k]! / (p + lam);
    const gi = -im[k]! / (p + lam);
    const a = (-2 * Math.PI * k * d) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    hr[k] = gr * c - gi * s;
    hi[k] = gr * s + gi * c;
    if (k > 0 && k < n / 2) {
      hr[n - k] = hr[k]!;
      hi[n - k] = -hi[k]!;
    }
  }
  hi[0] = 0;
  hi[n / 2] = 0;
  fft(hr, hi, true);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const j = Math.min(i, len - 1 - i);
    const w = j < spread ? 0.5 - 0.5 * Math.cos((Math.PI * j) / spread) : 1;
    out[i] = hr[i]! * w;
  }
  return out;
}
