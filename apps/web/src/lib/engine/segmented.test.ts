import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SegmentGeometry } from '@syncsound/audio-core';
import { SegmentedSource } from './segmented';

// a stand-in for the bits of Web Audio the source drives; times are whatever the test sets
class Param {
  value = 0;
  events: Array<[string, number, number]> = [];
  targets: Array<[number, number]> = [];
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', t, v]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['ramp', t, v]);
  }
  cancelScheduledValues(t: number) {
    this.events = this.events.filter((e) => e[1] < t);
  }
  setTargetAtTime(v: number, t: number) {
    this.value = v;
    this.targets.push([v, t]);
  }
}
class Node {
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}
class Gain extends Node {
  gain = new Param();
}
class Src extends Node {
  buffer: unknown = null;
  playbackRate = new Param();
  started: { when: number; offset: number } | null = null;
  stops: number[] = [];
  onended: (() => void) | null = null;
  start(when: number, offset: number) {
    this.started = { when, offset };
  }
  stop(when = 0) {
    this.stops.push(when);
  }
}
class Ctx {
  currentTime = 0;
  sources: Src[] = [];
  createGain() {
    return new Gain();
  }
  createBufferSource() {
    const s = new Src();
    this.sources.push(s);
    return s;
  }
}

// 100 Hz "audio": 10 s segments, 50 ms overlap, 25 s total, so three segments
const geo: SegmentGeometry = { segmentSamples: 1000, overlapSamples: 5, sampleRate: 100, totalSamples: 2500, count: 3 };
const ready = (...idx: number[]) => (i: number) => (idx.includes(i) ? ({} as AudioBuffer) : null);

let ctx: Ctx;
const make = (have = ready(0, 1, 2)) => new SegmentedSource(ctx as unknown as AudioContext, geo, have);

beforeEach(() => {
  vi.useFakeTimers();
  ctx = new Ctx();
});
afterEach(() => vi.useRealTimers());

const tick = (now: number) => {
  ctx.currentTime = now;
  vi.advanceTimersByTime(250);
};

describe('SegmentedSource', () => {
  it('starts the segment that owns the offset, at its local offset', () => {
    const s = make();
    s.start(5, 13); // 3 s into segment 1
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.started).toEqual({ when: 5, offset: 3 });
  });

  it('schedules the next segment at its seam a few seconds ahead, cross-fading over the overlap', () => {
    const s = make();
    s.start(5, 3); // reaches track position 10 (segment 1's start) at ctx 12
    tick(1);
    expect(ctx.sources).toHaveLength(1); // seam is 11 s away: too early
    tick(6.5);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]!.started).toEqual({ when: 12, offset: 0 });
    // the old one fades 1 → 0 over the 50 ms overlap and ends just after it; the new one fades 0 → 1
    expect(ctx.sources[0]!.stops.at(-1)).toBeCloseTo(12.055, 9);
    expect(ctx.sources[0]!.stops).toHaveLength(1);
  });

  it('re-plans a scheduled seam when the drift loop changes the rate', () => {
    const s = make();
    s.start(5, 3);
    tick(6.5);
    const first = ctx.sources[1]!;
    expect(first.started!.when).toBe(12);

    s.playbackRate.setTargetAtTime(1.002, 6.6, 0.02);
    // the old plan is torn down and a new one made at the seam the new rate implies
    expect(first.disconnected).toBe(true);
    expect(first.stops).toEqual([0]);
    expect(ctx.sources).toHaveLength(3);
    const replanned = ctx.sources[2]!;
    expect(replanned.started!.when).toBeCloseTo(6.6 + (10 - 4.6) / 1.002, 9);
    expect(replanned.started!.offset).toBe(0);
    // everything still playing follows the new rate
    expect(ctx.sources[0]!.playbackRate.targets).toEqual([[1.002, 6.6]]);
  });

  it('starts a seam that the timer served late part-way in rather than from its start', () => {
    const s = make();
    s.start(5, 3);
    tick(13); // the seam was due at 12: a throttled timer
    expect(ctx.sources[1]!.started).toEqual({ when: 13, offset: 1 });
    s.stop();
  });

  it('keeps going to the following segment once the seam has passed', () => {
    const s = make();
    s.start(5, 3);
    tick(6.5); // segment 1 scheduled for 12
    tick(12.5); // seam passed: segment 1 is now the current one; segment 2's seam (ctx 22) is 9.5 s away
    expect(ctx.sources).toHaveLength(2);
    tick(16.5);
    expect(ctx.sources).toHaveLength(3);
    expect(ctx.sources[2]!.started).toEqual({ when: 22, offset: 0 });
  });

  it('schedules nothing after the last segment', () => {
    const s = make();
    s.start(5, 22); // 2 s into the final segment
    expect(ctx.sources[0]!.started).toEqual({ when: 5, offset: 2 });
    tick(10);
    tick(20);
    expect(ctx.sources).toHaveLength(1);
  });

  it('does not schedule a segment that is not decoded, and ends when the current one runs out', () => {
    const s = make(ready(0));
    const ended = vi.fn();
    s.onended = ended;
    s.start(5, 3);
    tick(11);
    expect(ctx.sources).toHaveLength(1);
    ctx.sources[0]!.onended!();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('stops every live segment and schedules no more', () => {
    const s = make();
    const ended = vi.fn();
    s.onended = ended;
    s.start(5, 3);
    tick(6.5);
    s.stop(20);
    expect(ctx.sources.map((x) => x.stops.at(-1))).toEqual([20, 20]);
    tick(14);
    tick(30);
    expect(ctx.sources).toHaveLength(2);
    ctx.sources.forEach((x) => x.onended!());
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('ends at once if the first segment is not decoded', () => {
    const s = make(ready());
    const ended = vi.fn();
    s.onended = ended;
    s.start(5, 3);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
