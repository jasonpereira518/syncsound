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
