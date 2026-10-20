import { todo } from './todo';

/** FFT cross-correlation r[k] = Σ x[n+k]·ref[n] for k in [0, x.length − 1]. */
export function crossCorrelate(_x: Float32Array, _ref: Float32Array): Float64Array {
  return todo('crossCorrelate');
}

export interface Arrival {
  /** sample index in `recording` where `reference` starts (sub-sample, parabolic interpolation) */
  index: number;
  /** normalized correlation peak 0..1 */
  peak: number;
  /** peak-to-median ratio in dB — confidence */
  snrDb: number;
}

/** Find where `reference` occurs in recording[searchStart, searchEnd). Null if confidence too low. */
export function detectArrival(
  _recording: Float32Array,
  _reference: Float32Array,
  _opts?: { searchStart?: number; searchEnd?: number; minSnrDb?: number },
): Arrival | null {
  return todo('detectArrival');
}

/** Linear deconvolution of a recorded sweep with its inverse filter → impulse response (peak-aligned window). */
export function deconvolve(_recording: Float32Array, _inverse: Float32Array, _irLength?: number): Float32Array {
  return todo('deconvolve');
}

export interface Response {
  freqs: number[];
  db: number[];
}

/** Magnitude response (dB) of an IR, evaluated at log-spaced `freqs` (default 1/24-oct 20 Hz–20 kHz). */
export function magnitudeResponse(_ir: Float32Array, _sampleRate: number, _freqs?: number[]): Response {
  return todo('magnitudeResponse');
}

/** Log-spaced frequency grid, `perOctave` points per octave. */
export function logFreqs(_fMin: number, _fMax: number, _perOctave: number): number[] {
  return todo('logFreqs');
}

/** Fractional-octave smoothing (power average within ±1/(2·fraction) octave). */
export function smoothFractionalOctave(_r: Response, _fraction: number): Response {
  return todo('smoothFractionalOctave');
}

export function rmsDb(_x: Float32Array, _start?: number, _end?: number): number {
  return todo('rmsDb');
}

/** Estimated -6 dB low-frequency rolloff relative to the 300 Hz–3 kHz mean. */
export function estimateRolloffHz(_r: Response): number {
  return todo('estimateRolloffHz');
}
