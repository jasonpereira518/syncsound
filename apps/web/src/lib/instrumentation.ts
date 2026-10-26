/** E2E instrumentation (kept in production; tiny). `window.__syncsound`. */
import type { ScheduleAction } from '@syncsound/protocol';

export interface ScheduleRecord {
  /** advance = the server moved to this track at the end of the previous one (gapless join or crossfade) */
  action: ScheduleAction | 'reschedule' | 'advance';
  trackId: string;
  startRoomTime: number;
  trackOffset: number;
  whenCtx: number;
  offset: number;
  compensationSec: number;
  late: boolean;
  /** how far ahead of `startRoomTime` (by this device's room clock) the schedule was acted on, ms; negative = after it */
  arrivedLeadMs: number;
  /** audio-clock steps confirmed so far on this device */
  audioSteps: number;
  /** ctx→perf of the context's current time minus performance.now() at scheduling, ms (≈ 0 when the map is current) */
  mapSkewMs: number;
  /** audio-clock observations held back as a possible step at scheduling */
  pendingSteps: number;
  /** epoch ms at which this device believes track position `trackOffset` is heard */
  expectedHeardEpochMs: number;
}

export const schedules: ScheduleRecord[] = [];

export function recordSchedule(r: ScheduleRecord) {
  schedules.push(r);
  if (schedules.length > 500) schedules.shift();
}

export function installInstrumentation(api: {
  getState: () => unknown;
  clock: () => unknown;
  mix: () => unknown;
  /** `?tap=1`: per-channel level + spectral peaks of this device's output and of the live source */
  tap: () => unknown;
  /** live-capture alignment governor state */
  liveDelay: () => unknown;
}) {
  if (typeof window === 'undefined') return;
  (window as Window & { __syncsound?: unknown }).__syncsound = { ...api, schedules };
}
