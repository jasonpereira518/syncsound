/**
 * `startTicker(periodMs, fn)`: a periodic callback driven by one shared Worker (see ticker.worker.ts), so hidden-tab
 * timer throttling doesn't stretch the sync loops. Falls back to setInterval where Workers are unavailable or the
 * Worker can't be built; every consumer must stay correct at any tick rate — the Worker only improves the rate.
 */
export interface TickerWorker {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

let worker: TickerWorker | null | undefined; // undefined: not tried yet; null: unavailable
let factory: (() => TickerWorker) | null = null;
let nextId = 1;
const handlers = new Map<number, () => void>();

/** test hook: build the worker through `f` (or reset to the real one with null) */
export function _setTickerWorkerFactory(f: (() => TickerWorker) | null): void {
  factory = f;
  worker = undefined;
  handlers.clear();
}

/** `?noTicker` forces the setInterval fallback (to compare throttling behaviour on hardware) */
function disabledByQuery(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('noTicker');
  } catch {
    return false;
  }
}

function getWorker(): TickerWorker | null {
  if (worker !== undefined) return worker;
  try {
    const w = factory ? factory() : typeof Worker === 'undefined' || disabledByQuery() ? null : new Worker(new URL('./ticker.worker.ts', import.meta.url), { type: 'module' });
    if (w) {
      w.onmessage = (e) => {
        const id = (e.data as { id?: number } | null)?.id;
        const h = id === undefined ? undefined : handlers.get(id);
        if (h) h();
      };
    }
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** run `fn` every `periodMs`; returns the stop function */
export function startTicker(periodMs: number, fn: () => void): () => void {
  const w = getWorker();
  if (!w) {
    const t = setInterval(fn, periodMs);
    return () => clearInterval(t);
  }
  const id = nextId++;
  handlers.set(id, fn);
  w.postMessage({ op: 'start', id, periodMs });
  return () => {
    handlers.delete(id);
    w.postMessage({ op: 'stop', id });
  };
}

/** true when ticks come from the Worker (debug display) */
export function tickerInWorker(): boolean {
  return getWorker() !== null;
}
