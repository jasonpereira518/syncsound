import { describe, expect, it } from 'vitest';
import { LIVE_DELAY, PipelineFilter, bufferShortfallMs, jitterTargetMs, nextDelayMs, snapDelayMs } from './liveDelay';

const SR = 48000;
const samples = (ms: number, sr = SR) => (ms / 1000) * sr;

describe('PipelineFilter', () => {
  it('is null until the first poll, then the median of the window', () => {
    const f = new PipelineFilter();
    expect(f.estimate()).toBeNull();
    for (const v of [60, 61, 200, 59, 60]) f.push(v);
    expect(f.estimate()).toBe(60);
  });
  it('slides: the oldest poll falls out after windowSize pushes', () => {
    const f = new PipelineFilter(3);
    for (const v of [100, 100, 100, 10, 10]) f.push(v);
    expect(f.estimate()).toBe(10);
  });
  it('ignores NaN and negative values and can be reset', () => {
    const f = new PipelineFilter();
    f.push(Number.NaN);
    f.push(-5);
    expect(f.estimate()).toBeNull();
    f.push(42);
    expect(f.estimate()).toBe(42);
    f.reset();
    expect(f.estimate()).toBeNull();
  });
});

describe('snapDelayMs', () => {
  it.each([48000, 44100])('lands on a whole sample at %d Hz and moves by at most half a sample', (sr) => {
    for (const ms of [0, 12.3456, 85, 149.99, 1990]) {
      const s = snapDelayMs(ms, sr);
      const n = samples(s, sr);
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6);
      expect(Math.abs(s - ms)).toBeLessThanOrEqual(500 / sr + 1e-9);
    }
  });
});

describe('nextDelayMs', () => {
  it('applies the first target immediately, snapped', () => {
    const t = nextDelayMs({ desiredMs: 85.3, appliedMs: null, sampleRate: SR });
    expect(t).not.toBeNull();
    expect(Math.abs(samples(t!) - Math.round(samples(t!)))).toBeLessThan(1e-6);
    expect(Math.abs(t! - 85.3)).toBeLessThan(0.02);
  });
  it('keeps the current delay inside the deadband and switches at the edge', () => {
    expect(nextDelayMs({ desiredMs: 89.9, appliedMs: 80, sampleRate: SR })).toBeNull();
    expect(nextDelayMs({ desiredMs: 90, appliedMs: 80, sampleRate: SR })).toBe(snapDelayMs(90, SR));
    expect(nextDelayMs({ desiredMs: 70, appliedMs: 80, sampleRate: SR })).toBe(snapDelayMs(70, SR));
  });
  it('force bypasses the deadband but never re-applies an identical target', () => {
    expect(nextDelayMs({ desiredMs: 83, appliedMs: 80, sampleRate: SR, force: true })).toBe(snapDelayMs(83, SR));
    expect(nextDelayMs({ desiredMs: 80, appliedMs: snapDelayMs(80, SR), sampleRate: SR, force: true })).toBeNull();
  });
  it('clamps to 0 … maxMs', () => {
    expect(nextDelayMs({ desiredMs: -50, appliedMs: null, sampleRate: SR })).toBe(0);
    expect(nextDelayMs({ desiredMs: 5000, appliedMs: null, sampleRate: SR })).toBe(snapDelayMs(LIVE_DELAY.maxMs, SR));
  });
});

/** receiver loop as capture.ts runs it: buffer 200 ms, no compensation → desired = 200 − estimate */
function govern(polls: number[], sr = SR) {
  const f = new PipelineFilter();
  let applied: number | null = null;
  let changes = 0;
  for (const p of polls) {
    f.push(p);
    const next = nextDelayMs({ desiredMs: 200 - f.estimate()!, appliedMs: applied, sampleRate: sr });
    if (next !== null) {
      applied = next;
      changes++;
    }
  }
  return { applied, changes };
}

describe('governor scenarios', () => {
  it('a wobbling estimate (±4 ms) with one spike applies exactly once', () => {
    const polls = Array.from({ length: 30 }, (_, i) => 60 + [0, 4, -4, 2, -2][i % 5]!);
    polls[12] = 150; // one late getStats / NetEq expand
    const r = govern(polls);
    expect(r.changes).toBe(1);
    expect(r.applied).toBe(snapDelayMs(140, SR));
  });
  it('a slow drift (+0.5 ms per poll over 40 polls) applies exactly twice', () => {
    const polls = Array.from({ length: 40 }, (_, i) => 60 + 0.5 * i);
    const r = govern(polls);
    expect(r.changes).toBe(2);
    expect(r.applied).toBe(snapDelayMs(130, SR));
  });
});

describe('jitterTargetMs', () => {
  it('is half the room buffer, clamped to 40–500 ms', () => {
    expect(jitterTargetMs(150)).toBe(75);
    expect(jitterTargetMs(40)).toBe(40);
    expect(jitterTargetMs(300)).toBe(150);
    expect(jitterTargetMs(1000)).toBe(500);
  });
});

describe('bufferShortfallMs', () => {
  it('reports how late a device must play when the buffer cannot cover its latency', () => {
    expect(bufferShortfallMs({ videoBufferMs: 150, lipSyncNudgeMs: 0, pipelineDelayMs: 85, compensationMs: 250 })).toBe(185);
    expect(bufferShortfallMs({ videoBufferMs: 300, lipSyncNudgeMs: 0, pipelineDelayMs: 85, compensationMs: 40 })).toBe(0);
    expect(bufferShortfallMs({ videoBufferMs: 150, lipSyncNudgeMs: -100, pipelineDelayMs: 50, compensationMs: 10 })).toBe(10);
  });
});
