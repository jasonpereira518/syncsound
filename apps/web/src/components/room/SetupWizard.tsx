'use client';
import { useEffect, useState } from 'react';
import type { Device } from '@syncsound/protocol';
import { isRoutedLayout, layoutLabel, suggestLayout, TUNE_PERIOD_MS } from '@syncsound/audio-core';
import { tuneStatus } from '@/lib/tuneStatus';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, CLASS_ICON, Icon } from '../ui';
import { LayoutEditor } from './LayoutEditor';
import { SLOT_NAME } from './RoomDiagram';
import { useJoinLink } from './RoomHeader';
import { act } from './shared';
import { TuneStatus } from './TuneStatus';

/** what a speaker's row says about its microphone (a tune uses it to measure where the speaker is) */
export function micLine(d: Device): string {
  if (!d.caps.hasMic) return 'no microphone (it plays, but its spot is placed by hand)';
  switch (d.caps.micPermission) {
    case 'granted':
      return 'Mic ready';
    case 'denied':
      return 'mic not allowed (it plays, but its spot is placed by hand)';
    case 'prompt':
      return 'waiting for its mic permission…';
    default:
      return '';
  }
}

/**
 * First-run setup, one screen: invite speakers, then tune the room from the seat. The layout is suggested from the
 * speaker count and applied by the tune itself; "Adjust layout" opens the picture for anyone who wants to change it.
 */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const all = useRoomStore((s) => s.room?.devices);
  const devices = (all ?? []).filter((d) => d.connected);
  const scene = useRoomStore((s) => s.room?.scene);
  const cal = useRoomStore((s) => s.calibration);
  const sm = useRoomStore((s) => s.syncMeasure);
  const selfId = useRoomStore((s) => s.deviceId);
  const selfHasMic = devices.find((d) => d.id === selfId)?.caps.hasMic ?? true;
  const { code, joinUrl, qr } = useJoinLink();
  const layout = scene?.layout;
  const routed = isRoutedLayout(layout);
  // a room that already has a layout opens its picture (the host came back to change it)
  const [layoutOpen, setLayoutOpen] = useState(() => routed);
  const [started, setStarted] = useState(false);
  const busy = (cal.running && cal.step !== 'done' && cal.step !== 'error') || sm.running;
  const status = tuneStatus(devices, scene?.tune);
  const subs = devices.filter((d) => d.role === 'Sub').length;
  const suggested = suggestLayout(devices.length - subs);
  const seconds = Math.round((devices.length * TUNE_PERIOD_MS) / 1000) + 7;

  // a tune started here moves on by itself once it is done (its result lingers on the next screen)
  useEffect(() => {
    if (started && !cal.running && cal.step === 'done') onDone();
  }, [started, cal.running, cal.step, onDone]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-2 pb-28">
      <h1 data-testid="wizard-title" className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Set up your speakers
      </h1>
      <p className="mt-2 text-ink-200">
        Open this room on every phone, tablet or laptop you want to use as a speaker and turn its volume all the way up. Then sit where you
        listen and tap <strong className="text-ink-100">Tune the room</strong>.
      </p>

      <div className="mt-5 grid gap-6 sm:grid-cols-[11rem_1fr] sm:items-start">
        <div className="flex flex-col items-center gap-2">
          {qr ? <img src={qr} alt={`QR code to join, ${joinUrl}`} className="w-44 rounded-2xl bg-white p-2" /> : <div className="size-44 rounded-2xl bg-ink-800" />}
          <p className="font-mono text-2xl font-bold tracking-[0.18em] text-accent">{code}</p>
        </div>
        <div>
          <h2 className="text-sm text-ink-400">
            {devices.length} speaker{devices.length === 1 ? '' : 's'} connected ·{' '}
            {routed && layout ? layoutLabel(layout, subs > 0) : `${layoutLabel(suggested, subs > 0)} suggested`}
          </h2>
          <ul className="mt-2 divide-y divide-ink-800 rounded-2xl border border-ink-700" data-testid="wizard-speakers">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2" data-testid={`wizard-speaker-${d.id}`}>
                <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-5 shrink-0 text-ink-300" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {d.name}
                    {d.id === selfId && <span className="ml-2 text-xs text-ink-400">this device</span>}
                  </span>
                  <span className="block text-xs text-ink-400">
                    {[routed && d.role !== 'Full' ? SLOT_NAME[d.role] : null, micLine(d) || null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Button variant="ghost" className="!min-h-9 text-sm" onClick={() => act(() => roomActions.identify(d.id))}>
                  Beep
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-400" data-testid="wizard-tune-label">
            {status.label}
          </p>
        </div>
      </div>

      {selfHasMic ? (
        <p className="mt-5 text-sm text-ink-300">
          Each speaker plays one short chime in turn, about {seconds} seconds in all, while every laptop listens. Keep the room quiet.
        </p>
      ) : (
        <div className="mt-5 space-y-3">
          <p className="text-sm text-ink-300">
            This device has no microphone. Open this room on a phone, sit where you listen, and tune from there. Until then, each speaker
            uses a sensible preset for its type.
          </p>
          <Button onClick={() => devices.forEach((d) => act(() => roomActions.applyPresetEq(d.id)))}>Use presets for now</Button>
        </div>
      )}
      <div className="mt-4">
        <TuneStatus persistent testid="wizard-tune-status" />
      </div>

      <details className="mt-4" open={layoutOpen} onToggle={(e) => setLayoutOpen((e.target as HTMLDetailsElement).open)}>
        <summary data-testid="wizard-layout-toggle" className="cursor-pointer text-sm text-ink-300 hover:text-ink-100">
          Adjust layout
        </summary>
        {layoutOpen && (
          <div className="mt-3">
            <LayoutEditor devices={devices} />
          </div>
        )}
      </details>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          <Button variant="ghost" data-testid="wizard-later" onClick={onDone}>
            {cal.step === 'done' ? 'Done' : 'Skip for now'}
          </Button>
          <span className="flex-1" />
          {busy ? (
            <Button variant="danger" onClick={() => act(() => roomActions.cancelCalibration())}>
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="wizard-tune"
              disabled={!selfHasMic || !devices.length}
              onClick={() => {
                setStarted(true);
                act(() => roomActions.tune());
              }}
            >
              <Icon name="mic" className="size-4" /> {cal.step === 'done' ? 'Tune again' : 'Tune the room'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
