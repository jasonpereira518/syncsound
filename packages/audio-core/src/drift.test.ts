import { describe, expect, it } from 'vitest';
import { DriftController, PlaybackTracker } from './drift';

describe('DriftController', () => {
  it('proportional rate (clamped), reschedule', () => {
    const d = new DriftController();
    expect(d.update(0).action).toBe('none');
    const r = d.update(4);
    expect(r.action).toBe('rate');
    expect(r.rate).toBeLessThan(1); // ahead → slower
    expect(r.rate).toBeCloseTo(1 - 0.001, 4); // ≈ Kp·e (+ a small integral)
    expect(d.update(-20).rate).toBeCloseTo(1.002, 9); // clamped
    expect(d.update(31).action).toBe('reschedule');
  });

  it('learns a constant clock-rate mismatch and settles at ~0 error', () => {
    const d = new DriftController();
    const ppm = 150; // we run 150 ppm fast vs the room
    let errMs = 0;
    let rate = 1;
    const errs: number[] = [];
    for (let k = 0; k < 600; k++) {
      errMs += (rate * (1 + ppm * 1e-6) - 1) * 0.5 * 1000; // 0.5 s tick
      rate = d.update(errMs, 0.5).rate;
      errs.push(errMs);
    }
    expect(Math.abs(errs.at(-1)!)).toBeLessThan(0.01);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(0.5); // no deadband ride-up
    expect(d.biasPpm).toBeCloseTo(150, -1);
    d.forget();
    expect(d.biasPpm).toBe(0);
  });
});

describe('PlaybackTracker', () => {
  it('integrates position across rate changes', () => {
    const t = new PlaybackTracker();
    expect(t.active).toBe(false);
    t.start(10, 5);
    expect(t.positionAt(9)).toBe(5);
    expect(t.positionAt(12)).toBe(7);
    t.setRate(12, 0.998);
    expect(t.rate).toBe(0.998);
    expect(t.positionAt(22)).toBeCloseTo(7 + 9.98, 9);
    t.setRate(22, 1);
    expect(t.positionAt(23)).toBeCloseTo(17.98, 9);
    t.stop();
    expect(t.active).toBe(false);
    expect(t.rate).toBe(1);
  });
});

describe('DriftController dt and hold', () => {
  it('clamps the tick length fed to the integral (a 60 s throttled tick counts as 2 s) and holds the learned rate', () => {
    const a = new DriftController();
    const b = new DriftController();
    a.update(5, 60);
    b.update(5, 2);
    expect(a.biasPpm).toBeCloseTo(b.biasPpm, 9);
    expect(a.biasPpm).toBeGreaterThan(0);
    const c = new DriftController();
    const d = new DriftController();
    c.update(5, 0.001);
    d.update(5, 0.05);
    expect(c.biasPpm).toBeCloseTo(d.biasPpm, 9); // minDt: a tiny tick integrates like a 50 ms one
    const bias = a.biasPpm;
    const h = a.hold();
    expect(h.action).toBe('none');
    expect(h.rate).toBeCloseTo(1 - bias * 1e-6, 12);
    expect(a.biasPpm).toBe(bias);
  });

  it('a tracker can start at the learned rate', () => {
    const t = new PlaybackTracker();
    t.start(10, 5, 0.999);
    expect(t.rate).toBe(0.999);
    expect(t.positionAt(12)).toBeCloseTo(5 + 2 * 0.999, 9);
  });
});
