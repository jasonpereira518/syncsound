'use client';
import { useEffect, useState } from 'react';
import type { Device, HomeView } from '@syncsound/protocol';
import { isRoutedLayout, layoutLabel, positionAt } from '@syncsound/audio-core';
import { getHome, groupControl, savedHome } from '@/lib/home';
import { tuneStatus } from '@/lib/tuneStatus';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, CLASS_ICON, Icon, IconButton, StatusDot } from '../ui';
import { Library, MasterVolume } from './Player';
import { RoomDiagram, SLOT_NAME } from './RoomDiagram';
import { act, currentTrack, errMsg, roomNowMs, syncStatusOf, toast, useCanControl } from './shared';

/** the room's one-line health summary: how many speakers, whether they're all locked together, and who needs tuning */
function useRoomHealth() {
  const devices = useRoomStore((s) => s.room?.devices);
  const selfId = useRoomStore((s) => s.deviceId);
  const clock = useRoomStore((s) => s.clock);
  const live = (devices ?? []).filter((d) => d.connected);
  const statuses = live.map((d) => syncStatusOf(d, selfId, clock));
  const behind = statuses.filter((s) => s !== 'ok').length;
  const needs = live.filter((d) => d.syncState !== 'tuned');
  const status = behind === 0 && needs.length === 0 ? 'ok' : statuses.includes('bad') ? 'bad' : 'warn';
  const tail = needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} tuning` : behind === 0 ? 'in sync' : `${behind} catching up`;
  const label = `${live.length} speaker${live.length === 1 ? '' : 's'}, ${tail}`;
  return { live, status, label, needs } as const;
}

/** one line per speaker about its tune */
export function tuneLine(d: Device): string {
  if (d.syncState === 'tuned') return '';
  if (d.syncState === 'stale') return d.tuneStale === 'output' || d.tuneStale === 'route' ? ', needs tuning again (output changed)' : ', needs tuning again';
  return ', not tuned yet';
}

/** Controller's everyday screen: one volume, the speakers at a glance, and what to play. */
export function NowPlaying({ onSetup }: { onSetup: () => void }) {
  const [showSpeakers, setShowSpeakers] = useState(false);
  const health = useRoomHealth();
  const layout = useRoomStore((s) => s.room?.scene.layout);
  const hasSub = health.live.some((d) => d.role === 'Sub');
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-6">
      <section className="rounded-2xl border border-ink-700 p-4" aria-label="Speakers">
        <button
          type="button"
          data-testid="room-health"
          aria-expanded={showSpeakers}
          onClick={() => setShowSpeakers(!showSpeakers)}
          className="flex w-full items-center gap-3 text-left"
        >
          <StatusDot status={health.status} label="" testid="room-sync-status" />
          <span className="min-w-0 flex-1">
            <span className="block font-display text-lg font-semibold">{health.label}</span>
            <span className="block text-sm text-ink-400">{layout ? layoutLabel(layout, hasSub) : 'Speakers not placed yet'}</span>
          </span>
          <span className="text-sm text-ink-400">{showSpeakers ? 'Hide' : 'Show'}</span>
        </button>
        {showSpeakers && <SpeakerList devices={health.live} />}
        <TuneCard devices={health.live} onSetup={onSetup} />
      </section>
      <OtherRooms />
      <Library />
    </div>
  );
}

/** the room's tune at a glance, the one thing to do about it, and the picture to check */
function TuneCard({ devices, onSetup }: { devices: Device[]; onSetup: () => void }) {
  const scene = useRoomStore((s) => s.room?.scene);
  const busy = useRoomStore((s) => (s.calibration.running && s.calibration.step !== 'done' && s.calibration.step !== 'error') || s.syncMeasure.running);
  const canControl = useCanControl();
  if (!scene) return null;
  const view = tuneStatus(devices, scene.tune);
  const layout = scene.layout;
  return (
    <div className="mt-4">
      <p data-testid="tune-label" className={`text-sm ${view.state === 'tuned' ? 'text-ok' : 'text-warn'}`}>
        {view.label}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {canControl && (
          <Button variant={view.state === 'tuned' ? 'ghost' : 'primary'} data-testid="tune-room" disabled={busy} onClick={() => act(() => roomActions.tune())}>
            <Icon name="mic" className="size-4" /> {view.action}
          </Button>
        )}
        <Button variant="ghost" data-testid="change-setup" onClick={onSetup}>
          <Icon name="stage" className="size-4" /> Adjust layout
        </Button>
      </div>
      {isRoutedLayout(layout) && (
        <div className="mt-3 rounded-2xl border border-ink-700 bg-ink-950 p-2">
          <RoomDiagram layout={layout} scene={scene} devices={devices} />
          <p className="px-1 pb-1 text-xs text-ink-400">Check the picture matches your room; if a speaker sits elsewhere, drag it under Adjust layout.</p>
        </div>
      )}
    </div>
  );
}

/** tracks every device fetches and decodes itself; streamed sources (tab capture, YouTube, Spotify…) live in one room */
const SHAREABLE = new Set(['demo', 'file', 'url', 'video']);

/** Owner of a home room: play the current track in other rooms too, all starting at the same instant. */
function OtherRooms() {
  const code = useRoomStore((s) => s.room?.code);
  const track = useRoomStore((s) => currentTrack(s.room));
  const playback = useRoomStore((s) => s.room?.playback);
  const clock = useRoomStore((s) => s.clock);
  const [home, setHome] = useState<{ id: string; rooms: HomeView['rooms'] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const h = savedHome();
    if (!h?.ownerKey || !code) return;
    getHome(h.homeId)
      .then((v) => v.rooms.some((r) => r.id === code) && setHome({ id: h.homeId, rooms: v.rooms.filter((r) => r.id !== code) }))
      .catch(() => {});
  }, [code]);
  if (!home || !home.rooms.length || !code || !playback) return null;

  const shareable = !!track && SHAREABLE.has(track.kind);
  const others = picked.filter((id) => home.rooms.some((r) => r.id === id));
  const playTogether = async () => {
    if (!track) return;
    setBusy(true);
    try {
      await groupControl(home.id, others, { type: 'queue', track });
      const position = playback.status === 'playing' ? positionAt(playback, roomNowMs(clock)) : playback.trackOffset;
      const r = await groupControl(home.id, [code, ...others], { type: 'play', trackId: track.id, position: Math.max(0, position) });
      const failed = Object.keys(r.errors);
      if (failed.length) toast(`Couldn't start in ${failed.length} room${failed.length === 1 ? '' : 's'}.`);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const pauseAll = () => groupControl(home.id, [code, ...others], { type: 'pause' }).catch((e: unknown) => toast(errMsg(e)));

  return (
    <section className="rounded-2xl border border-ink-700 p-4" aria-labelledby="other-rooms-h">
      <h2 id="other-rooms-h" className="font-display text-lg font-semibold">
        Play in other rooms too
      </h2>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {home.rooms.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={others.includes(r.id)}
            data-testid={`group-room-${r.id}`}
            onClick={() => setPicked(others.includes(r.id) ? others.filter((x) => x !== r.id) : [...others, r.id])}
            className={`min-h-10 rounded-full border px-4 text-sm ${others.includes(r.id) ? 'border-accent bg-accent/15' : 'border-ink-600 hover:border-ink-400'}`}
          >
            {r.name}
            <span className="ml-1.5 text-xs text-ink-400">{r.connected ? `${r.connected} speaker${r.connected === 1 ? '' : 's'}` : 'no speakers'}</span>
          </button>
        ))}
      </div>
      {track && !shareable && <p className="mt-2 text-sm text-ink-400">{track.title} streams from this room only. Pick a music or video file to play it in several rooms.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" data-testid="group-play" disabled={!shareable || !others.length || busy} onClick={() => void playTogether()}>
          <Icon name="play" className="size-4" /> {others.length ? `Play here and in ${others.length} more` : 'Pick rooms to play in'}
        </Button>
        {others.length > 0 && (
          <Button variant="ghost" data-testid="group-pause" onClick={() => void pauseAll()}>
            Pause them all
          </Button>
        )}
      </div>
    </section>
  );
}

function SpeakerList({ devices }: { devices: Device[] }) {
  const selfId = useRoomStore((s) => s.deviceId);
  const clock = useRoomStore((s) => s.clock);
  const measured = useRoomStore((s) => s.syncMeasure.devices);
  const canControl = useCanControl();
  return (
    <ul className="mt-3 divide-y divide-ink-800 rounded-xl border border-ink-800" data-testid="speaker-list">
      {devices.map((d) => {
        const bt = d.caps.deviceClass === 'bluetooth';
        const jitter = bt ? measured.find((m) => m.deviceId === d.id)?.stdMs : undefined;
        return (
          <li key={d.id} className="flex items-center gap-3 px-3 py-2">
            <StatusDot status={syncStatusOf(d, selfId, clock)} label="" />
            <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-5 shrink-0 text-ink-300" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{d.name}</span>
              <span className="block text-xs text-ink-400">
                {SLOT_NAME[d.role]}
                {bt && (jitter !== undefined ? `, Bluetooth ±${jitter.toFixed(1)} ms` : ', Bluetooth')}
                {tuneLine(d)}
                {d.volumeUpDb ? ', needs its volume turned up' : ''}
              </span>
            </span>
            <Button variant="ghost" className="!min-h-9 text-sm" onClick={() => act(() => roomActions.identify(d.id))}>
              Beep
            </Button>
            {(canControl || d.id === selfId) && (
              <IconButton
                icon={d.muted ? 'mute' : 'volume'}
                label={d.muted ? `Unmute ${d.name}` : `Mute ${d.name}`}
                pressed={d.muted}
                className="border-transparent"
                onClick={() => act(() => roomActions.updateDevice({ muted: !d.muted }, d.id))}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A guest device's screen: which speaker it is, where it sits, and whether it's in sync. */
export function SpeakerScreen({ onControls }: { onControls?: () => void }) {
  const self = useRoomStore((s) => s.room?.devices.find((d) => d.id === s.deviceId) ?? null);
  const scene = useRoomStore((s) => s.room?.scene);
  const devices = useRoomStore((s) => s.room?.devices);
  const clock = useRoomStore((s) => s.clock);
  const wakeLock = useRoomStore((s) => s.engine.wakeLock);
  const recorderStep = useRoomStore((s) => s.calibration.recorderStep);
  const canControl = useCanControl();
  if (!self || !scene || !devices) return null;
  const layout = scene.layout;
  const routed = isRoutedLayout(layout);
  const status = syncStatusOf(self, self.id, clock);
  const title = routed && self.role === 'Full' ? 'Waiting for a spot' : routed || self.role === 'Sub' ? SLOT_NAME[self.role] : 'Playing along';
  const placedByHand = self.syncState === 'tuned' && !!scene.tune && !scene.tune.ranged.includes(self.id);
  const tuned =
    recorderStep !== 'idle'
      ? 'Listening for the tune…'
      : self.syncState === 'tuned'
        ? placedByHand
          ? 'Tuned · placed by hand'
          : 'Tuned'
        : self.syncState === 'stale'
          ? 'Needs tuning again'
          : 'Not tuned yet';

  return (
    <div className="mx-auto w-full max-w-md space-y-5 px-4 pb-6" data-testid="speaker-screen">
      <div>
        <p className="text-sm text-ink-400">This device is the</p>
        <h1 className="font-display text-5xl font-bold tracking-tight text-balance">{title}</h1>
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-300">
          <StatusDot status={status} label="" testid="self-sync-status" />
          {status === 'ok' ? 'In sync with the room' : 'Locking on to the room clock'}
          <span className="text-ink-500">·</span>
          <span data-testid="self-tune-state">{tuned}</span>
        </p>
      </div>
      {routed && (
        <div className="rounded-2xl border border-ink-700 bg-ink-950 p-2">
          <RoomDiagram layout={layout} scene={scene} devices={devices} highlight={self.id} />
        </div>
      )}
      {self.syncState === 'untuned' && !self.volumeUpDb && (
        <p role="status" data-testid="volume-max-hint" className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <strong>Turn this device&rsquo;s volume all the way up.</strong> Tuning then matches every speaker&rsquo;s loudness from the listening
          seat, and the room&rsquo;s master volume does the rest.
        </p>
      )}
      {!!self.volumeUpDb && (
        <p role="status" data-testid="volume-up-hint" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <strong className="text-warn">This speaker is quieter than the rest.</strong> Turn this device&rsquo;s own volume up, then tune the room again so
          it can keep up with the others.
        </p>
      )}
      {!wakeLock && <p className="text-sm text-ink-400">Keep this screen on and this tab open while it plays.</p>}
      {canControl && (
        <div className="space-y-3">
          <MasterVolume />
          {onControls && (
            <Button className="w-full" data-testid="open-controls" onClick={onControls}>
              <Icon name="music" className="size-4" /> Choose what plays
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
