import { describe, expect, it } from 'vitest';
import { MAX_REMEMBERED_OUTPUTS, recallOutputCalibration, rememberOutputCalibration, routeChangeAction } from './outputMemory';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('output calibration memory', () => {
  it('remembers per output label and recalls it', () => {
    const s = memStore();
    rememberOutputCalibration(s, 'JBL Flip 5', 212);
    rememberOutputCalibration(s, 'MacBook Pro Speakers', 4);
    expect(recallOutputCalibration(s, 'JBL Flip 5')).toBe(212);
    expect(recallOutputCalibration(s, 'MacBook Pro Speakers')).toBe(4);
    expect(recallOutputCalibration(s, 'AirPods')).toBeUndefined();
    expect(recallOutputCalibration(s, undefined)).toBeUndefined();
  });

  it('ignores missing labels, null/non-finite values, and corrupt storage', () => {
    const s = memStore();
    rememberOutputCalibration(s, undefined, 100);
    rememberOutputCalibration(s, 'X', null);
    rememberOutputCalibration(s, 'Y', NaN);
    expect(s.m.size).toBe(0);
    s.m.set('syncsound:outputCalibration', '{not json');
    expect(recallOutputCalibration(s, 'X')).toBeUndefined();
    s.m.set('syncsound:outputCalibration', JSON.stringify({ X: 'oops', Y: 7 }));
    expect(recallOutputCalibration(s, 'X')).toBeUndefined();
    expect(recallOutputCalibration(s, 'Y')).toBe(7);
    expect(recallOutputCalibration(null, 'Y')).toBeUndefined();
  });

  it('keeps only the most recently calibrated outputs', () => {
    const s = memStore();
    for (let i = 0; i <= MAX_REMEMBERED_OUTPUTS; i++) rememberOutputCalibration(s, `out${i}`, i);
    expect(recallOutputCalibration(s, 'out0')).toBeUndefined();
    expect(recallOutputCalibration(s, 'out1')).toBe(1);
    // re-calibrating an old entry makes it recent again
    rememberOutputCalibration(s, 'out1', 50);
    rememberOutputCalibration(s, 'fresh', 1);
    expect(recallOutputCalibration(s, 'out1')).toBe(50);
    expect(recallOutputCalibration(s, 'out2')).toBeUndefined();
  });

  it('decides what a route change means', () => {
    expect(routeChangeAction(undefined, 'JBL', 200)).toEqual({ kind: 'unknown' });
    expect(routeChangeAction('Speakers', undefined, undefined)).toEqual({ kind: 'unknown' });
    expect(routeChangeAction('Speakers', 'Speakers', 3)).toEqual({ kind: 'none' });
    expect(routeChangeAction('Speakers', 'JBL Flip 5', 212)).toEqual({ kind: 'restore', calibratedLatencyMs: 212 });
    expect(routeChangeAction('JBL Flip 5', 'Speakers', undefined)).toEqual({ kind: 'clear' });
  });
});
