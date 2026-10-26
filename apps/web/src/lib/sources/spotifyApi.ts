/**
 * Spotify Web API catalog client for the controller: search, the user's playlists, Liked Songs, saved albums.
 * Pure over an injected authorized fetch (spotifyFetch in the browser), so it's unit-testable.
 *
 * Current Web API rules this follows (Feb 2026 migration): search returns at most 10 per page; playlist songs come
 * from /playlists/{id}/items and only for playlists the user owns or collaborates on (others return metadata only);
 * batch lookups are gone (one id per request). Rate limits (429) are honored through one shared Retry-After gate.
 */

export interface SpTrack {
  id: string;
  /** spotify:track:… */
  uri: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  durationMs: number;
}
export interface SpAlbum {
  id: string;
  uri: string;
  name: string;
  artist: string;
  artworkUrl?: string;
  total: number;
  year?: string;
}
export interface SpPlaylist {
  id: string;
  uri: string;
  name: string;
  owner: string;
  artworkUrl?: string;
  total: number;
  /** Spotify lists the songs only for playlists the user owns or collaborates on */
  listable: boolean;
}
export interface Page<T> {
  items: T[];
  total: number;
  /** offset of the next page, null = last page */
  nextOffset: number | null;
  /** entries dropped as unplayable (local files, podcasts, unavailable in this market) */
  skipped: number;
}
export type SearchType = 'track' | 'album' | 'playlist';
export interface SearchResult {
  tracks?: Page<SpTrack>;
  albums?: Page<SpAlbum>;
  playlists?: Page<SpPlaylist>;
}
export interface SpUser {
  id: string;
  name: string;
}

/** the catalog the UI browses: the real Web API or the `?mockRemote=1` fixtures */
export interface SpotifyCatalog {
  me(): Promise<SpUser>;
  search(q: string, types: SearchType[], offset?: number, signal?: AbortSignal): Promise<SearchResult>;
  myPlaylists(offset?: number): Promise<Page<SpPlaylist>>;
  savedAlbums(offset?: number): Promise<Page<SpAlbum>>;
  likedTracks(offset?: number): Promise<Page<SpTrack>>;
  playlist(id: string): Promise<SpPlaylist>;
  playlistTracks(id: string, offset?: number): Promise<Page<SpTrack>>;
  album(id: string): Promise<SpAlbum>;
  albumTracks(id: string, offset?: number): Promise<Page<SpTrack>>;
  track(id: string): Promise<SpTrack>;
}

/** search page size: the Web API maximum for development-mode apps */
export const SEARCH_LIMIT = 10;
/** library/playlist/album page size */
export const PAGE_LIMIT = 50;
const MAX_RETRIES = 3;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 100;

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    msg: string,
    readonly retryAfterSec?: number,
  ) {
    super(msg);
  }
}

interface ApiImage {
  url: string;
  width?: number | null;
}
interface ApiArtist {
  name: string;
}
interface ApiAlbum {
  id: string;
  uri: string;
  name: string;
  artists?: ApiArtist[];
  images?: ApiImage[];
  total_tracks?: number;
  release_date?: string;
}
interface ApiTrack {
  id: string | null;
  uri: string;
  type?: string;
  name: string;
  duration_ms: number;
  artists?: ApiArtist[];
  album?: ApiAlbum;
  is_local?: boolean;
  is_playable?: boolean;
}
interface ApiPaging<T> {
  items: T[];
  total: number;
  next: string | null;
  offset: number;
  limit: number;
}
interface ApiPlaylist {
  id: string;
  uri: string;
  name: string;
  collaborative?: boolean;
  owner?: { id: string; display_name?: string | null };
  images?: ApiImage[] | null;
  /** renamed from `tracks` in Feb 2026; both handled */
  items?: { total: number } | ApiPaging<unknown>;
  tracks?: { total: number };
}

/** the image closest to 300 px (fits list rows and the player bar on high-DPI screens) */
export function pickArtwork(images: ApiImage[] | null | undefined): string | undefined {
  if (!images?.length) return undefined;
  const score = (i: ApiImage) => Math.abs((i.width ?? 300) - 300);
  return [...images].sort((a, b) => score(a) - score(b))[0]!.url;
}

const artistsOf = (a?: ApiArtist[]) => (a ?? []).map((x) => x.name).filter(Boolean).join(', ');

/** null = not playable here (local file, podcast episode, unavailable in this market) */
export function toSpTrack(t: ApiTrack | null | undefined, albumFallback?: SpAlbum): SpTrack | null {
  if (!t || !t.id || t.is_local || t.is_playable === false || (t.type !== undefined && t.type !== 'track')) return null;
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) || !(t.duration_ms > 0)) return null;
  return {
    id: t.id,
    uri: t.uri,
    title: t.name || 'Untitled',
    artist: artistsOf(t.artists) || albumFallback?.artist || '',
    album: t.album?.name ?? albumFallback?.name ?? '',
    artworkUrl: pickArtwork(t.album?.images) ?? albumFallback?.artworkUrl,
    durationMs: t.duration_ms,
  };
}

const toSpAlbum = (a: ApiAlbum): SpAlbum => ({
  id: a.id,
  uri: a.uri,
  name: a.name,
  artist: artistsOf(a.artists),
  artworkUrl: pickArtwork(a.images),
  total: a.total_tracks ?? 0,
  ...(a.release_date && { year: a.release_date.slice(0, 4) }),
});

const toSpPlaylist = (p: ApiPlaylist, meId: string | null): SpPlaylist => ({
  id: p.id,
  uri: p.uri,
  name: p.name,
  owner: p.owner?.display_name || p.owner?.id || '',
  artworkUrl: pickArtwork(p.images),
  total: p.items?.total ?? p.tracks?.total ?? 0,
  listable: !!p.collaborative || (meId !== null && p.owner?.id === meId),
});

function page<A, T>(raw: ApiPaging<A> | undefined, map: (a: A) => T | null): Page<T> {
  if (!raw) return { items: [], total: 0, nextOffset: null, skipped: 0 };
  const items: T[] = [];
  let skipped = 0;
  for (const a of raw.items ?? []) {
    const t = a == null ? null : map(a);
    if (t === null) skipped++;
    else items.push(t);
  }
  const nextOffset = raw.next ? raw.offset + (raw.items?.length || raw.limit) : null;
  return { items, total: raw.total ?? items.length, nextOffset, skipped };
}

export interface SpotifyApiDeps {
  /** authorized request to a path under https://api.spotify.com/v1 */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class SpotifyApi implements SpotifyCatalog {
  private blockedUntil = 0;
  private cache = new Map<string, { at: number; value: unknown }>();
  private meId: string | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly d: SpotifyApiDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? (() => Date.now());
  }

  /** GET with the shared 429 gate, one retry on 5xx and a short cache */
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    let serverErrors = 0;
    for (let attempt = 0; ; attempt++) {
      const wait = this.blockedUntil - this.now();
      if (wait > 0) await this.sleep(wait);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const res = await this.d.fetch(path, signal ? { signal } : {});
      if (res.ok) {
        const value = (await res.json()) as T;
        this.cache.set(path, { at: this.now(), value });
        if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        return value;
      }
      if (res.status === 429) {
        const sec = Math.max(1, Number(res.headers.get('retry-after')) || 1);
        this.blockedUntil = this.now() + sec * 1000;
        if (attempt < MAX_RETRIES) continue;
        throw new SpotifyApiError(429, `Spotify is rate-limiting this app. Try again in ${sec} s.`, sec);
      }
      if (res.status >= 500 && serverErrors++ === 0) {
        await this.sleep(500);
        continue;
      }
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        /* no body */
      }
      throw new SpotifyApiError(res.status, `Spotify request failed (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`);
    }
  }

  async me(): Promise<SpUser> {
    const j = await this.get<{ id: string; display_name?: string | null }>('/me');
    this.meId = j.id;
    return { id: j.id, name: j.display_name || j.id };
  }

  private async myId(): Promise<string | null> {
    if (this.meId === null) await this.me().catch(() => null);
    return this.meId;
  }

  async search(q: string, types: SearchType[], offset = 0, signal?: AbortSignal): Promise<SearchResult> {
    const query = q.trim();
    if (!query || !types.length) return {};
    const qs = new URLSearchParams({ q: query, type: types.join(','), limit: String(SEARCH_LIMIT), offset: String(offset), market: 'from_token' });
    const j = await this.get<{ tracks?: ApiPaging<ApiTrack>; albums?: ApiPaging<ApiAlbum | null>; playlists?: ApiPaging<ApiPlaylist | null> }>(
      `/search?${qs}`,
      signal,
    );
    const meId = types.includes('playlist') ? await this.myId() : null;
    return {
      ...(j.tracks && { tracks: page(j.tracks, (t) => toSpTrack(t)) }),
      ...(j.albums && { albums: page(j.albums, (a) => (a ? toSpAlbum(a) : null)) }),
      ...(j.playlists && { playlists: page(j.playlists, (p) => (p ? toSpPlaylist(p, meId) : null)) }),
    };
  }

  async myPlaylists(offset = 0): Promise<Page<SpPlaylist>> {
    const meId = await this.myId();
    const j = await this.get<ApiPaging<ApiPlaylist | null>>(`/me/playlists?limit=${PAGE_LIMIT}&offset=${offset}`);
    return page(j, (p) => (p ? toSpPlaylist(p, meId) : null));
  }

  async savedAlbums(offset = 0): Promise<Page<SpAlbum>> {
    const j = await this.get<ApiPaging<{ album: ApiAlbum }>>(`/me/albums?limit=${PAGE_LIMIT}&offset=${offset}&market=from_token`);
    return page(j, (s) => (s?.album ? toSpAlbum(s.album) : null));
  }

  async likedTracks(offset = 0): Promise<Page<SpTrack>> {
    const j = await this.get<ApiPaging<{ track: ApiTrack }>>(`/me/tracks?limit=${PAGE_LIMIT}&offset=${offset}&market=from_token`);
    return page(j, (s) => toSpTrack(s?.track));
  }

  async playlist(id: string): Promise<SpPlaylist> {
    const p = await this.get<ApiPlaylist>(`/playlists/${encodeURIComponent(id)}?market=from_token`);
    return toSpPlaylist(p, await this.myId());
  }

  async playlistTracks(id: string, offset = 0): Promise<Page<SpTrack>> {
    try {
      const j = await this.get<ApiPaging<{ item?: ApiTrack | null; track?: ApiTrack | null }>>(
        `/playlists/${encodeURIComponent(id)}/items?limit=${PAGE_LIMIT}&offset=${offset}&market=from_token`,
      );
      // the entry's object was renamed `track` → `item` (Feb 2026); accept either
      return page(j, (e) => toSpTrack(e?.item ?? e?.track));
    } catch (e) {
      if (e instanceof SpotifyApiError && (e.status === 403 || e.status === 404))
        throw new SpotifyApiError(
          e.status,
          "Spotify only lets apps list the songs of playlists you own or collaborate on. In Spotify, add this playlist's songs to one of your own playlists, then play that.",
        );
      throw e;
    }
  }

  async album(id: string): Promise<SpAlbum> {
    return toSpAlbum(await this.get<ApiAlbum>(`/albums/${encodeURIComponent(id)}?market=from_token`));
  }

  async albumTracks(id: string, offset = 0): Promise<Page<SpTrack>> {
    // simplified album tracks carry no album/artwork: fill both in from the album itself
    const album = await this.album(id);
    const j = await this.get<ApiPaging<ApiTrack>>(`/albums/${encodeURIComponent(id)}/tracks?limit=${PAGE_LIMIT}&offset=${offset}&market=from_token`);
    return page(j, (t) => toSpTrack(t, album));
  }

  async track(id: string): Promise<SpTrack> {
    const t = toSpTrack(await this.get<ApiTrack>(`/tracks/${encodeURIComponent(id)}?market=from_token`));
    if (!t) throw new SpotifyApiError(404, "That song isn't playable on Spotify in your country.");
    return t;
  }
}

/**
 * Gather up to `max` tracks from a paged source, following nextOffset. Stops early on the last page;
 * `skipped` adds up unplayable entries.
 */
export async function collect(
  pager: (offset: number) => Promise<Page<SpTrack>>,
  opts: { from?: number; max: number },
): Promise<{ tracks: SpTrack[]; total: number; skipped: number }> {
  const tracks: SpTrack[] = [];
  let skipped = 0;
  let total = 0;
  let offset: number | null = opts.from ?? 0;
  while (offset !== null && tracks.length < opts.max) {
    const p: Page<SpTrack> = await pager(offset);
    total = p.total;
    skipped += p.skipped;
    tracks.push(...p.items);
    offset = p.nextOffset;
  }
  return { tracks: tracks.slice(0, opts.max), total, skipped };
}
