import { describe, expect, it } from 'vitest';
import { clockSettled, MAX_RUN_OFFSET_MOVE_MS, runValidity, SETTLE_LIMITS, type SettleInput } from './tuneState';

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
