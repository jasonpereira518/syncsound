import type { CalibrationPlan } from '@syncsound/protocol';
import { CALIBRATION_LEAD_MS, type CalibrationInput } from './calibration';
import { detectArrival } from './measure';
import { CALIBRATION_SIGNAL_MS, calibrationSignal } from './signals';
import { SPEED_OF_SOUND } from './spatial';

/**
 * Sync measurement (spec §11.1): every device emits its device-unique chirp at the SAME room times
 * (one per period) through the normal playback compensation; the listener separates devices by matched filter
 * (distinct chirp bands) and reports, per click, each device's arrival relative to the mean of all devices.
 * Listener input latency and the listener's own clock error are common-mode and cancel.
 */
export function buildSyncMeasurementSlots(
  deviceIds: string[],
  opts: { durationSec?: number; periodMs?: number } = {},
): CalibrationPlan['slots'] {
  const periodMs = opts.periodMs ?? 1000;
  const repeat = Math.max(1, Math.min(600, Math.floor(((opts.durationSec ?? 60) * 1000) / periodMs)));
  return deviceIds.map((deviceId, i) => ({
    deviceId,
    deviceIndex: i % 64,
    signal: 'chirp' as const,
    offsetMs: CALIBRATION_LEAD_MS,
    durationMs: CALIBRATION_SIGNAL_MS.chirp,
    repeat,
    periodMs,
  }));
}

export interface SyncDeviceResult {
  deviceId: string;
  detected: number;
  total: number;
  /** per click: arrival − scheduled − propagation, ms (NaN = missed). Includes common-mode listener latency. */
  rawMs: number[];
  /** per click: raw − mean(raw over devices detected on that click), ms (NaN = missed or < 2 devices) */
  errorsMs: number[];
  /** mean / std / p95|·| / max|·| of errorsMs (NaN-free); for a single device, of raw − mean(raw) */
  meanMs: number;
  stdMs: number;
  p95AbsMs: number;
  maxAbsMs: number;
}

export interface SyncMeasurementReport {
  devices: SyncDeviceResult[];
  /** histogram of all inter-device errors */
  histogram: { binMs: number; edgesMs: number[]; counts: number[] };
  overall: { p50AbsMs: number; p95AbsMs: number; maxAbsMs: number; samples: number };
  warnings: string[];
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};

export function analyzeSyncMeasurement(
  input: CalibrationInput,
  opts: { binMs?: number; rangeMs?: number } = {},
): SyncMeasurementReport {
  const { plan, recording: rec, sampleRate: sr, recordingStartRoomTime: recStart } = input;
  const maxLat = input.maxLatencyMs ?? 300;
  const ms = (x: number) => Math.round((x / 1000) * sr);
  const toIdx = (roomMs: number) => Math.round(((roomMs - recStart) / 1000) * sr);
  const warnings: string[] = [];

  const raw: Record<string, number[]> = {};
  const totals: Record<string, number> = {};
  for (const slot of plan.slots) {
    const ref = calibrationSignal(slot.signal, slot.deviceIndex, sr);
    const pos = input.devicePositions[slot.deviceId];
    const propMs = pos ? (Math.hypot(pos.x - input.listener.x, pos.y - input.listener.y) / SPEED_OF_SOUND) * 1000 : 0;
    const n = slot.repeat ?? 1;
    const period = slot.periodMs ?? 0;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const schedRoom = plan.startRoomTime + slot.offsetMs + k * period;
      const sched = toIdx(schedRoom);
      const a = detectArrival(rec, ref, { searchStart: sched - ms(100), searchEnd: sched + ms(maxLat) });
      out.push(a ? recStart + (a.index / sr) * 1000 - schedRoom - propMs : NaN);
    }
    raw[slot.deviceId] = out;
    totals[slot.deviceId] = n;
  }

  const ids = Object.keys(raw);
  const clicks = Math.max(0, ...ids.map((id) => raw[id]!.length));
  const errors: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, [] as number[]]));
  for (let k = 0; k < clicks; k++) {
    const present = ids.filter((id) => Number.isFinite(raw[id]![k]));
    const mean = present.reduce((a, id) => a + raw[id]![k]!, 0) / (present.length || 1);
    for (const id of ids) {
      const v = raw[id]![k];
      errors[id]!.push(present.length >= 2 && Number.isFinite(v) ? v! - mean : NaN);
    }
  }

  const single = ids.length === 1;
  const devices: SyncDeviceResult[] = ids.map((id) => {
    const r = raw[id]!;
    const finiteRaw = r.filter(Number.isFinite);
    const rawMean = finiteRaw.reduce((a, b) => a + b, 0) / (finiteRaw.length || 1);
    const e = single ? finiteRaw.map((v) => v - rawMean) : errors[id]!.filter(Number.isFinite);
    const mean = e.reduce((a, b) => a + b, 0) / (e.length || 1);
    const std = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / (e.length || 1));
    const abs = e.map(Math.abs);
    if (finiteRaw.length < r.length / 2) warnings.push(`Only heard ${finiteRaw.length}/${r.length} clicks from ${id}.`);
    return {
      deviceId: id,
      detected: finiteRaw.length,
      total: totals[id]!,
      rawMs: r,
      errorsMs: single ? r.map((v) => (Number.isFinite(v) ? v - rawMean : NaN)) : errors[id]!,
      meanMs: e.length ? mean : NaN,
      stdMs: e.length ? std : NaN,
      p95AbsMs: quantile(abs, 0.95),
      maxAbsMs: abs.length ? Math.max(...abs) : NaN,
    };
  });

  const all = devices.flatMap((d) => d.errorsMs.filter(Number.isFinite));
  const binMs = opts.binMs ?? 1;
  const range = opts.rangeMs ?? 30;
  const edgesMs: number[] = [];
  for (let x = -range; x <= range + 1e-9; x += binMs) edgesMs.push(+x.toFixed(6));
  const counts = new Array(edgesMs.length - 1).fill(0) as number[];
  for (const v of all) {
    const c = Math.min(Math.max(v, -range), range - 1e-9);
    counts[Math.min(counts.length - 1, Math.floor((c + range) / binMs))]!++;
  }
  const absAll = all.map(Math.abs);
  if (!all.length) warnings.push('No clicks were detected. Turn speakers up and keep the listening device close.');
  return {
    devices,
    histogram: { binMs, edgesMs, counts },
    overall: {
      p50AbsMs: quantile(absAll, 0.5),
      p95AbsMs: quantile(absAll, 0.95),
      maxAbsMs: absAll.length ? Math.max(...absAll) : NaN,
      samples: all.length,
    },
    warnings,
  };
}
