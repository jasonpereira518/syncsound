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

/**
 * Matching to the quietest device guarantees equal level but costs everyone else that much loudness. Devices more
 * than `thresholdDb` below the median get a hint: raise this device's own volume by about this many dB and re-tune.
 * (No software boost instead: the output limiter sits at −3 dBFS, so a boost would just clip/compress.)
 */
export function volumeHints(levelsDb: Record<string, number>, thresholdDb = 3): Record<string, number> {
  const vals = Object.values(levelsDb).sort((a, b) => a - b);
  if (vals.length < 2) return {};
  const mid = vals.length / 2;
  const median = vals.length % 2 ? vals[Math.floor(mid)]! : (vals[mid - 1]! + vals[mid]!) / 2;
  const out: Record<string, number> = {};
  for (const [id, l] of Object.entries(levelsDb)) if (median - l > thresholdDb) out[id] = Math.round((median - l) * 10) / 10;
  return out;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));
