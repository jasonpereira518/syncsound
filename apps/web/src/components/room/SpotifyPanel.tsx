'use client';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { isMockRemote } from '@/lib/sources/mockMode';
import { auth, spotifyCanBrowse, spotifyCatalog } from '@/lib/sources/spotify';
import { collect, type Page, type SearchType, type SpAlbum, type SpPlaylist, type SpTrack } from '@/lib/sources/spotifyApi';
import { MAX_QUEUE } from '@syncsound/protocol';
import type { QueueMode } from '@/lib/sources/spotifyQueue';
import { parseSpotifyLink } from '@/lib/sources/types';
import { Badge, Button, Icon, IconButton, Tabs, fmtTime, inputClass, tabPanelProps, type IconName } from '../ui';
import { act, connectSpotifyHere, errMsg, toast, useCanControl } from './shared';

/** a list of songs the controller opened: a playlist, an album, Liked Songs */
interface SongList {
  key: string;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  load: (offset: number) => Promise<Page<SpTrack>>;
}

/**
 * Spotify in the Library: connect this speaker, see which speakers can play, and (the controller) search and browse
 * the account's music, then play or queue it. Every speaker plays under its own Premium account; SyncSound keeps
 * the players on the room timeline (sync-only: no spatial mix or EQ).
 */
export function SpotifyPanel() {
  const canControl = useCanControl();
  const status = useRoomStore((s) => s.remote.spotify);
  return (
    <div className="space-y-4 text-sm" data-testid="spotify-panel">
      <SpotifyAccount />
      {status === 'ready' && canControl ? (
        <SpotifyBrowser />
      ) : status === 'ready' ? (
        <p className="text-ink-400">The host picks what plays. This speaker plays it in time with the others.</p>
      ) : canControl ? (
        <p className="text-ink-400">Connect Spotify on this device to search and browse your music.</p>
      ) : null}
      <SpotifySpeakers />
    </div>
  );
}

// ---------- this device's account + the room's readiness ----------

function SpotifyAccount() {
  const status = useRoomStore((s) => s.remote.spotify);
  const message = useRoomStore((s) => s.remote.message);
  const devices = useRoomStore((s) => s.room?.devices);
  const live = (devices ?? []).filter((d) => d.connected);
  const ready = live.filter((d) => d.remote.spotify === 'ready').length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">Sync-only mode (no spatial/EQ)</Badge>
        <Badge tone={status === 'ready' ? 'ok' : status === 'signed-out' ? 'neutral' : 'bad'}>this device: {status}</Badge>
        <span data-testid="spotify-readiness" className="text-ink-300">
          {ready} of {live.length} speaker{live.length === 1 ? '' : 's'} connected
        </span>
      </div>
      <p className="text-ink-300">
        Spotify plays through its official player on each speaker, under that speaker&rsquo;s own Premium account (one account
        plays in one place). SyncSound keeps them in time but can&rsquo;t pan or EQ them.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {status !== 'ready' ? (
          <Button variant="primary" data-testid="spotify-connect" onClick={connectSpotifyHere}>
            Connect Spotify
          </Button>
        ) : (
          <Button data-testid="spotify-disconnect" onClick={() => act(() => roomActions.disconnectSpotify())}>
            Disconnect Spotify
          </Button>
        )}
      </div>
      {status === 'needs-premium' && (
        <p className="text-warn">This account can&rsquo;t use the web player. Spotify Premium is required.</p>
      )}
      {message && status !== 'ready' && <p className="text-ink-400">{message}</p>}
    </div>
  );
}

function SpotifySpeakers() {
  const remote = useRoomStore((s) => s.remote);
  const devices = useRoomStore((s) => s.room?.devices);
  return (
    <>
      {remote.meanAbsErrorMs !== null && (
        <p data-testid="remote-sync-stats" className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2 text-ink-300">
          Measured sync on this device: <span className="font-mono text-ink-100">{remote.errorMs ?? '—'} ms</span> now,{' '}
          <span className="font-mono text-ink-100">{remote.meanAbsErrorMs} ms</span> mean |error|, {remote.seeks} corrective seek
          {remote.seeks === 1 ? '' : 's'}. Sync-only sources typically land within 20–150 ms (rendered sources: under 10 ms).
        </p>
      )}
      {devices && (
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700" aria-label="Spotify on each speaker">
          {devices
            .filter((d) => d.connected)
            .map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="truncate">{d.name}</span>
                <span className="flex items-center gap-2">
                  {d.stats?.remoteErrorMs != null && (
                    <span className="font-mono text-xs text-ink-300 tabular">{Math.round(d.stats.remoteErrorMs)} ms</span>
                  )}
                  <Badge tone={d.remote.spotify === 'ready' ? 'ok' : 'neutral'}>{d.remote.spotify === 'ready' ? 'connected' : d.remote.spotify}</Badge>
                </span>
              </li>
            ))}
        </ul>
      )}
    </>
  );
}

// ---------- browse (controller) ----------

/** re-render when this device's Spotify sign-in changes (scopes granted, signed out) */
function useAuthVersion() {
  const [v, setV] = useState(0);
  useEffect(() => auth().subscribe(() => setV((x) => x + 1)), []);
  return v;
}

function SpotifyBrowser() {
  useAuthVersion(); // re-check the granted scopes whenever the sign-in changes
  const canBrowse = isMockRemote() || spotifyCanBrowse();
  const [list, setList] = useState<SongList | null>(null);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const openPlaylist = useCallback((p: SpPlaylist) => {
    if (!p.listable) return setErr("Spotify only lets apps list the songs of playlists you own or collaborate on. In Spotify, add its songs to one of your playlists, then play that.");
    setErr(null);
    setList({ key: p.uri, title: p.name, subtitle: `Playlist · ${p.owner}`, artworkUrl: p.artworkUrl, load: (o) => spotifyCatalog().playlistTracks(p.id, o) });
  }, []);
  const openAlbum = useCallback((a: SpAlbum) => {
    setErr(null);
    setList({ key: a.uri, title: a.name, subtitle: `Album · ${a.artist}${a.year ? ` · ${a.year}` : ''}`, artworkUrl: a.artworkUrl, load: (o) => spotifyCatalog().albumTracks(a.id, o) });
  }, []);
  const openLiked = useCallback(() => {
    setErr(null);
    setList({ key: 'liked', title: 'Liked Songs', subtitle: 'Your saved songs', load: (o) => spotifyCatalog().likedTracks(o) });
  }, []);

  if (!canBrowse)
    return (
      <div className="rounded-xl border border-ink-600 bg-ink-850 p-3">
        <p className="text-ink-200">Allow SyncSound to read your playlists, Liked Songs and saved albums to browse them here.</p>
        <Button
          variant="primary"
          className="mt-2"
          data-testid="spotify-allow-browse"
          onClick={() => act(() => roomActions.allowSpotifyBrowse())}
        >
          Allow access
        </Button>
      </div>
    );

  return (
    <div className="space-y-3">
      <PasteBox onAlbum={openAlbum} onPlaylist={openPlaylist} onError={setErr} />
      {err && (
        <p role="alert" className="text-bad">
          {err}
        </p>
      )}
      {list ? (
        <SongListView list={list} onBack={() => setList(null)} />
      ) : (
        <>
          <label htmlFor="spotify-search" className="sr-only">
            Search Spotify
          </label>
          <div className="relative">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
            <input
              id="spotify-search"
              data-testid="spotify-search"
              type="search"
              placeholder="Search songs, albums, playlists"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${inputClass} pl-9`}
            />
          </div>
          {query.trim() ? (
            <SearchResults query={query.trim()} onAlbum={openAlbum} onPlaylist={openPlaylist} />
          ) : (
            <LibraryHome onAlbum={openAlbum} onPlaylist={openPlaylist} onLiked={openLiked} />
          )}
        </>
      )}
    </div>
  );
}

function PasteBox({ onAlbum, onPlaylist, onError }: { onAlbum: (a: SpAlbum) => void; onPlaylist: (p: SpPlaylist) => void; onError: (e: string | null) => void }) {
  const [id, setId] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const link = parseSpotifyLink(id);
    if (!link) return onError("That doesn't look like a Spotify song, album or playlist link.");
    onError(null);
    setId('');
    if (link.type === 'track') return act(() => roomActions.queueRemote('spotify', `spotify:track:${link.id}`));
    const open = link.type === 'album' ? spotifyCatalog().album(link.id).then(onAlbum) : spotifyCatalog().playlist(link.id).then(onPlaylist);
    open.catch((x: unknown) => onError(errMsg(x)));
  };
  return (
    <form onSubmit={submit} className="flex gap-2" noValidate>
      <label htmlFor="remote-spotify" className="sr-only">
        Spotify track
      </label>
      <input
        id="remote-spotify"
        placeholder="Paste a Spotify song, album or playlist link"
        value={id}
        onChange={(e) => setId(e.target.value)}
        className={inputClass}
      />
      <Button type="submit">Queue</Button>
    </form>
  );
}

/** the first page of a paged source, with "Load more" */
function usePaged<T>(load: ((offset: number) => Promise<Page<T>>) | null) {
  const [state, setState] = useState<{ items: T[]; total: number; next: number | null; skipped: number; error: string | null; loading: boolean }>({
    items: [],
    total: 0,
    next: null,
    skipped: 0,
    error: null,
    loading: !!load,
  });
  useEffect(() => {
    if (!load) return;
    let live = true;
    setState({ items: [], total: 0, next: null, skipped: 0, error: null, loading: true });
    load(0).then(
      (p) => live && setState({ items: p.items, total: p.total, next: p.nextOffset, skipped: p.skipped, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ ...s, error: errMsg(e), loading: false })),
    );
    return () => {
      live = false;
    };
  }, [load]);
  const more = () => {
    if (!load || state.next === null || state.loading) return;
    const offset = state.next;
    setState((s) => ({ ...s, loading: true }));
    load(offset).then(
      (p) => setState((s) => ({ ...s, items: [...s.items, ...p.items], next: p.nextOffset, skipped: s.skipped + p.skipped, loading: false })),
      (e: unknown) => setState((s) => ({ ...s, error: errMsg(e), loading: false })),
    );
  };
  return { ...state, more };
}

function LoadMore({ show, loading, onMore }: { show: boolean; loading: boolean; onMore: () => void }) {
  if (!show) return null;
  return (
    <Button className="w-full" disabled={loading} onClick={onMore}>
      {loading ? 'Loading…' : 'Load more'}
    </Button>
  );
}

function LibraryHome({ onAlbum, onPlaylist, onLiked }: { onAlbum: (a: SpAlbum) => void; onPlaylist: (p: SpPlaylist) => void; onLiked: () => void }) {
  const loadPlaylists = useCallback((o: number) => spotifyCatalog().myPlaylists(o), []);
  const loadAlbums = useCallback((o: number) => spotifyCatalog().savedAlbums(o), []);
  const playlists = usePaged(loadPlaylists);
  const albums = usePaged(loadAlbums);
  return (
    <div className="space-y-4">
      <ul className="space-y-1">
        <li>
          <Row icon="heart" title="Liked Songs" subtitle="Your saved songs" onOpen={onLiked} testid="spotify-liked" />
        </li>
      </ul>
      <Section title="Your playlists" error={playlists.error} empty={!playlists.loading && playlists.items.length === 0 ? 'No playlists yet.' : null}>
        {playlists.items.map((p) => (
          <li key={p.id}>
            <Row
              art={p.artworkUrl}
              icon="music"
              title={p.name}
              subtitle={p.listable ? `${p.total} songs · ${p.owner}` : `${p.owner} · Spotify won't list this playlist's songs`}
              dim={!p.listable}
              onOpen={() => onPlaylist(p)}
              testid="spotify-playlist"
            />
          </li>
        ))}
        <LoadMore show={playlists.next !== null} loading={playlists.loading} onMore={playlists.more} />
      </Section>
      <Section title="Saved albums" error={albums.error} empty={!albums.loading && albums.items.length === 0 ? 'No saved albums.' : null}>
        {albums.items.map((a) => (
          <li key={a.id}>
            <Row art={a.artworkUrl} icon="music" title={a.name} subtitle={a.artist} onOpen={() => onAlbum(a)} testid="spotify-album" />
          </li>
        ))}
        <LoadMore show={albums.next !== null} loading={albums.loading} onMore={albums.more} />
      </Section>
    </div>
  );
}

const SEARCH_TABS: { id: SearchType; label: string }[] = [
  { id: 'track', label: 'Songs' },
  { id: 'album', label: 'Albums' },
  { id: 'playlist', label: 'Playlists' },
];

function SearchResults({ query, onAlbum, onPlaylist }: { query: string; onAlbum: (a: SpAlbum) => void; onPlaylist: (p: SpPlaylist) => void }) {
  const [type, setType] = useState<SearchType>('track');
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 350);
    return () => clearTimeout(t);
  }, [query]);
  const load = useCallback(
    async (offset: number): Promise<Page<SpTrack | SpAlbum | SpPlaylist>> => {
      const r = await spotifyCatalog().search(debounced, [type], offset);
      const empty = { items: [], total: 0, nextOffset: null, skipped: 0 };
      return (type === 'track' ? r.tracks : type === 'album' ? r.albums : r.playlists) ?? empty;
    },
    [debounced, type],
  );
  const res = usePaged(load);
  const songs = type === 'track' ? (res.items as SpTrack[]) : [];
  return (
    <div className="space-y-2">
      <Tabs
        tabs={SEARCH_TABS}
        value={type}
        onChange={setType}
        label="Search for"
        idPrefix="sp-search"
        className="flex gap-1.5"
        tabClassName="!min-h-8 rounded-full border border-ink-700 !px-3 text-xs aria-selected:border-accent/60 aria-selected:bg-accent/10"
      />
      <div {...tabPanelProps('sp-search', type)}>
        {res.error && (
          <p role="alert" className="text-bad">
            {res.error}
          </p>
        )}
        {!res.loading && !res.error && res.items.length === 0 && <p className="text-ink-400">Nothing found for &ldquo;{debounced}&rdquo;.</p>}
        <ul className="space-y-1">
          {type === 'track' &&
            songs.map((t, i) => (
              <li key={`${t.id}-${i}`}>
                <SongRow song={t} onPlay={() => queue([t], 'play')} />
              </li>
            ))}
          {type === 'album' &&
            (res.items as SpAlbum[]).map((a) => (
              <li key={a.id}>
                <Row art={a.artworkUrl} icon="music" title={a.name} subtitle={`${a.artist}${a.year ? ` · ${a.year}` : ''}`} onOpen={() => onAlbum(a)} testid="spotify-album" />
              </li>
            ))}
          {type === 'playlist' &&
            (res.items as SpPlaylist[]).map((p) => (
              <li key={p.id}>
                <Row
                  art={p.artworkUrl}
                  icon="music"
                  title={p.name}
                  subtitle={p.listable ? `${p.total} songs · ${p.owner}` : `${p.owner} · Spotify won't list this playlist's songs`}
                  dim={!p.listable}
                  onOpen={() => onPlaylist(p)}
                  testid="spotify-playlist"
                />
              </li>
            ))}
        </ul>
        <div className="mt-2">
          <LoadMore show={res.next !== null} loading={res.loading} onMore={res.more} />
        </div>
      </div>
    </div>
  );
}

/** queue songs and say what happened */
function queue(songs: SpTrack[], mode: QueueMode, startIndex = 0, total?: number, skipped = 0) {
  act(() => {
    const r = roomActions.queueSpotify(songs, mode, startIndex);
    if (!r.queued) return;
    const of = total !== undefined && total > r.queued ? ` of ${total}` : '';
    const verb = mode === 'play' || mode === 'shuffle' ? 'Playing' : mode === 'next' ? 'Playing next:' : 'Queued';
    const extra = [r.dropped > 0 && `the queue holds ${MAX_QUEUE}`, skipped > 0 && `${skipped} unavailable skipped`].filter(Boolean).join(', ');
    if (songs.length > 1 || of || extra) toast(`${verb} ${r.queued}${of} song${r.queued === 1 ? '' : 's'}${extra ? ` (${extra})` : ''}.`);
  });
}

function SongListView({ list, onBack }: { list: SongList; onBack: () => void }) {
  const songs = usePaged(list.load);
  const [busy, setBusy] = useState(false);
  /** the whole list (beyond the loaded pages) for Play / Shuffle / Add */
  const all = (mode: QueueMode, from = 0) => {
    setBusy(true);
    collect(list.load, { max: mode === 'shuffle' ? 1000 : from + MAX_QUEUE })
      .then(({ tracks, total, skipped }) => queue(tracks, mode, from, mode === 'play' ? Math.max(0, total - skipped - from) : total - skipped, skipped))
      .catch((e: unknown) => toast(errMsg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section aria-label={list.title} data-testid="spotify-detail" className="space-y-3">
      <div className="flex items-center gap-3">
        <IconButton icon="back" label="Back" className="border-transparent" data-testid="spotify-back" onClick={onBack} />
        <Art url={list.artworkUrl} icon={list.key === 'liked' ? 'heart' : 'music'} size="lg" />
        <div className="min-w-0">
          <h4 className="truncate font-display text-lg font-semibold">{list.title}</h4>
          {list.subtitle && <p className="truncate text-ink-400">{list.subtitle}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" data-testid="spotify-play-all" disabled={busy || songs.items.length === 0} onClick={() => all('play')}>
          <Icon name="play" className="size-4" /> Play
        </Button>
        <Button data-testid="spotify-shuffle" disabled={busy || songs.items.length === 0} onClick={() => all('shuffle')}>
          <Icon name="shuffle" className="size-4" /> Shuffle
        </Button>
        <Button data-testid="spotify-add-all" disabled={busy || songs.items.length === 0} onClick={() => all('append')}>
          <Icon name="plus" className="size-4" /> Add to queue
        </Button>
      </div>
      {songs.error && (
        <p role="alert" className="text-bad">
          {songs.error}
        </p>
      )}
      {songs.skipped > 0 && <p className="text-xs text-ink-400">{songs.skipped} unavailable song{songs.skipped === 1 ? '' : 's'} hidden.</p>}
      <ul className="space-y-1">
        {songs.items.map((t, i) => (
          <li key={`${t.id}-${i}`}>
            <SongRow song={t} index={i + 1} onPlay={() => all('play', i)} />
          </li>
        ))}
      </ul>
      {!songs.loading && !songs.error && songs.items.length === 0 && <p className="text-ink-400">No playable songs here.</p>}
      <LoadMore show={songs.next !== null} loading={songs.loading} onMore={songs.more} />
    </section>
  );
}

// ---------- rows ----------

function Art({ url, icon, size = 'sm' }: { url?: string; icon: IconName; size?: 'sm' | 'lg' }) {
  const [broken, setBroken] = useState(false);
  const box = size === 'lg' ? 'size-16' : 'size-10';
  if (!url || broken)
    return (
      <span className={`${box} grid shrink-0 place-items-center rounded-md bg-gradient-to-br from-accent/30 to-ink-800 text-accent`}>
        <Icon name={icon} className="size-5" />
      </span>
    );
  // remote cover art from Spotify's CDN: a plain <img>, nothing to optimize
  return <img src={url} alt="" className={`${box} shrink-0 rounded-md object-cover`} onError={() => setBroken(true)} />;
}

function Section({ title, error, empty, children }: { title: string; error: string | null; empty: string | null; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h4 className="mb-1 text-xs font-medium tracking-widest text-ink-400 uppercase">{title}</h4>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      {empty && <p className="text-ink-400">{empty}</p>}
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}

function Row({ art, icon, title, subtitle, dim, onOpen, testid }: { art?: string; icon: IconName; title: string; subtitle?: string; dim?: boolean; onOpen: () => void; testid: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onOpen}
      className={`flex min-h-12 w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850/50 px-2 py-1.5 text-left transition hover:border-accent/60 ${dim ? 'opacity-60' : ''}`}
    >
      <Art url={art} icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {subtitle && <span className="block truncate text-xs text-ink-400">{subtitle}</span>}
      </span>
    </button>
  );
}

function SongRow({ song, index, onPlay }: { song: SpTrack; index?: number; onPlay: () => void }) {
  return (
    <div data-testid="spotify-song" className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850/50 px-2 py-1">
      <button type="button" onClick={onPlay} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Play ${song.title} by ${song.artist}`}>
        {index !== undefined && <span className="w-5 text-center font-mono text-xs text-ink-500">{index}</span>}
        <Art url={song.artworkUrl} icon="music" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{song.title}</span>
          <span className="block truncate text-xs text-ink-400">
            {song.artist} · {fmtTime(song.durationMs / 1000)}
          </span>
        </span>
      </button>
      <IconButton icon="next" label={`Play ${song.title} next`} className="border-transparent" onClick={() => queue([song], 'next')} />
      <IconButton icon="plus" label={`Add ${song.title} to the queue`} className="border-transparent" onClick={() => queue([song], 'append')} />
    </div>
  );
}
