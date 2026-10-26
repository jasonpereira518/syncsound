'use client';
import { useState } from 'react';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { Badge, Button, selectClass } from '../ui';
import { act } from './shared';

const DURATIONS = [10, 30, 60] as const;

/** Sync-measurement tool (spec §11.1): synchronized clicks from every device → per-device error + histogram. */
export function SyncMeasurePanel() {
  const m = useRoomStore((s) => s.syncMeasure);
  const calRunning = useRoomStore((s) => s.calibration.running);
  const devices = useRoomStore((s) => s.room?.devices ?? []);
  const [duration, setDuration] = useState<number>(60);
  const busy = m.running && (m.step === 'recording' || m.step === 'analyzing');
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  const maxCount = Math.max(1, ...(m.histogram?.counts ?? [1]));

  return (
    <section className="mt-2 border-t border-ink-800 pt-3" aria-labelledby="sync-measure-title">
      <h3 id="sync-measure-title" className="text-sm text-ink-200">
        Measure sync
      </h3>
      <p className="mt-0.5 text-xs text-ink-400">Every speaker clicks; this microphone measures how far apart they land.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <span className="sr-only">Duration</span>
          <select
            data-testid="sync-measure-duration"
            className={selectClass}
            value={duration}
            disabled={busy}
            onChange={(e) => setDuration(Number(e.target.value))}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} s
              </option>
            ))}
          </select>
        </label>
        {busy ? (
          <Button onClick={() => act(() => roomActions.cancelCalibration())}>Cancel</Button>
        ) : (
          <Button
            data-testid="sync-measure-start"
            disabled={calRunning}
            onClick={() => act(() => roomActions.startSyncMeasurement(duration))}
          >
            Measure
          </Button>
        )}
      </div>
      {m.step !== 'idle' && (
        <div data-testid="sync-measure-status" data-step={m.step} className="mt-3" aria-live="polite">
          {busy && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-valuenow={Math.round(m.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Measurement progress">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${m.progress * 100}%` }} />
            </div>
          )}
          <p className={`mt-2 text-sm ${m.step === 'error' ? 'text-bad' : 'text-ink-200'}`}>{m.message}</p>
          {m.warnings.map((w) => (
            <p key={w} className="text-sm text-warn">
              {w}
            </p>
          ))}
        </div>
      )}
      {m.step === 'done' && m.histogram && (
        <div data-testid="sync-measure-result" className="mt-3">
          <svg viewBox="0 0 300 90" className="w-full" role="img" aria-label="Histogram of inter-device sync error">
            {m.histogram.counts.map((c, i) => {
              const w = 300 / m.histogram!.counts.length;
              const h = (c / maxCount) * 70;
              const center = (m.histogram!.edgesMs[i]! + m.histogram!.edgesMs[i + 1]!) / 2;
              const tone = Math.abs(center) < 5 ? 'var(--color-ok)' : Math.abs(center) < 20 ? 'var(--color-warn)' : 'var(--color-bad)';
              return <rect key={i} x={i * w + 0.5} y={75 - h} width={Math.max(0.5, w - 1)} height={h} fill={tone} />;
            })}
            <line x1="150" x2="150" y1="0" y2="75" stroke="currentColor" strokeOpacity="0.3" />
            <text x="0" y="88" fontSize="8" fill="currentColor" opacity="0.6">
              {m.histogram.edgesMs[0]} ms
            </text>
            <text x="150" y="88" fontSize="8" textAnchor="middle" fill="currentColor" opacity="0.6">
              0
            </text>
            <text x="300" y="88" fontSize="8" textAnchor="end" fill="currentColor" opacity="0.6">
              +{m.histogram.edgesMs.at(-1)} ms
            </text>
          </svg>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-xs text-ink-400">
              <tr>
                <th className="py-1 font-normal">Speaker</th>
                <th className="font-normal">Heard</th>
                <th className="font-normal">Mean</th>
                <th className="font-normal">p95</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular">
              {m.devices.map((d) => (
                <tr key={d.deviceId}>
                  <td className="py-1 font-sans">{nameOf(d.deviceId)}</td>
                  <td>
                    {d.detected}/{d.total}
                  </td>
                  <td>{Number.isFinite(d.meanMs) ? `${d.meanMs.toFixed(1)} ms` : '—'}</td>
                  <td>
                    {Number.isFinite(d.p95AbsMs) ? (
                      <Badge tone={d.p95AbsMs < 10 ? 'ok' : d.p95AbsMs < 30 ? 'warn' : 'bad'}>{d.p95AbsMs.toFixed(1)} ms</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
