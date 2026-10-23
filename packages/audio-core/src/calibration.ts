import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import { commonTarget, fitEq, type EqFitResult } from './eq';
import { loudnessTrims, volumeHints } from './loudness';
import {
  bandMeanDb,
  deconvolve,
  detectArrival,
  estimateRolloffHz,
  logFreqs,
  magnitudeResponse,
  rmsDb,
  smoothFractionalOctave,
  type Response,
} from './measure';
import {
  CALIBRATION_SIGNAL_MS,
  CALIBRATION_SWEEP,
  calibrationSignal,
  calibrationSweepInverse,
} from './signals';
import { SPEED_OF_SOUND } from './spatial';

/** Silence before the first slot (noise-floor reference + clock-error slack), ms. */
export const CALIBRATION_LEAD_MS = 500;
/** Extra silence after each slot on top of maxLatencyMs, ms. */
export const CALIBRATION_GUARD_MS = 200;
/** IR window used for response measurement, samples at 48 kHz (scaled with sample rate). */
const IR_SEC = 16384 / 48000;
/** A device whose measured rolloff is at or below this is treated as bass-capable. */
export const BASS_CAPABLE_ROLLOFF_HZ = 80;
/** Noise-burst SNR below this raises the noisy-room warning, dB. */
export const NOISY_ROOM_SNR_DB = 15;

/**
 * Build a calibration plan's slots: for each device (in order) a chirp, a sweep and a pink-noise burst,
 * each in its own non-overlapping time window with guard gaps sized for up to `maxLatencyMs` of output latency.
 */
export function buildCalibrationSlots(
  deviceIds: string[],
  opts: { maxLatencyMs?: number; include?: Array<'chirp' | 'sweep' | 'noise'> } = {},
): CalibrationPlan['slots'] {
  const gap = (opts.maxLatencyMs ?? 500) + CALIBRATION_GUARD_MS;
  const include = opts.include ?? ['chirp', 'sweep', 'noise'];
  const slots: CalibrationPlan['slots'] = [];
  let t = CALIBRATION_LEAD_MS;
  deviceIds.forEach((deviceId, i) => {
    for (const signal of include) {
      const durationMs = CALIBRATION_SIGNAL_MS[signal];
      slots.push({ deviceId, deviceIndex: i % 64, signal, offsetMs: t, durationMs });
      t += durationMs + gap;
    }
  });
  return slots;
}

/** How long the listener must record from plan.startRoomTime to capture every slot, ms. */
export function calibrationRecordingMs(slots: CalibrationPlan['slots'], maxLatencyMs = 500): number {
  return (
    Math.max(0, ...slots.map((s) => s.offsetMs + ((s.repeat ?? 1) - 1) * (s.periodMs ?? 0) + s.durationMs)) +
    maxLatencyMs +
    CALIBRATION_GUARD_MS
  );
}

export interface CalibrationInput {
  plan: CalibrationPlan;
  /** mono microphone recording */
  recording: Float32Array;
  sampleRate: number;
  /** room ms of recording[0] (as best the listener knows; its own input latency is common-mode) */
  recordingStartRoomTime: number;
  /** device positions + listener for propagation subtraction; missing → treated as distance 0 */
  devicePositions: Record<string, Vec2>;
  listener: Vec2;
  /** must match buildCalibrationSlots (default 500) */
  maxLatencyMs?: number;
}

export interface DeviceCalibration {
  deviceId: string;
  heard: boolean;
  /** arrival − scheduled − propagation, ms (includes listener input latency; common-mode) */
  rawLatencyMs: number | null;
  /** rawLatency − min(rawLatency over heard devices), ms → value to store as calibratedLatencyMs */
  relativeLatencyMs: number | null;
  snrDb: number | null;
  /** 1/6-octave smoothed magnitude response (absolute dB, includes distance + mic gain) */
  response: Response | null;
  rolloffHz: number | null;
  /** rolloffHz ≤ BASS_CAPABLE_ROLLOFF_HZ */
  bassCapable: boolean | null;
  /** pink-noise RMS at listener, dB (noise floor power-subtracted) */
  levelDb: number | null;
  noiseFloorDb: number | null;
}

export interface CalibrationReport {
  devices: DeviceCalibration[];
  /** shared EQ target on the response grid */
  targetDb: number[] | null;
  eq: Record<string, EqFitResult>;
  trims: Record<string, number>;
  /** dB to raise on the device itself (only devices well below the median; see volumeHints) */
  volumeUp: Record<string, number>;
  warnings: string[];
}

/** Response grid: 1/24 octave across the sweep band. */
export const CALIBRATION_FREQS = logFreqs(CALIBRATION_SWEEP.f1, CALIBRATION_SWEEP.f2, 24);

/** Full analysis: chirp arrival → latency, sweep → response → EQ toward common target, noise → loudness trims. */
export function analyzeCalibration(input: CalibrationInput): CalibrationReport {
  const { plan, recording: rec, sampleRate: sr, recordingStartRoomTime: recStart } = input;
  const maxLat = input.maxLatencyMs ?? 500;
  const toIdx = (roomMs: number) => Math.round(((roomMs - recStart) / 1000) * sr);
  const ms = (x: number) => Math.round((x / 1000) * sr);
  const pre = ms(100);
  const inverse = calibrationSweepInverse(sr);
  const irLength = Math.round(IR_SEC * sr);
  const warnings: string[] = [];
  const noisy: string[] = [];

  const ids = [...new Set(plan.slots.map((s) => s.deviceId))];
  const devices: DeviceCalibration[] = ids.map((deviceId) => {
    const slot = (k: string) => plan.slots.find((s) => s.deviceId === deviceId && s.signal === k);
    const dc: DeviceCalibration = {
      deviceId,
      heard: false,
      rawLatencyMs: null,
      relativeLatencyMs: null,
      snrDb: null,
      response: null,
      rolloffHz: null,
      bassCapable: null,
      levelDb: null,
      noiseFloorDb: null,
    };
    const chirpSlot = slot('chirp');
    if (!chirpSlot) return dc;
    const sched = toIdx(plan.startRoomTime + chirpSlot.offsetMs);
    // silence just before the slot (previous slot's guard gap)
    dc.noiseFloorDb = rmsDb(rec, sched - ms(150), sched - ms(20));
    const ref = calibrationSignal('chirp', chirpSlot.deviceIndex, sr);
    const arrival = detectArrival(rec, ref, {
      searchStart: sched - pre,
      searchEnd: sched + ms(maxLat) + pre,
    });
    if (!arrival) return dc;
    dc.heard = true;
    dc.snrDb = arrival.snrDb;
    const pos = input.devicePositions[deviceId];
    const propMs = pos
      ? (Math.hypot(pos.x - input.listener.x, pos.y - input.listener.y) / SPEED_OF_SOUND) * 1000
      : 0;
    dc.rawLatencyMs =
      recStart + (arrival.index / sr) * 1000 - (plan.startRoomTime + chirpSlot.offsetMs) - propMs;
    const lagSamples = arrival.index - sched; // total latency incl. propagation + listener input, samples

    const sweepSlot = slot('sweep');
    if (sweepSlot) {
      const s0 = Math.round(toIdx(plan.startRoomTime + sweepSlot.offsetMs) + lagSamples);
      const w0 = Math.max(0, s0 - ms(50));
      const w1 = Math.min(rec.length, s0 + inverse.length + irLength + ms(50));
      if (w1 > w0) {
        const ir = deconvolve(rec.subarray(w0, w1), inverse, irLength);
        dc.response = smoothFractionalOctave(magnitudeResponse(ir, sr, CALIBRATION_FREQS), 6);
        dc.rolloffHz = estimateRolloffHz(dc.response);
        dc.bassCapable = dc.rolloffHz <= BASS_CAPABLE_ROLLOFF_HZ;
      }
    }
    const noiseSlot = slot('noise');
    if (noiseSlot) {
      const n0 = Math.round(toIdx(plan.startRoomTime + noiseSlot.offsetMs) + lagSamples);
      const n = ms(noiseSlot.durationMs);
      const raw = rmsDb(rec, n0 + n * 0.1, n0 + n * 0.9);
      const snr = raw - dc.noiseFloorDb;
      dc.levelDb = snr > 1 ? 10 * Math.log10(10 ** (raw / 10) - 10 ** (dc.noiseFloorDb / 10)) : raw;
      if (snr < NOISY_ROOM_SNR_DB) noisy.push(`${deviceId} ${snr.toFixed(0)} dB`);
    }
    return dc;
  });

  const heard = devices.filter((d) => d.heard);
  const minRaw = Math.min(...heard.map((d) => d.rawLatencyMs!));
  for (const d of heard) d.relativeLatencyMs = d.rawLatencyMs! - minRaw;
  for (const d of devices) if (!d.heard) warnings.push(`Couldn't hear ${d.deviceId} — is its volume up?`);
  if (noisy.length) {
    warnings.push(
      `The room is noisy (signal-to-noise: ${noisy.join(', ')}) — results may be less accurate; try a quieter moment.`,
    );
  }

  const measured = heard.filter((d) => d.response);
  const targetDb = measured.length ? commonTarget(measured.map((d) => d.response!)) : null;
  const eq: Record<string, EqFitResult> = {};
  const postLevels: Record<string, number> = {};
  for (const d of measured) {
    const fit = fitEq(d.response!, targetDb!, { sampleRate: sr, rolloffHz: d.rolloffHz });
    eq[d.deviceId] = fit;
    if (d.levelDb !== null) {
      // trims act on the post-EQ loudness (EQ + preamp change each device's level differently)
      const eqShift =
        bandMeanDb({ freqs: d.response!.freqs, db: fit.predictedDb }, 300, 3000) -
        bandMeanDb(d.response!, 300, 3000);
      postLevels[d.deviceId] = d.levelDb + eqShift;
    }
  }
  for (const d of heard)
    if (d.levelDb !== null && postLevels[d.deviceId] === undefined) postLevels[d.deviceId] = d.levelDb;
  return { devices, targetDb, eq, trims: loudnessTrims(postLevels), volumeUp: volumeHints(postLevels), warnings };
}
