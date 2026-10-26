/**
 * Pure decisions of the engine's sync loop (no DOM, no audio), so they are unit-tested in Node:
 * when a forced rebuild of the playing source must be remembered, how long the last drift tick really was, and
 * whether a clock resync moved the mapping enough to warrant a crossfade reschedule.
 */

/** a resync that moved the mapping by more than this needs a hard reschedule; less is slewed by the drift loop */
export const RESYNC_RESCHEDULE_MS = 10;

/**
 * Remembers a forced reconcile requested while playback could not be rebuilt (clock re-acquiring, audio clock
 * not ready after a suspend, asset not decoded yet), so the rebuild happens as soon as it can instead of leaving
 * the old source playing stale audio until the drift loop notices a > 30 ms error.
 */
export class ReconcileGate {
  private force = false;

  request(force: boolean): void {
    if (force) this.force = true;
  }

  /** the pending force, cleared (call when a source was started or playback was stopped) */
  take(): boolean {
    const f = this.force;
    this.force = false;
    return f;
  }

  get pending(): boolean {
    return this.force;
  }
}

/**
 * Seconds elapsed on the audio clock since the previous drift tick: the real interval, which a throttled tab can
 * stretch to a minute, or `fallbackSec` when there is no previous tick or the context time did not advance (suspended).
 */
export function tickDt(prevCtx: number | null, nowCtx: number, fallbackSec: number): number {
  if (prevCtx === null || !(nowCtx > prevCtx)) return fallbackSec;
  return nowCtx - prevCtx;
}

/** after a clock resync burst: reschedule only when the (server-clock) mapping actually moved; never on the LAN path */
export function resyncNeedsReschedule(shiftMs: number, lanReady: boolean): boolean {
  return !lanReady && Math.abs(shiftMs) > RESYNC_RESCHEDULE_MS;
}
