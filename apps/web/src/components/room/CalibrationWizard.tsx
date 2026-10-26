'use client';
import { useState } from 'react';
import { downloadFailedRecording, hasFailedRecording } from '@/lib/engine/calibration';
import { roomActions, useRoomStore } from '@/store/roomStore';
import type { CalibrationUi } from '@/store/types';
import { Button, Icon, IconButton, Panel, Select, Toggle, fmtSigned } from '../ui';
import { act, useCanControl } from './shared';
import { SyncMeasurePanel } from './SyncMeasure';

const STEPS = ['Sit where you listen with this device', 'Allow microphone', 'Tune: each speaker chimes in turn', 'Done'];

function stepIndex(c: CalibrationUi): number {
  switch (c.step) {
    case 'place':
      return 0;
    case 'mic':
      return 1;
    case 'recording':
    case 'analyzing':
      return 2;
    case 'done':
      return 3;
    default:
      return -1;
  }
}

export function CalibrationWizard() {
  const cal = useRoomStore((s) => s.calibration);
  const devices = useRoomStore((s) => s.room?.devices ?? null);
  const selfHasMic = useRoomStore((s) => s.room?.devices.find((d) => d.id === s.deviceId)?.caps.hasMic ?? true);
  const selfId = useRoomStore((s) => s.deviceId);
  const engine = useRoomStore((s) => s.engine);
  const canControl = useCanControl();
  const [chartDevice, setChartDevice] = useState<string | null>(null);
  if (!devices) return null;

  const idx = stepIndex(cal);
  const busy = cal.running && cal.step !== 'done' && cal.step !== 'error';
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  const chartId = chartDevice ?? cal.devices.find((d) => d.beforeDb)?.deviceId ?? null;
  const chartDev = cal.devices.find((d) => d.deviceId === chartId);
  const unheard = cal.devices.filter((d) => !d.heard);

  const presetAll = () => {
    const ids = canControl ? devices.filter((d) => d.connected).map((d) => d.id) : [selfId];
    for (const id of ids) act(() => roomActions.applyPresetEq(id));
  };

  return (
    <Panel title="Calibrate" icon="mic" className="lg:min-h-0 lg:flex-1">
      <p className="text-sm text-ink-200">
        Sit where you listen with <strong className="text-ink-100">this device</strong>. Every speaker plays one short chime in turn while every
        laptop listens: SyncSound measures how far apart they are, each one&rsquo;s delay, level and frequency response, then lines them up at
        your seat and EQs them.
      </p>

      <ol data-testid="calibration-step" data-step={cal.step} className="mt-5 space-y-2.5" aria-label="Calibration steps">
        {STEPS.map((label, i) => {
          const state = cal.step === 'error' ? 'idle' : i < idx ? 'done' : i === idx ? 'current' : 'idle';
          return (
            <li key={label} aria-current={state === 'current' ? 'step' : undefined} className="flex items-center gap-3 text-sm">
              {state === 'done' ? (
                <Icon name="check-circle" className="size-6 shrink-0 text-ok" />
              ) : (
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular ${
                    state === 'current' ? 'bg-accent text-accent-ink' : 'bg-ink-800 text-ink-400'
                  }`}
                >
                  {i + 1}
                </span>
              )}
              <span className={state === 'idle' ? 'text-ink-400' : 'text-ink-100'}>{label}</span>
            </li>
          );
        })}
      </ol>

      {busy && (
        <div className="mt-4" role="status">
          <div className="h-1 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(cal.progress * 100)}%` }} />
          </div>
          <p className="mt-2 flex items-center gap-2 text-sm text-ink-200">
            <Icon name="spinner" className="size-4 shrink-0 animate-spin" /> {cal.message || 'Working…'} Keep the room quiet.
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {busy ? (
          <Button variant="danger" onClick={() => act(() => roomActions.cancelCalibration())}>
            <Icon name="x" className="size-4" /> Cancel
          </Button>
        ) : (
          <Button variant="primary" data-testid="calibrate-start" disabled={!selfHasMic} onClick={() => act(() => roomActions.startCalibration())}>
            <Icon name="mic" className="size-4" /> {cal.step === 'done' ? 'Recalibrate' : 'Start calibration'}
          </Button>
        )}
        {!busy && (
          <Button data-testid="calibrate-quick" disabled={!selfHasMic} onClick={() => act(() => roomActions.startCalibration({ quick: true }))}>
            <Icon name="resync" className="size-4" /> Quick re-sync
          </Button>
        )}
        <Button variant="ghost" onClick={presetAll}>
          <Icon name="eq" className="size-4" /> Use device-class presets
        </Button>
      </div>
      {!selfHasMic && (
        <p className="mt-3 flex items-start gap-2 text-sm text-warn">
          <Icon name="mic-off" className="mt-0.5 size-4 shrink-0" />
          No microphone available on this device. Run calibration from a phone instead, or use device-class presets (generic EQ per phone /
          laptop / tablet).
        </p>
      )}

      {cal.step === 'error' && (
        <div role="alert" className="mt-4 rounded-row bg-bad/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-bad">
            <Icon name="x-circle" className="size-4 shrink-0" />
            Calibration failed: {cal.message || 'unknown error'}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-200">
            <li>Microphone blocked? Allow it from the lock icon in the address bar, then retry.</li>
            <li>Nothing heard? Turn every speaker up, keep the room quiet and hold this phone in the open (not in a pocket).</li>
            <li>Make sure every device&rsquo;s tab is in the foreground with the screen on.</li>
          </ul>
          {hasFailedRecording() && (
            <Button className="mt-3" onClick={downloadFailedRecording}>
              Save microphone recording (.wav)
            </Button>
          )}
        </div>
      )}
      {cal.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-warn">
          {cal.warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <Icon name="warning" className="mt-0.5 size-4 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}

      {cal.devices.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-2 text-xs font-medium tracking-widest text-ink-400 uppercase">Results</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="text-xs text-ink-400">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Speaker</th>
                  <th scope="col" className="px-2 py-2 font-medium">Heard</th>
                  <th scope="col" className="px-2 py-2 font-medium">Latency</th>
                  <th scope="col" className="px-2 py-2 font-medium">Distance</th>
                  <th scope="col" className="px-2 py-2 font-medium">Level</th>
                  <th scope="col" className="px-2 py-2 font-medium">Trim</th>
                  <th scope="col" className="px-2 py-2 font-medium">Rolloff</th>
                </tr>
              </thead>
              <tbody className="text-xs text-ink-200 tabular">
                {cal.devices.map((r) => {
                  const dev = devices.find((d) => d.id === r.deviceId);
                  return (
                    <tr key={r.deviceId} className="border-t border-ink-800">
                      <th scope="row" className="max-w-32 truncate py-2.5 pr-3 text-sm font-normal text-ink-100">
                        {nameOf(r.deviceId)}
                      </th>
                      <td className="px-2 py-2">
                        {r.heard ? (
                          <Icon name="check-circle" className="size-4 text-ok" label="heard" />
                        ) : (
                          <Icon name="x-circle" className="size-4 text-bad" label="not heard" />
                        )}
                      </td>
                      <td className="px-2 py-2">{r.relativeLatencyMs != null ? `${fmtSigned(r.relativeLatencyMs, 1)} ms` : '—'}</td>
                      <td className="px-2 py-2" title={r.ranged ? 'measured' : 'from where it is placed on the stage'}>
                        {r.deviceId === selfId || r.distanceM == null ? '—' : `${r.distanceM.toFixed(2)} m${r.ranged ? '' : '*'}`}
                      </td>
                      <td className="px-2 py-2">{r.levelDb != null ? `${r.levelDb.toFixed(1)} dB` : '—'}</td>
                      <td className="px-2 py-2">{dev ? `${fmtSigned(dev.trimDb, 1)} dB` : '—'}</td>
                      <td className="px-2 py-2">{r.rolloffHz != null ? `${Math.round(r.rolloffHz)} Hz` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {unheard.length > 0 && (
            <p className="mt-3 flex items-start gap-2 text-sm text-warn">
              <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
              Not heard: {unheard.map((d) => nameOf(d.deviceId)).join(', ')}. Turn them up, move them closer or check they aren&rsquo;t muted, then
              recalibrate, or set their latency by ear below.
            </p>
          )}
          {cal.freqs && chartDev?.beforeDb && (
            <div className="mt-6">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label htmlFor="fr-device" className="text-sm text-ink-200">Frequency response</label>
                <Select
                  id="fr-device"
                  value={chartId ?? ''}
                  onChange={(e) => setChartDevice(e.target.value)}
                  wrapClassName="min-w-0 max-w-full"
                >
                  {cal.devices
                    .filter((d) => d.beforeDb)
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {nameOf(d.deviceId)}
                      </option>
                    ))}
                </Select>
              </div>
              <FrChart freqs={cal.freqs} target={cal.targetDb} before={chartDev.beforeDb} after={chartDev.afterDb} />
            </div>
          )}
        </div>
      )}

      <div className="mt-8 space-y-1">
        <h3 className="mb-1 text-xs font-medium tracking-widest text-ink-400 uppercase">Fine-tune by ear</h3>
        <Toggle
          label="Click test"
          description="Every speaker ticks on the beat. Adjust each device's latency (Devices) until the ticks merge into one."
          checked={engine.clickTest}
          onChange={(v) => act(() => roomActions.setClickTest(v))}
        />
        <Toggle
          label="EQ A/B (bypass)"
          description={engine.eqBypassed ? 'Hearing the uncorrected sound (B)' : 'Hearing the calibrated EQ (A)'}
          checked={engine.eqBypassed}
          onChange={(v) => act(() => roomActions.setEqBypass(v))}
        />
      </div>

      <div className="mt-8">
        <h3 className="mb-1 text-xs font-medium tracking-widest text-ink-400 uppercase">Which one is that?</h3>
        <p className="mb-2 text-sm text-ink-300">Tap a speaker to make it beep and flash, so you can find it in the room.</p>
        <ul className="divide-y divide-ink-800">
          {devices
            .filter((d) => d.connected)
            .map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink-100">{d.name}</span>
                <span className="text-xs text-ink-400">{d.role}</span>
                <IconButton icon="bell" label={`Identify ${d.name}`} variant="ghost" onClick={() => act(() => roomActions.identify(d.id))} />
              </li>
            ))}
        </ul>
      </div>
      <SyncMeasurePanel />
    </Panel>
  );
}

/** Before / after / target magnitude on a log-frequency axis. */
function FrChart({ freqs, target, before, after }: { freqs: number[]; target: number[] | null; before: number[]; after: number[] | null }) {
  const Wd = 320;
  const H = 170;
  const m = { l: 30, r: 8, t: 8, b: 20 };
  const f0 = Math.log10(20);
  const f1 = Math.log10(20000);
  const all = [...before, ...(after ?? []), ...(target ?? [])].filter(Number.isFinite);
  const lo = Math.max(-36, Math.floor((Math.min(...all, -6) - 3) / 6) * 6);
  const hi = Math.min(18, Math.ceil((Math.max(...all, 6) + 3) / 6) * 6);
  const x = (f: number) => m.l + ((Math.log10(Math.max(f, 20)) - f0) / (f1 - f0)) * (Wd - m.l - m.r);
  const y = (v: number) => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);
  const path = (vals: number[]) =>
    vals
      .map((v, i) => {
        const f = freqs[i];
        return f == null || !Number.isFinite(v) || f < 20 || f > 20000 ? '' : `${x(f).toFixed(1)},${y(v).toFixed(1)}`;
      })
      .filter(Boolean)
      .map((p, i) => (i === 0 ? `M${p}` : `L${p}`))
      .join('');
  const ticks = [50, 100, 500, 1000, 5000, 10000];
  const dbTicks: number[] = [];
  for (let v = lo; v <= hi; v += 6) dbTicks.push(v);

  return (
    <figure>
      <svg viewBox={`0 0 ${Wd} ${H}`} className="w-full rounded-row bg-ink-950" role="img" aria-label="Frequency response before and after EQ, against the target curve">
        {dbTicks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={Wd - m.r} y1={y(v)} y2={y(v)} stroke="var(--color-ink-700)" strokeWidth={v === 0 ? 1 : 0.5} />
            <text x={m.l - 4} y={y(v) + 3} textAnchor="end" fontSize={8} fill="var(--color-ink-400)" className="font-mono">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((f) => (
          <g key={f}>
            <line x1={x(f)} x2={x(f)} y1={m.t} y2={H - m.b} stroke="var(--color-ink-800)" strokeWidth={0.5} />
            <text x={x(f)} y={H - 6} textAnchor="middle" fontSize={8} fill="var(--color-ink-400)" className="font-mono">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        {target && <path d={path(target)} fill="none" stroke="var(--color-ink-300)" strokeWidth={1} strokeDasharray="4 3" />}
        <path d={path(before)} fill="none" stroke="var(--color-role-r)" strokeWidth={1.4} opacity={0.85} />
        {after && <path d={path(after)} fill="none" stroke="var(--color-accent)" strokeWidth={1.8} />}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-3 text-xs text-ink-400">
        <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-role-r" aria-hidden /> before</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-accent" aria-hidden /> after EQ</span>
        <span className="flex items-center gap-1"><span className="h-0 w-4 border-t border-dashed border-ink-300" aria-hidden /> target</span>
        <span>dB vs Hz</span>
      </figcaption>
    </figure>
  );
}
