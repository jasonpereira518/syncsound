import type { DeviceClass, DeviceEq } from '@syncsound/protocol';
import type { BiquadCoeffs } from './biquad';
import type { Response } from './measure';
import { todo } from './todo';

export interface EqFitOptions {
  sampleRate: number;
  maxBands?: number; // default 8
  maxBoostDb?: number; // default 6
  maxCutDb?: number; // default 12
  /** no boost below this (speaker rolloff), Hz */
  rolloffHz?: number | null;
  /** fit range (default 60 Hz – 14 kHz, clamped by rolloff) */
  fMin?: number;
  fMax?: number;
}

export interface EqFitResult {
  eq: DeviceEq;
  /** measured + EQ, dB, on the input freqs */
  predictedDb: number[];
  /** RMS deviation from target in fit range before/after, dB */
  rmsErrorBeforeDb: number;
  rmsErrorAfterDb: number;
}

/** Gentle house curve (dB, 0 at 1 kHz): slight bass lift, slight treble tilt down. */
export function houseCurve(_freqs: number[]): number[] {
  return todo('houseCurve');
}

/**
 * Common target for several devices: house curve shape, level-matched to each device's 300 Hz–3 kHz mean.
 * Returns target dB (0 dB reference) on the shared freq grid.
 */
export function commonTarget(_responses: Response[]): number[] {
  return todo('commonTarget');
}

/** Greedy parametric EQ fit (peaking bands + optional HP) with safety rails. measured & target share freqs. */
export function fitEq(_measured: Response, _targetDb: number[], _opts: EqFitOptions): EqFitResult {
  return todo('fitEq');
}

/** Biquad cascade realizing a DeviceEq (HP first, then bands); preamp handled separately as gain. */
export function eqToBiquads(_eq: DeviceEq, _sampleRate: number): BiquadCoeffs[] {
  return todo('eqToBiquads');
}

/** Conservative fallback EQ when no mic measurement exists. */
export function classPresetEq(_cls: DeviceClass): { eq: DeviceEq; bassCapable: boolean; rolloffHz: number | null } {
  return todo('classPresetEq');
}
