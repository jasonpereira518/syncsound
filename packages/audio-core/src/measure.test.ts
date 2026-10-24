import { describe, expect, it } from 'vitest';
import { cascadeMagnitudeDb, designBiquad, processCascade } from './biquad';
import {
  convolve,
  deconvolve,
  detectArrival,
  estimateRolloffHz,
  logFreqs,
  magnitudeResponse,
  rmsDb,
  scanArrival,
  smoothFractionalOctave,
} from './measure';
import { chirpBand, logSweep, mulberry32, pinkNoise } from './signals';

const SR = 48000;

/** Hann-windowed log chirp evaluated at a fractional start offset (exact fractional delay). */
function chirpAt(f1: number, f2: number, dur: number, n: number, delay: number): Float32Array {
  const L = dur / Math.log(f2 / f1);
  const len = Math.round(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i - delay;
    if (s < 0 || s > len - 1) continue;
    const t = s / SR;
    out[i] =
      (0.5 - 0.5 * Math.cos((2 * Math.PI * s) / (len - 1))) *
      Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
  }
  return out;
}

describe('arrival detection', () => {
  it('finds a fractional delay to sub-sample accuracy (wide and narrow band)', () => {
    const rnd = mulberry32(3);
    for (const [f1, f2] of [
      [1000, 4000],
      [chirpBand(0).f1, chirpBand(0).f2],
    ] as const) {
      for (const d of [2000.37, 5123.81]) {
        const ref = chirpAt(f1, f2, 0.4, Math.round(0.4 * SR), 0);
        const rec = chirpAt(f1, f2, 0.4, 48000, d).map((v) => 0.3 * v + 0.003 * (rnd() - 0.5));
        const a = detectArrival(rec, ref)!;
        expect(Math.abs(a.index - d)).toBeLessThan(0.25);
        expect(a.peak).toBeGreaterThan(0.9);
        expect(a.snrDb).toBeGreaterThan(20);
      }
    }
  });

  it('respects the search window and rejects noise-only input', () => {
    const ref = chirpAt(1000, 4000, 0.1, 4800, 0);
    const rec = chirpAt(1000, 4000, 0.1, 30000, 20000);
    expect(detectArrival(rec, ref, { searchStart: 0, searchEnd: 10000 })).toBeNull();
    expect(detectArrival(rec, ref, { searchStart: 15000, searchEnd: 25000 })!.index).toBeCloseTo(20000, 1);
    const noise = pinkNoise(48000, 9, 0.1);
    expect(detectArrival(noise, chirpAt(chirpBand(5).f1, chirpBand(5).f2, 0.4, 19200, 0))).toBeNull();
  });
});

describe('sweep deconvolution', () => {
  const { signal, inverse } = logSweep({ f1: 40, f2: 16000, durationSec: 2, sampleRate: SR });
  const place = (x: Float32Array, at: number, gain: number) => {
    const rec = new Float32Array(at + x.length + 20000);
    x.forEach((v, i) => (rec[at + i] = gain * v));
    return rec;
  };

  it('recovers a known delay and gain', () => {
    const rec = place(signal, 1234, 0.3);
    const y = convolve(rec, inverse);
    let p = 0;
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[p]!)) p = i;
    expect(p - (signal.length - 1)).toBe(1234);
    const r = smoothFractionalOctave(
      magnitudeResponse(deconvolve(rec, inverse), SR, logFreqs(60, 12000, 24)),
      6,
    );
    for (const db of r.db) expect(db).toBeCloseTo(20 * Math.log10(0.3), 0);
  });

  it('recovers a filtered response (smoothed) within 0.5 dB', () => {
    const cs = [
      designBiquad('highpass', 300, Math.SQRT1_2, 0, SR),
      designBiquad('peaking', 4000, 1.2, 6, SR),
    ];
    const rec = place(processCascade(cs, signal), 500, 1);
    const fs = logFreqs(60, 12000, 24);
    const got = smoothFractionalOctave(magnitudeResponse(deconvolve(rec, inverse, 16384), SR, fs), 6);
    const want = smoothFractionalOctave({ freqs: fs, db: fs.map((f) => cascadeMagnitudeDb(cs, f, SR)) }, 6);
    got.db.forEach((d, i) => expect(Math.abs(d - want.db[i]!)).toBeLessThan(0.5));
    const roll = estimateRolloffHz(got);
    expect(roll).toBeGreaterThan(200);
    expect(roll).toBeLessThan(260);
  });

  it('rmsDb of a full-scale sine is −3 dB', () => {
    const s = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
    expect(rmsDb(s)).toBeCloseTo(-3.01, 2);
  });
});

describe('scanArrival', () => {
  it('returns the best candidate with no thresholds; detectArrival rejects the same noise-only window', () => {
    const rnd = mulberry32(11);
    const noise = Float32Array.from({ length: SR }, () => (rnd() * 2 - 1) * 0.01);
    const { f1, f2 } = chirpBand(3);
    const ref = chirpAt(f1, f2, 0.4, Math.round(0.4 * SR), 0);
    const scanned = scanArrival(noise, ref, {});
    expect(scanned).not.toBeNull();
    expect(scanned!.peak).toBeLessThan(0.1);
    expect(detectArrival(noise, ref, {})).toBeNull();
  });
});
