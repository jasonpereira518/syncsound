export interface DriftOptions {
  /** |error| below this → do nothing (default 2 ms) */
  deadbandMs?: number;
  /** max |playbackRate − 1| (default 0.002 = 0.2 %) */
  maxRateDeviation?: number;
  /** |error| above this → hard reschedule (default 30 ms) */
  rescheduleMs?: number;
  /** seconds over which a rate nudge should cancel the error (default 4) */
  correctionWindowSec?: number;
}

export interface DriftDecision {
  action: 'none' | 'rate' | 'reschedule';
  /** playbackRate to apply (1 when action !== 'rate') */
  rate: number;
  errorMs: number;
}

/**
 * errorMs = actualPosition − expectedPosition (ms; +ve = we're ahead → slow down).
 * Called every ~500 ms. Hysteresis: correction starts at |e| ≥ deadband and continues until |e| < deadband/2.
 */
export class DriftController {
  private readonly deadband: number;
  private readonly maxDev: number;
  private readonly reschedule: number;
  private readonly windowSec: number;
  private correcting = false;

  constructor(opts: DriftOptions = {}) {
    this.deadband = opts.deadbandMs ?? 2;
    this.maxDev = opts.maxRateDeviation ?? 0.002;
    this.reschedule = opts.rescheduleMs ?? 30;
    this.windowSec = opts.correctionWindowSec ?? 4;
  }

  update(errorMs: number): DriftDecision {
    const abs = Math.abs(errorMs);
    if (abs > this.reschedule) {
      this.correcting = false;
      return { action: 'reschedule', rate: 1, errorMs };
    }
    this.correcting = this.correcting ? abs >= this.deadband / 2 : abs >= this.deadband;
    if (!this.correcting) return { action: 'none', rate: 1, errorMs };
    const dev = Math.min(this.maxDev, Math.max(-this.maxDev, errorMs / 1000 / this.windowSec));
    return { action: 'rate', rate: 1 - dev, errorMs };
  }

  reset(): void {
    this.correcting = false;
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
