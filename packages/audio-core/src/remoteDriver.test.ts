import { describe, expect, it } from 'vitest';
import { REMOTE_END_GUARD_MS, REMOTE_MAX_REPLAYS, REMOTE_START_GRACE_MS, clampRemoteSeek, decideRemoteTick, type RemoteTickInput } from './remoteDriver';

const base: RemoteTickInput = {
  roomPlaying: true,
  expectedMs: 30_000,
  durationMs: 200_000,
  player: { playing: true, uri: 'spotify:track:A' },
  wantUri: 'spotify:track:A',
  sinceStartMs: 10_000,
  replays: 0,
  elsewhere: false,
};
const tick = (o: Partial<RemoteTickInput>) => decideRemoteTick({ ...base, ...o });

describe('decideRemoteTick', () => {
  it('syncs while the right track plays', () => {
    expect(tick({})).toEqual({ kind: 'sync' });
    expect(tick({ player: { playing: true } })).toEqual({ kind: 'sync' }); // a player that doesn't report its URI
  });

  it('pauses a player that plays while the room does not; otherwise idles', () => {
    expect(tick({ roomPlaying: false })).toEqual({ kind: 'pause' });
    expect(tick({ roomPlaying: false, player: { playing: false } })).toEqual({ kind: 'hold', reason: 'idle' });
  });

  it('never corrects inside the end guard (the room hands over there)', () => {
    expect(tick({ expectedMs: 200_000 - REMOTE_END_GUARD_MS + 1, player: { playing: false, uri: null } })).toEqual({ kind: 'hold', reason: 'end' });
    expect(tick({ expectedMs: 200_000 - REMOTE_END_GUARD_MS - 1 })).toEqual({ kind: 'sync' });
    expect(tick({ durationMs: null, expectedMs: 1e9 })).toEqual({ kind: 'sync' });
  });

  it('gives a fresh start time to load', () => {
    expect(tick({ sinceStartMs: REMOTE_START_GRACE_MS - 1, player: { playing: false } })).toEqual({ kind: 'hold', reason: 'starting' });
  });

  it('restarts a stopped player or one on the wrong song, then gives up when the account plays elsewhere', () => {
    expect(tick({ player: { playing: false, uri: 'spotify:track:A' } })).toEqual({ kind: 'replay' });
    expect(tick({ player: { playing: true, uri: 'spotify:track:AUTOPLAY' } })).toEqual({ kind: 'replay' });
    expect(tick({ player: { playing: false, uri: null }, replays: REMOTE_MAX_REPLAYS })).toEqual({ kind: 'hold', reason: 'elsewhere' });
    expect(tick({ player: { playing: false, uri: null }, elsewhere: true })).toEqual({ kind: 'hold', reason: 'elsewhere' });
  });
});

describe('clampRemoteSeek', () => {
  it('keeps seeks out of the end guard and above 0', () => {
    expect(clampRemoteSeek(-50, 10_000)).toBe(0);
    expect(clampRemoteSeek(9_900, 10_000)).toBe(10_000 - REMOTE_END_GUARD_MS);
    expect(clampRemoteSeek(5_000, null)).toBe(5_000);
  });
});
