'use client';
import { useEffect, useState } from 'react';
import type { Device, HomeView } from '@syncsound/protocol';
import { isRoutedLayout, layoutLabel, positionAt } from '@syncsound/audio-core';
import { getHome, groupControl, savedHome } from '@/lib/home';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, CLASS_ICON, Icon, IconButton, Note, StatusDot } from '../ui';
import { Library, MasterVolume } from './Player';
import { RoomDiagram, SLOT_NAME } from './RoomDiagram';
import { act, currentTrack, errMsg, roomNowMs, syncStatusOf, toast, useCanControl } from './shared';

/** the room's one-line health summary: how many speakers, and whether they're all locked together */
function useRoomHealth() {
  const devices = useRoomStore((s) => s.room?.devices);
  const selfId = useRoomStore((s) => s.deviceId);
  const clock = useRoomStore((s) => s.clock);
  const live = (devices ?? []).filter((d) => d.connected);
  const statuses = live.map((d) => syncStatusOf(d, selfId, clock));
  const behind = statuses.filter((s) => s !== 'ok').length;
  const status = behind === 0 ? 'ok' : statuses.includes('bad') ? 'bad' : 'warn';
  const label = `${live.length} speaker${live.length === 1 ? '' : 's'}, ${behind === 0 ? 'in sync' : `${behind} catching up`}`;
  return { live, status, label } as const;
}

/** Controller's everyday screen: one volume, the speakers at a glance, and what to play. */
export function NowPlaying({ onSetup }: { onSetup: () => void }) {
  const [showSpeakers, setShowSpeakers] = useState(false);
  const health = useRoomHealth();
  const layout = useRoomStore((s) => s.room?.scene.layout);
  const hasSub = health.live.some((d) => d.role === 'Sub');
  return (
    <div className="mx-auto w-full max-w-2xl space-y-10 px-4 pt-4 pb-10 sm:px-5">
      <section aria-label="Speakers">
        <button
          type="button"
          data-testid="room-health"
          aria-expanded={showSpeakers}
          onClick={() => setShowSpeakers(!showSpeakers)}
          className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-4 rounded-row px-3 py-2 text-left transition hover:bg-ink-900"
        >
          <StatusDot status={health.status} label="" testid="room-sync-status" />
          <span className="min-w-0 flex-1">
            <span className="block font-display text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{health.label}</span>
            <span className="mt-0.5 block text-sm text-ink-300">{layout ? layoutLabel(layout, hasSub) : 'Speakers not placed yet'}</span>
          </span>
          <Icon name="chevron-down" className={`size-5 shrink-0 text-ink-300 transition-transform ${showSpeakers ? 'rotate-180' : ''}`} />
          <span className="sr-only">{showSpeakers ? 'Hide speakers' : 'Show speakers'}</span>
        </button>
        {showSpeakers && <SpeakerList devices={health.live} />}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="change-setup" onClick={onSetup}>
            <Icon name="stage" className="size-4" /> Change speaker setup
          </Button>
          <Button variant="ghost" data-testid="quick-resync" onClick={() => act(() => roomActions.startCalibration({ quick: true }))}>
            <Icon name="resync" className="size-4" /> Re-sync speakers
          </Button>
        </div>
      </section>
      <OtherRooms />
      <Library embedded />
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
    <section aria-labelledby="other-rooms-h">
      <h2 id="other-rooms-h" className="font-display text-xl font-semibold tracking-tight">
        Play in other rooms too
      </h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {home.rooms.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={others.includes(r.id)}
            data-testid={`group-room-${r.id}`}
            onClick={() => setPicked(others.includes(r.id) ? others.filter((x) => x !== r.id) : [...others, r.id])}
            className={`min-h-10 rounded-full px-4 text-sm transition ${
              others.includes(r.id) ? 'bg-ink-100 font-medium text-ink-950' : 'bg-ink-850 text-ink-100 hover:bg-ink-800'
            }`}
          >
            {r.name}
            <span className={`ml-1.5 text-xs ${others.includes(r.id) ? 'text-ink-700' : 'text-ink-400'}`}>{r.connected ? `${r.connected} speaker${r.connected === 1 ? '' : 's'}` : 'no speakers'}</span>
          </button>
        ))}
      </div>
      {track && !shareable && <p className="mt-3 text-sm text-ink-300">{track.title} streams from this room only. Pick a music or video file to play it in several rooms.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button data-testid="group-play" disabled={!shareable || !others.length || busy} onClick={() => void playTogether()}>
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
    <ul className="mt-2 divide-y divide-ink-800" data-testid="speaker-list">
      {devices.map((d) => {
        const bt = d.caps.deviceClass === 'bluetooth';
        const jitter = bt ? measured.find((m) => m.deviceId === d.id)?.stdMs : undefined;
        return (
          <li key={d.id} className="flex items-center gap-3 py-2.5">
            <span aria-hidden className="relative grid size-10 shrink-0 place-items-center rounded-full bg-ink-850 text-ink-200">
              <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-ink-100">{d.name}</span>
                <StatusDot status={syncStatusOf(d, selfId, clock)} label="" />
              </span>
              <span className="block text-xs text-ink-300">
                {SLOT_NAME[d.role]}
                {bt && (jitter !== undefined ? `, Bluetooth ±${jitter.toFixed(1)} ms` : ', Bluetooth')}
                {d.volumeUpDb ? ', needs its volume turned up' : ''}
              </span>
            </span>
            <IconButton icon="bell" label={`Beep ${d.name}`} variant="ghost" onClick={() => act(() => roomActions.identify(d.id))} />
            {(canControl || d.id === selfId) && (
              <IconButton
                icon={d.muted ? 'mute' : 'volume'}
                label={d.muted ? `Unmute ${d.name}` : `Mute ${d.name}`}
                pressed={d.muted}
                variant="ghost"
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
  const canControl = useCanControl();
  if (!self || !scene || !devices) return null;
  const layout = scene.layout;
  const routed = isRoutedLayout(layout);
  const status = syncStatusOf(self, self.id, clock);
  const title = routed && self.role === 'Full' ? 'Waiting for a spot' : routed || self.role === 'Sub' ? SLOT_NAME[self.role] : 'Playing along';

  return (
    <div className="mx-auto w-full max-w-md space-y-6 px-5 pt-4 pb-10" data-testid="speaker-screen">
      <div>
        <p className="text-sm text-ink-300">This device is the</p>
        <h1 className="mt-1 font-display text-5xl leading-[1.02] font-semibold tracking-[-0.035em] text-balance sm:text-6xl">{title}</h1>
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-200">
          <StatusDot status={status} label="" testid="self-sync-status" />
          {status === 'ok' ? 'In sync with the room' : 'Locking on to the room clock'}
        </p>
      </div>
      {routed && <RoomDiagram layout={layout} scene={scene} devices={devices} highlight={self.id} />}
      {self.calibratedLatencyMs === null && !self.volumeUpDb && (
        <Note role="status" data-testid="volume-max-hint" icon="volume" tone="accent">
          <strong className="font-semibold">Turn this device&rsquo;s volume all the way up.</strong> Tuning then matches every speaker&rsquo;s loudness from the listening
          seat, and the room&rsquo;s master volume does the rest.
        </Note>
      )}
      {!!self.volumeUpDb && (
        <Note role="status" data-testid="volume-up-hint" icon="warning" tone="warn">
          <strong className="font-semibold">This speaker is quieter than the rest.</strong> Turn this device&rsquo;s own volume up, then tune the room again so
          it can keep up with the others.
        </Note>
      )}
      {!wakeLock && (
        <p className="flex items-center gap-2 text-sm text-ink-300">
          <Icon name="moon" className="size-4 shrink-0" /> Keep this screen on and this tab open while it plays.
        </p>
      )}
      {canControl && (
        <div className="space-y-4 rounded-panel bg-ink-850 p-5">
          <MasterVolume />
          {onControls && (
            <Button className="w-full" data-testid="open-controls" onClick={onControls}>
              <Icon name="queue" className="size-4" /> Choose what plays
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
