import { describe, expect, it } from 'vitest';
import { MAX_REMEMBERED_OUTPUTS, recallOutputTune, rememberOutputTune, routeChangeAction } from './outputMemory';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const t = (tuneId: string, tuneArrivalMs: number) => ({ tuneId, tuneArrivalMs });

describe('output tune memory', () => {
  it('remembers per output label and recalls it', () => {
    const s = memStore();
    rememberOutputTune(s, 'JBL Flip 5', t('r1', 212));
    rememberOutputTune(s, 'MacBook Pro Speakers', t('r1', 4));
    expect(recallOutputTune(s, 'JBL Flip 5')).toEqual(t('r1', 212));
    expect(recallOutputTune(s, 'MacBook Pro Speakers')).toEqual(t('r1', 4));
    expect(recallOutputTune(s, 'AirPods')).toBeUndefined();
    expect(recallOutputTune(s, undefined)).toBeUndefined();
  });

  it('ignores missing labels, null/non-finite values, corrupt storage and the old numeric entries', () => {
    const s = memStore();
    rememberOutputTune(s, undefined, t('r1', 100));
    rememberOutputTune(s, 'X', null);
    rememberOutputTune(s, 'Y', t('r1', NaN));
    expect(s.m.size).toBe(0);
    s.m.set('syncsound:outputTune', '{not json');
    expect(recallOutputTune(s, 'X')).toBeUndefined();
    s.m.set('syncsound:outputTune', JSON.stringify({ X: 'oops', Y: 7, Z: { tuneId: 'r2', tuneArrivalMs: 9 } }));
    expect(recallOutputTune(s, 'X')).toBeUndefined();
    expect(recallOutputTune(s, 'Y')).toBeUndefined();
    expect(recallOutputTune(s, 'Z')).toEqual(t('r2', 9));
    expect(recallOutputTune(null, 'Z')).toBeUndefined();
  });

  it('keeps only the most recently tuned outputs', () => {
    const s = memStore();
    for (let i = 0; i <= MAX_REMEMBERED_OUTPUTS; i++) rememberOutputTune(s, `out${i}`, t('r', i));
    expect(recallOutputTune(s, 'out0')).toBeUndefined();
    expect(recallOutputTune(s, 'out1')).toEqual(t('r', 1));
    // re-tuning an old entry makes it recent again
    rememberOutputTune(s, 'out1', t('r', 50));
    rememberOutputTune(s, 'fresh', t('r', 1));
    expect(recallOutputTune(s, 'out1')).toEqual(t('r', 50));
    expect(recallOutputTune(s, 'out2')).toBeUndefined();
  });

  it('decides what a route change means', () => {
    expect(routeChangeAction(undefined, 'JBL', t('r', 200))).toEqual({ kind: 'unknown' });
    expect(routeChangeAction('Speakers', undefined, undefined)).toEqual({ kind: 'unknown' });
    expect(routeChangeAction('Speakers', 'Speakers', t('r', 3))).toEqual({ kind: 'none' });
    expect(routeChangeAction('Speakers', 'JBL Flip 5', t('r', 212))).toEqual({ kind: 'restore', tune: t('r', 212) });
    expect(routeChangeAction('JBL Flip 5', 'Speakers', undefined)).toEqual({ kind: 'clear' });
  });
});
