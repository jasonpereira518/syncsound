import { describe, expect, it } from 'vitest';
import { RemoteSyncController } from './remoteSync';

describe('RemoteSyncController', () => {
  it('needs confirmCount readings over enter, then seeks with the learned lead', () => {
    const c = new RemoteSyncController();
    expect(c.update({ expectedPositionMs: 1000, reportedPositionMs: 1100, nowMs: 0 }).action).toBe('none');
    const d = c.update({ expectedPositionMs: 1500, reportedPositionMs: 1600, nowMs: 500 });
    expect(d).toEqual({ action: 'seek', seekToMs: 1500, errorMs: 100 });
    c.recordSeekResult(200); // landed 200 ms behind → EMA seeded at 200
    expect(c.stats().seekLatencyMs).toBeCloseTo(200, 9);
    c.recordSeekResult(-100); // next seek (with 200 lead) landed 100 ms ahead → 200 − 0.3·100
    expect(c.stats().seekLatencyMs).toBeCloseTo(170, 9);
  });

  it('respects min seek interval and exits below exit threshold', () => {
    const c = new RemoteSyncController({ confirmCount: 1 });
    expect(c.update({ expectedPositionMs: 0, reportedPositionMs: 200, nowMs: 0 }).action).toBe('seek');
    expect(c.update({ expectedPositionMs: 0, reportedPositionMs: 50, nowMs: 1000 }).action).toBe('none');
    // still correcting (50 > exit 30) and interval elapsed → seek again
    expect(c.update({ expectedPositionMs: 0, reportedPositionMs: 50, nowMs: 3000 }).action).toBe('seek');
    expect(c.update({ expectedPositionMs: 0, reportedPositionMs: 10, nowMs: 6500 }).action).toBe('none');
    // idle again: 50 < enter 80 → no seek
    expect(c.update({ expectedPositionMs: 0, reportedPositionMs: 50, nowMs: 9000 }).action).toBe('none');
    const s = c.stats();
    expect(s.seeks).toBe(2);
    expect(s.samples).toBe(5);
    expect(s.meanAbsErrorMs).toBeCloseTo(72, 9);
  });
});
