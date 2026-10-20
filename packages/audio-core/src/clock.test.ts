import { describe, expect, it } from 'vitest';
import { ClockSync, fitLine, sampleOffset, sampleRtt, type ClockSample } from './clock';

/** server = client + offset (+ drift), symmetric one-way delay d */
const sample = (t0: number, offset: number, d: number, proc = 1): ClockSample => ({
  t0,
  tsRecv: t0 + offset + d,
  tsSend: t0 + offset + d + proc,
  t3: t0 + 2 * d + proc,
});

describe('sample math', () => {
  it('rtt excludes server processing; offset exact for symmetric paths', () => {
    const s = sample(1000, 5000, 20, 3);
    expect(sampleRtt(s)).toBe(40);
    expect(sampleOffset(s)).toBe(5000);
  });
});

describe('fitLine', () => {
  it('fits epoch-sized data and rejects outliers', () => {
    const xs = Array.from({ length: 50 }, (_, i) => 1.7e12 + i * 1000);
    const ys = xs.map((x) => 3 + 2e-6 * (x - 1.7e12));
    ys[10]! += 500;
    const f = fitLine(xs, ys);
    expect(f.slope).toBeCloseTo(2e-6, 9);
    expect(f.n).toBe(49);
  });
});

describe('ClockSync', () => {
  it('identity before any sample, converges after minSamples', () => {
    const c = new ClockSync();
    expect(c.toRoomTime(123)).toBe(123);
    for (let i = 0; i < 7; i++) c.addSample(sample(i * 50, 1e6, 15));
    expect(c.estimate().converged).toBe(false);
    c.addSample(sample(400, 1e6, 15));
    const e = c.estimate();
    expect(e.converged).toBe(true);
    expect(e.offsetMs).toBeCloseTo(1e6, 6);
    expect(e.rttMs).toBeCloseTo(30, 6);
  });

  it('ignores high-RTT outliers via the best subset', () => {
    const c = new ClockSync();
    for (let i = 0; i < 40; i++) {
      // every 3rd sample has a 200 ms one-way spike on the uplink (offset error +100 ms)
      const s = sample(i * 1000, 5000, 10);
      if (i % 3 === 0) {
        s.tsRecv += 200;
        s.tsSend += 200;
        s.t3 += 200;
      }
      c.addSample(s);
    }
    expect(Math.abs(c.estimate().offsetMs - 5000)).toBeLessThan(0.01);
  });

  it('toLocalTime is the exact inverse of toRoomTime, including mid-slew', () => {
    const c = new ClockSync();
    for (let i = 0; i < 10; i++) c.addSample(sample(i * 50, 2000, 10));
    c.addSample(sample(1000, 2010, 10)); // 10 ms jump → slewing
    for (const l of [-5000, 0, 1020, 5000, 11_000, 1e6]) expect(c.toLocalTime(c.toRoomTime(l))).toBeCloseTo(l, 6);
  });

  it('slews small corrections at ≤ maxSlew and steps large ones', () => {
    const c = new ClockSync({ maxSlewMsPerSec: 1, stepThresholdMs: 50 });
    for (let i = 0; i < 10; i++) c.addSample(sample(i * 50, 0, 10));
    // two lower-RTT samples at +10 ms take over the best subset → target +10 → slew, not step
    c.addSample(sample(1000, 10, 5));
    c.addSample(sample(1001, 10, 5));
    const at = (l: number) => c.toRoomTime(l) - l;
    const a0 = at(1020);
    expect(a0).toBeLessThan(1);
    expect(at(2020) - a0).toBeCloseTo(1, 6); // 1 ms per second
    expect(at(30_000)).toBeCloseTo(10, 6); // reaches the target, then holds
    for (let i = 0; i < 3; i++) c.addSample(sample(2000 + i, 500, 3)); // best subset now says +500 → step
    expect(c.estimate().offsetMs).toBeCloseTo(500, 6);
  });

  it('reset forgets state', () => {
    const c = new ClockSync();
    for (let i = 0; i < 10; i++) c.addSample(sample(i * 50, 777, 10));
    c.reset();
    expect(c.estimate().samples).toBe(0);
    expect(c.toRoomTime(5)).toBe(5);
    c.addSample(sample(0, -3000, 10));
    expect(c.estimate().offsetMs).toBeCloseTo(-3000, 6);
  });

  it('estimates drift (client slow → +ppm)', () => {
    const c = new ClockSync();
    const ppm = 50;
    for (let i = 0; i < 120; i++) c.addSample(sample(i * 1000, 100 + ppm * 1e-6 * i * 1000, 20));
    expect(c.estimate().driftPpm).toBeCloseTo(ppm, 1);
  });
});
