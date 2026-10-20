import { describe, expect, it } from 'vitest';
import {
  biquadMagnitudeDb,
  biquadResponse,
  cascadeMagnitudeDb,
  designBiquad,
  linkwitzRiley4,
  processCascade,
  type BiquadCoeffs,
} from './biquad';
import { realMagnitude } from './fft';
import { logFreqs } from './measure';

const SR = 48000;
const cascadeComplex = (cs: BiquadCoeffs[], f: number) =>
  cs.reduce(
    (acc, c) => {
      const h = biquadResponse(c, f, SR);
      return { re: acc.re * h.re - acc.im * h.im, im: acc.re * h.im + acc.im * h.re };
    },
    { re: 1, im: 0 },
  );

describe('biquad', () => {
  it('LR4: LP + HP sums to an allpass (flat ±0.1 dB) and each branch is −6 dB at the crossover', () => {
    for (const fc of [80, 100, 250]) {
      const { lowpass, highpass } = linkwitzRiley4(fc, SR);
      for (const f of logFreqs(10, 22000, 12)) {
        const a = cascadeComplex(lowpass, f);
        const b = cascadeComplex(highpass, f);
        expect(Math.abs(10 * Math.log10((a.re + b.re) ** 2 + (a.im + b.im) ** 2))).toBeLessThan(0.1);
      }
      expect(cascadeMagnitudeDb(lowpass, fc, SR)).toBeCloseTo(-6.02, 1);
      expect(cascadeMagnitudeDb(highpass, fc, SR)).toBeCloseTo(-6.02, 1);
    }
  });

  it('processCascade (time domain) realizes the same flat LR4 sum', () => {
    const { lowpass, highpass } = linkwitzRiley4(100, SR);
    const imp = new Float32Array(65536);
    imp[0] = 1;
    const lp = processCascade(lowpass, imp);
    const hp = processCascade(highpass, imp);
    const mag = realMagnitude(
      lp.map((v, i) => v + hp[i]!),
      65536,
    );
    for (let k = 3; k < mag.length; k += 97) expect(Math.abs(20 * Math.log10(mag[k]!))).toBeLessThan(0.1);
  });

  it('cookbook designs hit their nominal gains', () => {
    expect(biquadMagnitudeDb(designBiquad('peaking', 1000, 2, 6, SR), 1000, SR)).toBeCloseTo(6, 6);
    expect(biquadMagnitudeDb(designBiquad('peaking', 4000, 0.7, -9, SR), 4000, SR)).toBeCloseTo(-9, 6);
    expect(biquadMagnitudeDb(designBiquad('lowshelf', 200, 1, -8, SR), 10, SR)).toBeCloseTo(-8, 1);
    expect(biquadMagnitudeDb(designBiquad('lowshelf', 200, 1, -8, SR), 200, SR)).toBeCloseTo(-4, 1);
    expect(biquadMagnitudeDb(designBiquad('highshelf', 5000, 1, 4, SR), 22000, SR)).toBeCloseTo(4, 1);
    expect(biquadMagnitudeDb(designBiquad('highpass', 300, Math.SQRT1_2, 0, SR), 300, SR)).toBeCloseTo(
      -3.01,
      2,
    );
    expect(biquadMagnitudeDb(designBiquad('lowpass', 300, Math.SQRT1_2, 0, SR), 300, SR)).toBeCloseTo(
      -3.01,
      2,
    );
    expect(biquadMagnitudeDb(designBiquad('highpass', 300, Math.SQRT1_2, 0, SR), 5000, SR)).toBeCloseTo(0, 2);
  });
});
