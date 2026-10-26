import { describe, expect, it } from 'vitest';
import { tuneStatus } from './tuneStatus';

const tune = { id: 't1', listenerId: 'a', mic: { x: 0, y: 0 }, at: 0, quick: false, ranged: [], positions: {} };
const d = (name: string, syncState: 'tuned' | 'stale' | 'untuned') => ({ name, syncState });

describe('tuneStatus', () => {
  it('no tune, or nobody in it → "Not tuned yet", a full run', () => {
    expect(tuneStatus([d('Laptop', 'untuned'), d('Phone', 'untuned')], undefined)).toEqual({ state: 'none', label: 'Not tuned yet', action: 'Tune the room', mode: 'full' });
    expect(tuneStatus([d('Laptop', 'untuned')], tune).state).toBe('none');
  });

  it('some untuned (a late joiner, one not heard) → "N of M speakers tuned", a full run (it needs a position)', () => {
    expect(tuneStatus([d('Laptop', 'tuned'), d('Phone', 'untuned'), d('Tablet', 'tuned'), d('Kitchen', 'stale')], tune)).toEqual({
      state: 'partial',
      label: '3 of 4 speakers tuned',
      action: 'Tune',
      mode: 'full',
    });
  });

  it('only stale speakers → named, a timing-only run', () => {
    expect(tuneStatus([d('Laptop', 'tuned'), d('Kitchen phone', 'stale')], tune)).toEqual({
      state: 'stale',
      label: 'Kitchen phone needs tuning again',
      action: 'Tune',
      mode: 'quick',
    });
    expect(tuneStatus([d('A', 'stale'), d('B', 'stale')], tune).label).toBe('2 speakers need tuning again');
  });

  it('all tuned → "Tuned · N speakers", "Tune again"', () => {
    expect(tuneStatus([d('A', 'tuned'), d('B', 'tuned'), d('C', 'tuned'), d('D', 'tuned')], tune)).toEqual({ state: 'tuned', label: 'Tuned · 4 speakers', action: 'Tune again', mode: 'full' });
    expect(tuneStatus([d('A', 'tuned')], tune).label).toBe('Tuned · 1 speaker');
  });
});
