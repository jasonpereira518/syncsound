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

function median(a: Float64Array): number {
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1] ?? 0;
}

/**
 * Hilbert envelope of `x` band-limited to [lo, hi] Hz with raised-cosine edges one octave wide (lo/2→lo,
 * hi→min(2·hi, Nyquist)), zero-phase (one FFT pair). Smooth edges keep the band's time sidelobes far below the
 * −12 dB first-arrival threshold, which a brick-wall band (sinc ringing at −13 dB) would not.
 */
export function bandEnvelope(x: Float64Array, sampleRate: number, lo: number, hi: number): Float64Array {
  const n = nextPow2(x.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  const hiEnd = Math.min(2 * hi, sampleRate / 2);
  const w = (f: number) => {
    if (f <= lo / 2 || f >= hiEnd) return 0;
    if (f < lo) return 0.5 - 0.5 * Math.cos(Math.PI * Math.log2(f / (lo / 2)));
    if (f <= hi) return 1;
    return 0.5 + 0.5 * Math.cos((Math.PI * Math.log2(f / hi)) / Math.log2(hiEnd / hi));
  };
  re[0] = 0;
  im[0] = 0;
  for (let k = 1; k < n; k++) {
    const g = k < n / 2 ? 2 * w((k * sampleRate) / n) : 0;
    re[k] = re[k]! * g;
    im[k] = im[k]! * g;
  }
  fft(re, im, true);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.hypot(re[i]!, im[i]!);
  return out;
}

/** Band where the direct-path arrival is located: wide (sharp, reflection-resolving peak) and played by laptops. */
export const ARRIVAL_BAND = { lo: 1000, hi: 12000 } as const;

export interface FirstArrival {
  /** index in the matched-filter output (= where the reference starts in the recording), sub-sample */
  index: number;
  /** strongest envelope peak / median envelope in the window, dB */
  snrDb: number;
  /** how far after the direct path the strongest peak came (a louder reflection), ms; 0 = direct was strongest */
  lagMs: number;
  /** direct-path envelope height, dB (relative: same reference → comparable across arrivals at one mic) */
  directDb: number;
}

/**
 * Direct-path arrival in a matched-filter output `y` (a correlation against the emitted signal ≈ the impulse
 * response): band envelope (`ARRIVAL_BAND`), strongest peak P in [start, end), then the EARLIEST local envelope peak
 * within `lookbackMs` before P that is at most `dropDb` below it, refined by parabolic interpolation. A louder
 * reflection (side/down-firing laptop speakers, a desk) therefore never wins over the direct sound.
 */
export function firstArrival(
  y: Float64Array,
  sampleRate: number,
  opts: { start?: number; end?: number; lookbackMs?: number; dropDb?: number } = {},
): FirstArrival | null {
  const env = bandEnvelope(y, sampleRate, ARRIVAL_BAND.lo, ARRIVAL_BAND.hi);
  const s = Math.max(1, Math.floor(opts.start ?? 0));
  const e = Math.min(env.length - 1, Math.ceil(opts.end ?? env.length));
  if (e - s < 3) return null;
  let p = s;
  for (let k = s + 1; k < e; k++) if (env[k]! > env[p]!) p = k;
  const floor = env[p]! * Math.pow(10, -(opts.dropDb ?? 12) / 20);
  let k0 = p;
  for (let k = Math.max(s, p - Math.round(((opts.lookbackMs ?? 5) / 1000) * sampleRate)); k < p; k++) {
    if (env[k]! >= floor && env[k]! >= env[k - 1]! && env[k]! >= env[k + 1]!) {
      k0 = k;
      break;
    }
  }
  const a = env[k0 - 1]!;
  const b = env[k0]!;
  const c = env[k0 + 1]!;
  const den = a - 2 * b + c;
  const delta = den < 0 ? (0.5 * (a - c)) / den : 0;
  return {
    index: k0 + delta,
    snrDb: 20 * Math.log10(env[p]! / (median(env.subarray(s, e)) + 1e-30)),
    lagMs: ((p - k0) / sampleRate) * 1000,
    directDb: 20 * Math.log10(b + 1e-30),
  };
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
