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

  it('rejects a high-leverage outlier at the end of a short window (a late timestamp in the first 8 observations)', () => {
    const xs = Array.from({ length: 8 }, (_, i) => 1.7e12 + i * 250);
    const ys = xs.map((x) => 3 + 1e-3 * (1 + 80e-6) * (x - 1.7e12));
    xs[7]! += 24; // the perf stamp came 24 ms late: the point sits 24 ms right of the line
    const f = fitLine(xs, ys, 3, 1e-5);
    expect(f.n).toBe(7);
    expect(Math.abs(f.slope / 1e-3 - 1) * 1e6).toBeLessThan(100); // within 100 ppm, not bent by 8000
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

describe('ClockSync re-acquisition after a gap', () => {
  const ppm = 50;
  const off = (t: number) => 100 + ppm * 1e-6 * t;

  it('bounds the window by age, not by count (one ping a minute keeps ≤ 5 min of samples)', () => {
    const c = new ClockSync();
    for (let i = 0; i < 10; i++) c.addSample(sample(i * 60_000, 100, 10));
    expect(c.estimate().samples).toBe(6); // 240 s … 540 s
  });

  it('a burst after a silence that agrees with the mapping forgets nothing', () => {
    const c = new ClockSync();
    let t = 0;
    for (; t < 60_000; t += 1000) c.addSample(sample(t, off(t), 20));
    const drift0 = c.estimate().driftPpm;
    expect(Math.abs(drift0 - ppm)).toBeLessThan(1);
    t = 90_000; // 30 s without pings, then a burst
    for (let i = 0; i < 25; i++, t += 40) c.addSample(sample(t, off(t), 20));
    const e = c.estimate();
    expect(e.samples).toBe(64);
    expect(Math.abs(e.driftPpm - drift0)).toBeLessThan(0.5);
    expect(Math.abs(e.pendingSlewMs)).toBeLessThan(0.05);
    expect(Math.abs(c.toRoomTime(t) - (t + off(t)))).toBeLessThan(0.05);
  });

  it('a burst that disagrees steps onto it, drops the old window and carries the drift over', () => {
    const c = new ClockSync();
    let t = 0;
    for (; t < 60_000; t += 1000) c.addSample(sample(t, off(t), 20));
    t = 100_000; // the server (or the device) clock jumped +4 s while no pings flowed
    for (let i = 0; i < 8; i++, t += 40) c.addSample(sample(t, off(t) + 4000, 20));
    const e = c.estimate();
    expect(e.samples).toBe(8); // stepped at the 8th post-gap sample, pre-gap window gone
    expect(e.pendingSlewMs).toBe(0);
    expect(e.ageMs).toBeLessThan(500);
    expect(Math.abs(c.toRoomTime(t) - (t + off(t) + 4000))).toBeLessThan(0.1);
    expect(Math.abs(e.driftPpm - ppm)).toBeLessThan(2); // carried over as the prior for the new history
    for (let i = 0; i < 120; i++, t += 1000) c.addSample(sample(t, off(t) + 4000, 20));
    expect(Math.abs(c.estimate().driftPpm - ppm)).toBeLessThan(1);
    expect(c.estimate().resets).toBe(0);
  });

  it('rebase() re-acquires without a reset; shiftSince reports how far the mapping moved', () => {
    const c = new ClockSync();
    let t = 0;
    for (; t < 30_000; t += 1000) c.addSample(sample(t, 500, 20));
    const before = c.mapping()!;
    c.rebase();
    for (let i = 0; i < 25; i++, t += 40) c.addSample(sample(t, 500, 20));
    expect(Math.abs(c.shiftSince(before, t))).toBeLessThan(0.01);
    expect(c.estimate().samples).toBe(55);
    c.rebase();
    for (let i = 0; i < 25; i++, t += 40) c.addSample(sample(t, 520, 20)); // +20 ms: between the 3 ms gap and 50 ms step thresholds
    expect(c.shiftSince(before, t)).toBeCloseTo(20, 1);
    expect(c.estimate().samples).toBe(25);
  });

  it('frozenAt is the de-slewed mapping anchored at the applied offset', () => {
    const c = new ClockSync();
    for (let i = 0; i < 10; i++) c.addSample(sample(i * 50, 2000, 10));
    // two lower-RTT samples at +10 ms take over the best subset → slewing at 1 ms/s for 10 s
    c.addSample(sample(1000, 2010, 5));
    c.addSample(sample(1001, 2010, 5));
    expect(c.estimate().pendingSlewMs).toBeCloseTo(10, 3);
    const f = c.frozenAt(1020);
    expect(f.toRoomTime(1020)).toBeCloseTo(c.toRoomTime(1020), 6);
    const live = (c.toRoomTime(2020) - c.toRoomTime(1020)) / 1000 - 1;
    const frozen = (f.toRoomTime(2020) - f.toRoomTime(1020)) / 1000 - 1;
    expect(live).toBeCloseTo(1e-3, 6);
    expect(Math.abs(frozen)).toBeLessThan(5e-6);
    expect(f.toLocalTime(f.toRoomTime(777))).toBeCloseTo(777, 9);
  });

  it('reset counts and clears the re-acquisition state', () => {
    const c = new ClockSync();
    for (let i = 0; i < 10; i++) c.addSample(sample(i * 50, 777, 10));
    c.rebase();
    c.reset();
    expect(c.estimate().resets).toBe(1);
    expect(c.estimate().ageMs).toBe(0);
    expect(c.estimate().driftSePpm).toBe(Infinity);
  });
});
