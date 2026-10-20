/**
 * Trims (dB) that bring each device to the quietest device's level, so every trim is ≤ 0 dB (clamped to the
 * protocol's −24 dB floor and to `maxBoostDb` on top, which only matters if callers pass a negative cap).
 */
export function loudnessTrims(levelsDb: Record<string, number>, maxBoostDb = 6): Record<string, number> {
  const vals = Object.values(levelsDb);
  if (!vals.length) return {};
  const ref = Math.min(...vals);
  const out: Record<string, number> = {};
  for (const [id, l] of Object.entries(levelsDb)) out[id] = Math.min(maxBoostDb, Math.max(-24, ref - l));
  return out;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));
