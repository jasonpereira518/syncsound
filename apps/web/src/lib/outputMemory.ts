/**
 * Per-output calibration memory. A phone playing through its own speaker, wired headphones or a Bluetooth speaker
 * needs a different calibrated latency (Bluetooth adds 100–300 ms the browser doesn't report), so the calibrated
 * value is remembered per output label and restored when that output comes back. Labels are only readable once
 * the page has mic permission (and never on iOS); without a label the app falls back to "recalibrate" prompts.
 */

const KEY = 'syncsound:outputCalibration';
/** oldest entries are dropped beyond this */
export const MAX_REMEMBERED_OUTPUTS = 16;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function load(store: KV | null): Record<string, number> {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function recallOutputCalibration(store: KV | null, label: string | undefined): number | undefined {
  return label ? load(store)[label] : undefined;
}

export function rememberOutputCalibration(store: KV | null, label: string | undefined, calibratedLatencyMs: number | null): void {
  if (!label || calibratedLatencyMs === null || !Number.isFinite(calibratedLatencyMs)) return;
  const all = load(store);
  if (all[label] === calibratedLatencyMs) return;
  delete all[label]; // re-insert last so it counts as most recent
  all[label] = calibratedLatencyMs;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_OUTPUTS))) delete all[k];
  try {
    store?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked: memory is a convenience */
  }
}

export type RouteChangeAction =
  /** same output as before: devicechange was about something else (a mic plugged in, permission granted) */
  | { kind: 'none' }
  /** labels unreadable: can't tell what changed → prompt to recalibrate */
  | { kind: 'unknown' }
  /** a known output came back: reuse its calibration */
  | { kind: 'restore'; calibratedLatencyMs: number }
  /** a new output: the previous output's calibration doesn't apply to it → clear it and prompt */
  | { kind: 'clear' };

export function routeChangeAction(prevLabel: string | undefined, nextLabel: string | undefined, remembered: number | undefined): RouteChangeAction {
  if (!prevLabel || !nextLabel) return { kind: 'unknown' };
  if (prevLabel === nextLabel) return { kind: 'none' };
  return remembered !== undefined ? { kind: 'restore', calibratedLatencyMs: remembered } : { kind: 'clear' };
}
