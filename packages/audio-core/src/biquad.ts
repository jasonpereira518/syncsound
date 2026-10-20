import type { EqBand } from '@syncsound/protocol';

/** Normalized biquad (a0 = 1): y = b0 x + b1 x1 + b2 x2 − a1 y1 − a2 y2 */
export interface BiquadCoeffs {
  b: [number, number, number];
  a: [number, number, number];
}

export type BiquadType = EqBand['type'];

/** RBJ Audio-EQ-Cookbook designs. q is linear Q (for shelves: S=q). */
export function designBiquad(
  type: BiquadType,
  freq: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'lowshelf' || type === 'highshelf') {
    // shelf slope S = q; clamp so the sqrt argument stays ≥ 0
    const alpha = (sw / 2) * Math.sqrt(Math.max(0, (A + 1 / A) * (1 / q - 1) + 2));
    const k = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cw + k);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - k);
      a0 = A + 1 + (A - 1) * cw + k;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - k;
    } else {
      b0 = A * (A + 1 + (A - 1) * cw + k);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - k);
      a0 = A + 1 - (A - 1) * cw + k;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - k;
    }
  } else {
    const alpha = sw / (2 * q);
    switch (type) {
      case 'peaking':
        b0 = 1 + alpha * A;
        b1 = -2 * cw;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cw;
        a2 = 1 - alpha / A;
        break;
      case 'lowpass':
        b0 = (1 - cw) / 2;
        b1 = 1 - cw;
        b2 = (1 - cw) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2;
        b1 = -(1 + cw);
        b2 = (1 + cw) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
    }
  }
  return { b: [b0 / a0, b1 / a0, b2 / a0], a: [1, a1 / a0, a2 / a0] };
}

/** Complex frequency response H(e^{jw}) of one section. */
export function biquadResponse(
  c: BiquadCoeffs,
  freq: number,
  sampleRate: number,
): { re: number; im: number } {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c.b[0] + c.b[1] * c1 + c.b[2] * c2;
  const ni = -(c.b[1] * s1 + c.b[2] * s2);
  const dr = c.a[0] + c.a[1] * c1 + c.a[2] * c2;
  const di = -(c.a[1] * s1 + c.a[2] * s2);
  const den = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

export function biquadMagnitudeDb(c: BiquadCoeffs, freq: number, sampleRate: number): number {
  const h = biquadResponse(c, freq, sampleRate);
  return 10 * Math.log10(Math.max(h.re * h.re + h.im * h.im, 1e-30));
}

export function cascadeMagnitudeDb(cs: BiquadCoeffs[], freq: number, sampleRate: number): number {
  let db = 0;
  for (const c of cs) db += biquadMagnitudeDb(c, freq, sampleRate);
  return db;
}

/** 4th-order Linkwitz-Riley crossover = two cascaded Butterworth (Q=1/√2) sections per branch. */
export function linkwitzRiley4(
  freq: number,
  sampleRate: number,
): { lowpass: BiquadCoeffs[]; highpass: BiquadCoeffs[] } {
  const lp = designBiquad('lowpass', freq, Math.SQRT1_2, 0, sampleRate);
  const hp = designBiquad('highpass', freq, Math.SQRT1_2, 0, sampleRate);
  return { lowpass: [lp, lp], highpass: [hp, hp] };
}

/** Run a cascade over a signal (Direct Form I). */
export function processCascade(cs: BiquadCoeffs[], input: Float32Array): Float32Array {
  let buf = Float64Array.from(input);
  for (const { b, a } of cs) {
    const out = new Float64Array(buf.length);
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let n = 0; n < buf.length; n++) {
      const x = buf[n]!;
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[n] = y;
    }
    buf = out;
  }
  return Float32Array.from(buf);
}

/** IIRFilterNode arguments ([b0,b1,b2], [1,a1,a2]) */
export function toIirArgs(c: BiquadCoeffs): { feedforward: number[]; feedback: number[] } {
  return { feedforward: [...c.b], feedback: [...c.a] };
}
