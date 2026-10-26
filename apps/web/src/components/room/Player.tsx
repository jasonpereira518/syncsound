'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MAX_UPLOAD_BYTES, type Track, type TrackKind } from '@syncsound/protocol';
import { positionAt } from '@syncsound/audio-core';
import { roomActions, useRoomStore } from '@/store/roomStore';
import {
  Badge,
  Button,
  Disclosure,
  Icon,
  IconButton,
  Panel,
  RangeField,
  Sheet,
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
  { id: 'demo', label: 'Demo tracks', icon: 'wave' },
  { id: 'upload', label: 'Music file', icon: 'music' },
  { id: 'video', label: 'Video file', icon: 'video' },
  { id: 'url', label: 'Web link', icon: 'link' },
  { id: 'youtube', label: 'YouTube', icon: 'play' },
  { id: 'capture', label: 'Browser tab', icon: 'capture' },
  { id: 'spotify', label: 'Spotify', icon: 'music' },
  { id: 'apple', label: 'Apple Music', icon: 'music' },
];
const KIND_ICON: Record<TrackKind, IconName> = {
  demo: 'wave',
  file: 'music',
  url: 'link',
  video: 'video',
  capture: 'capture',
  youtube: 'video',
  spotify: 'music',
  apple: 'music',
};
const KIND_LABEL: Record<TrackKind, string> = {
  demo: 'Demo',
  file: 'File',
  url: 'Web link',
  video: 'Video',
  capture: 'Browser tab',
  youtube: 'YouTube',
  spotify: 'Spotify',
  apple: 'Apple Music',
};
const SYNC_ONLY = 'Sync-only mode (no spatial/EQ)';

const control = (cmd: Parameters<typeof roomActions.control>[0]) => act(() => roomActions.control(cmd));

/** Left pane: what's showing now (video, tab share, sync-only stats), the queue, and an Add sheet for sources. */
export function Library() {
  const canControl = useCanControl();
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<Source>('demo');
  const [youtube, setYoutube] = useState<string | null>(null);
  const [localVideo, setLocalVideo] = useState<{ trackId: string; url: string } | null>(null);
  const remote = useRoomStore((s) => s.remote);
  // the last track this device queued: adding one closes the sheet so the queue and player bar are in view
  const lastMine = useRoomStore((s) => s.room?.queue.findLast((t) => t.addedBy === s.deviceId)?.id ?? null);
  const seenMine = useRef(lastMine);
  useEffect(() => {
    if (lastMine !== seenMine.current) setAdding(false);
    seenMine.current = lastMine;
  }, [lastMine]);
  // a replaced (or unmounted) local preview frees its blob URL
  useEffect(
    () => () => {
      if (localVideo) URL.revokeObjectURL(localVideo.url);
    },
    [localVideo],
  );
  // streaming services this deployment isn't set up for simply don't appear
  const sources = SOURCES.filter((s) => (s.id !== 'spotify' && s.id !== 'apple') || remote[s.id] !== 'unconfigured');
  const open = () => setAdding(true);

  return (
    <Panel
      title="Library"
      className="lg:h-full"
      actions={
        <Button variant="ghost" data-testid="add-audio" disabled={!canControl} onClick={open} className="!px-3">
          <Icon name="plus" className="size-4" /> Add
        </Button>
      }
    >
      {!canControl && (
        <p className="mb-2 flex items-center gap-2 text-sm text-ink-400">
          <Icon name="lock" className="size-4" /> The host controls playback.
        </p>
      )}
      {/* the player bar has no room for these on phones */}
      <fieldset disabled={!canControl} className="mb-3 min-w-0 space-y-1 md:hidden">
        <legend className="sr-only">Room playback settings</legend>
        <MasterVolume />
        <HostOnlyToggle />
      </fieldset>

      <LiveSource youtube={youtube} onCloseYoutube={() => setYoutube(null)} localVideo={localVideo} />

      <fieldset disabled={!canControl} className="min-w-0">
        <legend className="sr-only">Queue</legend>
        <Queue onAdd={canControl ? open : undefined} />
      </fieldset>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add audio" testid="add-sheet">
        <Tabs
          tabs={sources}
          value={source}
          onChange={setSource}
          label="Audio source"
          idPrefix="src"
          className="grid grid-cols-4 gap-1.5"
          tabClassName="!min-h-16 flex-col !gap-1 rounded-lg !px-1 text-center text-xs !whitespace-normal hover:bg-ink-850 aria-selected:bg-ink-800 aria-selected:text-ink-100"
        />
        <div {...tabPanelProps('src', source)} className="min-w-0 pt-4">
          <fieldset disabled={!canControl} className="min-w-0">
            <legend className="sr-only">{SOURCES.find((s) => s.id === source)?.label} source</legend>
            {source === 'demo' && <DemoSource />}
            {source === 'upload' && <UploadSource />}
            {source === 'url' && <UrlSource />}
            {source === 'spotify' && <RemoteSource kind="spotify" />}
            {source === 'apple' && <RemoteSource kind="apple" />}
            {source === 'capture' && <CaptureSource />}
            {source === 'youtube' && (
              <YouTubeSource
                onPlay={(id) => {
                  setYoutube(id);
                  setAdding(false);
                }}
              />
            )}
            {source === 'video' && (
              <LocalVideoSource onLocal={(trackId, url) => setLocalVideo({ trackId, url })} />
            )}
          </fieldset>
        </div>
      </Sheet>
    </Panel>
  );
}

// ---------- what's showing now ----------

/** Pictures and live-source status live outside the Add sheet, so closing it never stops them. */
function LiveSource({
  youtube,
  onCloseYoutube,
  localVideo,
}: {
  youtube: string | null;
  onCloseYoutube: () => void;
  localVideo: { trackId: string; url: string } | null;
}) {
  const track = useRoomStore((s) => currentTrack(s.room));
  const videoSrc = track?.kind === 'video' ? (localVideo?.trackId === track.id ? localVideo.url : track.url) : undefined;
  return (
    <>
      {youtube && <YouTubePicture videoId={youtube} onClose={onCloseYoutube} />}
      {videoSrc && <VideoPicture src={videoSrc} />}
      <CaptureStatus />
      {track?.sourceClass === 'remote' && <RemoteSyncStats />}
    </>
  );
}

/** Mode 2 (local video): audio is decoded + scheduled like music; this muted picture follows the room clock. */
function VideoPicture({ src }: { src: string }) {
  const attach = useCallback(
    (el: HTMLVideoElement | null) =>
      attempt(
        () => roomActions.attachVideo(el),
        () => {},
      ),
    [],
  );
  return (
    <video
      ref={attach}
      src={src}
      muted
      playsInline
      preload="auto"
      className="mb-3 aspect-video w-full rounded-lg bg-black"
      aria-label="Video picture (audio plays through the speakers)"
    />
  );
}

function CaptureStatus() {
  const capture = useRoomStore((s) => s.capture);
  const captureHost = useRoomStore((s) => s.room?.devices.find((d) => d.id === s.room?.captureHostId)?.name ?? null);
  if (!capture.active && !capture.receiving && !capture.silent && !capture.error) return null;
  return (
    <div className="mb-3 space-y-2 text-sm">
      {capture.active && (
        <p className="flex items-center gap-2">
          <Icon name="capture" className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            Sharing tab audio · {capture.peers} speaker{capture.peers === 1 ? '' : 's'}
          </span>
          <Button variant="ghost" className="!min-h-9" onClick={() => act(() => roomActions.stopCapture())}>
            Stop
          </Button>
        </p>
      )}
      {capture.receiving && (
        <p className="flex items-center gap-2 text-ink-300">
          <Icon name="capture" className="size-4 shrink-0 text-ink-400" />
          Playing {captureHost ?? 'the host'}&rsquo;s tab · {fmtMs(capture.pipelineDelayMs, 0)} buffer
        </p>
      )}
      {capture.silent && (
        <div role="alert" className="border-l-2 border-warn pl-3">
          <p className="font-medium text-warn">This tab is silent.</p>
          <p className="text-ink-300">
            DRM-protected sites (Netflix, Disney+, Prime Video…) block audio capture. Use a video file or a non-DRM site instead.
          </p>
        </div>
      )}
      {capture.error && (
        <p role="alert" className="text-bad">
          {capture.error}
        </p>
      )}
    </div>
  );
}

function RemoteSyncStats() {
  const remote = useRoomStore((s) => s.remote);
  if (remote.meanAbsErrorMs === null) return null;
  return (
    <p data-testid="remote-sync-stats" className="mb-3 text-xs text-ink-400">
      Measured sync: <span className="font-mono text-ink-200 tabular">{remote.errorMs ?? '—'} ms</span> now,{' '}
      <span className="font-mono text-ink-200 tabular">{remote.meanAbsErrorMs} ms</span> mean |error|, {remote.seeks} seek
      {remote.seeks === 1 ? '' : 's'}
    </p>
  );
}

// ---------- player bar ----------

/** Bottom now-playing bar: track | transport + seek | room volume. */
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
      className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-ink-800 bg-ink-950 px-4 pt-1.5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] md:pt-2"
    >
      <div className="flex min-w-0 items-center gap-3 md:row-span-2">
        <span className="hidden size-10 shrink-0 place-items-center rounded-md bg-ink-850 text-ink-400 sm:grid">
          <Icon name={track ? KIND_ICON[track.kind] : 'music'} className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{track?.title ?? 'Nothing playing'}</p>
          {track?.sourceClass === 'remote' ? (
            <Badge tone="warn">{SYNC_ONLY}</Badge>
          ) : (
            <p className="truncate text-xs text-ink-400">{track ? (playing ? KIND_LABEL[track.kind] : 'Paused') : 'Add something to the queue'}</p>
          )}
        </div>
      </div>

      <fieldset disabled={!canControl} className="flex items-center justify-center gap-1">
        <legend className="sr-only">Transport</legend>
        <IconButton icon="prev" label="Previous track" onClick={() => control({ type: 'previous' })} />
        <button
          type="button"
          data-testid="play-pause"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={togglePlay}
          disabled={!playing && queue.length === 0}
          className="inline-flex size-11 items-center justify-center rounded-full bg-accent text-accent-ink transition hover:brightness-110 disabled:opacity-40"
        >
          <Icon name={playing ? 'pause' : 'play'} className="size-5" />
        </button>
        <IconButton icon="next" label="Next track" onClick={() => control({ type: 'next' })} />
      </fieldset>

      <fieldset disabled={!canControl} className="col-span-2 -mt-1.5 min-w-0 md:col-span-1 md:col-start-2">
        <legend className="sr-only">Seek</legend>
        <Seek duration={track?.durationSec ?? 0} />
      </fieldset>

      <fieldset
        disabled={!canControl}
        className="hidden min-w-0 items-center justify-end gap-1 md:col-start-3 md:row-span-2 md:row-start-1 md:flex"
      >
        <legend className="sr-only">Room volume</legend>
        {!canControl && <Icon name="lock" label="Only the host can control playback" className="size-4 shrink-0 text-ink-400" />}
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
      onClick={() => set(!hostOnly)}
    />
  ) : (
    <Toggle label="Only I can control" checked={hostOnly} onChange={set} />
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

// on devices with a mouse, row actions appear on hover/focus; touch screens always show them
const ROW_ACTION = '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 group-focus-within:opacity-100';

function Queue({ onAdd }: { onAdd?: () => void }) {
  const queue = useRoomStore((s) => s.room?.queue);
  const currentId = useRoomStore((s) => s.room?.playback.trackId ?? null);
  if (!queue?.length)
    return (
      <div className="py-10 text-center text-sm text-ink-400">
        <p>Nothing queued yet.</p>
        {onAdd && (
          <Button variant="primary" className="mt-3" onClick={onAdd}>
            <Icon name="plus" className="size-4" /> Add audio
          </Button>
        )}
      </div>
    );
  return (
    <ol className="-mx-1">
      {queue.map((t: Track, i) => {
        const current = t.id === currentId;
        return (
          <li
            key={t.id}
            data-testid="queue-item"
            aria-current={current ? 'true' : undefined}
            className="group flex items-center gap-2 rounded-lg py-0.5 pl-2 hover:bg-ink-900"
          >
            <span className="w-5 shrink-0 text-center font-mono text-xs text-ink-500">
              {current ? <Icon name="play" className="mx-auto size-3 text-accent" label="Current track" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1 py-1">
              <span className={`block truncate text-sm ${current ? 'text-accent' : ''}`}>{t.title}</span>
              <span className="block truncate text-xs text-ink-500">
                {t.sourceClass === 'remote' ? SYNC_ONLY : t.durationSec ? fmtTime(t.durationSec) : KIND_LABEL[t.kind]}
              </span>
            </span>
            <IconButton icon="play" label={`Play ${t.title}`} className={ROW_ACTION} onClick={() => control({ type: 'play', trackId: t.id })} />
            <IconButton icon="trash" label={`Remove ${t.title}`} className={ROW_ACTION} onClick={() => control({ type: 'remove', trackId: t.id })} />
          </li>
        );
      })}
    </ol>
  );
}

// ---------- sources ----------

/** one short line under a source's controls */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-ink-400">{children}</p>;
}

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
        <Note>
          Loading demo tracks… (run <code className="font-mono">pnpm demo</code> if none appear)
        </Note>
      )}
      <ul className="-mx-1">
        {assets.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              data-testid="demo-asset"
              onClick={() => act(() => roomActions.queueDemo(a))}
              className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left transition hover:bg-ink-800 disabled:opacity-50"
            >
              <Icon name="plus" className="size-4 shrink-0 text-ink-400" />
              <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
              <span className="shrink-0 text-xs text-ink-500 tabular">
                {a.channels === 6 ? '5.1' : a.channels === 2 ? 'stereo' : a.channels === 1 ? 'mono' : `${a.channels} ch`} · {fmtTime(a.durationSec)}
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
        <p className="truncate text-sm text-ink-300">Uploading {job.name}…</p>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-800">
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
  const upload = (file: File, onDone?: (t: Track) => void) => {
    if (file.size > MAX_UPLOAD_BYTES)
      return setJob({ state: 'error', msg: `That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    setJob({ state: 'busy', name: file.name });
    let p: Promise<Track>;
    try {
      p = roomActions.uploadFile(file);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((t) => {
      setJob({ state: 'done', msg: `Queued “${t.title}”.` });
      onDone?.(t);
    }).catch((e: unknown) => setJob({ state: 'error', msg: errMsg(e) }));
  };
  return { job, upload };
}

function FilePick({ accept, label, onFile }: { accept: string; label: string; onFile: (f: File) => void }) {
  return (
    <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-700 p-4 text-center text-sm text-ink-300 transition hover:border-ink-500 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
      <Icon name="upload" className="size-5 text-ink-400" />
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
    <div className="space-y-2">
      <FilePick accept="audio/*,video/*" label="Choose an audio or video file" onFile={(f) => upload(f)} />
      <Note>Uploaded once, then decoded on every speaker.</Note>
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
      <label htmlFor="src-url" className="sr-only">
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
      <label htmlFor="src-url-title" className="sr-only">
        Title (optional)
      </label>
      <input
        id="src-url-title"
        placeholder="Title (optional)"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        className={inputClass}
      />
      <Button type="submit" variant="primary">
        Add to queue
      </Button>
      <Note>Only audio you have rights to. The host must allow cross-origin access (CORS).</Note>
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
  const devices = useRoomStore((s) => s.room?.devices);
  const [id, setId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const meta = REMOTE[kind];

  // the engine reports 'unconfigured' when neither credentials nor the mock adapter (?mockRemote=1) are available
  if (status === 'unconfigured') {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium text-ink-100">Not configured</p>
        <p className="text-ink-300">
          Set <code className="font-mono text-accent">{meta.env}</code> in <code className="font-mono">apps/web/.env.local</code> and restart the
          dev server
          {kind === 'spotify' ? (
            <>
              {' '}
              (and add <code className="font-mono">/spotify-callback</code> as a redirect URI in the Spotify dashboard)
            </>
          ) : null}
          .
        </p>
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
        <Badge tone="warn">{SYNC_ONLY}</Badge>
        <span className="text-xs text-ink-400">This device: {status}</span>
      </div>
      <Note>Plays through each device&rsquo;s own {meta.name} player, kept in time.</Note>
      {status !== 'ready' && (
        <Button variant="primary" onClick={connect}>
          Connect {meta.name}
        </Button>
      )}
      {status === 'needs-premium' && <p className="text-warn">This account can&rsquo;t use the web player. A paid subscription is required.</p>}
      {message && <p className="text-ink-400">{message}</p>}
      <form onSubmit={queue} className="flex gap-2" noValidate>
        <label htmlFor={`remote-${kind}`} className="sr-only">
          {meta.name} track
        </label>
        <input id={`remote-${kind}`} placeholder={meta.placeholder} value={id} onChange={(e) => setId(e.target.value)} className={inputClass} />
        <Button type="submit">Queue</Button>
      </form>
      {err && (
        <p role="alert" className="text-bad">
          {err}
        </p>
      )}
      <Disclosure summary="Requirements and devices">
        <p className="text-ink-300">
          {meta.name} audio is DRM-protected, so SyncSound can&rsquo;t pan or EQ it. {meta.req}
        </p>
        {devices && (
          <ul className="mt-2 divide-y divide-ink-800">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                <span className="truncate">{d.name}</span>
                <span className="flex items-center gap-2">
                  {d.stats?.remoteErrorMs != null && (
                    <span className="font-mono text-xs text-ink-300 tabular">{Math.round(d.stats.remoteErrorMs)} ms</span>
                  )}
                  <Badge tone={d.remote[kind] === 'ready' ? 'ok' : 'neutral'}>{d.remote[kind]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
    </div>
  );
}

function CaptureSource() {
  const capture = useRoomStore((s) => s.capture);
  const settings = useRoomStore((s) => s.room?.settings);
  return (
    <div className="space-y-3 text-sm">
      <Note>Play something in another tab, then share that tab with &ldquo;share audio&rdquo; ticked.</Note>
      {capture.active ? (
        <Button variant="danger" onClick={() => act(() => roomActions.stopCapture())}>
          Stop capture
        </Button>
      ) : (
        <Button variant="primary" onClick={() => act(() => roomActions.startCapture())}>
          <Icon name="capture" className="size-4" /> Start capture
        </Button>
      )}
      {settings && (
        <Disclosure summary="Buffer and lip-sync">
          <div className="grid gap-3 pb-1">
            <RangeField
              label="Stream buffer"
              min={40}
              max={1000}
              step={10}
              value={settings.videoBufferMs}
              format={(v) => `${v} ms`}
              hint="Higher is steadier on busy Wi-Fi, with more lip-sync delay."
              onCommit={(v) => act(() => roomActions.updateSettings({ videoBufferMs: v }))}
            />
            <RangeField
              label="Lip-sync nudge"
              min={-300}
              max={300}
              step={5}
              value={settings.lipSyncNudgeMs}
              format={(v) => `${v > 0 ? '+' : ''}${v} ms`}
              hint="+ delays audio relative to picture."
              onCommit={(v) => act(() => roomActions.updateSettings({ lipSyncNudgeMs: v }))}
            />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

// ----- YouTube (official IFrame Player API; streams are never downloaded) -----

interface YTPlayer {
  destroy(): void;
}
declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: { videoId: string; width?: string; height?: string; playerVars?: Record<string, number> },
      ) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}
let ytReady: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  ytReady ??= new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      ytReady = null;
      reject(new Error('Could not load the YouTube player'));
    };
    document.head.appendChild(s);
  });
  return ytReady;
}
const youtubeId = (s: string) =>
  /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/.exec(s)?.[1] ??
  (/^[A-Za-z0-9_-]{11}$/.test(s.trim()) ? s.trim() : null);

function YouTubeSource({ onPlay }: { onPlay: (videoId: string) => void }) {
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const capturing = useRoomStore((s) => s.capture.active);

  return (
    <div className="space-y-3 text-sm">
      <form
        className="flex gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const id = youtubeId(input);
          setErr(id ? null : 'Paste a YouTube video link.');
          if (!id) return;
          // one step: ask to share this tab's sound right away, inside the same click (the browser requires a gesture)
          if (!capturing) act(() => roomActions.startCapture());
          onPlay(id);
        }}
      >
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
        <Button type="submit" variant="primary" data-testid="youtube-play" className="shrink-0 whitespace-nowrap">
          Play on all speakers
        </Button>
      </form>
      {err && (
        <p role="alert" className="text-bad">
          {err}
        </p>
      )}
      <Note>Share this tab when asked, with &ldquo;share tab audio&rdquo; on. Official player; never downloaded.</Note>
    </div>
  );
}

function YouTubePicture({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const capturing = useRoomStore((s) => s.capture.active);
  const [err, setErr] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let player: YTPlayer | null = null;
    let live = true;
    loadYouTubeApi()
      .then(() => {
        if (!live || !window.YT) return;
        const el = document.createElement('div'); // YT replaces this node; keep React's node untouched
        host.appendChild(el);
        player = new window.YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0 },
        });
      })
      .catch((e: unknown) => setErr(errMsg(e)));
    return () => {
      live = false;
      player?.destroy();
      host.replaceChildren();
    };
  }, [videoId]);

  return (
    <div className="mb-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-ink-400">YouTube</span>
        {!capturing && (
          <Button variant="ghost" className="!min-h-9 text-accent" onClick={() => act(() => roomActions.startCapture())}>
            Share sound to speakers
          </Button>
        )}
        <IconButton icon="x" label="Close YouTube" className="!size-9" onClick={onClose} />
      </div>
      <div ref={hostRef} className="aspect-video w-full overflow-hidden rounded-lg bg-black" />
      {err && (
        <p role="alert" className="mt-1 text-bad">
          {err}
        </p>
      )}
    </div>
  );
}

// ----- Local video (Mode 2: audio is decoded + scheduled, the picture shows in the library) -----

function LocalVideoSource({ onLocal }: { onLocal: (trackId: string, url: string) => void }) {
  const { job, upload } = useUpload();
  return (
    <div className="space-y-2 text-sm">
      <FilePick accept="video/*" label="Choose a video file" onFile={(f) => upload(f, (t) => onLocal(t.id, URL.createObjectURL(f)))} />
      <Note>The sound plays on every speaker; the picture stays on this screen.</Note>
      <JobStatus job={job} />
    </div>
  );
}
