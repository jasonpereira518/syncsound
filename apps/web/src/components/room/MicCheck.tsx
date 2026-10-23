'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomStore } from '@/store/roomStore';
import { openMic, REMOTE_MIC_RE, savedMicId, setMicId } from '@/lib/mic';
import { Button, Icon, inputClass } from '../ui';

/**
 * Before tuning: which microphone will listen, a picker, and a live level bar. A dead or wrong mic (another
 * device's mic picked by the OS, a muted input) is the usual reason nothing is heard, so check it first.
 */
export function MicCheck() {
  const tuning = useRoomStore((s) => s.calibration.running || s.syncMeasure.running);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [label, setLabel] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  const list = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setMics(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'));
    } catch {
      /* no media devices API */
    }
  }, []);

  useEffect(() => {
    setChosen(savedMicId() ?? '');
    void list();
    navigator.mediaDevices?.addEventListener?.('devicechange', list);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', list);
      stop.current?.();
    };
  }, [list]);

  const halt = () => {
    stop.current?.();
    stop.current = null;
    setTesting(false);
    setLevel(0);
  };

  const test = async () => {
    halt();
    setErr(null);
    try {
      const stream = await openMic();
      const track = stream.getAudioTracks()[0];
      setLabel(track?.label || 'the default microphone');
      void list(); // labels appear once permission is granted
      const ctx = new AudioContext();
      // created after an await, i.e. outside the tap's gesture: it may start suspended (a suspended analyser reads silence)
      await ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      let raf = 0;
      let shown = 0;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const x of buf) peak = Math.max(peak, Math.abs(x));
        // −60 dBFS … 0 dBFS → 0 … 1, with peak hold falling over ~1 s (a raw frame-by-frame level just flickers)
        const now = Math.max(0, Math.min(1, (20 * Math.log10(peak + 1e-9) + 60) / 60));
        shown = Math.max(now, shown - 1 / 60);
        setLevel(shown);
        raf = requestAnimationFrame(tick);
      };
      tick();
      stop.current = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
      };
      setTesting(true);
    } catch (e) {
      setErr(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it for this site, then test again.'
          : `Couldn't open the microphone: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  // tuning opens the mic itself
  useEffect(() => {
    if (tuning) halt();
  }, [tuning]);

  const pick = (id: string) => {
    setChosen(id);
    setMicId(id || null);
    if (testing) void test();
  };

  const remote = label !== null && REMOTE_MIC_RE.test(label);
  return (
    <div className="rounded-2xl border border-ink-700 p-3" data-testid="mic-check">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="mic-select" className="mb-1 block text-sm text-ink-300">
            Microphone that listens
          </label>
          <select id="mic-select" data-testid="mic-select" value={chosen} onChange={(e) => pick(e.target.value)} className={inputClass}>
            <option value="">Default microphone</option>
            {mics.map((m, i) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
        {testing ? (
          <Button variant="ghost" onClick={halt}>
            Stop test
          </Button>
        ) : (
          <Button data-testid="mic-test" disabled={tuning} onClick={() => void test()}>
            <Icon name="mic" className="size-4" /> Test microphone
          </Button>
        )}
      </div>
      {testing && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-ink-800" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div data-testid="mic-level" data-level={level.toFixed(2)} className="h-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <p className="mt-1 text-sm text-ink-400">
            Listening with <strong className="text-ink-200">{label}</strong>. Say something: the bar should jump. If it stays flat, pick another microphone.
          </p>
        </div>
      )}
      {remote && (
        <p className="mt-2 text-sm text-warn">
          {label} isn&rsquo;t this device&rsquo;s own microphone. Tuning measures what reaches <em>this</em> device, so pick its built-in microphone.
        </p>
      )}
      {err && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {err}
        </p>
      )}
    </div>
  );
}

/** After a run: which mic was used, how loud the recording was, and how close each speaker came to being heard. */
export function TuningDiagnostics() {
  const dx = useRoomStore((s) => s.calibration.diagnostics);
  const step = useRoomStore((s) => s.calibration.step);
  const devices = useRoomStore((s) => s.room?.devices);
  if (!dx || (step !== 'error' && step !== 'done') || dx.devices.every((d) => d.heard)) return null;
  const name = (id: string) => devices?.find((d) => d.id === id)?.name ?? 'Speaker';
  return (
    <details className="rounded-xl border border-ink-700 px-3 py-2 text-sm" data-testid="tuning-diagnostics" open={step === 'error'}>
      <summary className="cursor-pointer text-ink-300">What the microphone heard</summary>
      <p className="mt-2 text-ink-300">
        Microphone: <strong className="text-ink-100">{dx.micLabel}</strong>. Loudest sound recorded: {dx.recordingPeakDb.toFixed(0)} dBFS
        {dx.recordingPeakDb < -60 ? ' (almost silent: this mic isn’t picking up the room)' : ''}.
      </p>
      <ul className="mt-1 space-y-0.5 text-ink-400">
        {dx.devices.map((d) => (
          <li key={d.deviceId}>
            {name(d.deviceId)}:{' '}
            {d.heard
              ? 'heard'
              : d.bestSnrDb === null
                ? 'not measured'
                : `not heard (its chirp came through ${d.bestSnrDb.toFixed(0)} dB above the background; tuning needs 10 dB)`}
          </li>
        ))}
      </ul>
    </details>
  );
}
