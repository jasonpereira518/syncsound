/**
 * The playable source of a long (segmented) track: a chain of AudioBufferSourceNodes, one per decoded segment, so
 * no whole-track AudioBuffer ever exists. It looks like one source to the engine (start / stop / playbackRate /
 * onended) and plays into `output`, which feeds a `Voice` exactly like a single buffer source would.
 *
 * Each segment carries a short tail of the next one (the server's overlap). Segment k+1 is started at the seam
 * (computed from the source's own rate line, so drift-loop rate nudges move it) while k keeps playing its tail; the
 * two cross-fade linearly over that overlap. The overlapped audio is identical, so complementary gains sum to unity,
 * and any sub-sample misalignment or resampler edge effect at a seam is absorbed.
 */
import {
  ctxAtPosition,
  segmentIndexAt,
  segmentLocalSec,
  segmentOverlapSec,
  segmentStartSec,
  withRate,
  type RateAnchor,
  type SegmentGeometry,
} from '@syncsound/audio-core';

/** schedule a seam this far ahead (a rate change before it re-plans it); wide so a throttled timer still makes it */
const LOOKAHEAD_SEC = 6;
const PUMP_MS = 250;

interface Part {
  idx: number;
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** ctx time this part starts sounding */
  startAt: number;
}

export class SegmentedSource {
  /** connect to the Voice: every segment plays into this */
  readonly output: GainNode;
  onended: (() => void) | null = null;
  /** the slice of AudioParam the engine uses: set the starting rate, then nudge it for drift */
  readonly playbackRate: { value: number; setTargetAtTime(v: number, t: number, tc: number): void };

  private rate = 1;
  private anchor: RateAnchor | null = null;
  private current: Part | null = null;
  private next: Part | null = null;
  private readonly live = new Set<Part>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private finished = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly geo: SegmentGeometry,
    /** the decoded segment, or null if it isn't ready (the source then ends and the engine restarts it later) */
    private readonly getBuffer: (idx: number) => AudioBuffer | null,
  ) {
    this.output = ctx.createGain();
    const me = () => this;
    this.playbackRate = {
      get value() {
        return me().rate;
      },
      set value(v: number) {
        me().rate = v;
      },
      setTargetAtTime: (v, t) => this.setRate(v, t),
    };
  }

  /** start segment-by-segment from track position `offset` (s) at ctx time `when` */
  start(when: number, offset: number): void {
    const idx = segmentIndexAt(this.geo, offset);
    this.anchor = { ctx: when, pos: offset, rate: this.rate };
    const part = this.launch(idx, when, segmentLocalSec(this.geo, offset), 1);
    if (!part) return void this.finish();
    this.current = part;
    this.timer = setInterval(() => this.pump(), PUMP_MS);
    this.pump();
  }

  /** stop every segment at ctx time `when` (0 = now) and schedule no more */
  stop(when = 0): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.live) {
      try {
        p.src.stop(when);
      } catch {
        /* never started */
      }
    }
    if (this.live.size === 0) this.finish();
  }

  private setRate(rate: number, now: number) {
    if (!this.anchor) {
      this.rate = rate;
      return;
    }
    this.anchor = withRate(this.anchor, Math.max(now, this.anchor.ctx), rate);
    this.rate = rate;
    for (const p of this.live) p.src.playbackRate.setTargetAtTime(rate, now, 0.02);
    // the seam moves with the rate: re-plan one that is already scheduled but hasn't begun
    if (this.next && this.next.startAt > now) {
      this.unscheduleNext();
      this.pump();
    }
  }

  private pump() {
    const a = this.anchor;
    if (this.stopped || !a || !this.current) return;
    const now = this.ctx.currentTime;
    if (this.next && this.next.startAt <= now) {
      this.current = this.next;
      this.next = null;
    }
    const nextIdx = this.current.idx + 1;
    if (this.next || nextIdx >= this.geo.count) return;
    const when = ctxAtPosition(a, segmentStartSec(this.geo, nextIdx));
    if (when - now > LOOKAHEAD_SEC) return;
    // the segment isn't decoded in time: the current one plays out its tail, ends, and the engine restarts at the right spot
    if (!this.getBuffer(nextIdx)) return;
    this.next = this.schedule(nextIdx, when, now, this.current);
  }

  /** start `idx` at its seam `when` (or, if that has passed, now and that far in) and cross-fade `from` into it */
  private schedule(idx: number, when: number, now: number, from: Part): Part | null {
    const startAt = Math.max(when, now);
    const part = this.launch(idx, startAt, (startAt - when) * this.rate, 0);
    if (!part) return null;
    const od = segmentOverlapSec(this.geo) / this.rate;
    part.gain.gain.setValueAtTime(0, startAt);
    part.gain.gain.linearRampToValueAtTime(1, startAt + od);
    from.gain.gain.setValueAtTime(1, startAt);
    from.gain.gain.linearRampToValueAtTime(0, startAt + od);
    try {
      from.src.stop(startAt + od + 0.005);
    } catch {
      /* already ended */
    }
    return part;
  }

  private unscheduleNext() {
    const n = this.next;
    const from = this.current;
    this.next = null;
    if (!n) return;
    n.src.onended = null;
    try {
      n.src.stop();
    } catch {
      /* never started */
    }
    n.src.disconnect();
    n.gain.disconnect();
    this.live.delete(n);
    if (from) {
      // drop the fade-out that was planned for the seam; the caller plans a new one
      from.gain.gain.cancelScheduledValues(n.startAt);
      from.gain.gain.setValueAtTime(1, n.startAt);
      try {
        from.src.stop(1e9); // the last stop() call wins: play to the end of its buffer unless re-planned
      } catch {
        /* already ended */
      }
    }
  }

  private launch(idx: number, when: number, localOffset: number, gain: number): Part | null {
    const buffer = this.getBuffer(idx);
    if (!buffer) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.output);
    const part: Part = { idx, src, gain: g, startAt: when };
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      this.live.delete(part);
      if (this.live.size === 0 && (this.stopped || !this.next)) this.finish();
    };
    this.live.add(part);
    src.start(when, localOffset);
    return part;
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onended?.();
  }
}
