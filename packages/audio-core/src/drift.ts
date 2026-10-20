import { todo } from './todo';

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
 * Called every ~500 ms.
 */
export class DriftController {
  constructor(_opts: DriftOptions = {}) {}
  update(_errorMs: number): DriftDecision {
    return todo('DriftController.update');
  }
  reset(): void {
    todo('DriftController.reset');
  }
}

/** Integrates track position over AudioContext time across playbackRate changes. */
export class PlaybackTracker {
  /** source started at ctx time `when` from track `offset` seconds, rate 1 */
  start(_when: number, _offset: number): void {
    todo('PlaybackTracker.start');
  }
  setRate(_ctxNow: number, _rate: number): void {
    todo('PlaybackTracker.setRate');
  }
  /** track position (s) at ctx time */
  positionAt(_ctxSec: number): number {
    return todo('PlaybackTracker.positionAt');
  }
  get rate(): number {
    return todo('PlaybackTracker.rate');
  }
  get active(): boolean {
    return todo('PlaybackTracker.active');
  }
  stop(): void {
    todo('PlaybackTracker.stop');
  }
}
