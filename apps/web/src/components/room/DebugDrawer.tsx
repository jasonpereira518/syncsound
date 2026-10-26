'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { Icon, fmtMs, fmtSigned } from '../ui';
import { isTypingTarget } from './shared';

export function DebugDrawer() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'd' || e.key === 'D') setOpen((o) => !o);
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        data-testid="debug-toggle"
        aria-expanded={open}
        aria-controls="debug-drawer"
        aria-keyshortcuts="D"
        onClick={() => setOpen(!open)}
        className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl border transition hover:text-accent ${open ? 'border-accent/70 bg-accent/15 text-accent' : 'border-transparent text-ink-300'}`}
      >
        <Icon name="bug" />
        <span className="sr-only">{open ? 'Hide' : 'Show'} debug info (D)</span>
      </button>
      {open && <DebugBody />}
    </>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-ink-400">{k}</dt>
      <dd className="text-right text-ink-100">{v}</dd>
    </>
  );
}

function DebugBody() {
  const clock = useRoomStore((s) => s.clock);
  const engine = useRoomStore((s) => s.engine);
  const capture = useRoomStore((s) => s.capture);
  const remote = useRoomStore((s) => s.remote);
  const devices = useRoomStore((s) => s.room?.devices ?? []);
  const selfId = useRoomStore((s) => s.deviceId);
  const conn = useRoomStore((s) => s.conn);

  return (
    <aside
      id="debug-drawer"
      aria-label="Debug info"
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70dvh] overflow-y-auto border-t border-ink-600 bg-ink-950/97 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] font-mono text-xs backdrop-blur lg:inset-x-auto lg:top-16 lg:right-0 lg:max-h-none lg:w-[420px] lg:border-t-0 lg:border-l lg:pb-20"
    >
      <h2 className="mb-3 font-display text-base font-semibold">Debug</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <section aria-label="Clock">
          <h3 className="mb-1 text-[11px] tracking-widest text-accent uppercase">Clock</h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular">
            <Row k="conn" v={conn} />
            <Row k="offset vs wall clock" v={clock ? `${fmtSigned(clock.offsetMs - performance.timeOrigin, 2)} ms` : '—'} />
            <Row k="rtt" v={fmtMs(clock?.rttMs, 2)} />
            <Row k="jitter" v={fmtMs(clock?.jitterMs, 2)} />
            <Row k="drift" v={clock ? `${fmtSigned(clock.driftPpm, 1)} ppm` : '—'} />
            <Row k="samples" v={clock ? `${clock.samples}${clock.converged ? ' ✓ converged' : ' …'}` : '—'} />
          </dl>
        </section>
        <section aria-label="Engine">
          <h3 className="mb-1 text-[11px] tracking-widest text-accent uppercase">Engine</h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular">
            <Row k="ctx" v={`${engine.ctxState}${engine.sampleRate ? ` @ ${engine.sampleRate}` : ''}`} />
            <Row k="autoLatency" v={fmtMs(engine.autoLatencyMs, 1)} />
            <Row k="outputTimestamp" v={engine.usingOutputTimestamp ? 'yes' : 'no'} />
            <Row k="compensation" v={fmtMs(engine.compensationMs, 1)} />
            <Row k="sync error" v={fmtMs(engine.syncErrorMs, 2)} />
            <Row k="playbackRate" v={engine.playbackRate.toFixed(5)} />
            <Row k="corrections" v={`rate ${engine.corrections.rate} · resched ${engine.corrections.reschedule}`} />
            <Row k="tick gap" v={fmtMs(engine.tickGapMs, 0)} />
            <Row k="output steps" v={String(engine.audioSteps)} />
            <Row k="buffer" v={`${engine.bufferState}${engine.loadedTrackId ? ` (${engine.loadedTrackId.slice(0, 8)})` : ''}`} />
            <Row k="wake lock" v={engine.wakeLock ? 'held' : 'no'} />
          </dl>
        </section>
        <section aria-label="Capture and remote">
          <h3 className="mb-1 text-[11px] tracking-widest text-accent uppercase">Capture · remote</h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular">
            <Row k="capture" v={capture.active ? `sending (${capture.peers})` : capture.receiving ? 'receiving' : 'off'} />
            <Row k="pipeline delay" v={fmtMs(capture.pipelineDelayMs, 0)} />
            <Row k="silent" v={capture.silent ? 'YES' : 'no'} />
            <Row k="remote error" v={fmtMs(remote.errorMs, 1)} />
            <Row k="remote |err| mean" v={fmtMs(remote.meanAbsErrorMs, 1)} />
            <Row k="remote seeks" v={remote.seeks} />
          </dl>
        </section>
      </div>
      <section aria-label="Devices" className="mt-4">
        <h3 className="mb-1 text-[11px] tracking-widest text-accent uppercase">Devices</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[360px] tabular">
            <thead className="text-ink-500">
              <tr>
                <th scope="col" className="py-1 text-left font-normal">device</th>
                <th scope="col" className="text-right font-normal">offset</th>
                <th scope="col" className="text-right font-normal">rtt</th>
                <th scope="col" className="text-right font-normal">err</th>
                <th scope="col" className="text-right font-normal">buffer</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-t border-ink-800">
                  <th scope="row" className="max-w-28 truncate py-1 text-left font-normal">
                    {d.id === selfId ? '★ ' : ''}
                    {d.name}
                  </th>
                  <td className="text-right">{d.stats ? fmtSigned(d.stats.offsetMs, 1) : '—'}</td>
                  <td className="text-right">{d.stats ? d.stats.rttMs.toFixed(1) : '—'}</td>
                  <td className="text-right">{d.stats ? d.stats.syncErrorMs.toFixed(2) : '—'}</td>
                  <td className="text-right">{d.stats?.bufferState ?? (d.connected ? '—' : 'offline')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </aside>
  );
}
