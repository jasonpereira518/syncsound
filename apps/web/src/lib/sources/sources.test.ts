import { describe, expect, it } from 'vitest';
import { MockRemoteAdapter } from './mock';
import { extrapolate, normalizeRemoteId, parseSpotifyLink, sourceFor } from './types';

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

  it('moves into the song riding along at the end, then stops at position 0 like the SDK', async () => {
    const c = fakeClock();
    const dur = (uri: string) => (uri === 'A' ? 1000 : uri === 'B' ? 2000 : null);
    const m = new MockRemoteAdapter({ seekLatencyMs: 0, jitterMs: 0, now: c.now, sleep: c.sleep, durationMs: dur });
    await m.load('A', { next: 'B' });
    await m.play(500);
    c.advance(400);
    expect(await m.getPosition()).toMatchObject({ uri: 'A', playing: true, positionMs: 900, durationMs: 1000 });
    c.advance(300); // 200 ms into B
    expect(await m.getPosition()).toMatchObject({ uri: 'B', playing: true, positionMs: 200 });
    // loading the next room track doesn't stop what is playing (the hand-over happens at the room boundary)
    await m.load('B');
    expect((await m.getPosition()).playing).toBe(true);
    c.advance(5000);
    expect(await m.getPosition()).toMatchObject({ uri: 'B', playing: false, positionMs: 0 });
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
  it('parses Spotify track, album and playlist links', () => {
    const id = '37i9dQZF1DXcBWIGoYBM5M';
    expect(parseSpotifyLink(`https://open.spotify.com/playlist/${id}?si=abc`)).toEqual({ type: 'playlist', id });
    expect(parseSpotifyLink(`https://open.spotify.com/intl-pt-br/album/${id}`)).toEqual({ type: 'album', id });
    expect(parseSpotifyLink(`https://open.spotify.com/embed/track/${id}`)).toEqual({ type: 'track', id });
    expect(parseSpotifyLink(`spotify:playlist:${id}`)).toEqual({ type: 'playlist', id });
    expect(parseSpotifyLink(id)).toEqual({ type: 'track', id });
    expect(parseSpotifyLink('https://open.spotify.com/artist/x')).toBeNull();
    // only tracks can be queued one at a time
    expect(normalizeRemoteId('spotify', `https://open.spotify.com/intl-de/track/${id}`)).toBe(`spotify:track:${id}`);
    expect(normalizeRemoteId('spotify', `spotify:album:${id}`)).toBeNull();
  });
  it('marks remote sources sync-only', () => {
    expect(sourceFor({ kind: 'spotify', sourceClass: 'remote' }).capabilities).toEqual({ spatial: false, eq: false, sampleAccurate: false });
    expect(sourceFor({ kind: 'file', sourceClass: 'rendered' }).capabilities.spatial).toBe(true);
  });
});
