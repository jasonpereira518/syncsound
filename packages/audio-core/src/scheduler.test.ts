import { describe, expect, it } from 'vitest';
import { MIN_SCHEDULE_LEAD_MS, SCHEDULE_SAFETY_MARGIN_MS } from '@syncsound/protocol';
import { computeStart, minScheduleLeadMs, positionAt } from './scheduler';

const roomToCtx = (ms: number) => (ms - 10_000) / 1000; // room 10 s ↔ ctx 0

describe('computeStart', () => {
  it('schedules in the future with compensation', () => {
    const d = computeStart({ startRoomTime: 12_000, trackOffset: 5, roomToCtx, nowCtx: 1, compensationSec: 0.18 })!;
    expect(d.when).toBeCloseTo(1.82, 9);
    expect(d.offset).toBe(5);
    expect(d.late).toBe(false);
  });

  it('late start jumps forward to stay on the timeline', () => {
    const d = computeStart({ startRoomTime: 12_000, trackOffset: 5, roomToCtx, nowCtx: 9.3, compensationSec: 0 })!;
    expect(d.late).toBe(true);
    expect(d.when).toBeCloseTo(9.31, 9);
    expect(d.offset).toBeCloseTo(5 + 7.31, 9);
    expect(d.latenessSec).toBeCloseTo(7.31, 9);
    // invariant: offset − when is the same as for an on-time start
    expect(d.offset - d.when).toBeCloseTo(5 - 2, 9);
  });

  it('late start uses the mapping near now, so a mapping-rate error does not scale with lateness', () => {
    const fast = (ms: number) => ((ms - 10_000) / 1000) * 1.01; // ctx runs 1 % fast vs room
    const d = computeStart({ startRoomTime: 12_000, trackOffset: 5, roomToCtx: fast, nowCtx: 9.3, compensationSec: 0 })!;
    const heardRoomMs = 10_000 + (d.when / 1.01) * 1000; // exact room time heard at `when`
    expect(d.offset).toBeCloseTo(5 + (heardRoomMs - 12_000) / 1000, 6);
  });

  it('returns null past the end of the track', () => {
    expect(
      computeStart({ startRoomTime: 12_000, trackOffset: 5, roomToCtx, nowCtx: 100, compensationSec: 0, durationSec: 60 }),
    ).toBeNull();
  });
});

describe('positionAt / minScheduleLeadMs', () => {
  it('positionAt', () => {
    const p = { status: 'playing' as const, trackId: 'a', startRoomTime: 1000, trackOffset: 2 };
    expect(positionAt(p, 3500)).toBe(4.5);
    expect(positionAt(p, 0)).toBe(2);
    expect(positionAt({ ...p, status: 'paused' }, 9999)).toBe(2);
  });
  it('minScheduleLeadMs', () => {
    expect(minScheduleLeadMs([])).toBe(MIN_SCHEDULE_LEAD_MS);
    expect(minScheduleLeadMs([40, 300])).toBe(300 + SCHEDULE_SAFETY_MARGIN_MS);
    expect(minScheduleLeadMs([40], 10)).toBe(MIN_SCHEDULE_LEAD_MS);
  });
});
