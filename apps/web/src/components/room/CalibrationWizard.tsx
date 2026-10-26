'use client';
import { useState } from 'react';
import { downloadFailedRecording, hasFailedRecording } from '@/lib/engine/calibration';
import { roomActions, useRoomStore } from '@/store/roomStore';
import type { CalibrationUi } from '@/store/types';
import { Button, Disclosure, Icon, Panel, Toggle, fmtSigned, selectClass } from '../ui';
import { act, useCanControl } from './shared';
import { SyncMeasurePanel } from './SyncMeasure';

const STEPS = ['Sit where you listen', 'Allow microphone', 'Each speaker sweeps', 'Done'];

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
  const measuring = useRoomStore((s) => s.syncMeasure.step !== 'idle');
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
    <Panel title="Calibrate" className="lg:min-h-0 lg:flex-1" headerClassName="lg:sr-only">
      <p className="text-sm text-ink-300">
        {selfHasMic
          ? 'Sit where you listen with this device. Each speaker plays a short sweep.'
          : 'This device has no microphone. Calibrate from a phone, or use presets.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {busy ? (
          <Button variant="danger" onClick={() => act(() => roomActions.cancelCalibration())}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" data-testid="calibrate-start" disabled={!selfHasMic} onClick={() => act(() => roomActions.startCalibration())}>
            <Icon name="mic" className="size-4" /> {cal.step === 'done' ? 'Recalibrate' : 'Calibrate'}
          </Button>
        )}
        {!busy && (
          <Button variant="ghost" data-testid="calibrate-quick" disabled={!selfHasMic} onClick={() => act(() => roomActions.startCalibration({ quick: true }))}>
            Quick re-sync
          </Button>
        )}
        <Button variant="ghost" className="text-ink-400" onClick={presetAll}>
          Use presets
        </Button>
      </div>

      {/* always rendered: its data-step is the calibration state hook for tests and assistive tech */}
      <div data-testid="calibration-step" data-step={cal.step} role="status" className="mt-3 text-sm">
        {busy && (
          <>
            <div className="h-1 overflow-hidden rounded-full bg-ink-800">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(cal.progress * 100)}%` }} />
            </div>
            <p className="mt-2 text-ink-300">
              <span className="text-ink-500">
                {idx + 1}/{STEPS.length} {STEPS[idx] ?? ''} ·{' '}
              </span>
              {cal.message || 'Working…'} Keep the room quiet.
            </p>
          </>
        )}
      </div>

      {cal.step === 'error' && (
        <div role="alert" className="mt-1 text-sm">
          <p className="text-bad">Calibration failed: {cal.message || 'unknown error'}</p>
          <Disclosure summary="Tips">
            <ul className="list-disc space-y-1 pb-2 pl-5 text-ink-300">
              <li>Microphone blocked? Allow it from the lock icon in the address bar.</li>
              <li>Nothing heard? Turn every speaker up and keep this device in the open.</li>
              <li>Keep every device&rsquo;s tab in front with the screen on.</li>
            </ul>
            {hasFailedRecording() && (
              <Button variant="ghost" className="!px-2" onClick={downloadFailedRecording}>
                Save microphone recording (.wav)
              </Button>
            )}
          </Disclosure>
        </div>
      )}
      {cal.warnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-warn">
          {cal.warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <Icon name="warning" className="mt-0.5 size-4 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}

      {cal.devices.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm text-ink-400">Results</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th scope="col" className="py-1.5 pr-2 font-normal">Speaker</th>
                  <th scope="col" className="px-2 font-normal">Delay</th>
                  <th scope="col" className="px-2 font-normal">Distance</th>
                  <th scope="col" className="pl-2 text-right font-normal">Level</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs tabular">
                {cal.devices.map((r) => {
                  const dev = devices.find((d) => d.id === r.deviceId);
                  return (
                    <tr key={r.deviceId} className="border-t border-ink-800">
                      <th scope="row" className="max-w-32 truncate py-2 pr-2 font-sans text-sm font-normal">
                        {r.heard ? null : (
                          <Icon name="warning" label="not heard" className="mr-1.5 inline size-3.5 align-[-2px] text-warn" />
                        )}
                        {nameOf(r.deviceId)}
                      </th>
                      <td className="px-2">{r.relativeLatencyMs != null ? `${fmtSigned(r.relativeLatencyMs, 1)} ms` : '—'}</td>
                      <td className="px-2" title={r.ranged ? 'measured' : 'from where it is placed on the stage'}>
                        {r.deviceId === selfId || r.distanceM == null ? '—' : `${r.distanceM.toFixed(2)} m${r.ranged ? '' : '*'}`}
                      </td>
                      <td
                        className="pl-2 text-right"
                        title={`trim ${dev ? `${fmtSigned(dev.trimDb, 1)} dB` : '—'}, rolloff ${r.rolloffHz != null ? `${Math.round(r.rolloffHz)} Hz` : '—'}`}
                      >
                        {r.levelDb != null ? `${r.levelDb.toFixed(1)} dB` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {unheard.length > 0 && (
            <p className="mt-2 text-sm text-warn">
              Not heard: {unheard.map((d) => nameOf(d.deviceId)).join(', ')}. Turn them up or move them closer, then recalibrate.
            </p>
          )}
          {cal.freqs && chartDev?.beforeDb && (
            <Disclosure summary="Frequency response" className="mt-2">
              <label htmlFor="fr-device" className="sr-only">
                Speaker
              </label>
              <select id="fr-device" value={chartId ?? ''} onChange={(e) => setChartDevice(e.target.value)} className={`${selectClass} mb-2 min-w-0`}>
                {cal.devices
                  .filter((d) => d.beforeDb)
                  .map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {nameOf(d.deviceId)}
                    </option>
                  ))}
              </select>
              <FrChart freqs={cal.freqs} target={cal.targetDb} before={chartDev.beforeDb} after={chartDev.afterDb} />
            </Disclosure>
          )}
        </div>
      )}

      <Disclosure summary="Tools" defaultOpen={measuring} className="mt-4 border-t border-ink-800 pt-1" testid="calibration-tools">
        <div className="space-y-1 pb-2">
          <Toggle label="Click test (every speaker ticks on the beat)" checked={engine.clickTest} onChange={(v) => act(() => roomActions.setClickTest(v))} />
          <Toggle
            label={engine.eqBypassed ? 'EQ bypassed (hearing B)' : 'EQ on (hearing A)'}
            checked={engine.eqBypassed}
            onChange={(v) => act(() => roomActions.setEqBypass(v))}
          />
        </div>
        <SyncMeasurePanel />
      </Disclosure>
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
      <svg viewBox={`0 0 ${Wd} ${H}`} className="w-full rounded-lg border border-ink-800 bg-ink-950" role="img" aria-label="Frequency response before and after EQ, against the target curve">
        {dbTicks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={Wd - m.r} y1={y(v)} y2={y(v)} stroke="var(--color-ink-700)" strokeWidth={v === 0 ? 1 : 0.5} />
            <text x={m.l - 4} y={y(v) + 3} textAnchor="end" fontSize={8} fill="var(--color-ink-500)" className="font-mono">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((f) => (
          <g key={f}>
            <line x1={x(f)} x2={x(f)} y1={m.t} y2={H - m.b} stroke="var(--color-ink-800)" strokeWidth={0.5} />
            <text x={x(f)} y={H - 6} textAnchor="middle" fontSize={8} fill="var(--color-ink-500)" className="font-mono">
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
