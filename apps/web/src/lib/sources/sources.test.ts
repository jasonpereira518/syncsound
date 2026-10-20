import { describe, expect, it } from 'vitest';
import { MockRemoteAdapter } from './mock';
import { extrapolate, normalizeRemoteId, sourceFor } from './types';

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => (t += ms),
  };
}

describe('MockRemoteAdapter', () => {
  it('play takes effect after the seek latency, leaving the player behind by it', async () => {
    const c = fakeClock();
    const m = new MockRemoteAdapter({ seekLatencyMs: 200, jitterMs: 0, now: c.now, sleep: c.sleep });
    await m.connect();
    expect(m.status).toBe('ready');
    const requestedAt = c.now();
    await m.play(1000);
    c.advance(500);
    const p = await m.getPosition();
    // room timeline would be at 1000 + (now − requestedAt) = 1700
    expect(1000 + (c.now() - requestedAt) - p.positionMs).toBeCloseTo(200, 6);
  });

  it('pause freezes position; seek jumps; rate error drifts', async () => {
    const c = fakeClock();
    const m = new MockRemoteAdapter({ seekLatencyMs: 0, jitterMs: 0, rateError: 0.01, now: c.now, sleep: c.sleep });
    await m.play(0);
    c.advance(1000);
    expect((await m.getPosition()).positionMs).toBeCloseTo(1010, 6);
    await m.pause();
    c.advance(1000);
    expect((await m.getPosition()).positionMs).toBeCloseTo(1010, 6);
    await m.seek(5000);
    expect((await m.getPosition()).positionMs).toBe(5000);
  });

  it('jitter stays within bounds', async () => {
    const c = fakeClock();
    const m = new MockRemoteAdapter({ seekLatencyMs: 100, jitterMs: 30, now: c.now, sleep: c.sleep, random: () => 1 });
    const t0 = c.now();
    await m.seek(0);
    expect(c.now() - t0).toBe(130);
  });
});

describe('remote helpers', () => {
  it('extrapolates only while playing', () => {
    expect(extrapolate({ positionMs: 1000, atMs: 50, playing: true }, 150)).toBe(1100);
    expect(extrapolate({ positionMs: 1000, atMs: 50, playing: false }, 150)).toBe(1000);
  });
  it('normalizes Spotify and Apple ids', () => {
    expect(normalizeRemoteId('spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(normalizeRemoteId('spotify', 'nope')).toBeNull();
    expect(normalizeRemoteId('apple', 'https://music.apple.com/us/album/x/1440833?i=1440833098')).toBe('1440833098');
    expect(normalizeRemoteId('apple', '1440833098')).toBe('1440833098');
  });
  it('marks remote sources sync-only', () => {
    expect(sourceFor({ kind: 'spotify', sourceClass: 'remote' }).capabilities).toEqual({ spatial: false, eq: false, sampleAccurate: false });
    expect(sourceFor({ kind: 'file', sourceClass: 'rendered' }).capabilities.spatial).toBe(true);
  });
});
