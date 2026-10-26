import { describe, expect, it } from 'vitest';
import { cascadeMagnitudeDb, designBiquad, processCascade } from './biquad';
import { crossCorrelate, deconvolve, firstArrival, logFreqs, magnitudeResponse, smoothFractionalOctave } from './measure';
import {
  CALIBRATION_PEAK,
  CALIBRATION_SIGNAL_MS,
  calibrationArrivalRef,
  calibrationInverse,
  calibrationSignal,
  mulberry32,
  TUNE_SWOOSH_MS,
  tuneSignalParts,
} from './signals';

const SR = 48000;
const IR = 16384;
const FS = logFreqs(40, 16000, 24);

/** the tune signal through `cs` (and optionally `shape`), placed at `at` in a recording like analyzeRecording sees */
function record(at: number, cs: ReturnType<typeof designBiquad>[], opts: { noise?: number; shape?: (v: number) => number } = {}) {
  const x = processCascade(cs, calibrationSignal('tune', 0, SR));
  const rec = new Float32Array(at + x.length + IR + 4800);
  const rnd = mulberry32(5);
  x.forEach((v, i) => (rec[at + i] = opts.shape ? opts.shape(v) : v));
  if (opts.noise) for (let i = 0; i < rec.length; i++) rec[i] = rec[i]! + opts.noise * (rnd() - 0.5) * Math.sqrt(12);
  return rec;
}

/** the same segment + deconvolution analyzeRecording uses, smoothed to 1/6 octave */
function response(rec: Float32Array, at: number) {
  const full = calibrationSignal('tune', 0, SR);
  const seg = rec.subarray(at - 2400, Math.min(rec.length, at + full.length + IR + 2400));
  return smoothFractionalOctave(magnitudeResponse(deconvolve(seg, calibrationInverse('tune', SR), IR), SR, FS), 6);
}

const want = (cs: ReturnType<typeof designBiquad>[], offsetDb = 0) =>
  smoothFractionalOctave({ freqs: FS, db: FS.map((f) => offsetDb + cascadeMagnitudeDb(cs, f, SR)) }, 6);

describe('tune signal (swoosh → chime)', () => {
  it('has the declared length, stays under the calibration peak and starts and ends silent', () => {
    const { swoosh, full } = tuneSignalParts(SR);
    expect(full.length).toBe(Math.round((CALIBRATION_SIGNAL_MS.tune / 1000) * SR));
    expect(swoosh.length).toBe(Math.round((TUNE_SWOOSH_MS / 1000) * SR));
    let peak = 0;
    for (const v of full) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(CALIBRATION_PEAK + 1e-6);
    expect(Math.abs(full[0]!)).toBeLessThan(1e-6);
    expect(Math.abs(full[full.length - 1]!)).toBeLessThan(1e-4);
    expect(Math.abs(swoosh[swoosh.length - 1]!)).toBeLessThan(1e-4);
  });

  it('is deterministic, and the arrival reference is its swoosh (a prefix of the signal)', () => {
    const a = calibrationSignal('tune', 0, SR);
    const b = calibrationSignal('tune', 7, SR);
    expect(Array.from(a)).toEqual(Array.from(b));
    const ref = calibrationArrivalRef('tune', 0, SR);
    expect(ref.length).toBe(Math.round((TUNE_SWOOSH_MS / 1000) * SR));
    expect(Array.from(ref)).toEqual(Array.from(a.subarray(0, ref.length)));
    expect(Array.from(calibrationArrivalRef('chirp', 0, SR))).toEqual(Array.from(calibrationSignal('chirp', 0, SR)));
  });

  it('times the direct path through a speaker, past a 3 dB louder reflection 2 ms later', () => {
    const cs = [designBiquad('highpass', 200, Math.SQRT1_2, 0, SR), designBiquad('peaking', 3000, 1, 4, SR)];
    const x = processCascade(cs, calibrationSignal('tune', 0, SR));
    const at = 12000;
    const lag = 0.002 * SR;
    const rec = new Float32Array(at + x.length + 12000);
    x.forEach((v, i) => {
      rec[at + i] = rec[at + i]! + 0.3 * v;
      rec[at + lag + i] = rec[at + lag + i]! + 0.42 * v;
    });
    const y = crossCorrelate(rec, calibrationArrivalRef('tune', 0, SR));
    const a = firstArrival(y, SR, { start: at - 9600, end: at + 24000 })!;
    expect(a.snrDb).toBeGreaterThan(30);
    // the speaker's minimum-phase group delay moves the band envelope a little: same filter ⇒ same bias for every
    // device, which the tune cancels. Compare against the clean (no reflection) arrival through the same filter.
    const clean = new Float32Array(rec.length);
    x.forEach((v, i) => (clean[at + i] = 0.3 * v));
    const c = firstArrival(crossCorrelate(clean, calibrationArrivalRef('tune', 0, SR)), SR, { start: at - 9600, end: at + 24000 })!;
    expect(Math.abs(a.index - c.index) / SR * 1000).toBeLessThan(0.02);
    expect(Math.abs(c.index - at) / SR * 1000).toBeLessThan(0.1);
  });

  it('no envelope peak within 20 dB of the arrival in the 5 ms before it (the chime is not in the reference)', () => {
    const at = 12000;
    const rec = record(at, []);
    const y = crossCorrelate(rec, calibrationArrivalRef('tune', 0, SR));
    const a = firstArrival(y, SR, { start: at - 9600, end: at + 24000, dropDb: 20 })!;
    expect(Math.abs(a.index - at)).toBeLessThan(0.5);
    expect(a.lagMs).toBe(0);
  });
});

describe('regularized deconvolution of the tune signal', () => {
  const cs = [
    designBiquad('highpass', 150, Math.SQRT1_2, 0, SR),
    designBiquad('peaking', 4000, 1.2, 6, SR),
    designBiquad('highshelf', 9000, Math.SQRT1_2, -4, SR),
  ];

  it('recovers unit gain and a known delay', () => {
    const at = 7000;
    const rec = record(at, []).map((v) => 0.3 * v);
    const r = response(rec, at);
    for (const db of r.db) expect(Math.abs(db - 20 * Math.log10(0.3))).toBeLessThan(0.3);
  });

  it('recovers a speaker response within 0.5 dB, 40 Hz–16 kHz (the chime leaves no tones behind)', () => {
    const at = 7000;
    const got = response(record(at, cs), at);
    const w = want(cs);
    got.db.forEach((d, i) => expect(Math.abs(d - w.db[i]!)).toBeLessThan(0.5));
  });

  it('…with −60 dB of noise', () => {
    const at = 7000;
    const got = response(record(at, cs, { noise: 0.25 * 1e-3 }), at);
    const w = want(cs);
    got.db.forEach((d, i) => expect(Math.abs(d - w.db[i]!)).toBeLessThan(0.5));
  });

  it('…and within 1 dB through a mildly distorting (soft-clipping) speaker', () => {
    const at = 7000;
    // tanh drive: 3rd harmonic ≈ x²/12 of the fundamental at amplitude x, so drive·peak = 0.35 is ~1% on the
    // loudest parts (−0.35 dB of compression there)
    const drive = 0.35 / CALIBRATION_PEAK;
    const got = response(record(at, cs, { shape: (v) => Math.tanh(drive * v) / drive }), at);
    const w = want(cs);
    got.db.forEach((d, i) => expect(Math.abs(d - w.db[i]!)).toBeLessThan(1));
  });
});
