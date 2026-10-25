import { describe, expect, it } from 'vitest';
import { cascadeMagnitudeDb, designBiquad, type BiquadCoeffs } from './biquad';
import { classPresetEq, commonTarget, eqToBiquads, fitEq, houseCurve } from './eq';
import { loudnessTrims, volumeHints } from './loudness';
import { estimateRolloffHz, logFreqs, smoothFractionalOctave, type Response } from './measure';

const SR = 48000;
const FS = logFreqs(40, 16000, 24);
const resp = (cs: BiquadCoeffs[], levelDb = 0): Response =>
  smoothFractionalOctave({ freqs: FS, db: FS.map((f) => levelDb + cascadeMagnitudeDb(cs, f, SR)) }, 6);
const b = designBiquad;

const cases: Record<string, BiquadCoeffs[]> = {
  presencePeak: [b('peaking', 3000, 2, 6, SR)],
  midDip: [b('peaking', 800, 1.5, -5, SR), b('highshelf', 8000, 1, -3, SR)],
  smallSpeaker: [
    b('highpass', 150, Math.SQRT1_2, 0, SR),
    b('peaking', 1200, 1, 4, SR),
    b('peaking', 6000, 3, -4, SR),
  ],
  boomyBass: [b('lowshelf', 250, 1, 5, SR), b('peaking', 2500, 1.5, 3, SR)],
};

describe('fitEq', () => {
  for (const [name, cs] of Object.entries(cases)) {
    it(`${name}: corrected response within ±2 dB of the target in the passband`, () => {
      const m = resp(cs, -20);
      const target = commonTarget([m]);
      const rolloff = estimateRolloffHz(m);
      const fit = fitEq(m, target, { sampleRate: SR, rolloffHz: rolloff });
      const lo = Math.max(60, 1.2 * rolloff);
      const idx = FS.flatMap((f, i) => (f >= lo && f <= 14000 ? [i] : []));
      const off = idx.reduce((s, i) => s + fit.predictedDb[i]! - target[i]!, 0) / idx.length;
      for (const i of idx) expect(Math.abs(fit.predictedDb[i]! - target[i]! - off)).toBeLessThanOrEqual(2);
      expect(fit.rmsErrorAfterDb).toBeLessThan(fit.rmsErrorBeforeDb);
    });
  }

  it('safety rails: boost ≤ 6 dB per band, no boost below rolloff, overall ≤ 0 dB, protective HP', () => {
    // deep narrow-ish notch + steep rolloff: tempts the fitter to boost hard and low
    const m = resp([b('highpass', 250, 1, 0, SR), b('peaking', 1500, 2, -15, SR)]);
    const rolloff = estimateRolloffHz(m);
    const fit = fitEq(m, commonTarget([m]), { sampleRate: SR, rolloffHz: rolloff, maxBands: 6 });
    expect(fit.eq.bands.length).toBeLessThanOrEqual(6);
    expect(Math.max(...fit.eq.bands.map((x) => x.gainDb))).toBeLessThanOrEqual(6);
    expect(fit.eq.highpassHz).toBe(Math.round(rolloff));
    const cs = eqToBiquads(fit.eq, SR);
    const dense = logFreqs(20, 20000, 96);
    for (const f of dense) {
      const g = cascadeMagnitudeDb(cs, f, SR);
      if (f < rolloff) expect(g).toBeLessThanOrEqual(0.05);
      expect(g + fit.eq.preampDb).toBeLessThanOrEqual(0.05);
    }
    expect(fit.eq.preampDb).toBeGreaterThanOrEqual(-12);
    expect(fit.eq.preampDb).toBeLessThanOrEqual(0);
    // no HP for full-range devices
    expect(
      fitEq(resp([]), commonTarget([resp([])]), { sampleRate: SR, rolloffHz: 40 }).eq.highpassHz,
    ).toBeNull();
  });

  it('house curve is 0 dB at 1 kHz, +3 dB in the deep bass, tilted down in the treble', () => {
    const [lo, mid, hi] = houseCurve([50, 1000, 8000]);
    expect(lo).toBe(3);
    expect(mid).toBe(0);
    expect(hi).toBeCloseTo(-2, 9);
  });

  it('class presets and eqToBiquads', () => {
    const phone = classPresetEq('phone');
    expect(phone.eq.highpassHz).toBe(180);
    expect(phone.bassCapable).toBe(false);
    expect(phone.eq.source).toBe('preset');
    expect(classPresetEq('desktop').bassCapable).toBe(true);
    expect(classPresetEq('desktop').eq.highpassHz).toBeNull();
    expect(classPresetEq('laptop').eq.preampDb).toBeLessThan(0);
    expect(eqToBiquads(phone.eq, SR)).toHaveLength(2);
    expect(eqToBiquads({ ...phone.eq, enabled: false }, SR)).toHaveLength(0);
  });

  it('loudness trims meet in the middle: loud devices cut, soft ones boosted (≤ +6 dB) to the median', () => {
    expect(loudnessTrims({ a: -20, b: -26, c: -23 })).toEqual({ a: -3, b: 3, c: 0 });
    // even count: the mean of the middle two (−21.5)
    expect(loudnessTrims({ a: -20, b: -23 })).toEqual({ a: -1.5, b: 1.5 });
    // b would need +15: capped at the boost limit; a 40 dB-hot device is floored at −24
    expect(loudnessTrims({ a: -20, b: -35, c: -20 })).toEqual({ a: 0, b: 6, c: 0 });
    expect(loudnessTrims({ a: 20, b: -20, c: -20 })).toEqual({ a: -24, b: 0, c: 0 });
    expect(loudnessTrims({ a: -20, b: -30 }, { refDb: -24 })).toEqual({ a: -4, b: 6 });
    expect(loudnessTrims({})).toEqual({});
  });

  it('volume hints flag only what the boost leaves short', () => {
    // median −21: b is 14 dB under, the boost covers 6 → raise it ~8 dB
    expect(volumeHints({ a: -20, b: -35, c: -21 })).toEqual({ b: 8 });
    // within the boost (+ 1 dB tolerance): no hint
    expect(volumeHints({ a: -20, b: -26.9, c: -20 })).toEqual({});
    expect(volumeHints({ a: -20, b: -40 })).toEqual({ b: 4 });
    expect(volumeHints({ a: -20 })).toEqual({});
  });
});
