import { describe, expect, it } from 'vitest';
import { SELF_OFFSET_M } from './calibration';
import { SPEED_OF_SOUND } from './spatial';
import { clockSettled, deriveCalibratedLatency, MAX_RUN_OFFSET_MOVE_MS, runValidity, SETTLE_LIMITS, syncStateOf, type SettleInput } from './tuneState';

describe('deriveCalibratedLatency / syncStateOf', () => {
  const msPerM = 1000 / SPEED_OF_SOUND;
  const devs = [
    { id: 'L', tuneArrivalMs: 0.5, tuneId: 't1' },
    { id: 'g1', tuneArrivalMs: 10 + 3.43 * msPerM, tuneId: 't1' }, // 3.43 m away: 10 ms of latency + 10 ms of air
    { id: 'h', tuneArrivalMs: 15 + 1.715 * msPerM, tuneId: 't1' }, // 1.715 m away
    { id: 'old', tuneArrivalMs: 7, tuneId: 't0' }, // from an earlier run
    { id: 'never', tuneArrivalMs: null, tuneId: null },
  ];
  const positions = { L: { x: 0, y: 0 }, g1: { x: 3.43, y: 0 }, h: { x: 0, y: 1.715 }, old: { x: 1, y: 1 } };
  const tune = { id: 't1', listenerId: 'L', mic: { x: 0, y: 0 }, positions };
  const head = { x: 0, y: 0.4 };

  it('subtracts each device’s air path to the mic and re-zeroes on the fastest; other runs get null', () => {
    const cal = deriveCalibratedLatency(devs, tune, positions);
    const L = 0.5 - SELF_OFFSET_M * msPerM; // the listener’s own near-field prior
    const min = Math.min(L, 10, 15);
    expect(cal.L).toBeCloseTo(L - min, 9);
    expect(cal.g1).toBeCloseTo(10 - min, 9);
    expect(cal.h).toBeCloseTo(15 - min, 9);
    expect(cal.old).toBeNull();
    expect(cal.never).toBeNull();
  });

  it('a position edit moves only that device’s value, by exactly what the engine’s propagation delay moves', () => {
    const before = deriveCalibratedLatency(devs, tune, positions, head);
    const moved = { x: 3.43 + 0.343, y: 0 };
    const after = deriveCalibratedLatency(devs, tune, { ...positions, g1: moved }, head);
    const dHead = (p: { x: number; y: number }) => Math.hypot(p.x - head.x, p.y - head.y);
    expect(after.g1! - before.g1!).toBeCloseTo(-(dHead(moved) - dHead(positions.g1)) * msPerM, 9); // ≈ −1 ms
    expect(after.g1! - before.g1!).toBeCloseTo(-1, 1);
    expect(after.h).toBeCloseTo(before.h!, 9);
    // without tune-time positions the current ones stand in (the mic reading); with the head at the mic both agree
    expect(deriveCalibratedLatency(devs, { ...tune, positions: undefined }, positions, head)).toEqual(before);
    expect(deriveCalibratedLatency(devs, { ...tune, positions: undefined }, { ...positions, g1: moved }, { x: 0, y: 0 }).g1! - before.g1!).toBeCloseTo(-1, 6);
  });

  it('moving the listener changes nothing here (the engine’s delays follow the head)', () => {
    const before = deriveCalibratedLatency(devs, tune, positions, head);
    expect(deriveCalibratedLatency(devs, tune, positions, { x: 2, y: -1 })).toEqual(before);
  });

  it('a device without a position keeps its raw arrival; no tune or no devices in it → all null', () => {
    const cal = deriveCalibratedLatency(devs, { ...tune, positions: undefined }, { L: { x: 0, y: 0 } });
    expect(cal.g1).toBeCloseTo(10 + 3.43 * msPerM - Math.min(0.5 - SELF_OFFSET_M * msPerM, 10 + 3.43 * msPerM, 15 + 1.715 * msPerM), 9);
    expect(Object.values(deriveCalibratedLatency(devs, undefined, positions)).every((v) => v === null)).toBe(true);
    expect(Object.values(deriveCalibratedLatency(devs, { ...tune, id: 'tX' }, positions)).every((v) => v === null)).toBe(true);
  });

  it('syncStateOf', () => {
    expect(syncStateOf(devs[0]!, tune)).toBe('tuned');
    expect(syncStateOf({ ...devs[0]!, tuneStale: 'route' }, tune)).toBe('stale');
    expect(syncStateOf(devs[3]!, tune)).toBe('untuned');
    expect(syncStateOf(devs[4]!, tune)).toBe('untuned');
    expect(syncStateOf(devs[0]!, undefined)).toBe('untuned');
  });
});

const good: SettleInput = { converged: true, ageMs: 10_000, jitterMs: 0.5, pendingSlewMs: 0.05, driftSePpm: 4, link: 'none', audioRateSePpm: 3 };

describe('clockSettled', () => {
  it('passes a steady clock', () => {
    expect(clockSettled(good)).toEqual({ ok: true, hard: false, reason: null });
  });

  it('each hard criterion blocks on its own', () => {
    for (const bad of [
      { converged: false },
      { link: 'not-ready' as const },
      { pendingSlewMs: SETTLE_LIMITS.maxPendingSlewMs + 0.01 },
      { pendingSlewMs: -(SETTLE_LIMITS.maxPendingSlewMs + 0.01) },
      { ageMs: SETTLE_LIMITS.minAgeMs - 1 },
    ]) {
      const v = clockSettled({ ...good, ...bad });
      expect(v.ok).toBe(false);
      expect(v.hard).toBe(true);
      expect(v.reason).toBeTruthy();
    }
    expect(clockSettled({ ...good, link: 'ready' }).ok).toBe(true);
  });

  it('each soft criterion only warns', () => {
    for (const bad of [
      { driftSePpm: SETTLE_LIMITS.maxDriftSePpm + 1 },
      { driftSePpm: Infinity },
      { jitterMs: SETTLE_LIMITS.maxJitterMs + 1 },
      { audioRateSePpm: null },
      { audioRateSePpm: SETTLE_LIMITS.maxAudioRateSePpm + 1 },
    ]) {
      const v = clockSettled({ ...good, ...bad });
      expect(v.ok).toBe(false);
      expect(v.hard).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });
});

describe('runValidity', () => {
  const snap = { path: 'lan:m', resets: 0, steps: 1 };
  it('accepts an unchanged run and rejects each kind of movement', () => {
    expect(runValidity(snap, snap, 0.4)).toEqual({ valid: true });
    expect(runValidity(snap, snap, MAX_RUN_OFFSET_MOVE_MS).valid).toBe(true);
    expect(runValidity(snap, snap, -(MAX_RUN_OFFSET_MOVE_MS + 0.01)).reason).toMatch(/moved/);
    expect(runValidity(snap, { ...snap, path: 'wan' }, 0).reason).toMatch(/path/);
    expect(runValidity(snap, { ...snap, resets: 1 }, 0).reason).toMatch(/reset/);
    expect(runValidity(snap, { ...snap, steps: 2 }, 0).reason).toMatch(/output/);
    expect(runValidity(snap, snap, NaN).valid).toBe(false);
  });
});
