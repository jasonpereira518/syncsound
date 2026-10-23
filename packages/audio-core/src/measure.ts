import { fft, nextPow2 } from './fft';

/** FFT cross-correlation r[k] = Σ x[n+k]·ref[n] for k in [0, x.length − 1]. */
export function crossCorrelate(x: Float32Array, ref: Float32Array): Float64Array {
  const n = nextPow2(x.length + ref.length);
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const rr = new Float64Array(n);
  const ri = new Float64Array(n);
  xr.set(x);
  rr.set(ref);
  fft(xr, xi);
  fft(rr, ri);
  // X · conj(R)
  for (let k = 0; k < n; k++) {
    const re = xr[k]! * rr[k]! + xi[k]! * ri[k]!;
    const im = xi[k]! * rr[k]! - xr[k]! * ri[k]!;
    xr[k] = re;
    xi[k] = im;
  }
  fft(xr, xi, true);
  return xr.slice(0, x.length);
}

/** |analytic signal| (Hilbert envelope) of a real sequence. */
export function envelope(x: Float64Array): Float64Array {
  const n = nextPow2(x.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  for (let k = 1; k < n / 2; k++) {
    re[k] = re[k]! * 2;
    im[k] = im[k]! * 2;
  }
  for (let k = n / 2 + 1; k < n; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fft(re, im, true);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.hypot(re[i]!, im[i]!);
  return out;
}

export interface Arrival {
  /** sample index in `recording` where `reference` starts (sub-sample, parabolic interpolation) */
  index: number;
  /** normalized correlation peak 0..1 */
  peak: number;
  /** peak-to-median ratio in dB — confidence */
  snrDb: number;
}

function median(a: Float64Array): number {
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1] ?? 0;
}

/**
 * Best match of `reference` in recording[searchStart, searchEnd), with no acceptance threshold (null only when
 * the window is empty). detectArrival applies the thresholds; failures report this candidate as diagnostics.
 */
export function bestArrival(
  recording: Float32Array,
  reference: Float32Array,
  opts: { searchStart?: number; searchEnd?: number } = {},
): Arrival | null {
  const m = reference.length;
  const start = Math.max(0, Math.floor(opts.searchStart ?? 0));
  const end = Math.min(recording.length - m + 1, Math.ceil(opts.searchEnd ?? recording.length - m + 1));
  if (end <= start) return null;
  const seg = recording.subarray(start, end + m - 1);
  const env = envelope(crossCorrelate(seg, reference)).subarray(0, end - start);
  let k0 = 0;
  for (let k = 1; k < env.length; k++) if (env[k]! > env[k0]!) k0 = k;
  const pk = env[k0]!;
  let delta = 0;
  if (k0 > 0 && k0 < env.length - 1) {
    const a = env[k0 - 1]!;
    const c = env[k0 + 1]!;
    const den = a - 2 * pk + c;
    if (den < 0) delta = (0.5 * (a - c)) / den;
  }
  let refE = 0;
  for (let i = 0; i < m; i++) refE += reference[i]! * reference[i]!;
  let segE = 0;
  for (let i = k0; i < k0 + m; i++) segE += seg[i]! * seg[i]!;
  const peak = pk / Math.sqrt(refE * segE + 1e-30);
  const snrDb = 20 * Math.log10(pk / (median(env) + 1e-30));
  return { index: start + k0 + delta, peak, snrDb };
}

/**
 * Find where `reference` occurs in recording[searchStart, searchEnd) (= range of candidate start indices).
 * Works on the Hilbert envelope of the cross-correlation so narrow-band references (and phase-shifting
 * speakers) don't cause carrier-cycle slips; the envelope peak is refined by parabolic interpolation.
 * Null if snrDb (envelope peak / median) < minSnrDb or the normalized peak < minPeak.
 */
export function detectArrival(
  recording: Float32Array,
  reference: Float32Array,
  opts: { searchStart?: number; searchEnd?: number; minSnrDb?: number; minPeak?: number } = {},
): Arrival | null {
  const a = bestArrival(recording, reference, opts);
  if (!a || a.snrDb < (opts.minSnrDb ?? 10) || a.peak < (opts.minPeak ?? 0.1)) return null;
  return a;
}

/** Linear convolution via FFT. */
export function convolve(a: Float32Array, b: Float32Array): Float64Array {
  const len = a.length + b.length - 1;
  const n = nextPow2(len);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < n; k++) {
    const re = ar[k]! * br[k]! - ai[k]! * bi[k]!;
    ai[k] = ar[k]! * bi[k]! + ai[k]! * br[k]!;
    ar[k] = re;
  }
  fft(ar, ai, true);
  return ar.slice(0, len);
}

/**
 * Linear deconvolution of a recorded sweep with its inverse filter → impulse response window starting a
 * little (irLength/8) before the main peak, with tapered edges.
 */
export function deconvolve(recording: Float32Array, inverse: Float32Array, irLength = 8192): Float32Array {
  const y = convolve(recording, inverse);
  let p = 0;
  for (let i = 1; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[p]!)) p = i;
  // pre-roll irLength/8 keeps the low-frequency pre-ringing of the band-limited delta (≈ 1/f1 long) while staying
  // far after the harmonic-distortion images (≥ L·ln2 ≈ 230 ms earlier for the calibration sweep)
  const pre = Math.min(p, Math.max(16, irLength >> 3));
  const s = p - pre;
  // Tukey-style taper (half-cosine over the pre-roll, and over the last quarter) instead of a hard cut, so the
  // truncation doesn't ripple the low end of the magnitude response
  const tail = irLength >> 2;
  const out = new Float32Array(irLength);
  for (let i = 0; i < irLength && s + i < y.length; i++) {
    const wIn = i < pre ? 0.5 - 0.5 * Math.cos((Math.PI * i) / pre) : 1;
    const j = irLength - 1 - i;
    const wOut = j < tail ? 0.5 - 0.5 * Math.cos((Math.PI * j) / tail) : 1;
    out[i] = y[s + i]! * wIn * wOut;
  }
  return out;
}

export interface Response {
  freqs: number[];
  db: number[];
}

/** Magnitude response (dB) of an IR, evaluated at log-spaced `freqs` (default 1/24-oct 20 Hz–20 kHz). */
export function magnitudeResponse(ir: Float32Array, sampleRate: number, freqs?: number[]): Response {
  const fs = freqs ?? logFreqs(20, 20000, 24);
  const nfft = Math.max(nextPow2(ir.length), 16384);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  re.set(ir);
  fft(re, im);
  const half = nfft / 2;
  const db = fs.map((f) => {
    const b = Math.min(Math.max((f * nfft) / sampleRate, 0), half);
    const k = Math.min(Math.floor(b), half - 1);
    const t = b - k;
    const p0 = re[k]! * re[k]! + im[k]! * im[k]!;
    const p1 = re[k + 1]! * re[k + 1]! + im[k + 1]! * im[k + 1]!;
    return 10 * Math.log10(p0 * (1 - t) + p1 * t + 1e-30);
  });
  return { freqs: fs, db };
}

/** Log-spaced frequency grid, `perOctave` points per octave (fMin included; fMax included if on-grid). */
export function logFreqs(fMin: number, fMax: number, perOctave: number): number[] {
  const n = Math.floor(Math.log2(fMax / fMin) * perOctave + 1e-9);
  return Array.from({ length: n + 1 }, (_, k) => fMin * Math.pow(2, k / perOctave));
}

/** Fractional-octave smoothing (power average within ±1/(2·fraction) octave). */
export function smoothFractionalOctave(r: Response, fraction: number): Response {
  const k = Math.pow(2, 1 / (2 * fraction));
  const pow = r.db.map((d) => Math.pow(10, d / 10));
  // ponytail: O(n²) window scan; fine for ~300-point grids
  const db = r.freqs.map((f) => {
    let s = 0;
    let c = 0;
    for (let j = 0; j < r.freqs.length; j++) {
      const g = r.freqs[j]!;
      if (g >= f / k && g <= f * k) {
        s += pow[j]!;
        c++;
      }
    }
    return 10 * Math.log10(s / c);
  });
  return { freqs: [...r.freqs], db };
}

export function rmsDb(x: Float32Array, start = 0, end = x.length): number {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(x.length, Math.floor(end));
  let sum = 0;
  for (let i = s; i < e; i++) sum += x[i]! * x[i]!;
  return 10 * Math.log10(sum / Math.max(1, e - s) + 1e-20);
}

/** Mean dB of a response over [f1, f2]. */
export function bandMeanDb(r: Response, f1: number, f2: number): number {
  let s = 0;
  let c = 0;
  r.freqs.forEach((f, i) => {
    if (f >= f1 && f <= f2) {
      s += r.db[i]!;
      c++;
    }
  });
  return c ? s / c : 0;
}

/**
 * Estimated -6 dB low-frequency rolloff relative to the 300 Hz–3 kHz mean: scanning down from 300 Hz, the
 * first crossing (log-interpolated). Returns the lowest grid frequency if the response never drops 6 dB.
 */
export function estimateRolloffHz(r: Response): number {
  const thr = bandMeanDb(r, 300, 3000) - 6;
  let i = r.freqs.findIndex((f) => f >= 300);
  if (i < 0) i = r.freqs.length - 1;
  for (; i > 0; i--) {
    const hiDb = r.db[i]!;
    const loDb = r.db[i - 1]!;
    if (loDb < thr && hiDb >= thr) {
      const t = (hiDb - thr) / (hiDb - loDb);
      return r.freqs[i]! * Math.pow(r.freqs[i - 1]! / r.freqs[i]!, t);
    }
    if (hiDb < thr) return r.freqs[i]!;
  }
  return r.freqs[0] ?? 20;
}
