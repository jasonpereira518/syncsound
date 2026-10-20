import { describe, expect, it } from 'vitest';
import { AudioClockMap } from './audioClock';

describe('AudioClockMap', () => {
  it('fits rate and offset, rejects a scheduling spike, inverts', () => {
    const m = new AudioClockMap();
    expect(m.ready()).toBe(false);
    const rate = 1 + 80e-6;
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
    for (let i = 0; i < 64; i++) {
      const perf = 1e6 + i * 500;
      let ctx = 3 + ((perf - 1e6) / 1000) * rate + rnd() * 0.0027; // ±half render quantum, zero-mean
      if (i === 17) ctx += 0.05; // 50 ms OS hiccup
      m.addObservation(perf, ctx);
    }
    expect(m.ready()).toBe(true);
    expect(Math.abs(m.ratePpm() - 80)).toBeLessThan(20);
    expect(Math.abs(m.perfToCtx(1e6 + 5000) - (3 + 5 * rate))).toBeLessThan(0.0005);
    expect(m.ctxToPerf(m.perfToCtx(1234567))).toBeCloseTo(1234567, 6);
    m.reset();
    expect(m.ready()).toBe(false);
  });

  it('falls back to nominal rate before it has two observations', () => {
    const m = new AudioClockMap();
    m.addObservation(5000, 1);
    expect(m.perfToCtx(6000)).toBeCloseTo(2, 9);
  });
});
