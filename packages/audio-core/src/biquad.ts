import type { EqBand } from '@syncsound/protocol';
import { todo } from './todo';

/** Normalized biquad (a0 = 1): y = b0 x + b1 x1 + b2 x2 − a1 y1 − a2 y2 */
export interface BiquadCoeffs {
  b: [number, number, number];
  a: [number, number, number];
}

export type BiquadType = EqBand['type'];

/** RBJ Audio-EQ-Cookbook designs. q is linear Q (for shelves: S=q). */
export function designBiquad(
  _type: BiquadType,
  _freq: number,
  _q: number,
  _gainDb: number,
  _sampleRate: number,
): BiquadCoeffs {
  return todo('designBiquad');
}

export function biquadMagnitudeDb(_c: BiquadCoeffs, _freq: number, _sampleRate: number): number {
  return todo('biquadMagnitudeDb');
}

export function cascadeMagnitudeDb(_cs: BiquadCoeffs[], _freq: number, _sampleRate: number): number {
  return todo('cascadeMagnitudeDb');
}

/** 4th-order Linkwitz-Riley crossover = two cascaded Butterworth (Q=1/√2) sections per branch. */
export function linkwitzRiley4(_freq: number, _sampleRate: number): { lowpass: BiquadCoeffs[]; highpass: BiquadCoeffs[] } {
  return todo('linkwitzRiley4');
}

/** Run a cascade over a signal (Direct Form I). */
export function processCascade(_cs: BiquadCoeffs[], _input: Float32Array): Float32Array {
  return todo('processCascade');
}

/** IIRFilterNode arguments ([b0,b1,b2], [1,a1,a2]) */
export function toIirArgs(c: BiquadCoeffs): { feedforward: number[]; feedback: number[] } {
  return { feedforward: [...c.b], feedback: [...c.a] };
}
