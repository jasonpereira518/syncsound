/**
 * When a tune may start, and whether a run stayed valid: pure predicates over clock-estimate numbers, shared by
 * the app and the calibration sims.
 */

export interface SettleInput {
  converged: boolean;
  /** ms since the clock mapping was last (re)acquired */
  ageMs: number;
  jitterMs: number;
  /** target − applied offset still being slewed in, ms */
  pendingSlewMs: number;
  /** standard error of the drift estimate, ppm (Infinity until fitted) */
  driftSePpm: number;
  /** the in-room clock link: none (no master, or this device is the master), ready, or still connecting */
  link: 'none' | 'ready' | 'not-ready';
  /** standard error of the audio clock's long-baseline rate, ppm (null until the long window is in use) */
  audioRateSePpm: number | null;
}

export interface SettleLimits {
  minAgeMs: number;
  maxPendingSlewMs: number;
  maxJitterMs: number;
  maxDriftSePpm: number;
  maxAudioRateSePpm: number;
}

/** tuned in packages/sim/test/tuneClock.test.ts: the gate must hold head p95 < 1 ms without waiting long */
export const SETTLE_LIMITS: SettleLimits = {
  minAgeMs: 3000,
  maxPendingSlewMs: 0.3,
  maxJitterMs: 3,
  maxDriftSePpm: 30,
  maxAudioRateSePpm: 15,
};

export interface SettleVerdict {
  ok: boolean;
  /** a hard criterion failed: the run would be wrong, wait (soft: less accurate, proceed with a warning after the wait) */
  hard: boolean;
  reason: string | null;
}

/**
 * Is this device's clock steady enough to time a tune? Hard criteria (must pass): the room clock has converged and
 * wasn't just re-acquired, the in-room link (when there is a master) is up — a run on the server path would be
 * invalidated by the switch — and no slew is pending. Soft criteria: the drift and audio-rate estimates are
 * tight and the network isn't too jittery.
 */
export function clockSettled(i: SettleInput, l: SettleLimits = SETTLE_LIMITS): SettleVerdict {
  if (!i.converged) return { ok: false, hard: true, reason: 'the room clock has too few samples yet' };
  if (i.link === 'not-ready') return { ok: false, hard: true, reason: 'the in-room clock link is still connecting' };
  if (!(Math.abs(i.pendingSlewMs) <= l.maxPendingSlewMs)) return { ok: false, hard: true, reason: `the room clock is still catching up (${Math.abs(i.pendingSlewMs).toFixed(1)} ms)` };
  if (i.ageMs < l.minAgeMs) return { ok: false, hard: true, reason: 'the room clock was just re-acquired' };
  if (!(i.driftSePpm <= l.maxDriftSePpm)) return { ok: false, hard: false, reason: 'the clock rate is still uncertain' };
  if (!(i.jitterMs <= l.maxJitterMs)) return { ok: false, hard: false, reason: `the network is jittery (${i.jitterMs.toFixed(1)} ms)` };
  if (i.audioRateSePpm === null || !(i.audioRateSePpm <= l.maxAudioRateSePpm)) return { ok: false, hard: false, reason: 'the audio clock rate is still uncertain' };
  return { ok: true, hard: false, reason: null };
}

/** what a device notes when it freezes its clocks for a run (and compares at the end) */
export interface RunSnapshot {
  /** the clock path in use: 'wan' or 'lan:<master>' */
  path: string;
  /** ClockSync.estimate().resets */
  resets: number;
  /** AudioClockMap.steps */
  steps: number;
}

/** the room clock may move this much during a run (beyond its drift slope) before the run is discarded, ms */
export const MAX_RUN_OFFSET_MOVE_MS = 1;

export interface RunValidity {
  valid: boolean;
  reason?: string;
}

/**
 * Did the clocks stay put for the whole run? `offsetMoveMs` = live mapping − the mapping frozen at the start, at
 * the end of the run (slews and steps that happened meanwhile; the drift slope cancels).
 */
export function runValidity(before: RunSnapshot, after: RunSnapshot, offsetMoveMs: number): RunValidity {
  if (before.path !== after.path) return { valid: false, reason: 'the clock path changed during the run' };
  if (before.resets !== after.resets) return { valid: false, reason: 'the room clock was reset during the run' };
  if (before.steps !== after.steps) return { valid: false, reason: 'the audio output changed during the run' };
  if (!(Math.abs(offsetMoveMs) <= MAX_RUN_OFFSET_MOVE_MS)) return { valid: false, reason: `the room clock moved ${Math.abs(offsetMoveMs).toFixed(1)} ms during the run` };
  return { valid: true };
}
