import { describe, expect, it } from 'vitest';
import {
  ctxAtPosition,
  positionAtCtx,
  segmentIndexAt,
  segmentLocalSec,
  segmentStartSec,
  segmentTotalSec,
  segmentWindow,
  withRate,
  type SegmentGeometry,
} from './segments';

// the real-world case: a 3 h stereo 44.1 kHz mix in 2 minute segments
const SR = 44_100;
const threeHours: SegmentGeometry = {
  segmentSamples: 120 * SR,
  overlapSamples: Math.round(0.05 * SR),
  sampleRate: SR,
  totalSamples: 3 * 3600 * SR,
  count: 90,
};

describe('segment geometry', () => {
  it('owns each position by exactly one segment, with seams on whole samples', () => {
    expect(segmentIndexAt(threeHours, 0)).toBe(0);
    expect(segmentIndexAt(threeHours, 119.999)).toBe(0);
    expect(segmentIndexAt(threeHours, 120)).toBe(1);
    expect(segmentIndexAt(threeHours, 7199.999)).toBe(59);
    expect(segmentIndexAt(threeHours, 7200)).toBe(60);
    expect(segmentStartSec(threeHours, 60)).toBe(7200);
  });

  it('has no drift at the far end of a 3 hour track', () => {
    // the start of the last segment is an exact integer number of samples, however far in
    const i = threeHours.count - 1;
    expect(segmentStartSec(threeHours, i) * SR).toBe(i * threeHours.segmentSamples);
    expect(segmentIndexAt(threeHours, segmentStartSec(threeHours, i))).toBe(i);
    expect(segmentLocalSec(threeHours, 10_799.5)).toBeCloseTo(119.5, 9);
    expect(segmentTotalSec(threeHours)).toBe(10_800);
  });

  it('clamps before the start and past the end', () => {
    expect(segmentIndexAt(threeHours, -5)).toBe(0);
    expect(segmentIndexAt(threeHours, 99_999)).toBe(89);
  });

  it('works at other sample rates and a short final segment', () => {
    const g: SegmentGeometry = { segmentSamples: 120 * 48_000, overlapSamples: 2400, sampleRate: 48_000, totalSamples: 250 * 48_000, count: 3 };
    expect(segmentIndexAt(g, 239.9)).toBe(1);
    expect(segmentIndexAt(g, 240)).toBe(2);
    expect(segmentIndexAt(g, 249.99)).toBe(2);
    expect(segmentLocalSec(g, 245)).toBeCloseTo(5, 9);
  });

  it('keeps the playing segment plus those ahead, never past the last', () => {
    expect(segmentWindow(threeHours, 5, 2)).toEqual([0, 1, 2]);
    expect(segmentWindow(threeHours, 7300, 2)).toEqual([60, 61, 62]);
    expect(segmentWindow(threeHours, 10_790, 2)).toEqual([89]);
  });
});

describe('rate anchor', () => {
  it('maps track position to audio-clock time and back', () => {
    const a = { ctx: 10, pos: 100, rate: 1 };
    expect(ctxAtPosition(a, 160)).toBe(70);
    expect(positionAtCtx(a, 70)).toBe(160);
  });

  it('moves a seam later when the source runs slower (the drift loop at -0.2 %)', () => {
    const fast = { ctx: 0, pos: 0, rate: 1.002 };
    const slow = { ctx: 0, pos: 0, rate: 0.998 };
    // 120 s of audio takes 0.48 s longer at the slow end than the fast end
    expect(ctxAtPosition(slow, 120) - ctxAtPosition(fast, 120)).toBeCloseTo(0.4796, 3);
  });

  it('keeps position continuous across a rate change', () => {
    const a = { ctx: 0, pos: 50, rate: 1 };
    const b = withRate(a, 20, 1.002);
    expect(b.pos).toBe(70);
    expect(positionAtCtx(b, 20)).toBe(positionAtCtx(a, 20));
    expect(ctxAtPosition(b, 120)).toBeCloseTo(20 + 50 / 1.002, 9);
  });
});
