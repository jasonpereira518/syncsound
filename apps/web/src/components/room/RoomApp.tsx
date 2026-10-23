'use client';
import { useEffect, useState } from 'react';
import { useRoomStore, roomActions } from '@/store/roomStore';
import { Icon, Tabs, tabPanelProps, type TabDef } from '../ui';
import { CalibrationWizard } from './CalibrationWizard';
import { DeviceList, SpeakerCard } from './DeviceList';
import { JoinGate } from './JoinGate';
import { Library, Player } from './Player';
import { RoomHeader } from './RoomHeader';
import { Stage } from './Stage';
import { act, dismissToast, useToasts } from './shared';

type RoomTab = 'library' | 'stage' | 'devices' | 'calibrate';
const TABS: TabDef<RoomTab>[] = [
  { id: 'library', label: 'Library', icon: 'music' },
  { id: 'stage', label: 'Stage', icon: 'stage' },
  { id: 'devices', label: 'Devices', icon: 'devices' },
  { id: 'calibrate', label: 'Calibrate', icon: 'mic' },
];
const SIDE_TABS = TABS.slice(2);

export function RoomApp({ code }: { code: string }) {
  const joined = useRoomStore((s) => s.room !== null);
  const isHost = useRoomStore((s) => s.isHost);
  // null = default: hosts start on the library, guests on their own speaker card
  const [picked, setPicked] = useState<RoomTab | null>(null);
  const tab = picked ?? (isHost ? 'library' : 'devices');

  useEffect(
    () => () => {
      try {
        roomActions.leave();
      } catch {
        /* not joined / engine not ready */
      }
    },
    [],
  );

  if (!joined) {
    return (
      <>
        <JoinGate code={code} />
        <Toasts />
      </>
    );
  }

  // Desktop (lg+): library | stage | devices-or-calibrate, all fitting the viewport above the player bar.
  // Mobile: one section at a time, picked from the bottom tab bar.
  const side = tab === 'calibrate' ? 'calibrate' : 'devices';
  const panel = (id: RoomTab) => ({
    ...tabPanelProps('room', id),
    'aria-labelledby': `room-tab-${id}${id === 'devices' || id === 'calibrate' ? ` side-tab-${id}` : ''}`,
    className: `${tab === id ? 'block' : 'hidden'} min-w-0 lg:min-h-0 ${
      id === 'library' || id === 'stage'
        ? 'lg:block'
        : side === id
          ? 'lg:flex lg:flex-1 lg:flex-col'
          : 'lg:hidden'
    }`,
  });

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <RoomHeader />
      <Banners />
      <main
        id="main"
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)_20rem] lg:gap-3 lg:overflow-hidden xl:grid-cols-[19rem_minmax(0,1fr)_22rem] 2xl:grid-cols-[22rem_minmax(0,1fr)_26rem]"
      >
        <div {...panel('library')}>
          <Library />
        </div>
        <div {...panel('stage')}>
          <Stage />
        </div>
        <div className="max-lg:contents lg:flex lg:min-h-0 lg:flex-col lg:gap-2">
          <Tabs
            tabs={SIDE_TABS}
            value={side}
            onChange={setPicked}
            label="Speaker tools"
            idPrefix="side"
            panelPrefix="room"
            className="hidden gap-1 rounded-xl border border-ink-700/80 bg-ink-900/80 p-1 lg:grid lg:grid-cols-2"
            tabClassName="!min-h-9 rounded-lg aria-selected:bg-ink-700/70"
          />
          <div {...panel('devices')}>
            <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {!isHost && <SpeakerCard />}
              <DeviceList />
            </div>
          </div>
          <div {...panel('calibrate')}>
            <CalibrationWizard />
          </div>
        </div>
      </main>
      <Player />
      <nav
        aria-label="Room sections"
        className="border-t border-ink-700 bg-ink-950 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={setPicked}
          label="Room sections"
          idPrefix="room"
          className="grid grid-cols-4"
          tabClassName="min-h-14 flex-col !gap-0.5 !px-1 text-xs"
        />
      </nav>
      <Toasts />
    </div>
  );
}

function Banners() {
  const routeChanged = useRoomStore((s) => s.routeChanged);
  const emitting = useRoomStore((s) => s.calibration.emitting);
  return (
    <>
      {routeChanged && (
        <div
          role="status"
          className="mx-3 mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-2 text-sm"
        >
          <Icon name="warning" className="size-5 shrink-0 text-warn" />
          <p className="min-w-0 flex-1">
            <strong className="text-warn">Audio output changed.</strong> Headphones or Bluetooth add latency
            the browser often doesn&rsquo;t report. Run a quick re-sync (Calibrate tab, about 1 s per speaker)
            or fine-tune the latency slider.
          </p>
          <button
            type="button"
            onClick={() => act(() => roomActions.dismissRouteChange())}
            className="min-h-11 rounded-lg px-3 text-ink-200 hover:bg-ink-800"
          >
            Dismiss
          </button>
        </div>
      )}
      {emitting && (
        <div
          role="status"
          className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-accent bg-ink-950/95 px-4 py-2 text-sm shadow-[0_0_30px_-4px_var(--color-accent)]"
        >
          <span className="relative inline-flex size-3">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent" />
            <span className="relative size-3 rounded-full bg-accent" />
          </span>
          Calibrating: this speaker is playing a test signal
        </div>
      )}
    </>
  );
}

function Toasts() {
  const error = useRoomStore((s) => s.error);
  const items = useToasts((s) => s.items);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const all = [...(error && error !== dismissed ? [{ id: -1, msg: error }] : []), ...items];
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-3 top-16 z-50 flex flex-col items-center gap-2"
    >
      {all.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-bad/50 bg-ink-900/95 px-4 py-3 text-sm shadow-xl backdrop-blur"
        >
          <Icon name="warning" className="mt-0.5 size-5 shrink-0 text-bad" />
          <p className="min-w-0 flex-1 break-words">{t.msg}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => (t.id === -1 ? setDismissed(t.msg) : dismissToast(t.id))}
            className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-400 hover:text-ink-100"
          >
            <Icon name="x" className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
