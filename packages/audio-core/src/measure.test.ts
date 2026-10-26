import { describe, expect, it } from 'vitest';
import { cascadeMagnitudeDb, designBiquad, processCascade } from './biquad';
import {
  convolve,
  crossCorrelate,
  deconvolve,
  estimateRolloffHz,
  firstArrival,
  logFreqs,
  loudnessDb,
  magnitudeResponse,
  rmsDb,
  smoothFractionalOctave,
} from './measure';
import { logSweep, mulberry32, pinkNoise } from './signals';

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

describe('firstArrival', () => {
  const ref = chirpAt(300, 20000, 0.1, 4800, 0);
  const arrival = (rec: Float32Array) => firstArrival(crossCorrelate(rec, ref), SR)!;

  it('finds a fractional delay to sub-sample accuracy', () => {
    const rnd = mulberry32(3);
    for (const d of [2000.37, 5123.81]) {
      const rec = chirpAt(300, 20000, 0.1, 12000, d).map((v) => 0.3 * v + 0.003 * (rnd() - 0.5));
      const a = arrival(rec);
      expect(Math.abs(a.index - d)).toBeLessThan(0.25);
      expect(a.snrDb).toBeGreaterThan(30);
      expect(a.lagMs).toBe(0);
    }
  });

  it('takes the direct path when a reflection 1.5 ms later is 3 dB louder', () => {
    const d = 3000.4;
    const lag = 0.0015 * SR;
    const direct = chirpAt(300, 20000, 0.1, 12000, d);
    const refl = chirpAt(300, 20000, 0.1, 12000, d + lag);
    const rec = direct.map((v, i) => 0.3 * v + 0.42 * refl[i]!);
    const a = arrival(rec);
    expect(Math.abs(a.index - d)).toBeLessThan(0.5);
    expect(a.lagMs).toBeCloseTo(1.5, 1);
  });

  it('stays below the heard gate on noise only, and respects the window', () => {
    const noise = pinkNoise(24000, 9, 0.1);
    expect(firstArrival(crossCorrelate(noise, ref), SR)!.snrDb).toBeLessThan(20);
    const rec = chirpAt(300, 20000, 0.1, 30000, 20000);
    const y = crossCorrelate(rec, ref);
    expect(firstArrival(y, SR, { start: 15000, end: 25000 })!.index).toBeCloseTo(20000, 1);
    expect(firstArrival(y, SR, { start: 0, end: 10000 })!.snrDb).toBeLessThan(20);
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

describe('loudnessDb', () => {
  const fs = logFreqs(20, 16000, 24);
  const flat = (db: number) => ({ freqs: fs, db: fs.map(() => db) });

  it('moves dB for dB with a uniform level change', () => {
    expect(loudnessDb(flat(6)) - loudnessDb(flat(0))).toBeCloseTo(6, 9);
    expect(loudnessDb(flat(-20)) - loudnessDb(flat(0))).toBeCloseTo(-20, 9);
  });

  it('ignores the bass below its band, weighs treble above midrange, and a dip less than an equal peak', () => {
    const lift = (lo: number, hi: number, db: number) => ({ freqs: fs, db: fs.map((f) => (f >= lo && f < hi ? db : 0)) });
    expect(loudnessDb(lift(20, 150, -20))).toBeCloseTo(loudnessDb(flat(0)), 9);
    // same octave count, +6 dB: 4–8 kHz (K-shelf +4 dB) counts more than 250–500 Hz
    expect(loudnessDb(lift(4000, 8000, 6))).toBeGreaterThan(loudnessDb(lift(250, 500, 6)));
    // power mean: a −10 dB octave costs less than a +10 dB octave adds
    const dip = loudnessDb(flat(0)) - loudnessDb(lift(1000, 2000, -10));
    const peak = loudnessDb(lift(1000, 2000, 10)) - loudnessDb(flat(0));
    expect(dip).toBeLessThan(peak);
  });
});
