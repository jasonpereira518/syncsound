import { describe, expect, it } from 'vitest';
import { DriftController, PlaybackTracker } from './drift';

describe('DriftController', () => {
  it('deadband, proportional rate (clamped), reschedule', () => {
    const d = new DriftController();
    expect(d.update(1.5)).toEqual({ action: 'none', rate: 1, errorMs: 1.5 });
    const r = d.update(4);
    expect(r.action).toBe('rate');
    expect(r.rate).toBeCloseTo(1 - 0.001, 9); // ahead → slower
    expect(d.update(-20).rate).toBeCloseTo(1.002, 9); // clamped
    expect(d.update(31).action).toBe('reschedule');
  });

  it('hysteresis: keeps correcting until |e| < deadband/2', () => {
    const d = new DriftController();
    expect(d.update(2.5).action).toBe('rate');
    expect(d.update(1.5).action).toBe('rate');
    expect(d.update(0.9).action).toBe('none');
    expect(d.update(1.5).action).toBe('none');
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
