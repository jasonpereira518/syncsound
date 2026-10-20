/**
 * Battery-friendly mode (per device, remembered locally): once the clock has converged, ping every 5 s instead
 * of 1 s, run the drift loop every 1.5 s instead of 0.5 s and report stats every 10 s instead of 2 s.
 * Sync stays within target on a stable network (drift is tracked between pings); recovery is slower.
 */
const KEY = 'syncsound:batterySaver';
let saver = false;
try {
  saver = typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1';
} catch {
  /* storage blocked */
}

export const batterySaver = () => saver;

export function setBatterySaverFlag(on: boolean): void {
  saver = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

/** true when a periodic job should run now: always in normal mode, every `slowMs` in battery-friendly mode */
export function dueNow(last: { t: number }, slowMs: number, now = performance.now()): boolean {
  if (saver && now - last.t < slowMs - 50) return false;
  last.t = now;
  return true;
}
