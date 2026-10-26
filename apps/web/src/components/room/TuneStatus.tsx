'use client';
import { useEffect, useState } from 'react';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Button, Icon } from '../ui';
import { SLOT_NAME } from './RoomDiagram';
import { act } from './shared';

/** how long a finished run's result stays on screen in the simple views (the setup screen keeps it) */
const LINGER_MS = 20_000;

/**
 * What a tune run started on this device is doing and what it found: progress while it runs, one line per speaker
 * when it is done, the warnings in plain words, the error with a retry. Shared by the setup screen, Now Playing and
 * a guest's screen (the "tune again" banner), so a run started anywhere has visible feedback.
 */
export function TuneStatus({ persistent = false, testid = 'tune-status' }: { persistent?: boolean; testid?: string }) {
  const cal = useRoomStore((s) => s.calibration);
  const sm = useRoomStore((s) => s.syncMeasure);
  const devices = useRoomStore((s) => s.room?.devices ?? []);
  const selfId = useRoomStore((s) => s.deviceId);
  const [lingerUntil, setLingerUntil] = useState(0);
  const finished = cal.step === 'done' || cal.step === 'error';
  useEffect(() => {
    if (!finished) return;
    setLingerUntil(Date.now() + LINGER_MS);
    const t = setTimeout(() => setLingerUntil(0), LINGER_MS);
    return () => clearTimeout(t);
  }, [finished, cal.message]);

  const busy = cal.running && !finished;
  const visible = persistent ? cal.step !== 'idle' : busy || (finished && Date.now() < lingerUntil);
  if (!visible) return null;
  const byId = new Map(devices.map((d) => [d.id, d]));
  const jitterOf = (id: string) => (sm.step === 'done' ? sm.devices.find((m) => m.deviceId === id)?.stdMs : undefined);

  return (
    <div role="status" data-testid={testid} data-step={cal.step} className="rounded-2xl border border-ink-700 p-4">
      <p className={cal.step === 'error' ? 'text-bad' : 'text-ink-100'}>{cal.step === 'error' ? `Tuning failed: ${cal.message}` : cal.message}</p>
      {busy && (
        <>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(cal.progress * 100)}%` }} />
          </div>
          <Button variant="ghost" className="mt-3 !min-h-9 text-sm" onClick={() => act(() => roomActions.cancelCalibration())}>
            Stop
          </Button>
        </>
      )}
      {cal.step === 'done' && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {cal.devices.map((r) => {
            const d = byId.get(r.deviceId);
            const jitter = d?.caps.deviceClass === 'bluetooth' ? jitterOf(d.id) : undefined;
            return (
              <li key={r.deviceId} data-testid={`tune-row-${r.deviceId}`} className="flex items-start gap-2">
                <Icon name={r.heard ? 'check' : 'warning'} className={`mt-0.5 size-4 shrink-0 ${r.heard ? 'text-ok' : 'text-warn'}`} />
                <span>
                  <strong className="font-medium">{d?.name ?? 'Speaker'}</strong>
                  {d && d.role !== 'Full' && <span className="text-ink-400"> ({SLOT_NAME[d.role].toLowerCase()})</span>}
                  {r.heard && r.distanceM != null && r.deviceId !== selfId && (
                    <span className="text-ink-400">
                      {' '}
                      {r.distanceM.toFixed(1)} m away{r.ranged ? '' : ' (placed by hand)'}
                    </span>
                  )}
                  {r.heard
                    ? d?.volumeUpDb
                      ? `: in sync, but about ${Math.round(d.volumeUpDb)} dB quieter. Turn it up and tune again.`
                      : ': in sync, level matched'
                    : ': not heard. Check its volume and that it is unmuted.'}
                  {jitter !== undefined && (
                    <span data-testid={`bt-jitter-${r.deviceId}`} className="block text-ink-400">
                      Bluetooth timing varies by about ±{jitter.toFixed(1)} ms{jitter >= 1 ? ', so it can drift slightly from the others' : ''}.
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {cal.step === 'done' && cal.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-warn">
          {cal.warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <Icon name="warning" className="mt-0.5 size-4 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {cal.step === 'error' && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-ink-300">Allow the microphone, turn every speaker up and keep the room quiet, then try again.</p>
          <Button className="!min-h-9 text-sm" data-testid="tune-retry" onClick={() => act(() => roomActions.startCalibration({ quick: cal.quick }))}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
