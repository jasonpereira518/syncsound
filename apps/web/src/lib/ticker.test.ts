import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setTickerWorkerFactory, startTicker, tickerInWorker, type TickerWorker } from './ticker';

class FakeWorker implements TickerWorker {
  sent: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  tick(id: number) {
    this.onmessage?.({ data: { id } } as MessageEvent);
  }
}

afterEach(() => _setTickerWorkerFactory(null));

describe('startTicker', () => {
  it('multiplexes tickers over one worker and stops them by id', () => {
    const w = new FakeWorker();
    _setTickerWorkerFactory(() => w);
    const a: number[] = [];
    const b: number[] = [];
    const stopA = startTicker(250, () => a.push(1));
    const stopB = startTicker(500, () => b.push(1));
    expect(tickerInWorker()).toBe(true);
    expect(w.sent).toEqual([
      { op: 'start', id: expect.any(Number), periodMs: 250 },
      { op: 'start', id: expect.any(Number), periodMs: 500 },
    ]);
    const [idA, idB] = (w.sent as Array<{ id: number }>).map((m) => m.id);
    w.tick(idA!);
    w.tick(idA!);
    w.tick(idB!);
    expect(a.length).toBe(2);
    expect(b.length).toBe(1);
    stopA();
    w.tick(idA!); // a stopped ticker never fires again, even if a tick was in flight
    expect(a.length).toBe(2);
    expect(w.sent.at(-1)).toEqual({ op: 'stop', id: idA });
    stopB();
    w.tick(999); // unknown ids are ignored
  });

  it('falls back to setInterval when the worker cannot be built', () => {
    vi.useFakeTimers();
    try {
      _setTickerWorkerFactory(() => {
        throw new Error('no workers here');
      });
      const calls: number[] = [];
      const stop = startTicker(100, () => calls.push(1));
      expect(tickerInWorker()).toBe(false);
      vi.advanceTimersByTime(350);
      expect(calls.length).toBe(3);
      stop();
      vi.advanceTimersByTime(500);
      expect(calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
