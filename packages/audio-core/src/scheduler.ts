import type { Playback } from '@syncsound/protocol';
import { todo } from './todo';

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

/** Decide `source.start(when, offset)` for a room-timeline start. Late starts jump to the correct position. */
export function computeStart(_p: StartParams): StartDecision | null {
  return todo('computeStart');
}

/** Track position (s) on the room timeline at roomMs. */
export function positionAt(_playback: Playback, _roomMs: number): number {
  return todo('positionAt');
}

/** Minimum lead time for a scheduled action given device RTTs: max(rtt) + safety, at least MIN_SCHEDULE_LEAD_MS. */
export function minScheduleLeadMs(_rttsMs: number[], _safetyMs?: number): number {
  return todo('minScheduleLeadMs');
}
