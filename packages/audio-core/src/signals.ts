import type { CalibrationSignal } from '@syncsound/protocol';
import { todo } from './todo';

export interface SweepSpec {
  f1: number;
  f2: number;
  durationSec: number;
  sampleRate: number;
  /** fade in/out seconds (default 0.01) */
  fadeSec?: number;
}

/** Farina exponential sine sweep + its amplitude-compensated time-reversed inverse filter. */
export function logSweep(_spec: SweepSpec): { signal: Float32Array; inverse: Float32Array } {
  return todo('logSweep');
}

/** Linear-in-log chirp between f1 and f2 with Hann window (for arrival detection). */
export function chirp(_f1: number, _f2: number, _durationSec: number, _sampleRate: number): Float32Array {
  return todo('chirp');
}

/** Deterministic pink noise (Paul Kellet filter over seeded white noise), peak-normalized to `peak`. */
export function pinkNoise(_n: number, _seed: number, _peak?: number): Float32Array {
  return todo('pinkNoise');
}

/** Click track: short 1 kHz-ish clicks at `bpm` (accent on beat 1 of 4). */
export function clickTrack(_bpm: number, _durationSec: number, _sampleRate: number): Float32Array {
  return todo('clickTrack');
}

/** Device-unique chirp band (Hz) for calibration ID. */
export function chirpBand(_deviceIndex: number): { f1: number; f2: number } {
  return todo('chirpBand');
}

/** Durations (ms) of each calibration signal. */
export const CALIBRATION_SIGNAL_MS: Record<CalibrationSignal, number> = {
  chirp: 400,
  sweep: 2000,
  noise: 1000,
  click: 50,
};

/** Sweep range used for frequency-response measurement. */
export const CALIBRATION_SWEEP = { f1: 40, f2: 16000 } as const;

/** Deterministic calibration signal; speaker and listener generate identical samples. */
export function calibrationSignal(_kind: CalibrationSignal, _deviceIndex: number, _sampleRate: number): Float32Array {
  return todo('calibrationSignal');
}
