/**
 * Leading + trailing throttle that merges payloads: at most one send per `intervalMs`, and the latest merged
 * payload is always sent eventually (trailing send guaranteed).
 */
export function mergingThrottle<T extends object>(send: (payload: T) => void, intervalMs: number) {
  let pending: T | null = null;
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const p = pending;
    pending = null;
    last = Date.now();
    send(p);
  };

  return {
    push(patch: T) {
      pending = { ...(pending ?? {}), ...patch } as T;
      const wait = last + intervalMs - Date.now();
      if (wait <= 0) flush();
      else if (!timer) timer = setTimeout(flush, wait);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
