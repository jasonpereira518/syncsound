import { describe, expect, it } from 'vitest';
import { SEARCH_LIMIT, SpotifyApi, SpotifyApiError, collect, pickArtwork, toSpTrack, type Page, type SpTrack } from './spotifyApi';
import { MockSpotifyApi, mockDurationMs } from './spotifyMock';

const ID = (n: number) => `${'A'.repeat(20)}${String(n).padStart(2, '0')}`;
const apiTrack = (n: number, extra: Record<string, unknown> = {}) => ({
  id: ID(n),
  uri: `spotify:track:${ID(n)}`,
  type: 'track',
  name: `Song ${n}`,
  duration_ms: 200_000 + n,
  artists: [{ name: 'A' }, { name: 'B' }],
  album: { id: 'al', uri: 'spotify:album:x', name: 'Album', images: [{ url: 'https://i.scdn.co/image/640', width: 640 }, { url: 'https://i.scdn.co/image/300', width: 300 }, { url: 'https://i.scdn.co/image/64', width: 64 }] },
  ...extra,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function api(handler: (path: string) => Response | Promise<Response>) {
  const paths: string[] = [];
  const sleeps: number[] = [];
  let now = 0;
  const a = new SpotifyApi({
    fetch: async (path) => {
      paths.push(path);
      return handler(path);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  });
  return { a, paths, sleeps };
}

describe('SpotifyApi', () => {
  it('maps tracks: joined artists, ~300 px artwork, unplayable entries dropped', () => {
    expect(toSpTrack(apiTrack(1))).toEqual({
      id: ID(1),
      uri: `spotify:track:${ID(1)}`,
      title: 'Song 1',
      artist: 'A, B',
      album: 'Album',
      artworkUrl: 'https://i.scdn.co/image/300',
      durationMs: 200_001,
    });
    expect(toSpTrack(apiTrack(2, { is_local: true }))).toBeNull();
    expect(toSpTrack(apiTrack(3, { is_playable: false }))).toBeNull();
    expect(toSpTrack(apiTrack(4, { type: 'episode' }))).toBeNull();
    expect(toSpTrack(null)).toBeNull();
    expect(pickArtwork([])).toBeUndefined();
  });

  it('searches 10 at a time with paging', async () => {
    const t = api(() =>
      json({ tracks: { items: [apiTrack(1), apiTrack(2)], total: 25, next: 'https://x', offset: 10, limit: 10 } }),
    );
    const r = await t.a.search('  lofi ', ['track'], 10);
    const q = new URLSearchParams(t.paths[0]!.split('?')[1]);
    expect(q.get('q')).toBe('lofi');
    expect(q.get('limit')).toBe(String(SEARCH_LIMIT));
    expect(q.get('offset')).toBe('10');
    expect(q.get('market')).toBe('from_token');
    expect(r.tracks).toMatchObject({ total: 25, nextOffset: 12, skipped: 0 });
    expect(r.tracks!.items).toHaveLength(2);
    expect(await t.a.search('   ', ['track'])).toEqual({});
  });

  it('reads playlist entries under `item` (Feb 2026) or `track`, and counts skipped ones', async () => {
    const t = api(() =>
      json({ items: [{ item: apiTrack(1) }, { track: apiTrack(2) }, { item: null }, { item: apiTrack(3, { is_local: true }) }], total: 4, next: null, offset: 0, limit: 50 }),
    );
    const p = await t.a.playlistTracks('pl1');
    expect(t.paths[0]).toMatch(/^\/playlists\/pl1\/items\?limit=50&offset=0/);
    expect(p.items.map((x) => x.title)).toEqual(['Song 1', 'Song 2']);
    expect(p).toMatchObject({ total: 4, skipped: 2, nextOffset: null });
  });

  it("explains playlists Spotify won't list (not owned or collaborative)", async () => {
    const t = api(() => json({ error: { status: 403, message: 'Forbidden' } }, 403));
    await expect(t.a.playlistTracks('pl1')).rejects.toThrow(/own or collaborate on/);
  });

  it('marks only own or collaborative playlists as listable', async () => {
    const t = api((path) =>
      path === '/me'
        ? json({ id: 'me1', display_name: 'Me' })
        : json({
            items: [
              { id: 'p1', uri: 'spotify:playlist:p1', name: 'Mine', owner: { id: 'me1' }, items: { total: 5 } },
              { id: 'p2', uri: 'spotify:playlist:p2', name: 'Followed', owner: { id: 'other' }, tracks: { total: 9 } },
              { id: 'p3', uri: 'spotify:playlist:p3', name: 'Shared', collaborative: true, owner: { id: 'other' } },
              null,
            ],
            total: 4,
            next: null,
            offset: 0,
            limit: 50,
          }),
    );
    const p = await t.a.myPlaylists();
    expect(p.items.map((x) => [x.name, x.listable, x.total])).toEqual([
      ['Mine', true, 5],
      ['Followed', false, 9],
      ['Shared', true, 0],
    ]);
    expect(p.skipped).toBe(1);
  });

  it('fills album name and artwork into simplified album tracks', async () => {
    const t = api((path) =>
      path.startsWith('/albums/al1/tracks')
        ? json({ items: [{ ...apiTrack(1), album: undefined, artists: [] }], total: 1, next: null, offset: 0, limit: 50 })
        : json({ id: 'al1', uri: 'spotify:album:al1', name: 'LP', artists: [{ name: 'Band' }], images: [{ url: 'https://i.scdn.co/image/lp', width: 300 }], total_tracks: 1, release_date: '2021-05-01' }),
    );
    const p = await t.a.albumTracks('al1');
    expect(p.items[0]).toMatchObject({ album: 'LP', artist: 'Band', artworkUrl: 'https://i.scdn.co/image/lp' });
    expect(await t.a.album('al1')).toMatchObject({ year: '2021', total: 1 });
  });

  it('waits out Retry-After on 429 and shares the backoff across calls', async () => {
    let n = 0;
    const t = api(() => (n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : json({ id: 'u', display_name: 'U' })));
    expect(await t.a.me()).toEqual({ id: 'u', name: 'U' });
    expect(t.sleeps).toEqual([2000]);
    expect(t.paths).toHaveLength(2);
  });

  it('gives up after repeated 429s with the wait in the error', async () => {
    const t = api(() => new Response('', { status: 429, headers: { 'retry-after': '1' } }));
    await expect(t.a.me()).rejects.toMatchObject({ status: 429, retryAfterSec: 1 });
    expect(t.paths).toHaveLength(4);
  });

  it('retries once on a server error, then reports it', async () => {
    let n = 0;
    const ok = api(() => (n++ === 0 ? new Response('', { status: 502 }) : json({ id: 'u' })));
    expect((await ok.a.me()).id).toBe('u');
    const bad = api(() => json({ error: { message: 'boom' } }, 500));
    await expect(bad.a.me()).rejects.toThrow(SpotifyApiError);
    expect(bad.paths).toHaveLength(2);
  });

  it('caches GETs briefly', async () => {
    const t = api(() => json({ id: 'u' }));
    await t.a.me();
    await t.a.me();
    expect(t.paths).toHaveLength(1);
  });
});

describe('collect', () => {
  it('follows pages up to max and adds up skipped entries', async () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }) as SpTrack);
    const pager = async (offset: number): Promise<Page<SpTrack>> => ({
      items: all.slice(offset, offset + 3),
      total: 7,
      nextOffset: offset + 3 < 7 ? offset + 3 : null,
      skipped: 1,
    });
    expect(await collect(pager, { max: 100 })).toMatchObject({ total: 7, skipped: 3 });
    const capped = await collect(pager, { max: 4 });
    expect(capped.tracks.map((t) => t.id)).toEqual(['0', '1', '2', '3']);
    expect((await collect(pager, { from: 6, max: 10 })).tracks.map((t) => t.id)).toEqual(['6']);
  });
});

describe('MockSpotifyApi', () => {
  it('serves the fixture road-trip playlist with 15 s songs and refuses unlistable playlists', async () => {
    const m = new MockSpotifyApi();
    const pls = await m.myPlaylists();
    const road = pls.items.find((p) => p.name === 'Mock Road Trip')!;
    const songs = await m.playlistTracks(road.id);
    expect(songs.items.map((t) => t.durationMs)).toEqual([15_000, 15_000, 15_000]);
    expect(mockDurationMs(songs.items[0]!.uri)).toBe(15_000);
    expect(mockDurationMs('spotify:track:unknownunknownunknown12')).toBe(180_000);
    const other = pls.items.find((p) => !p.listable)!;
    await expect(m.playlistTracks(other.id)).rejects.toThrow(/own or collaborate/);
    expect((await m.search('quiet', ['album'])).albums!.items[0]!.name).toBe('Quiet Hours');
  });
});
