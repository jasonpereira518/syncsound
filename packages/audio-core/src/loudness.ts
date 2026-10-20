import { todo } from './todo';

/** Trims (dB) that bring each device to the quietest device's level (never boost beyond +6 dB). */
export function loudnessTrims(_levelsDb: Record<string, number>, _maxBoostDb?: number): Record<string, number> {
  return todo('loudnessTrims');
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));
