'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRoomStore, roomActions } from '@/store/roomStore';
import { rememberLastRoom } from '@/lib/home';
import { getRoomInfo } from '@/lib/roomClient';
import { Button, Icon, Tabs, fmtSigned, tabPanelProps, type TabDef } from '../ui';
import { CalibrationWizard } from './CalibrationWizard';
import { DeviceList, SpeakerCard } from './DeviceList';
import { JoinGate } from './JoinGate';
import { Library, Player } from './Player';
import { RoomHeader } from './RoomHeader';
import { SetupWizard } from './SetupWizard';
import { NowPlaying, SpeakerScreen } from './SimpleRoom';
import { Stage } from './Stage';
import { act, dismissToast, useToasts } from './shared';

type View = 'setup' | 'controls' | 'speaker' | 'advanced';

type RoomTab = 'library' | 'stage' | 'devices' | 'calibrate';
const TABS: TabDef<RoomTab>[] = [
  { id: 'library', label: 'Library', icon: 'music' },
  { id: 'stage', label: 'Stage', icon: 'stage' },
  { id: 'devices', label: 'Speakers', icon: 'devices' },
  { id: 'calibrate', label: 'Calibrate', icon: 'mic' },
];
const SIDE_TABS = TABS.slice(2);

export function RoomApp({ code }: { code: string }) {
  const joined = useRoomStore((s) => s.room !== null);
  const isHost = useRoomStore((s) => s.isHost);
  const hasLayout = useRoomStore((s) => !!s.room?.scene.layout);
  // null = default: a host without a layout yet gets the setup wizard, other hosts the controls, guests their speaker screen
  const [picked, setPicked] = useState<View | null>(null);
  useEffect(() => {
    if (window.location.hash === '#advanced') setPicked('advanced');
  }, []);
  const view: View = picked ?? (isHost ? (hasLayout ? 'controls' : 'setup') : 'speaker');
  // once the wizard opens it stays open: choosing a layout inside it would otherwise flip the default view
  useEffect(() => {
    if (joined && picked === null && view === 'setup') setPicked('setup');
  }, [joined, picked, view]);
  // a home room has a name ("Living room"); quick rooms only have their code
  const [name, setName] = useState<string | undefined>();
  useEffect(() => {
    getRoomInfo(code)
      .then((r) => setName(r.name))
      .catch(() => {});
  }, [code]);
  useEffect(() => {
    document.title = `${name ?? `Room ${code}`} · SyncSound`;
    if (joined) rememberLastRoom(code, name);
  }, [code, name, joined]);
  const go = (v: View) => {
    setPicked(v);
    history.replaceState(null, '', v === 'advanced' ? '#advanced' : window.location.pathname + window.location.search);
  };

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

  // everyone may open Advanced (it holds their own device's latency/EQ fine-tuning); its controls enforce permissions
  const toggle = view !== 'setup' && (
    <button
      type="button"
      data-testid={view === 'advanced' ? 'view-simple' : 'view-advanced'}
      onClick={() => go(view === 'advanced' ? (isHost ? 'controls' : 'speaker') : 'advanced')}
      className="min-h-11 shrink-0 rounded-lg px-3 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-100"
    >
      {view === 'advanced' ? 'Simple view' : 'Advanced'}
    </button>
  );

  if (view !== 'advanced') {
    return (
      <div className="flex min-h-dvh flex-col">
        <RoomHeader name={name} extra={toggle} />
        <Banners />
        <main id="main" className="flex flex-1 flex-col pt-2">
          {view === 'setup' && <SetupWizard onDone={() => go('controls')} />}
          {view === 'controls' && <NowPlaying onSetup={() => go('setup')} />}
          {view === 'speaker' && <SpeakerScreen onControls={() => go('controls')} />}
        </main>
        {view !== 'setup' && (
          <div className="sticky bottom-0 z-20">
            <Player />
          </div>
        )}
        <Toasts />
      </div>
    );
  }
  return <AdvancedRoom header={<RoomHeader name={name} debug extra={toggle} />} />;
}

/** The full expert shell: library | free-placement stage | devices & calibration, plus debug. */
function AdvancedRoom({ header }: { header: ReactNode }) {
  const isHost = useRoomStore((s) => s.isHost);
  // null = default: hosts start on the library, guests on their own speaker card
  const [picked, setPicked] = useState<RoomTab | null>(null);
  const tab = picked ?? (isHost ? 'library' : 'devices');

  // Desktop (lg+): library | stage | devices-or-calibrate, all fitting the viewport above the player bar.
  // Mobile: one section at a time, picked from the bottom tab bar.
  const side = tab === 'calibrate' ? 'calibrate' : 'devices';
  const panel = (id: RoomTab) => ({
    ...tabPanelProps('room', id),
    'aria-labelledby': `room-tab-${id}${id === 'devices' || id === 'calibrate' ? ` side-tab-${id}` : ''}`,
    className: `${tab === id ? 'block' : 'hidden'} min-w-0 lg:min-h-0 ${id === 'library' || id === 'stage' ? 'lg:px-4 lg:pt-2 lg:pb-3' : ''} ${
      id === 'library' || id === 'stage'
        ? 'lg:block'
        : side === id
          ? 'lg:flex lg:flex-1 lg:flex-col'
          : 'lg:hidden'
    }`,
  });

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {header}
      <Banners />
      <main
        id="main"
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)_20rem] lg:divide-x lg:divide-ink-800 lg:overflow-hidden lg:p-0 xl:grid-cols-[19rem_minmax(0,1fr)_22rem] 2xl:grid-cols-[22rem_minmax(0,1fr)_26rem]"
      >
        <div {...panel('library')}>
          <Library />
        </div>
        <div {...panel('stage')}>
          <Stage />
        </div>
        <div className="max-lg:contents lg:flex lg:min-h-0 lg:flex-col lg:px-4 lg:pb-3">
          <Tabs
            tabs={SIDE_TABS}
            value={side}
            onChange={setPicked}
            label="Speaker tools"
            idPrefix="side"
            panelPrefix="room"
            className="mb-2 hidden gap-5 border-b border-ink-800 lg:flex"
            tabClassName="-mb-px !min-h-12 border-b-2 border-transparent !px-0 font-medium aria-selected:border-accent aria-selected:text-ink-100"
          />
          <div {...panel('devices')}>
            <div className="flex flex-col gap-3 lg:-mx-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-1">
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
        className="border-t border-ink-800 bg-ink-950 pb-[env(safe-area-inset-bottom)] lg:hidden"
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
  const routeRestored = useRoomStore((s) => s.routeRestored);
  const emitting = useRoomStore((s) => s.calibration.emitting);
  const nowPlaying = useRoomStore((s) => s.calibration.nowPlaying);
  const nowPlayingName = useRoomStore((s) => (nowPlaying === s.deviceId ? null : s.room?.devices.find((d) => d.id === nowPlaying)?.name));
  const nowPlayingSelf = useRoomStore((s) => nowPlaying !== null && nowPlaying === s.deviceId);
  return (
    <>
      {routeRestored && !routeChanged && (
        <div
          role="status"
          data-testid="route-restored"
          className="flex flex-wrap items-center gap-x-3 border-b border-ink-800 px-4 py-1 text-sm"
        >
          <Icon name="bluetooth" className="size-4 shrink-0 text-ink-400" />
          <p className="min-w-0 flex-1 basis-56 py-2">
            Output changed to {routeRestored.label}, using its saved sync ({fmtSigned(routeRestored.calibratedLatencyMs, 0)} ms).
          </p>
          <Button variant="ghost" className="ml-auto" onClick={() => act(() => roomActions.dismissRouteChange())}>
            Dismiss
          </Button>
        </div>
      )}
      {routeChanged && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 border-b border-ink-800 px-4 py-1 text-sm">
          <Icon name="warning" className="size-4 shrink-0 text-warn" />
          <p className="min-w-0 flex-1 basis-56 py-2">This speaker&rsquo;s audio delay changed (headphones or Bluetooth?).</p>
          <div className="ml-auto flex">
            <Button variant="ghost" data-testid="banner-resync" className="text-warn" onClick={() => act(() => roomActions.startCalibration({ quick: true }))}>
              Re-sync now
            </Button>
            <Button variant="ghost" onClick={() => act(() => roomActions.dismissRouteChange())}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {emitting && (
        <div
          role="status"
          className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-ink-700 bg-ink-900 px-4 py-2 text-sm shadow-lg"
        >
          <span aria-hidden className="size-2 animate-pulse rounded-full bg-accent" />
          {nowPlayingSelf
            ? 'Tuning: this speaker is playing its sweep'
            : nowPlayingName
              ? `Tuning: ${nowPlayingName} is playing`
              : 'Tuning the room, keep it quiet'}
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
          className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm shadow-lg"
        >
          <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-bad" />
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
