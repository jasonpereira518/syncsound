export interface DriftOptions {
  /** |error| below this → no proportional nudge, only the learned base rate (default 0: a deadband turns the integral into an undamped limit cycle) */
  deadbandMs?: number;
  /** max |playbackRate − 1| (default 0.002 = 0.2 %) */
  maxRateDeviation?: number;
  /** |error| above this → hard reschedule (default 30 ms) */
  rescheduleMs?: number;
  /** seconds over which the proportional nudge should cancel the error (default 4) */
  correctionWindowSec?: number;
  /** the integral never sees a tick longer than this, s (default 2): a throttled tab that ticks once a minute
   * must not wind the integral up sixty times faster than it was tuned for */
  maxDtSec?: number;
  /** …nor shorter than this, s (default 0.05) */
  minDtSec?: number;
}

export interface DriftDecision {
  action: 'none' | 'rate' | 'reschedule';
  /** playbackRate to apply (1 on reschedule; the learned base rate when action === 'none') */
  rate: number;
  errorMs: number;
}

/**
 * PI loop on errorMs = actualPosition − expectedPosition (ms; +ve = we're ahead → slow down).
 * The integral learns the steady clock-rate mismatch (device crystal vs room clock, typically 10–200 ppm), so a
 * constant drift settles at ~0 error instead of riding the edge of a deadband. Gains are critically damped
 * (Ki = Kp²/4). The integral outlives tracks, pauses, clock-path switches and audio-clock resets: it is the ratio
 * of this device's audio clock to the room clock, which none of those change (forgetting it costs a ~0.6 ms
 * transient; keeping it across a path switch costs ~0.02 ms). Call forget() only when the output device changes
 * (a different crystal). Pass the real elapsed `dtSec`; it is clamped to [minDtSec, maxDtSec].
 */
export class DriftController {
  private readonly deadband: number;
  private readonly maxDev: number;
  private readonly reschedule: number;
  private readonly kp: number;
  private readonly ki: number;
  private readonly maxDt: number;
  private readonly minDt: number;
  /** learned rate deviation (s/s); +ve = we run fast → play slower */
  private bias = 0;

  constructor(opts: DriftOptions = {}) {
    this.deadband = opts.deadbandMs ?? 0;
    this.maxDev = opts.maxRateDeviation ?? 0.002;
    this.reschedule = opts.rescheduleMs ?? 30;
    this.kp = 1 / (opts.correctionWindowSec ?? 4);
    this.ki = (this.kp * this.kp) / 4;
    this.maxDt = opts.maxDtSec ?? 2;
    this.minDt = opts.minDtSec ?? 0.05;
  }

  /** @param dtSec seconds since the previous update (default 0.5; clamped to [minDtSec, maxDtSec]) */
  update(errorMs: number, dtSec = 0.5): DriftDecision {
    const abs = Math.abs(errorMs);
    if (abs > this.reschedule) return { action: 'reschedule', rate: 1, errorMs };
    const e = errorMs / 1000;
    const dt = Math.min(this.maxDt, Math.max(this.minDt, Number.isFinite(dtSec) ? dtSec : this.minDt));
    this.bias = this.clamp(this.bias + this.ki * e * dt);
    const p = abs <= this.deadband ? 0 : this.kp * e;
    const dev = this.clamp(this.bias + p);
    return { action: p === 0 ? 'none' : 'rate', rate: 1 - dev, errorMs };
  }

  /** no measurement available right now (clock re-acquiring, audio clock not ready): play at the learned rate alone */
  hold(): DriftDecision {
    return { action: 'none', rate: 1 - this.bias, errorMs: NaN };
  }

  /** learned steady rate deviation, ppm */
  get biasPpm(): number {
    return this.bias * 1e6;
  }

  /** the output device changed (a different crystal): forget the learned bias */
  forget(): void {
    this.bias = 0;
  }

  private clamp(x: number): number {
    return Math.min(this.maxDev, Math.max(-this.maxDev, x));
  }
}

/**
 * Integrates track position over AudioContext time across playbackRate changes.
 * Before `when` the position is the start offset; when inactive, positionAt returns 0 and rate is 1.
 */
export class PlaybackTracker {
  private when = 0;
  private anchorCtx = 0;
  private anchorPos = 0;
  private r = 1;
  private on = false;

  /** source started at ctx time `when` from track `offset` seconds, at playbackRate `rate` (default 1) */
  start(when: number, offset: number, rate = 1): void {
    this.when = this.anchorCtx = when;
    this.anchorPos = offset;
    this.r = rate;
    this.on = true;
  }

  setRate(ctxNow: number, rate: number): void {
    if (!this.on) return;
    const t = Math.max(ctxNow, this.when);
    this.anchorPos = this.positionAt(t);
    this.anchorCtx = t;
    this.r = rate;
  }

  /** track position (s) at ctx time */
  positionAt(ctxSec: number): number {
    if (!this.on) return 0;
    return this.anchorPos + this.r * (Math.max(ctxSec, this.when) - this.anchorCtx);
  }

  get rate(): number {
    return this.on ? this.r : 1;
  }

  get active(): boolean {
    return this.on;
  }

  stop(): void {
    this.on = false;
    this.r = 1;
  }
}
