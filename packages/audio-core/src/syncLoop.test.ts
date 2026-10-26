import { describe, expect, it } from 'vitest';
import { ReconcileGate, RESYNC_RESCHEDULE_MS, resyncNeedsReschedule, tickDt } from './syncLoop';

describe('ReconcileGate', () => {
  it('keeps a forced request pending until taken, exactly once', () => {
    const g = new ReconcileGate();
    expect(g.pending).toBe(false);
    g.request(false);
    expect(g.pending).toBe(false);
    g.request(true);
    g.request(false); // a later soft request does not cancel it
    expect(g.pending).toBe(true);
    expect(g.take()).toBe(true);
    expect(g.pending).toBe(false);
    expect(g.take()).toBe(false);
  });
});

describe('tickDt', () => {
  it('measures the real interval, falls back when there is none or the context is frozen', () => {
    expect(tickDt(null, 10, 0.5)).toBe(0.5);
    expect(tickDt(10, 10, 0.5)).toBe(0.5); // suspended: ctx time did not advance
    expect(tickDt(10, 9.9, 1.5)).toBe(1.5);
    expect(tickDt(10, 70, 0.5)).toBe(60); // a throttled tab
    expect(tickDt(10, 10.5, 0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('resyncNeedsReschedule', () => {
  it('reschedules only for a server-clock shift beyond the threshold', () => {
    expect(resyncNeedsReschedule(RESYNC_RESCHEDULE_MS - 1, false)).toBe(false);
    expect(resyncNeedsReschedule(RESYNC_RESCHEDULE_MS + 1, false)).toBe(true);
    expect(resyncNeedsReschedule(-(RESYNC_RESCHEDULE_MS + 1), false)).toBe(true);
    expect(resyncNeedsReschedule(RESYNC_RESCHEDULE_MS + 1, true)).toBe(false);
  });
});
