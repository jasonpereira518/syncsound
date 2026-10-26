/**
 * Live-capture alignment governor: pure math that turns noisy per-poll pipeline-delay estimates into rare,
 * sample-exact output-delay changes. No DOM, unit-tested in Node.
 *
 * Why: the output DelayNode is the alignment mechanism for live streams. Its delayTime is a-rate while it is
 * being automated, so a *moving* delay is a pitch bend, and a fractional-sample delay is linearly interpolated
 * (treble loss). So the delay must change rarely, by whole samples, and never glide (OutputChain.setDelayMs does
 * the actual click-free switch).
 */
export const LIVE_DELAY = {
  /** receivers poll getStats this often, ms */
  pollMs: 500,
  /** median window, in polls (2.5 s at pollMs) */
  windowSize: 5,
  /** smallest change worth an audible switch, ms: under ~10 ms between speakers reads as width, not echo */
  deadbandMs: 10,
  /** DelayNode maximum (2 s) minus headroom, ms */
  maxMs: 1990,
} as const;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median of the last `size` pipeline-delay polls: one late getStats or one NetEq expand doesn't move it. */
export class PipelineFilter {
  private xs: number[] = [];

  constructor(private readonly size: number = LIVE_DELAY.windowSize) {}

  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.xs.push(ms);
    if (this.xs.length > this.size) this.xs.shift();
  }

  estimate(): number | null {
    return this.xs.length ? median(this.xs) : null;
  }

  reset(): void {
    this.xs = [];
  }
}

/** Whole-sample delay, so the DelayNode takes its exact-copy path instead of interpolating. */
export function snapDelayMs(ms: number, sampleRate: number): number {
  return (Math.round((ms / 1000) * sampleRate) / sampleRate) * 1000;
}

/**
 * The next delay to apply, or null to keep the current one. The first application and a forced one (the user
 * moved a slider) ignore the deadband; otherwise only a change of at least `deadbandMs` is worth a switch.
 */
export function nextDelayMs(p: {
  desiredMs: number;
  appliedMs: number | null;
  sampleRate: number;
  force?: boolean;
  deadbandMs?: number;
}): number | null {
  const target = snapDelayMs(Math.min(LIVE_DELAY.maxMs, Math.max(0, p.desiredMs)), p.sampleRate);
  if (p.appliedMs === null || p.force) return target === p.appliedMs ? null : target;
  return Math.abs(target - p.appliedMs) >= (p.deadbandMs ?? LIVE_DELAY.deadbandMs) ? target : null;
}

/**
 * WebRTC jitter-buffer target for a receiver: half the room buffer (40–500 ms). Network jitter is then absorbed by
 * the jitter buffer, which can conceal, instead of by our DelayNode, which can't.
 */
export function jitterTargetMs(videoBufferMs: number): number {
  return Math.min(500, Math.max(40, Math.round(videoBufferMs / 2)));
}

/** How late this device is forced to play because buffer + nudge − pipeline − compensation < 0 (0 = fits). */
export function bufferShortfallMs(p: {
  videoBufferMs: number;
  lipSyncNudgeMs: number;
  pipelineDelayMs: number;
  compensationMs: number;
}): number {
  return Math.max(0, -(p.videoBufferMs + p.lipSyncNudgeMs - p.pipelineDelayMs - p.compensationMs));
}
