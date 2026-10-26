/**
 * Shared interval ticker in a dedicated Worker: timers here are outside the page's background-tab throttling
 * (1 Hz when hidden, one wake-up a minute after five minutes hidden), so the clock pings, the audio-clock
 * observations and the drift loop keep their cadence in a paused room whose tab is in the background.
 * Protocol: { op: 'start', id, periodMs } | { op: 'stop', id } in; { id } out on every tick.
 */
type In = { op: 'start'; id: number; periodMs: number } | { op: 'stop'; id: number };

const scope = self as unknown as { onmessage: ((e: MessageEvent<In>) => void) | null; postMessage(m: unknown): void };
const timers = new Map<number, ReturnType<typeof setInterval>>();

scope.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  const t = timers.get(m.id);
  if (t !== undefined) clearInterval(t);
  timers.delete(m.id);
  if (m.op === 'start') timers.set(m.id, setInterval(() => scope.postMessage({ id: m.id }), m.periodMs));
};
