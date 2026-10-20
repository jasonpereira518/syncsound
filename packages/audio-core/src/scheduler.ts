import { MIN_SCHEDULE_LEAD_MS, SCHEDULE_SAFETY_MARGIN_MS, type Playback } from '@syncsound/protocol';

export interface StartParams {
  /** room ms at which trackOffset must be heard */
  startRoomTime: number;
  /** seconds */
  trackOffset: number;
  /** room ms → AudioContext seconds (when that room time is heard through this device's mapping) */
  roomToCtx: (roomMs: number) => number;
  /** AudioContext.currentTime now */
  nowCtx: number;
  /** extra seconds to start earlier (manual + calibrated latency + fallback output latency − propagation delay) */
  compensationSec: number;
  /** if we're late by less than this, start immediately at offset+lateness (default 0.05 s) — beyond it too */
  lateToleranceSec?: number;
  /** track duration, s; if offset passes it, returns null */
  durationSec?: number;
  /** minimum lead added to "now" for immediate starts (default 0.01 s) */
  minLeadSec?: number;
}

export interface StartDecision {
  /** AudioContext time to pass to source.start(when, offset) */
  when: number;
  /** track offset to pass to source.start */
  offset: number;
  late: boolean;
  latenessSec: number;
}

/**
 * Decide `source.start(when, offset)` for a room-timeline start. Late starts jump to the correct position
 * (so the device lands on the shared timeline): offset = trackOffset + (room time heard at `when` − startRoomTime),
 * found by evaluating roomToCtx near now. lateToleranceSec is informational only: correctness is the
 * same either way; callers may compare latenessSec against it to label a "late join".
 */
export function computeStart(p: StartParams): StartDecision | null {
  const minLead = p.minLeadSec ?? 0.01;
  const target = p.roomToCtx(p.startRoomTime) - p.compensationSec;
  const earliest = p.nowCtx + minLead;
  const late = target < earliest;
  const when = late ? earliest : target;
  let offset = p.trackOffset;
  if (late) {
    // Find the room time r heard at `when` by fixed-point refinement near now, instead of using
    // (when − target) directly: that would scale any mapping-rate error by the lateness (seconds back).
    let r = p.startRoomTime + (when - target) * 1000;
    for (let i = 0; i < 3; i++) r += (when - (p.roomToCtx(r) - p.compensationSec)) * 1000;
    offset = p.trackOffset + (r - p.startRoomTime) / 1000;
  }
  const latenessSec = offset - p.trackOffset;
  if (p.durationSec !== undefined && offset >= p.durationSec) return null;
  return { when, offset, late, latenessSec };
}

/** Track position (s) on the room timeline at roomMs. */
export function positionAt(playback: Playback, roomMs: number): number {
  if (playback.status !== 'playing') return playback.trackOffset;
  return playback.trackOffset + Math.max(0, roomMs - playback.startRoomTime) / 1000;
}

/** Minimum lead time for a scheduled action given device RTTs: max(rtt) + safety, at least MIN_SCHEDULE_LEAD_MS. */
export function minScheduleLeadMs(rttsMs: number[], safetyMs: number = SCHEDULE_SAFETY_MARGIN_MS): number {
  const maxRtt = rttsMs.reduce((a, b) => (Number.isFinite(b) ? Math.max(a, b) : a), 0);
  return Math.max(MIN_SCHEDULE_LEAD_MS, maxRtt + safetyMs);
}
