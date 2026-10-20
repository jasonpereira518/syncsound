import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import type { EqFitResult } from './eq';
import type { Response } from './measure';
import { todo } from './todo';

/**
 * Build a calibration plan's slots: for each device (in order) a chirp, a sweep and a pink-noise burst,
 * each in its own non-overlapping time window with guard gaps sized for up to `maxLatencyMs` of output latency.
 */
export function buildCalibrationSlots(
  _deviceIds: string[],
  _opts?: { maxLatencyMs?: number; include?: Array<'chirp' | 'sweep' | 'noise'> },
): CalibrationPlan['slots'] {
  return todo('buildCalibrationSlots');
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
}

export interface DeviceCalibration {
  deviceId: string;
  heard: boolean;
  /** arrival − scheduled − propagation, ms (includes listener input latency; common-mode) */
  rawLatencyMs: number | null;
  /** rawLatency − min(rawLatency over heard devices), ms → value to store as calibratedLatencyMs */
  relativeLatencyMs: number | null;
  snrDb: number | null;
  response: Response | null;
  rolloffHz: number | null;
  /** pink-noise RMS at listener, dB */
  levelDb: number | null;
  noiseFloorDb: number | null;
}

export interface CalibrationReport {
  devices: DeviceCalibration[];
  /** shared EQ target on the response grid */
  targetDb: number[] | null;
  eq: Record<string, EqFitResult>;
  trims: Record<string, number>;
  warnings: string[];
}

/** Full analysis: chirp arrival → latency, sweep → response → EQ toward common target, noise → loudness trims. */
export function analyzeCalibration(_input: CalibrationInput): CalibrationReport {
  return todo('analyzeCalibration');
}
