'use client';
import { useEffect, useRef, useState } from 'react';
import { LayoutId, type Device, type DeviceRole } from '@syncsound/protocol';
import { isRoutedLayout, TUNE_PERIOD_MS, LAYOUT_SLOTS, layoutLabel, suggestLayout } from '@syncsound/audio-core';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, CLASS_ICON, Icon } from '../ui';
import { RoomDiagram, SLOT_NAME } from './RoomDiagram';
import { useJoinLink } from './RoomHeader';
import { act } from './shared';
import { TuneStatus } from './TuneStatus';

const STANDARD = LayoutId.options.filter((l) => isRoutedLayout(l));
const STEP_TITLES = ['Add your speakers', 'Choose your sound', 'Tune the room'] as const;

/** First-run setup for a room: invite speakers → pick a layout and slots → acoustic tuning from the seat. */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const all = useRoomStore((s) => s.room?.devices);
  const devices = (all ?? []).filter((d) => d.connected);
  const busy = useRoomStore((s) => s.calibration.running || s.syncMeasure.running);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-2 pb-28">
      <ol className="flex gap-2" aria-label="Setup steps">
        {STEP_TITLES.map((t, i) => (
          <li key={t} className="flex-1" aria-current={i === step ? 'step' : undefined}>
            <span className={`block h-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-ink-700'}`} />
            <span className={`mt-1.5 block text-xs ${i === step ? 'text-ink-100' : 'text-ink-400'}`}>
              {i + 1}. {t}
            </span>
          </li>
        ))}
      </ol>
      <h1 data-testid="wizard-title" className="mt-6 font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {STEP_TITLES[step]}
      </h1>
      <div className="mt-4 flex-1">
        {step === 0 && <AddSpeakers devices={devices} />}
        {step === 1 && <ChooseSound devices={devices} />}
        {step === 2 && <Tune devices={devices} />}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          {step > 0 ? (
            <Button variant="ghost" disabled={busy} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" data-testid="wizard-later" onClick={onDone}>
              Set up later
            </Button>
          )}
          <span className="flex-1" />
          {step < 2 ? (
            <Button variant="primary" data-testid="wizard-next" disabled={!devices.length} onClick={() => setStep(step + 1)}>
              {step === 0 ? 'Choose your sound' : 'Tune the room'}
            </Button>
          ) : (
            <Button variant="primary" data-testid="wizard-finish" disabled={busy} onClick={onDone}>
              Finish
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddSpeakers({ devices }: { devices: Device[] }) {
  const { code, joinUrl, qr } = useJoinLink();
  const selfId = useRoomStore((s) => s.deviceId);
  return (
    <div className="grid gap-6 sm:grid-cols-[13rem_1fr] sm:items-start">
      <div className="flex flex-col items-center gap-2">
        {qr ? <img src={qr} alt={`QR code to join, ${joinUrl}`} className="w-52 rounded-2xl bg-white p-2" /> : <div className="size-52 rounded-2xl bg-ink-800" />}
        <p className="font-mono text-2xl font-bold tracking-[0.18em] text-accent">{code}</p>
      </div>
      <div>
        <p className="text-ink-200">
          Scan this code with every phone, tablet or laptop you want to use as a speaker, then tap{' '}
          <strong className="text-ink-100">Use this device as a speaker</strong> on it. Turn each one&rsquo;s volume all the way up.
        </p>
        <h2 className="mt-5 text-sm text-ink-400">
          {devices.length} speaker{devices.length === 1 ? '' : 's'} connected
        </h2>
        <ul className="mt-2 divide-y divide-ink-800 rounded-2xl border border-ink-700" data-testid="wizard-speakers">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-5 shrink-0 text-ink-300" />
              <span className="min-w-0 flex-1 truncate">
                {d.name}
                {d.id === selfId && <span className="ml-2 text-xs text-ink-400">this device</span>}
              </span>
              <Button variant="ghost" className="!min-h-9 text-sm" onClick={() => act(() => roomActions.identify(d.id))}>
                Play a beep
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ChooseSound({ devices }: { devices: Device[] }) {
  const scene = useRoomStore((s) => s.room?.scene);
  const [slot, setSlot] = useState<DeviceRole | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (slot) picker.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [slot]);
  const subs = devices.filter((d) => d.role === 'Sub');
  const suggested = suggestLayout(devices.length - subs.length);
  const layout = scene?.layout;
  const routed = isRoutedLayout(layout);

  // first visit: start from the suggestion so the diagram is never empty
  useEffect(() => {
    if (!routed) act(() => roomActions.setLayout(suggested));
  }, [routed, suggested]);
  if (!scene || !routed) return null;

  const options = [suggested, ...STANDARD.filter((l) => l !== suggested)];
  const missing = LAYOUT_SLOTS[layout].filter((s) => !devices.some((d) => d.role === s));
  const unplaced = devices.filter((d) => d.role === 'Full');

  return (
    <div className="space-y-5">
      <p className="text-ink-200">
        With {devices.length} speaker{devices.length === 1 ? '' : 's'}, <strong className="text-ink-100">{layoutLabel(suggested, subs.length > 0)}</strong> fits
        best. Tap a spot in the room to choose which speaker sits there.
      </p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Speaker layout">
        {options.map((l) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={layout === l}
            data-testid={`wizard-layout-${l}`}
            onClick={() => act(() => roomActions.setLayout(l))}
            className={`min-h-10 rounded-full border px-4 text-sm transition ${
              layout === l ? 'border-accent bg-accent/15 text-ink-100' : 'border-ink-600 text-ink-300 hover:border-ink-400'
            }`}
          >
            {layoutLabel(l, subs.length > 0)}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-ink-700 bg-ink-950 p-2">
        <RoomDiagram layout={layout} scene={scene} devices={devices} selected={slot} onSlot={(s) => setSlot(s === slot ? null : s)} />
      </div>

      {slot ? (
        <div ref={picker} className="rounded-2xl border border-accent/40 p-3">
          <h2 className="text-sm text-ink-300">Who plays {SLOT_NAME[slot].toLowerCase()}?</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {devices.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={d.role === slot}
                data-testid={`assign-${d.id}`}
                onClick={() => {
                  act(() => roomActions.assignSlot(d.id, d.role === slot ? 'Full' : slot));
                  setSlot(null);
                }}
                className={`flex min-h-10 items-center gap-2 rounded-full border px-3 text-sm ${
                  d.role === slot ? 'border-accent bg-accent/15' : 'border-ink-600 hover:border-ink-400'
                }`}
              >
                <Icon name={CLASS_ICON[d.caps.deviceClass]} className="size-4" />
                {d.name}
                {d.role !== 'Full' && d.role !== slot && <span className="text-xs text-ink-400">now {SLOT_NAME[d.role].toLowerCase()}</span>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="space-y-1 text-sm text-ink-300">
          {missing.length > 0 && <li>Empty spots ({missing.map((s) => SLOT_NAME[s].toLowerCase()).join(', ')}) are covered by the nearest speakers.</li>}
          {unplaced.length > 0 && (
            <li className="text-warn">
              {unplaced.map((d) => d.name).join(', ')} {unplaced.length === 1 ? 'has' : 'have'} no spot yet and will stay silent.
            </li>
          )}
          <li>A speaker with a big bass driver can be your subwoofer: tap the corner spot.</li>
        </ul>
      )}
    </div>
  );
}

function Tune({ devices }: { devices: Device[] }) {
  const cal = useRoomStore((s) => s.calibration);
  const sm = useRoomStore((s) => s.syncMeasure);
  const selfHasMic = useRoomStore((s) => s.room?.devices.find((d) => d.id === s.deviceId)?.caps.hasMic ?? true);
  const busy = (cal.running && cal.step !== 'done' && cal.step !== 'error') || sm.running;
  const seconds = Math.round((devices.length * TUNE_PERIOD_MS) / 1000) + 7;

  if (!selfHasMic) {
    return (
      <div className="space-y-4">
        <p className="text-ink-200">
          This device has no microphone. Open this room on a phone, sit where you listen, and tune from there. Until then, each speaker uses a
          sensible preset for its type.
        </p>
        <Button onClick={() => devices.forEach((d) => act(() => roomActions.applyPresetEq(d.id)))}>Use presets for now</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-ink-200">
        Check that every speaker&rsquo;s own volume is all the way up (each one shows a reminder). Then sit where you usually listen with
        this device in front of you and keep the room quiet. Each speaker plays one short chime in turn, about {seconds} seconds in all, while
        every laptop listens (each asks once for its microphone). SyncSound measures how far apart they are, lines them up in time at your
        seat and matches their loudness.
      </p>
      {busy ? (
        <Button variant="danger" onClick={() => act(() => roomActions.cancelCalibration())}>
          Stop
        </Button>
      ) : (
        <Button variant="primary" data-testid="wizard-tune" onClick={() => act(() => roomActions.startCalibration())}>
          <Icon name="mic" className="size-4" /> {cal.step === 'done' ? 'Tune again' : 'Start tuning'}
        </Button>
      )}
      <TuneStatus persistent testid="wizard-tune-status" />
    </div>
  );
}
