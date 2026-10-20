import { describe, expect, it } from 'vitest';
import { fft, nextPow2, realMagnitude } from './fft';
import { mulberry32 } from './signals';

describe('fft', () => {
  it('round-trips and satisfies Parseval', () => {
    const rnd = mulberry32(1);
    const n = 1024;
    const re = Float64Array.from({ length: n }, () => rnd() - 0.5);
    const im = Float64Array.from({ length: n }, () => rnd() - 0.5);
    const r0 = re.slice();
    const i0 = im.slice();
    const eTime = r0.reduce((s, x, k) => s + x * x + i0[k]! * i0[k]!, 0);
    fft(re, im);
    const eFreq = re.reduce((s, x, k) => s + x * x + im[k]! * im[k]!, 0) / n;
    expect(eFreq).toBeCloseTo(eTime, 9);
    fft(re, im, true);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(r0[k]!, 12);
      expect(im[k]).toBeCloseTo(i0[k]!, 12);
    }
  });

  it('puts a sine in its bin; realMagnitude zero-pads', () => {
    const n = 256;
    const x = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 10 * i) / n));
    const m = realMagnitude(x, n);
    expect(m.length).toBe(n / 2 + 1);
    expect(m[10]).toBeCloseTo(n / 2, 9);
    expect(m[11]).toBeCloseTo(0, 9);
    expect(realMagnitude(new Float32Array([1]), 8).every((v) => Math.abs(v - 1) < 1e-12)).toBe(true);
    expect(nextPow2(1000)).toBe(1024);
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
  });
});
