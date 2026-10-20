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

describe('AudioClockMap output-path steps', () => {
  it('re-fits after a persistent latency step instead of bending the slope', () => {
    const m = new AudioClockMap();
    const obs = (perf: number, lat: number) => {
      const ctx = Math.floor((((perf - lat) / 1000) * 48000) / 128) * 128 / 48000;
      m.addObservation(ctx * 1000 + lat, ctx);
    };
    let perf = 3000;
    for (let i = 0; i < 20; i++) obs((perf += 250), 304);
    // output latency jumps +44 ms (device re-open)
    for (let i = 0; i < 6; i++) obs((perf += 250), 348);
    expect(m.steps).toBe(1);
    expect(m.ready()).toBe(true);
    expect(Math.abs(m.ratePpm())).toBeLessThan(100);
    // prediction 1.5 s ahead in the new regime within 1 ms
    const future = perf + 1500;
    const truth = (future - 348) / 1000;
    expect(Math.abs(m.perfToCtx(future) - truth) * 1000).toBeLessThan(1);
  });

  it('ignores a single spike', () => {
    const m = new AudioClockMap();
    let perf = 1000;
    for (let i = 0; i < 20; i++) m.addObservation((perf += 250), (perf - 50) / 1000);
    m.addObservation((perf += 250), (perf - 50) / 1000 + 0.03); // 30 ms glitch
    for (let i = 0; i < 4; i++) m.addObservation((perf += 250), (perf - 50) / 1000);
    expect(m.steps).toBe(0);
    expect(Math.abs(m.ratePpm())).toBeLessThan(10);
  });
});
