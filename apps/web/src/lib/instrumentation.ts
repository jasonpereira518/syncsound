/** E2E instrumentation (kept in production; tiny). `window.__syncsound`. */
import type { ScheduleAction } from '@syncsound/protocol';

export interface ScheduleRecord {
  action: ScheduleAction | 'reschedule';
  trackId: string;
  startRoomTime: number;
  trackOffset: number;
  whenCtx: number;
  offset: number;
  compensationSec: number;
  late: boolean;
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
