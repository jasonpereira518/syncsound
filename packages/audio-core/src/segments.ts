/**
 * Geometry of a long track split into fixed-length segments (see protocol `SegmentPlan`): which segment owns a
 * position, where its seam falls on the audio clock, and which segments to keep decoded. Everything is derived from
 * track time and the integer sample counts, never from accumulated per-segment durations, so a 3-hour track has no
 * rounding drift. Pure: no DOM, no Web Audio.
 */

export interface SegmentGeometry {
  /** samples (at the source rate) each segment owns; the last one holds whatever is left */
  segmentSamples: number;
  /** extra samples every non-final segment carries from the start of the next */
  overlapSamples: number;
  /** the source sample rate the counts above are in */
  sampleRate: number;
  totalSamples: number;
  count: number;
}

export const segmentTotalSec = (g: SegmentGeometry) => g.totalSamples / g.sampleRate;
/** track time at which segment `i` starts */
export const segmentStartSec = (g: SegmentGeometry, i: number) => (i * g.segmentSamples) / g.sampleRate;
export const segmentOverlapSec = (g: SegmentGeometry) => g.overlapSamples / g.sampleRate;

/** index of the segment that owns track position `sec` (before the start → 0, past the end → the last) */
export function segmentIndexAt(g: SegmentGeometry, sec: number): number {
  const i = Math.floor((Math.max(0, sec) * g.sampleRate) / g.segmentSamples);
  return Math.min(g.count - 1, i);
}

/** where `sec` falls inside the segment that owns it, seconds from that segment's first sample */
export const segmentLocalSec = (g: SegmentGeometry, sec: number) => sec - segmentStartSec(g, segmentIndexAt(g, sec));

/** the segment to keep decoded for position `sec` and the `ahead` that follow it */
export function segmentWindow(g: SegmentGeometry, sec: number, ahead: number): number[] {
  const first = segmentIndexAt(g, sec);
  const out: number[] = [];
  for (let i = first; i <= Math.min(g.count - 1, first + ahead); i++) out.push(i);
  return out;
}

/**
 * A playing source's position as a straight line on the audio clock: it was at `pos` (track s) at `ctx` (audio-clock s)
 * and has advanced at `rate` since (the drift loop nudges `rate` by at most ±0.2 %).
 */
export interface RateAnchor {
  ctx: number;
  pos: number;
  rate: number;
}
export const positionAtCtx = (a: RateAnchor, ctx: number) => a.pos + (ctx - a.ctx) * a.rate;
/** audio-clock time at which the source reaches track position `pos` if `rate` holds until then */
export const ctxAtPosition = (a: RateAnchor, pos: number) => a.ctx + (pos - a.pos) / a.rate;
/** re-anchor at `ctx` with a new rate, keeping the position continuous */
export const withRate = (a: RateAnchor, ctx: number, rate: number): RateAnchor => ({ ctx, pos: positionAtCtx(a, ctx), rate });
