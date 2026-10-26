/** Most a tune boosts a soft device in software, dB. The trim sits before the output limiter, so a boost is limited. */
export const MAX_BOOST_DB = 6;

/** median of the values (mean of the middle two for an even count) */
export function medianOf(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 ? s[Math.floor(mid)]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Trims (dB) that bring every device to the median level ("meet in the middle"): loud devices are cut, soft ones are
 * boosted by at most `maxBoostDb` (clamped to the protocol's −24 dB floor). `refDb` overrides the median.
 */
export function loudnessTrims(
  levelsDb: Record<string, number>,
  opts: { maxBoostDb?: number; refDb?: number } = {},
): Record<string, number> {
  const vals = Object.values(levelsDb);
  if (!vals.length) return {};
  const ref = opts.refDb ?? medianOf(vals);
  const cap = opts.maxBoostDb ?? MAX_BOOST_DB;
  const out: Record<string, number> = {};
  for (const [id, l] of Object.entries(levelsDb)) out[id] = Math.min(cap, Math.max(-24, ref - l));
  return out;
}

/**
 * A device more than `maxBoostDb` below the median can't be brought up in software: hint how many dB it is still
 * short after the boost (raise this device's own volume by about that much and re-tune), when that exceeds
 * `toleranceDb`. `refDb` overrides the median.
 */
export function volumeHints(
  levelsDb: Record<string, number>,
  opts: { maxBoostDb?: number; toleranceDb?: number; refDb?: number } = {},
): Record<string, number> {
  const vals = Object.values(levelsDb);
  if (vals.length < 2) return {};
  const ref = opts.refDb ?? medianOf(vals);
  const cap = opts.maxBoostDb ?? MAX_BOOST_DB;
  const out: Record<string, number> = {};
  for (const [id, l] of Object.entries(levelsDb)) {
    const short = ref - l - cap;
    if (short > (opts.toleranceDb ?? 1)) out[id] = Math.round(short * 10) / 10;
  }
  return out;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));
