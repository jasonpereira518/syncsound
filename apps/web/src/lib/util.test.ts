import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { History } from './history';
import { mergingThrottle } from './throttle';

describe('mergingThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends leading, merges the burst and guarantees the trailing send', () => {
    const sent: Array<Record<string, number>> = [];
    const t = mergingThrottle<Record<string, number>>((p) => sent.push(p), 33);
    t.push({ a: 1 });
    t.push({ b: 2 });
    t.push({ a: 3 });
    expect(sent).toEqual([{ a: 1 }]);
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([{ a: 1 }, { b: 2, a: 3 }]);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
  });

  it('caps the rate at ~30 Hz under continuous pushes', () => {
    const sent: unknown[] = [];
    const t = mergingThrottle<{ x: number }>((p) => sent.push(p), 33);
    for (let i = 0; i < 100; i++) {
      t.push({ x: i });
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(50);
    expect(sent.length).toBeLessThanOrEqual(32);
    expect(sent.at(-1)).toEqual({ x: 99 });
  });
});

describe('History', () => {
  it('records one step per committed gesture and undoes/redoes it', () => {
    const h = new History<number>();
    let s = 0;
    for (const v of [1, 2, 3]) {
      h.beginEdit(s);
      s = v;
    }
    h.commit(s);
    expect(h.canUndo).toBe(true);
    s = h.undo(s)!;
    expect(s).toBe(0);
    expect(h.canRedo).toBe(true);
    s = h.redo(s)!;
    expect(s).toBe(3);
    expect(h.undo(s)).toBe(0);
  });

  it('a new edit clears the redo stack; no-op gestures are not recorded', () => {
    const h = new History<number>();
    h.beginEdit(0);
    h.commit(5);
    h.undo(5);
    h.beginEdit(0);
    h.commit(7);
    expect(h.canRedo).toBe(false);
    h.beginEdit(7);
    h.commit(7);
    expect(h.undo(7)).toBe(0);
    expect(h.undo(0)).toBeNull();
  });
});
