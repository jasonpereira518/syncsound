/**
 * When a tune may start, whether a run stayed valid, and what a stored tune means for a device now: pure functions
 * shared by the app, the server and the calibration sims.
 */
import type { Vec2 } from '@syncsound/protocol';
import { SELF_OFFSET_M } from './calibration';
import { SPEED_OF_SOUND } from './spatial';

export interface TunedDevice {
  id: string;
  tuneArrivalMs: number | null;
  tuneId: string | null;
  tuneStale?: 'route' | 'clock' | 'output' | null;
}

export interface TuneRefLike {
  id: string;
  listenerId: string;
  mic: Vec2;
  /** where each device was when its arrival was measured; a device missing here is taken to be where it is now */
  positions?: Record<string, Vec2>;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

export type SyncState = 'tuned' | 'stale' | 'untuned';

/** the device's tune is the room's current one */
export const inTune = (d: TunedDevice, tune: TuneRefLike | undefined): boolean =>
  !!tune && d.tuneId === tune.id && d.tuneArrivalMs !== null && Number.isFinite(d.tuneArrivalMs);

export function syncStateOf(d: TunedDevice, tune: TuneRefLike | undefined): SyncState {
  if (!inTune(d, tune)) return 'untuned';
  return d.tuneStale ? 'stale' : 'tuned';
}

/**
 * Each device's output compensation (`calibratedLatencyMs`) from the tune's invariant, the positions it was
 * measured at and the CURRENT scene:
 *
 *   cal_i = A_i − |q_i − mic|/c − (|p_i − L| − |q_i − L|)/c
 *
 * with q_i the device's position at tune time, p_i its position now, L the listener (head) now, and the listener's
 * own path the SELF_OFFSET_M prior; minus the min over the devices in the current tune. The first term is the
 * device's latency as the tune measured it; the second moves exactly as the engine's `propagationDelays` moves
 * when the picture is edited, so a layout change, a drag or an auto-placement never changes when a tuned device's
 * sound reaches the head. Moving the listener icon is left to the engine (that is where the head is now). Devices
 * from another run, or never tuned, get null. A speaker that physically moved needs a new tune: its arrival was
 * measured where it was.
 */
export function deriveCalibratedLatency(
  devices: TunedDevice[],
  tune: TuneRefLike | undefined,
  positions: Record<string, Vec2>,
  listener?: Vec2,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const raw: Array<[string, number]> = [];
  for (const d of devices) {
    out[d.id] = null;
    if (!inTune(d, tune)) continue;
    const p = positions[d.id] ?? tune!.positions?.[d.id];
    const q = tune!.positions?.[d.id] ?? p;
    const dMic = d.id === tune!.listenerId ? SELF_OFFSET_M : q ? dist(q, tune!.mic) : 0;
    const moved = p && q && listener ? dist(p, listener) - dist(q, listener) : 0;
    raw.push([d.id, d.tuneArrivalMs! - ((dMic + moved) / SPEED_OF_SOUND) * 1000]);
  }
  if (!raw.length) return out;
  const min = Math.min(...raw.map(([, v]) => v));
  for (const [id, v] of raw) out[id] = Math.max(-1000, Math.min(1000, v - min));
  return out;
}

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
