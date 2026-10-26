/**
 * `?mockRemote=1` Spotify catalog: invented fixture playlists, albums and songs behind the same SpotifyCatalog
 * interface as the Web API client, so the browse → queue → auto-advance flow runs in tests and demos without
 * Spotify accounts. Artwork URLs point at i.scdn.co paths that tests serve themselves.
 */
import type { Page, SearchResult, SearchType, SpAlbum, SpPlaylist, SpTrack, SpUser, SpotifyCatalog } from './spotifyApi';

/** 22-char base62 id derived from a short key (deterministic) */
export function mockId(key: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let h = 2166136261;
  let out = '';
  for (let i = 0; out.length < 22; i++) {
    h ^= key.charCodeAt(i % key.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += chars[h % 62];
  }
  return out;
}

const art = (key: string) => `https://i.scdn.co/image/mock-${key}`;

function tr(key: string, title: string, artist: string, album: string, sec: number): SpTrack {
  const id = mockId(`t:${key}`);
  return { id, uri: `spotify:track:${id}`, title, artist, album, artworkUrl: art(album.toLowerCase().replace(/\W+/g, '-')), durationMs: sec * 1000 };
}

const ROAD = [
  tr('road1', 'Open Highway', 'The Mock Band', 'Mock Road Trip', 10),
  tr('road2', 'Rest Stop', 'The Mock Band', 'Mock Road Trip', 10),
  tr('road3', 'City Lights', 'The Mock Band', 'Mock Road Trip', 10),
];
const CHILL = [
  tr('chill1', 'Slow Morning', 'Fixture Trio', 'Quiet Hours', 180),
  tr('chill2', 'Tea Steam', 'Fixture Trio', 'Quiet Hours', 200),
  tr('chill3', 'Window Rain', 'Fixture Trio', 'Quiet Hours', 210),
  tr('chill4', 'Paper Boats', 'Fixture Trio', 'Quiet Hours', 190),
];
const LIKED = [CHILL[0]!, ROAD[1]!, tr('liked1', 'Sample Song', 'Test Artist', 'Placeholder', 150), tr('liked2', 'Demo Groove', 'Test Artist', 'Placeholder', 165), tr('liked3', 'Stub Anthem', 'Nobody Real', 'Mockup', 175)];

interface PlaylistFixture {
  p: SpPlaylist;
  tracks: SpTrack[];
}
const pl = (key: string, name: string, owner: string, tracks: SpTrack[], listable = true): PlaylistFixture => {
  const id = mockId(`p:${key}`);
  return { p: { id, uri: `spotify:playlist:${id}`, name, owner, artworkUrl: art(`pl-${key}`), total: tracks.length, listable }, tracks };
};
const PLAYLISTS: PlaylistFixture[] = [
  pl('road', 'Mock Road Trip', 'You', ROAD),
  pl('chill', 'Quiet Hours Mix', 'You', CHILL),
  pl('editorial', 'Someone Else’s Hits', 'Another User', [...CHILL].reverse(), false),
];
const ALBUMS: Array<{ a: SpAlbum; tracks: SpTrack[] }> = [
  { a: { id: mockId('a:quiet'), uri: `spotify:album:${mockId('a:quiet')}`, name: 'Quiet Hours', artist: 'Fixture Trio', artworkUrl: art('quiet-hours'), total: CHILL.length, year: '2024' }, tracks: CHILL },
  { a: { id: mockId('a:road'), uri: `spotify:album:${mockId('a:road')}`, name: 'Mock Road Trip', artist: 'The Mock Band', artworkUrl: art('mock-road-trip'), total: ROAD.length, year: '2025' }, tracks: ROAD },
];
const ALL_TRACKS = [...ROAD, ...CHILL, ...LIKED];

/** length of a fixture track; unknown ids (pasted links) are 3 minutes */
export function mockDurationMs(uri: string): number {
  return ALL_TRACKS.find((t) => t.uri === uri)?.durationMs ?? 180_000;
}

function pageOf<T>(all: T[], offset: number, limit: number): Page<T> {
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null, skipped: 0 };
}

const match = (q: string, ...fields: string[]) => fields.some((f) => f.toLowerCase().includes(q.toLowerCase()));

export class MockSpotifyApi implements SpotifyCatalog {
  async me(): Promise<SpUser> {
    return { id: 'mock-user', name: 'Mock Listener' };
  }

  async search(q: string, types: SearchType[], offset = 0): Promise<SearchResult> {
    const query = q.trim();
    if (!query) return {};
    const uniq = [...new Map(ALL_TRACKS.map((t) => [t.id, t])).values()];
    return {
      ...(types.includes('track') && { tracks: pageOf(uniq.filter((t) => match(query, t.title, t.artist, t.album)), offset, 10) }),
      ...(types.includes('album') && { albums: pageOf(ALBUMS.map((a) => a.a).filter((a) => match(query, a.name, a.artist)), offset, 10) }),
      ...(types.includes('playlist') && { playlists: pageOf(PLAYLISTS.map((p) => p.p).filter((p) => match(query, p.name)), offset, 10) }),
    };
  }

  async myPlaylists(offset = 0) {
    return pageOf(
      PLAYLISTS.map((p) => p.p),
      offset,
      50,
    );
  }

  async savedAlbums(offset = 0) {
    return pageOf(
      ALBUMS.map((a) => a.a),
      offset,
      50,
    );
  }

  async likedTracks(offset = 0) {
    return pageOf(LIKED, offset, 50);
  }

  async playlist(id: string) {
    const f = PLAYLISTS.find((p) => p.p.id === id);
    if (!f) throw new Error('Playlist not found.');
    return f.p;
  }

  async playlistTracks(id: string, offset = 0) {
    const f = PLAYLISTS.find((p) => p.p.id === id);
    if (!f) throw new Error('Playlist not found.');
    if (!f.p.listable) throw new Error('Spotify only lets apps list the songs of playlists you own or collaborate on.');
    return pageOf(f.tracks, offset, 50);
  }

  async album(id: string) {
    const f = ALBUMS.find((a) => a.a.id === id);
    if (!f) throw new Error('Album not found.');
    return f.a;
  }

  async albumTracks(id: string, offset = 0) {
    const f = ALBUMS.find((a) => a.a.id === id);
    if (!f) throw new Error('Album not found.');
    return pageOf(f.tracks, offset, 50);
  }

  async track(id: string): Promise<SpTrack> {
    return ALL_TRACKS.find((t) => t.id === id) ?? { id, uri: `spotify:track:${id}`, title: 'Mock track', artist: 'Mock artist', album: 'Mock album', artworkUrl: art('mock-track'), durationMs: 180_000 };
  }
}
