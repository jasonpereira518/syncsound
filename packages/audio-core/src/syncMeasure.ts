import type { CalibrationPlan, Scene, Vec2 } from '@syncsound/protocol';
import { CALIBRATION_LEAD_MS, indexMap, normalizedPeak, SELF_OFFSET_M, type RecordingInput } from './calibration';
import { crossCorrelate, firstArrival } from './measure';
import { CALIBRATION_SIGNAL_MS, calibrationSignal } from './signals';
import { SPEED_OF_SOUND } from './spatial';

/** Devices click one after another, this far apart (identical wideband chirps are told apart by time), ms. */
export const SYNC_STAGGER_MS = 250;
/** Arrival search window around each click's expected arrival, ms: well inside ±stagger. */
const SYNC_SEARCH_EARLY_MS = 100;
export const SYNC_SEARCH_LATE_MS = 200;
const MIN_SNR_DB = 20;
const MIN_PEAK = 0.1;

/**
 * Sync check: every device plays a short wideband chirp through its normal playback compensation, once per
 * period, device i at `i·SYNC_STAGGER_MS` (the stagger is exact on the room timeline, so it is subtracted). The
 * listener reports each click's arrival relative to the mean over devices; listener latency and clock error are
 * common-mode and cancel.
 */
export function buildSyncMeasurementSlots(
  deviceIds: string[],
  opts: { durationSec?: number; periodMs?: number } = {},
): CalibrationPlan['slots'] {
  const periodMs = Math.max(opts.periodMs ?? 1000, deviceIds.length * SYNC_STAGGER_MS);
  const repeat = Math.max(1, Math.min(600, Math.floor(((opts.durationSec ?? 60) * 1000) / periodMs)));
  return deviceIds.map((deviceId, i) => ({
    deviceId,
    deviceIndex: i % 64,
    signal: 'chirp' as const,
    offsetMs: CALIBRATION_LEAD_MS + i * SYNC_STAGGER_MS,
    durationMs: CALIBRATION_SIGNAL_MS.chirp,
    repeat,
    periodMs,
  }));
}

/**
 * Where each device's click should land at the listener mic relative to the others, ms. Playback aligns at the head
 * (propagation alignment on) or at emission (off), so the mic legitimately sees these offsets; the check scores the
 * rest. `mic` = the measuring device's position.
 */
export function expectedArrivalMs(
  scene: Pick<Scene, 'devices' | 'listener' | 'propagationComp'>,
  mic: Vec2,
  micId: string,
  ids: string[],
): Record<string, number> {
  const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
  return Object.fromEntries(
    ids.map((id) => {
      const p = scene.devices[id];
      if (!p) return [id, 0];
      const toMic = id === micId ? SELF_OFFSET_M : d(p, mic);
      return [id, ((scene.propagationComp ? toMic - d(p, scene.listener) : toMic) / SPEED_OF_SOUND) * 1000];
    }),
  );
}

export interface SyncInput extends RecordingInput {
  /** per device: expected arrival offset at this mic (`expectedArrivalMs`), ms */
  expectedMs: Record<string, number>;
}

export interface SyncDeviceResult {
  deviceId: string;
  detected: number;
  total: number;
  /** per click: arrival − scheduled − expected, ms (NaN = missed). Includes common-mode listener latency. */
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
  input: SyncInput,
  opts: { binMs?: number; rangeMs?: number } = {},
): SyncMeasurementReport {
  const { plan, recording: rec, sampleRate: sr } = input;
  const ms = (x: number) => Math.round((x / 1000) * sr);
  const toIdx = indexMap(input.toRoomMs, rec.length);
  const warnings: string[] = [];

  const raw: Record<string, number[]> = {};
  const totals: Record<string, number> = {};
  for (const slot of plan.slots) {
    const ref = calibrationSignal(slot.signal, slot.deviceIndex, sr);
    const expected = input.expectedMs[slot.deviceId] ?? 0;
    const n = slot.repeat ?? 1;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const schedRoom = plan.startRoomTime + slot.offsetMs + k * (slot.periodMs ?? 0);
      const at = Math.round(toIdx(schedRoom + expected));
      const w0 = Math.max(0, at - ms(SYNC_SEARCH_EARLY_MS));
      const w1 = Math.min(rec.length - ref.length, at + ms(SYNC_SEARCH_LATE_MS));
      const y = w1 > w0 ? crossCorrelate(rec.subarray(w0, w1 + ref.length), ref) : null;
      const fa = y ? firstArrival(y, sr, { start: 0, end: w1 - w0 + 1 }) : null;
      const ok = fa && y && fa.snrDb >= MIN_SNR_DB && normalizedPeak(rec, y, w0, fa.index, ref) >= MIN_PEAK;
      out.push(ok ? input.toRoomMs(w0 + fa!.index) - schedRoom - expected : NaN);
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
  const binMs = opts.binMs ?? 0.25;
  const range = opts.rangeMs ?? 10;
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
