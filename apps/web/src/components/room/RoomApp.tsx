'use client';
import { useEffect, useState } from 'react';
import { useRoomStore, roomActions } from '@/store/roomStore';
import { Icon, Tabs, tabPanelProps, type TabDef } from '../ui';
import { CalibrationWizard } from './CalibrationWizard';
import { DebugDrawer } from './DebugDrawer';
import { DeviceList, SpeakerCard } from './DeviceList';
import { JoinGate } from './JoinGate';
import { Player } from './Player';
import { RoomHeader } from './RoomHeader';
import { Stage } from './Stage';
import { act, dismissToast, useToasts } from './shared';

type RoomTab = 'player' | 'stage' | 'devices' | 'calibrate';
const TABS: TabDef<RoomTab>[] = [
  { id: 'player', label: 'Player', icon: 'music' },
  { id: 'stage', label: 'Stage', icon: 'stage' },
  { id: 'devices', label: 'Devices', icon: 'devices' },
  { id: 'calibrate', label: 'Calibrate', icon: 'mic' },
];

export function RoomApp({ code }: { code: string }) {
  const joined = useRoomStore((s) => s.room !== null);
  const isHost = useRoomStore((s) => s.isHost);
  const [tab, setTab] = useState<RoomTab>('player');

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

  // Mobile: only the active tab's panel is visible. Desktop (lg+): every panel, as a dashboard.
  const panel = (id: RoomTab, cls: string) => ({
    ...tabPanelProps('room', id),
    className: `${tab === id ? 'block' : 'hidden'} min-w-0 lg:block ${cls}`,
  });

  return (
    <div className="pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-10">
      <RoomHeader />
      <main id="main" className="mx-auto max-w-[1600px] space-y-4 px-3 sm:px-6">
        <Banners />
        {!isHost && <SpeakerCard />}
        <div className="grid gap-4 lg:grid-cols-12">
          <div {...panel('player', 'lg:col-span-5 xl:col-span-4')}>
            <Player />
          </div>
          <div {...panel('stage', 'lg:col-span-7 xl:col-span-8')}>
            <Stage />
          </div>
          <div {...panel('devices', 'lg:col-span-7 xl:col-span-8')}>
            <DeviceList />
          </div>
          <div {...panel('calibrate', 'lg:col-span-5 xl:col-span-4')}>
            <CalibrationWizard />
          </div>
        </div>
      </main>
      <nav
        aria-label="Room sections"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={setTab}
          label="Room sections"
          idPrefix="room"
          className="grid grid-cols-4"
          tabClassName="min-h-16 flex-col !gap-1 !px-1 text-xs"
        />
      </nav>
      <DebugDrawer />
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
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <Icon name="warning" className="size-5 shrink-0 text-warn" />
          <p className="min-w-0 flex-1">
            <strong className="text-warn">Audio output changed.</strong> Headphones or Bluetooth add latency the browser
            often doesn&rsquo;t report. Recalibrate (Calibrate tab) or fine-tune the latency slider.
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
      className="pointer-events-none fixed inset-x-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 lg:bottom-6"
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
