'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MAX_UPLOAD_BYTES, type Track, type TrackKind } from '@syncsound/protocol';
import { positionAt } from '@syncsound/audio-core';
import { roomActions, useRoomStore } from '@/store/roomStore';
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Panel,
  RangeField,
  Tabs,
  Toggle,
  fmtMs,
  fmtTime,
  inputClass,
  tabPanelProps,
  type IconName,
  type TabDef,
} from '../ui';
import { act, attempt, currentTrack, errMsg, roomNowMs, useCanControl } from './shared';

type Source = 'demo' | 'upload' | 'url' | 'spotify' | 'apple' | 'capture' | 'youtube' | 'video';
const SOURCES: TabDef<Source>[] = [
  { id: 'demo', label: 'Demo tracks' },
  { id: 'upload', label: 'Music file' },
  { id: 'video', label: 'Video file' },
  { id: 'url', label: 'Web link' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'capture', label: 'Browser tab' },
  { id: 'spotify', label: 'Spotify (sync only)' },
  { id: 'apple', label: 'Apple Music (sync only)' },
];
const KIND_ICON: Record<TrackKind, IconName> = {
  demo: 'sparkle',
  file: 'music',
  url: 'link',
  video: 'video',
  capture: 'capture',
  youtube: 'video',
  spotify: 'music',
  apple: 'music',
};

const control = (cmd: Parameters<typeof roomActions.control>[0]) => act(() => roomActions.control(cmd));

/** Left pane: queue + sources (Spotify's "Your Library"). */
export function Library() {
  const canControl = useCanControl();
  const [source, setSource] = useState<Source>('demo');
  const remote = useRoomStore((s) => s.remote);
  // streaming services this deployment isn't set up for simply don't appear
  const sources = SOURCES.filter((s) => (s.id !== 'spotify' && s.id !== 'apple') || remote[s.id] !== 'unconfigured');
  return (
    <Panel title="Library" icon="music" className="lg:h-full">
      {!canControl && (
        <p className="mb-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-300">
          <Icon name="lock" className="mr-1 inline size-4 align-[-3px]" /> Only the host can control playback
          in this room.
        </p>
      )}
      {/* the player bar has no room for these on phones */}
      <fieldset disabled={!canControl} className="mb-4 min-w-0 space-y-1 md:hidden">
        <legend className="sr-only">Room playback settings</legend>
        <MasterVolume />
        <HostOnlyToggle />
      </fieldset>

      <fieldset disabled={!canControl} className="min-w-0">
        <legend className="mb-2 text-xs font-medium tracking-widest text-ink-400 uppercase">Queue</legend>
        <Queue />
      </fieldset>

      <h3 className="mt-5 mb-1 text-xs font-medium tracking-widest text-ink-400 uppercase">Add audio</h3>
      <Tabs
        tabs={sources}
        value={source}
        onChange={setSource}
        label="Audio source"
        idPrefix="src"
        className="flex flex-wrap gap-1.5 py-1"
        tabClassName="!min-h-8 rounded-full border border-ink-700 !px-3 text-xs aria-selected:border-accent/60 aria-selected:bg-accent/10"
      />
      <div {...tabPanelProps('src', source)} className="min-w-0 pt-3">
        <fieldset disabled={!canControl} className="min-w-0">
          <legend className="sr-only">{SOURCES.find((s) => s.id === source)?.label} source</legend>
          {source === 'demo' && <DemoSource />}
          {source === 'upload' && <UploadSource />}
          {source === 'url' && <UrlSource />}
          {source === 'spotify' && <RemoteSource kind="spotify" />}
          {source === 'apple' && <RemoteSource kind="apple" />}
          {source === 'capture' && <CaptureSource />}
          {source === 'youtube' && <YouTubeSource />}
          {source === 'video' && <LocalVideoSource />}
        </fieldset>
      </div>
    </Panel>
  );
}

// ---------- player bar ----------

/** Bottom now-playing bar: track | transport + seek | room volume (Spotify layout). */
export function Player() {
  const canControl = useCanControl();
  const playback = useRoomStore((s) => s.room?.playback);
  const queue = useRoomStore((s) => s.room?.queue);
  const track = useRoomStore((s) => currentTrack(s.room));
  if (!playback || !queue) return null;
  const playing = playback.status === 'playing';

  const togglePlay = () => {
    if (playing) return control({ type: 'pause' });
    const trackId = playback.trackId ?? queue[0]?.id;
    control(trackId ? { type: 'play', trackId } : { type: 'play' });
  };

  return (
    <section
      aria-label="Player"
      className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-ink-700 bg-ink-900/95 px-3 pt-1.5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] md:pt-2"
    >
      <div className="flex min-w-0 items-center gap-3 md:row-span-2">
        <span className="hidden size-12 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent/30 to-ink-800 text-accent sm:grid">
          <Icon name={track ? KIND_ICON[track.kind] : 'music'} className="size-6" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{track?.title ?? 'Nothing playing'}</p>
          <p className="truncate text-xs text-ink-400">
            {track ? `${track.kind} · ${playback.status}` : 'Queue a track from the library'}
          </p>
          {track?.sourceClass === 'remote' && <Badge tone="warn">Sync-only mode (no spatial/EQ)</Badge>}
        </div>
      </div>

      <fieldset disabled={!canControl} className="flex items-center justify-center gap-2">
        <legend className="sr-only">Transport</legend>
        <IconButton
          icon="prev"
          label="Previous track"
          className="border-transparent"
          onClick={() => control({ type: 'previous' })}
        />
        <button
          type="button"
          data-testid="play-pause"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={togglePlay}
          disabled={!playing && queue.length === 0}
          className="inline-flex size-11 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_0_24px_-6px_var(--color-accent)] transition hover:brightness-110 disabled:opacity-40"
        >
          <Icon name={playing ? 'pause' : 'play'} className="size-5" />
        </button>
        <IconButton
          icon="next"
          label="Next track"
          className="border-transparent"
          onClick={() => control({ type: 'next' })}
        />
      </fieldset>

      <fieldset disabled={!canControl} className="col-span-2 -mt-1.5 min-w-0 md:col-span-1 md:col-start-2">
        <legend className="sr-only">Seek</legend>
        <Seek duration={track?.durationSec ?? 0} />
      </fieldset>

      <fieldset
        disabled={!canControl}
        className="hidden min-w-0 items-center justify-end gap-2 md:col-start-3 md:row-span-2 md:row-start-1 md:flex"
      >
        <legend className="sr-only">Room volume</legend>
        {!canControl && (
          <Icon
            name="lock"
            label="Only the host can control playback"
            className="size-4 shrink-0 text-ink-400"
          />
        )}
        <HostOnlyToggle compact />
        <MasterVolume compact />
      </fieldset>
    </section>
  );
}

export function MasterVolume({ compact }: { compact?: boolean }) {
  const volume = useRoomStore((s) => s.room?.volume ?? 1);
  return (
    <div className={compact ? 'flex w-40 min-w-0 items-center gap-2' : undefined}>
      {compact && <Icon name="volume" className="size-5 shrink-0 text-ink-400" />}
      <RangeField
        label="Master volume"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => control({ type: 'volume', volume: v })}
        compact={compact}
      />
    </div>
  );
}

export function HostOnlyToggle({ compact }: { compact?: boolean }) {
  const isHost = useRoomStore((s) => s.isHost);
  const hostOnly = useRoomStore((s) => !!s.room?.settings.hostOnlyControl);
  if (!isHost) return null;
  const set = (v: boolean) => act(() => roomActions.updateSettings({ hostOnlyControl: v }));
  return compact ? (
    <IconButton
      icon="lock"
      label="Only I can control: others can still adjust their own speaker"
      pressed={hostOnly}
      className={hostOnly ? '' : 'border-transparent'}
      onClick={() => set(!hostOnly)}
    />
  ) : (
    <Toggle
      label="Only I can control"
      description="Others can still adjust their own speaker"
      checked={hostOnly}
      onChange={set}
    />
  );
}

function Seek({ duration }: { duration: number }) {
  const playback = useRoomStore((s) => s.room?.playback);
  const clock = useRoomStore((s) => s.clock);
  const [pos, setPos] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);

  useEffect(() => {
    if (!playback) return;
    let raf = 0;
    const tick = () => {
      let p: number;
      try {
        p = positionAt(playback, roomNowMs(clock));
      } catch {
        // audio-core not ready: same formula, inline
        p =
          playback.status === 'playing'
            ? playback.trackOffset + (roomNowMs(clock) - playback.startRoomTime) / 1000
            : playback.trackOffset;
      }
      setPos(Math.max(0, duration > 0 ? Math.min(p, duration) : p));
      if (playback.status === 'playing') raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [playback, clock, duration]);

  const v = drag ?? pos;
  const commit = () => {
    if (drag === null) return;
    control({ type: 'seek', position: Math.max(0, drag) });
    setDrag(null);
  };
  return (
    <div className="flex items-center gap-3">
      <span className="w-11 text-right font-mono text-xs text-ink-400 tabular">{fmtTime(v)}</span>
      <input
        type="range"
        data-testid="seek-bar"
        aria-label="Seek"
        aria-valuetext={`${fmtTime(v)} of ${fmtTime(duration)}`}
        className="min-w-0 flex-1"
        min={0}
        max={Math.max(duration, 0.1)}
        step={0.1}
        value={Math.min(v, Math.max(duration, 0.1))}
        disabled={duration <= 0}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-11 font-mono text-xs text-ink-400 tabular">{fmtTime(duration)}</span>
    </div>
  );
}

// ---------- queue ----------

function Queue() {
  const queue = useRoomStore((s) => s.room?.queue);
  const currentId = useRoomStore((s) => s.room?.playback.trackId ?? null);
  if (!queue?.length)
    return (
      <p className="rounded-xl border border-dashed border-ink-700 p-4 text-center text-sm text-ink-400">
        The queue is empty.
      </p>
    );
  return (
    <ol className="space-y-1.5">
      {queue.map((t: Track, i) => {
        const current = t.id === currentId;
        return (
          <li
            key={t.id}
            data-testid="queue-item"
            aria-current={current ? 'true' : undefined}
            className={`flex items-center gap-2 rounded-xl border px-2 py-1 ${current ? 'border-accent/60 bg-accent/10' : 'border-ink-700 bg-ink-850/50'}`}
          >
            <span className="w-5 text-center font-mono text-xs text-ink-500">{i + 1}</span>
            <Icon
              name={KIND_ICON[t.kind]}
              className={`size-4 shrink-0 ${current ? 'text-accent' : 'text-ink-400'}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{t.title}</span>
              <span className="block text-xs text-ink-500">
                {t.kind}
                {t.durationSec ? ` · ${fmtTime(t.durationSec)}` : ''}
                {t.sourceClass === 'remote' ? ' · sync-only' : ''}
              </span>
            </span>
            <IconButton
              icon="play"
              label={`Play ${t.title}`}
              onClick={() => control({ type: 'play', trackId: t.id })}
              className="border-transparent"
            />
            <IconButton
              icon="trash"
              label={`Remove ${t.title}`}
              onClick={() => control({ type: 'remove', trackId: t.id })}
              className="border-transparent"
            />
          </li>
        );
      })}
    </ol>
  );
}

// ---------- sources ----------

function DemoSource() {
  const assets = useRoomStore((s) => s.demoAssets);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => attempt(() => roomActions.loadDemoAssets(), setErr), []);
  return (
    <div>
      {err && (
        <p role="alert" className="mb-2 text-sm text-bad">
          Couldn&rsquo;t load demo tracks: {err}
        </p>
      )}
      {assets.length === 0 && !err && (
        <p className="text-sm text-ink-400">
          Loading demo tracks… (run <code className="font-mono">pnpm demo</code> if none appear)
        </p>
      )}
      <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
        {assets.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              data-testid="demo-asset"
              onClick={() => act(() => roomActions.queueDemo(a))}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850/60 px-3 text-left transition hover:border-accent/60 disabled:opacity-50"
            >
              <Icon name="plus" className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.title}</span>
                <span className="block text-xs text-ink-400">
                  {a.channels === 6
                    ? '5.1'
                    : a.channels === 2
                      ? 'stereo'
                      : a.channels === 1
                        ? 'mono'
                        : `${a.channels} ch`}{' '}
                  · {fmtTime(a.durationSec)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Job =
  | { state: 'idle' }
  | { state: 'busy'; name: string }
  | { state: 'done'; msg: string }
  | { state: 'error'; msg: string };

function JobStatus({ job }: { job: Job }) {
  if (job.state === 'busy')
    return (
      <div role="status" className="mt-3">
        <p className="text-sm text-ink-300">Uploading {job.name}…</p>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-700">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        </div>
      </div>
    );
  if (job.state === 'done')
    return (
      <p role="status" className="mt-3 text-sm text-ok">
        {job.msg}
      </p>
    );
  if (job.state === 'error')
    return (
      <p role="alert" className="mt-3 text-sm text-bad">
        {job.msg}
      </p>
    );
  return null;
}

function useUpload() {
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const upload = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES)
      return setJob({ state: 'error', msg: `That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    setJob({ state: 'busy', name: file.name });
    let p: Promise<Track>;
    try {
      p = roomActions.uploadFile(file);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((t) => setJob({ state: 'done', msg: `Queued “${t.title}”.` })).catch((e: unknown) =>
      setJob({ state: 'error', msg: errMsg(e) }),
    );
  };
  return { job, upload };
}

function FilePick({ accept, label, onFile }: { accept: string; label: string; onFile: (f: File) => void }) {
  return (
    <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-600 bg-ink-850/40 p-4 text-center text-sm text-ink-300 transition hover:border-accent/60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
      <Icon name="upload" className="size-6 text-accent" />
      {label}
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function UploadSource() {
  const { job, upload } = useUpload();
  return (
    <div>
      <FilePick
        accept="audio/*,video/*"
        label="Choose an audio or video file (it's uploaded to the room server and decoded on every device)"
        onFile={upload}
      />
      <JobStatus job={job} />
    </div>
  );
}

function UrlSource() {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [job, setJob] = useState<Job>({ state: 'idle' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(url).protocol);
    } catch {
      /* invalid */
    }
    if (!ok) return setJob({ state: 'error', msg: 'Enter a full http(s) link to an audio file.' });
    setJob({ state: 'busy', name: url });
    let p: Promise<Track>;
    try {
      p = roomActions.queueUrl(url, title.trim() || undefined);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then((t) => {
      setJob({ state: 'done', msg: `Queued “${t.title}”.` });
      setUrl('');
      setTitle('');
    }).catch((err: unknown) => setJob({ state: 'error', msg: errMsg(err) }));
  };
  return (
    <form onSubmit={submit} className="grid gap-2" noValidate>
      <label htmlFor="src-url" className="text-sm text-ink-200">
        Audio URL
      </label>
      <input
        id="src-url"
        type="url"
        inputMode="url"
        placeholder="https://example.com/track.mp3"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className={inputClass}
      />
      <label htmlFor="src-url-title" className="text-sm text-ink-200">
        Title (optional)
      </label>
      <input
        id="src-url-title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        className={inputClass}
      />
      <Button type="submit" variant="primary" className="mt-1">
        Queue URL
      </Button>
      <p className="text-xs text-ink-400">
        Only use audio you own or have the rights to play. The server must allow cross-origin access (CORS).
      </p>
      <JobStatus job={job} />
    </form>
  );
}

const REMOTE = {
  spotify: {
    name: 'Spotify',
    env: 'NEXT_PUBLIC_SPOTIFY_CLIENT_ID',
    req: 'Every device needs its own Spotify Premium account signed in (Web Playback SDK requirement).',
    placeholder: 'spotify:track:… or open.spotify.com link',
  },
  apple: {
    name: 'Apple Music',
    env: 'NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN',
    req: 'Every device needs an active Apple Music subscription signed in to MusicKit.',
    placeholder: 'Catalog song ID or music.apple.com link',
  },
} as const;

function normalizeRemote(kind: 'spotify' | 'apple', raw: string): string | null {
  const s = raw.trim();
  if (kind === 'spotify') {
    const m = /(?:spotify:track:|open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/)([A-Za-z0-9]{22})/.exec(s);
    if (m) return `spotify:track:${m[1]}`;
    return /^[A-Za-z0-9]{22}$/.test(s) ? `spotify:track:${s}` : null;
  }
  const m = /[?&]i=(\d+)/.exec(s) ?? /\/song\/[^/]*\/(\d+)/.exec(s);
  if (m?.[1]) return m[1];
  return /^\d{5,}$/.test(s) ? s : null;
}

function RemoteSource({ kind }: { kind: 'spotify' | 'apple' }) {
  const status = useRoomStore((s) => s.remote[kind]);
  const message = useRoomStore((s) => s.remote.message);
  const remote = useRoomStore((s) => s.remote);
  const devices = useRoomStore((s) => s.room?.devices);
  const [id, setId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const meta = REMOTE[kind];

  // the engine reports 'unconfigured' when neither credentials nor the mock adapter (?mockRemote=1) are available
  if (status === 'unconfigured') {
    return (
      <div className="rounded-xl border border-ink-600 bg-ink-850 p-4 text-sm">
        <p className="font-medium text-ink-100">Not configured</p>
        <p className="mt-1 text-ink-300">
          Set <code className="font-mono text-accent">{meta.env}</code> in{' '}
          <code className="font-mono">apps/web/.env.local</code> and restart the dev server
          {kind === 'spotify' ? (
            <>
              {' '}
              (and add <code className="font-mono">/spotify-callback</code> as a redirect URI in the Spotify
              dashboard)
            </>
          ) : null}
          .
        </p>
        <p className="mt-2 text-ink-400">{meta.req}</p>
      </div>
    );
  }

  const connect = () => {
    try {
      sessionStorage.setItem('syncsound:returnTo', window.location.pathname);
    } catch {
      /* storage blocked */
    }
    act(() => (kind === 'spotify' ? roomActions.connectSpotify() : roomActions.connectApple()));
  };
  const queue = (e: FormEvent) => {
    e.preventDefault();
    const norm = normalizeRemote(kind, id);
    if (!norm) return setErr(`That doesn't look like a ${meta.name} track.`);
    setErr(null);
    act(() => roomActions.queueRemote(kind, norm));
    setId('');
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">Sync-only mode (no spatial/EQ)</Badge>
        <Badge tone={status === 'ready' ? 'ok' : status === 'signed-out' ? 'neutral' : 'bad'}>
          this device: {status}
        </Badge>
      </div>
      <p className="text-ink-300">
        {meta.name} audio is DRM-protected, so it plays through the official player on each device. SyncSound
        keeps the players in time, but can&rsquo;t pan or EQ them. {meta.req}
      </p>
      {status !== 'ready' && (
        <Button variant="primary" onClick={connect}>
          Connect {meta.name}
        </Button>
      )}
      {status === 'needs-premium' && (
        <p className="text-warn">
          This account can&rsquo;t use the web player. A Premium / paid subscription is required.
        </p>
      )}
      {message && <p className="text-ink-400">{message}</p>}
      {remote.meanAbsErrorMs !== null && (
        <p
          data-testid="remote-sync-stats"
          className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2 text-ink-300"
        >
          Measured sync on this device:{' '}
          <span className="font-mono text-ink-100">{remote.errorMs ?? '—'} ms</span> now,{' '}
          <span className="font-mono text-ink-100">{remote.meanAbsErrorMs} ms</span> mean |error|,{' '}
          {remote.seeks} corrective seek
          {remote.seeks === 1 ? '' : 's'}. Sync-only sources typically land within 20–150 ms (rendered
          sources: under 10 ms).
        </p>
      )}
      <form onSubmit={queue} className="flex gap-2" noValidate>
        <label htmlFor={`remote-${kind}`} className="sr-only">
          {meta.name} track
        </label>
        <input
          id={`remote-${kind}`}
          placeholder={meta.placeholder}
          value={id}
          onChange={(e) => setId(e.target.value)}
          className={inputClass}
        />
        <Button type="submit">Queue</Button>
      </form>
      {err && (
        <p role="alert" className="text-bad">
          {err}
        </p>
      )}
      {devices && (
        <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="truncate">{d.name}</span>
              <span className="flex items-center gap-2">
                {d.stats?.remoteErrorMs != null && (
                  <span className="font-mono text-xs text-ink-300 tabular">
                    {Math.round(d.stats.remoteErrorMs)} ms
                  </span>
                )}
                <Badge tone={d.remote[kind] === 'ready' ? 'ok' : 'neutral'}>{d.remote[kind]}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Start/stop, status, DRM warning, buffer sliders: shared by the Browser-tab and YouTube panels. */
function CaptureControls() {
  const capture = useRoomStore((s) => s.capture);
  const settings = useRoomStore((s) => s.room?.settings);
  const captureHost = useRoomStore(
    (s) => s.room?.devices.find((d) => d.id === s.room?.captureHostId)?.name ?? null,
  );
  const raiseTo =
    settings && capture.shortfallMs !== null ? Math.ceil((settings.videoBufferMs + capture.shortfallMs) / 10) * 10 : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {capture.active ? (
          <Button variant="danger" onClick={() => act(() => roomActions.stopCapture())}>
            Stop capture
          </Button>
        ) : (
          <Button variant="primary" onClick={() => act(() => roomActions.startCapture())}>
            <Icon name="capture" className="size-4" /> Start capture
          </Button>
        )}
        {capture.active && (
          <Badge tone="ok">
            capturing · {capture.peers} peer{capture.peers === 1 ? '' : 's'}
          </Badge>
        )}
        {capture.receiving && (
          <Badge tone="accent">
            receiving from {captureHost ?? 'host'} · {fmtMs(capture.pipelineDelayMs, 0)}
          </Badge>
        )}
      </div>
      {capture.active && capture.hostPlayback && (
        <p className="text-ink-300" data-testid="host-playback" data-mode={capture.hostPlayback}>
          {capture.hostPlayback === 'monitor' && 'This speaker plays the same delayed copy, in time with the others.'}
          {capture.hostPlayback === 'original' &&
            'This device plays the original; the other speakers follow it by the stream buffer. Share the tab itself for tight sync.'}
          {capture.hostPlayback === 'none' && 'This device stays silent while sharing; the other speakers play the sound.'}
        </p>
      )}
      {capture.silent && (
        <div role="alert" className="rounded-xl border border-warn/60 bg-warn/10 p-3">
          <p className="flex items-center gap-2 font-semibold text-warn">
            <Icon name="warning" className="size-5" /> This tab is silent.
          </p>
          <p className="mt-1 text-ink-200">
            DRM-protected sites (Netflix, Disney+, Prime Video…) block audio capture and deliver silence. Use{' '}
            <strong>Local video</strong> or a non-DRM source instead.
          </p>
        </div>
      )}
      {capture.error && (
        <p role="alert" className="text-bad">
          {capture.error}
        </p>
      )}
      {capture.receiving && raiseTo !== null && (
        <p role="status" className="rounded-xl border border-warn/60 bg-warn/10 p-3 text-ink-200">
          This speaker plays {capture.shortfallMs} ms late: its output latency doesn&rsquo;t fit the stream buffer. Raise{' '}
          <strong>Stream buffer</strong> to at least {raiseTo} ms.
        </p>
      )}
      {settings && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <RangeField
            label="Stream buffer"
            min={40}
            max={1000}
            step={10}
            value={settings.videoBufferMs}
            format={(v) => `${v} ms`}
            hint="Higher = more robust on busy Wi-Fi, more lip-sync delay"
            onCommit={(v) => act(() => roomActions.updateSettings({ videoBufferMs: v }))}
          />
          <RangeField
            label="Lip-sync nudge"
            min={-300}
            max={300}
            step={5}
            value={settings.lipSyncNudgeMs}
            format={(v) => `${v > 0 ? '+' : ''}${v} ms`}
            hint="+ delays audio relative to picture"
            onCommit={(v) => act(() => roomActions.updateSettings({ lipSyncNudgeMs: v }))}
          />
        </div>
      )}
    </>
  );
}

function CaptureSource() {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-300">
        <strong className="text-ink-100">Share a browser tab.</strong> Play a video or music in another tab, start
        capture and pick that tab with &ldquo;share tab audio&rdquo; on. Its sound streams to every speaker over
        WebRTC with a fixed buffer so they all play together, this one included. Sharing a window or the whole screen
        works too, but then this device plays the original and the other speakers follow it by the buffer.
      </p>
      <CaptureControls />
    </div>
  );
}

// ----- YouTube: plays in its own tab (official player) and is shared like any tab; streams are never downloaded -----

const youtubeId = (s: string) =>
  /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/.exec(s)?.[1] ??
  (/^[A-Za-z0-9_-]{11}$/.test(s.trim()) ? s.trim() : null);

function YouTubeSource() {
  const [input, setInput] = useState('');
  const id = youtubeId(input);
  const href = id ? `https://www.youtube.com/watch?v=${id}` : null;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-300">
        <strong className="text-ink-100">Two steps.</strong> Open the video in its own tab and start it there, then
        come back and share that tab (keep &ldquo;share tab audio&rdquo; on). The sound plays on every speaker, this
        one included; the picture stays in the YouTube tab.
      </p>
      <div className="flex gap-2">
        <label htmlFor="yt-url" className="sr-only">
          YouTube link
        </label>
        <input
          id="yt-url"
          inputMode="url"
          placeholder="https://youtube.com/watch?v=…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className={inputClass}
        />
        <a
          data-testid="youtube-open"
          href={href ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={href === null}
          className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-ink-600 px-4 text-sm whitespace-nowrap text-ink-100 transition hover:border-ink-400 hover:bg-ink-800 ${href === null ? 'pointer-events-none opacity-45' : ''}`}
        >
          Open on YouTube <Icon name="link" className="size-4" />
        </a>
      </div>
      {input.trim() !== '' && !id && (
        <p role="alert" className="text-bad">
          Paste a YouTube video link.
        </p>
      )}
      <CaptureControls />
      <p className="text-xs text-ink-400">
        YouTube plays in its own official player. Streams are never downloaded or re-hosted.
      </p>
    </div>
  );
}

// ----- Local video (Mode 2: audio is decoded + scheduled, <video> follows the room clock) -----

function LocalVideoSource() {
  const track = useRoomStore((s) => currentTrack(s.room));
  const { job, upload } = useUpload();
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const attach = useCallback(
    (el: HTMLVideoElement | null) =>
      attempt(
        () => roomActions.attachVideo(el),
        () => {},
      ),
    [],
  );
  const src = localUrl ?? (track?.kind === 'video' ? track.url : undefined);
  useEffect(
    () => () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    },
    [localUrl],
  );

  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-300">
        <strong className="text-ink-100">Mode 2: local video.</strong> The file&rsquo;s audio is uploaded and
        played in sync on every speaker. This screen shows the muted picture, locked to the room clock.
      </p>
      <FilePick
        accept="video/*"
        label="Choose a video file"
        onFile={(f) => {
          setLocalUrl(URL.createObjectURL(f));
          upload(f);
        }}
      />
      <JobStatus job={job} />
      <video
        ref={attach}
        src={src}
        muted
        playsInline
        preload="auto"
        className={`aspect-video w-full rounded-xl bg-black ${src ? '' : 'hidden'}`}
        aria-label="Video picture (audio plays through the speakers)"
      />
    </div>
  );
}
