export interface DriftOptions {
  /** |error| below this → no proportional nudge, only the learned base rate (default 0: a deadband turns the integral into an undamped limit cycle) */
  deadbandMs?: number;
  /** max |playbackRate − 1| (default 0.002 = 0.2 %) */
  maxRateDeviation?: number;
  /** |error| above this → hard reschedule (default 30 ms) */
  rescheduleMs?: number;
  /** seconds over which the proportional nudge should cancel the error (default 4) */
  correctionWindowSec?: number;
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
 * (Ki = Kp²/4). The integral outlives tracks (it's a property of this device's clocks); call forget() when the clock path changes.
 */
export class DriftController {
  private readonly deadband: number;
  private readonly maxDev: number;
  private readonly reschedule: number;
  private readonly kp: number;
  private readonly ki: number;
  /** learned rate deviation (s/s); +ve = we run fast → play slower */
  private bias = 0;

  constructor(opts: DriftOptions = {}) {
    this.deadband = opts.deadbandMs ?? 0;
    this.maxDev = opts.maxRateDeviation ?? 0.002;
    this.reschedule = opts.rescheduleMs ?? 30;
    this.kp = 1 / (opts.correctionWindowSec ?? 4);
    this.ki = (this.kp * this.kp) / 4;
  }

  /** @param dtSec seconds since the previous update (default 0.5) */
  update(errorMs: number, dtSec = 0.5): DriftDecision {
    const abs = Math.abs(errorMs);
    if (abs > this.reschedule) return { action: 'reschedule', rate: 1, errorMs };
    const e = errorMs / 1000;
    this.bias = this.clamp(this.bias + this.ki * e * dtSec);
    const p = abs <= this.deadband ? 0 : this.kp * e;
    const dev = this.clamp(this.bias + p);
    return { action: p === 0 ? 'none' : 'rate', rate: 1 - dev, errorMs };
  }

  /** learned steady rate deviation, ppm */
  get biasPpm(): number {
    return this.bias * 1e6;
  }

  /** clock path changed (new output route / clock re-sync): forget the learned bias too */
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

  /** source started at ctx time `when` from track `offset` seconds, rate 1 */
  start(when: number, offset: number): void {
    this.when = this.anchorCtx = when;
    this.anchorPos = offset;
    this.r = 1;
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
