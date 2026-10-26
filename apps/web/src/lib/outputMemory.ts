/**
 * Per-output tune memory. A phone playing through its own speaker, wired headphones or a Bluetooth speaker
 * needs a different timing (Bluetooth adds 100–300 ms the browser doesn't report), so the device's tune invariant
 * (`tuneArrivalMs`, with the run it belongs to) is remembered per output label and restored when that output comes
 * back. Labels are only readable once the page has mic permission (and never on iOS); without a label the app
 * falls back to "tune again" prompts.
 */

const KEY = 'syncsound:outputTune';
/** oldest entries are dropped beyond this */
export const MAX_REMEMBERED_OUTPUTS = 16;

export interface OutputTune {
  tuneId: string;
  tuneArrivalMs: number;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function load(store: KV | null): Record<string, OutputTune> {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, OutputTune> = {};
    for (const [k, v] of Object.entries(raw)) {
      const t = v as Partial<OutputTune> | null;
      if (t && typeof t === 'object' && typeof t.tuneId === 'string' && typeof t.tuneArrivalMs === 'number' && Number.isFinite(t.tuneArrivalMs))
        out[k] = { tuneId: t.tuneId, tuneArrivalMs: t.tuneArrivalMs };
    }
    return out;
  } catch {
    return {};
  }
}

export function recallOutputTune(store: KV | null, label: string | undefined): OutputTune | undefined {
  return label ? load(store)[label] : undefined;
}

export function rememberOutputTune(store: KV | null, label: string | undefined, tune: OutputTune | null): void {
  if (!label || !tune || !Number.isFinite(tune.tuneArrivalMs)) return;
  const all = load(store);
  const cur = all[label];
  if (cur && cur.tuneId === tune.tuneId && cur.tuneArrivalMs === tune.tuneArrivalMs) return;
  delete all[label]; // re-insert last so it counts as most recent
  all[label] = { tuneId: tune.tuneId, tuneArrivalMs: tune.tuneArrivalMs };
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
  /** labels unreadable: can't tell what changed → prompt to tune again */
  | { kind: 'unknown' }
  /** a known output came back: reuse its tune */
  | { kind: 'restore'; tune: OutputTune }
  /** a new output: the previous output's tune doesn't apply to it → clear it and prompt */
  | { kind: 'clear' };

export function routeChangeAction(prevLabel: string | undefined, nextLabel: string | undefined, remembered: OutputTune | undefined): RouteChangeAction {
  if (!prevLabel || !nextLabel) return { kind: 'unknown' };
  if (prevLabel === nextLabel) return { kind: 'none' };
  return remembered ? { kind: 'restore', tune: remembered } : { kind: 'clear' };
}
