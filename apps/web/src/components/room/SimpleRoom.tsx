'use client';
import { useState } from 'react';
import type { Device } from '@syncsound/protocol';
import { isRoutedLayout, layoutLabel } from '@syncsound/audio-core';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, CLASS_ICON, Icon, IconButton, StatusDot } from '../ui';
import { Library, MasterVolume } from './Player';
import { RoomDiagram, SLOT_NAME } from './RoomDiagram';
import { act, syncStatusOf, useCanControl } from './shared';

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
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="change-setup" onClick={onSetup}>
            <Icon name="stage" className="size-4" /> Change speaker setup
          </Button>
          <Button variant="ghost" data-testid="quick-resync" onClick={() => act(() => roomActions.startCalibration({ quick: true }))}>
            <Icon name="target" className="size-4" /> Re-sync speakers
          </Button>
        </div>
      </section>
      <Library />
    </div>
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
  const canControl = useCanControl();
  if (!self || !scene || !devices) return null;
  const layout = scene.layout;
  const routed = isRoutedLayout(layout);
  const status = syncStatusOf(self, self.id, clock);
  const title = routed && self.role === 'Full' ? 'Waiting for a spot' : routed || self.role === 'Sub' ? SLOT_NAME[self.role] : 'Playing along';

  return (
    <div className="mx-auto w-full max-w-md space-y-5 px-4 pb-6" data-testid="speaker-screen">
      <div>
        <p className="text-sm text-ink-400">This device is the</p>
        <h1 className="font-display text-5xl font-bold tracking-tight text-balance">{title}</h1>
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-300">
          <StatusDot status={status} label="" testid="self-sync-status" />
          {status === 'ok' ? 'In sync with the room' : 'Locking on to the room clock'}
        </p>
      </div>
      {routed && (
        <div className="rounded-2xl border border-ink-700 bg-ink-950 p-2">
          <RoomDiagram layout={layout} scene={scene} devices={devices} highlight={self.id} />
        </div>
      )}
      {!!self.volumeUpDb && (
        <p role="status" data-testid="volume-up-hint" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <strong className="text-warn">This speaker is quieter than the rest.</strong> Turn this device&rsquo;s own volume up, then tune the room again so
          everyone can play louder.
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
