import type { DeviceClass, DeviceEq, EqBand } from '@syncsound/protocol';
import { biquadMagnitudeDb, designBiquad, type BiquadCoeffs } from './biquad';
import { bandMeanDb, logFreqs, type Response } from './measure';

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
  /** measured + EQ (HP, bands and preamp), dB, on the input freqs */
  predictedDb: number[];
  /** RMS deviation from target in fit range before/after, dB (level offset removed: shape error only) */
  rmsErrorBeforeDb: number;
  rmsErrorAfterDb: number;
}

/** Gentle house curve (dB, 0 at 1 kHz): +3 dB below 150 Hz easing to 0 by 400 Hz; −1 dB/octave above 2 kHz. */
export function houseCurve(freqs: number[]): number[] {
  return freqs.map((f) => {
    const bass = f <= 150 ? 3 : f >= 400 ? 0 : (3 * Math.log(400 / f)) / Math.log(400 / 150);
    const treble = f > 2000 ? -Math.log2(f / 2000) : 0;
    return bass + treble;
  });
}

/**
 * Common target for several devices: the house-curve shape placed at the devices' average 300 Hz–3 kHz level,
 * on the shared freq grid (responses[0].freqs). fitEq level-aligns it to each device, so every device is
 * pulled toward the SAME shape (that is what makes different devices converge).
 */
export function commonTarget(responses: Response[]): number[] {
  const first = responses[0];
  if (!first) return [];
  const house = houseCurve(first.freqs);
  const level = responses.reduce((s, r) => s + bandMeanDb(r, 300, 3000), 0) / responses.length;
  const houseLevel = bandMeanDb({ freqs: first.freqs, db: house }, 300, 3000);
  return house.map((h) => h + level - houseLevel);
}

const peakingDb = (b: EqBand, f: number, sr: number) =>
  biquadMagnitudeDb(designBiquad(b.type, b.freq, b.q, b.gainDb, sr), f, sr);

/** Shape RMS of `a − b` over `idx` (mean difference removed). */
function shapeRms(a: number[], b: number[], idx: number[]): number {
  if (!idx.length) return 0;
  const d = idx.map((i) => a[i]! - b[i]!);
  const m = d.reduce((s, x) => s + x, 0) / d.length;
  return Math.sqrt(d.reduce((s, x) => s + (x - m) * (x - m), 0) / d.length);
}

const round = (x: number, step: number) => Number((Math.round(x / step) * step).toFixed(6));

/**
 * Greedy parametric EQ fit (peaking bands + protective HP) with safety rails. measured & target share freqs.
 * Rails: each band within [−maxCut, +maxBoost]; total band boost ≤ maxBoost; total EQ (HP + bands) ≤ 0 dB
 * below rolloffHz (no boost into a speaker's rolloff); preamp = −max(total EQ gain) so overall gain ≤ 0 dB.
 */
export function fitEq(measured: Response, targetDb: number[], opts: EqFitOptions): EqFitResult {
  const sr = opts.sampleRate;
  const maxBands = opts.maxBands ?? 8;
  const maxBoost = opts.maxBoostDb ?? 6;
  const maxCut = opts.maxCutDb ?? 12;
  const rolloff = opts.rolloffHz ?? null;
  const fs = measured.freqs;
  const lo = Math.max(opts.fMin ?? 60, rolloff ? rolloff * 1.2 : 0);
  const hi = Math.min(opts.fMax ?? 14000, sr * 0.45);
  const idx = fs.map((f, i) => (f >= lo && f <= hi ? i : -1)).filter((i) => i >= 0);

  const highpassHz = rolloff && rolloff > 60 ? Math.round(rolloff) : null;
  const hpDb = fs.map((f) =>
    highpassHz ? biquadMagnitudeDb(designBiquad('highpass', highpassHz, Math.SQRT1_2, 0, sr), f, sr) : 0,
  );
  // what the peaking bands should add: target (level-aligned to this device) − (measured + HP)
  const base = fs.map((_, i) => measured.db[i]! + hpDb[i]!);
  const off = idx.length ? idx.reduce((s, i) => s + base[i]! - targetDb[i]!, 0) / idx.length : 0;
  const desired = fs.map((_, i) => targetDb[i]! + off - base[i]!);

  const bands: EqBand[] = [];
  const resp: number[][] = []; // per-band dB on fs
  const total = () => fs.map((_, i) => resp.reduce((s, r) => s + r[i]!, 0));
  const setGain = (j: number, g: number) => {
    bands[j]!.gainDb = Math.max(-maxCut, Math.min(maxBoost, g));
    resp[j] = fs.map((f) => peakingDb(bands[j]!, f, sr));
  };
  const limitAt = (f: number) => (rolloff && f < rolloff ? 0 : maxBoost);
  const enforceRails = () => {
    for (let guard = 0; guard < 200; guard++) {
      const tot = total();
      let worst = -1;
      let excess = 0;
      fs.forEach((f, i) => {
        const e = tot[i]! + (f < (rolloff ?? 0) ? hpDb[i]! : 0) - limitAt(f);
        if (e > excess + 1e-9) {
          excess = e;
          worst = i;
        }
      });
      if (worst < 0) return;
      let j = -1;
      resp.forEach((r, k) => {
        if (bands[k]!.gainDb > 0 && (j < 0 || r[worst]! > resp[j]![worst]!)) j = k;
      });
      if (j < 0) return;
      setGain(j, bands[j]!.gainDb * 0.85);
    }
  };
  const refit = () => {
    for (let pass = 0; pass < 6; pass++) {
      for (let j = 0; j < bands.length; j++) {
        const tot = total();
        const g0 = Math.abs(bands[j]!.gainDb) > 0.1 ? bands[j]!.gainDb : 1;
        const unit = fs.map((f) => peakingDb({ ...bands[j]!, gainDb: g0 }, f, sr) / g0);
        let num = 0;
        let den = 0;
        for (const i of idx) {
          const r = desired[i]! - (tot[i]! - resp[j]![i]!);
          num += r * unit[i]!;
          den += unit[i]! * unit[i]!;
        }
        if (den > 0) setGain(j, num / den);
      }
      enforceRails();
    }
  };

  for (let it = 0; it < maxBands; it++) {
    const tot = total();
    let best = -1;
    // candidates: not within 1/3 octave of an existing band (refit already owns those; re-placing there just
    // stacks bands against a rail-limited residual)
    const free = (i: number) => bands.every((b) => Math.abs(Math.log2(fs[i]! / b.freq)) > 1 / 3);
    for (const i of idx) {
      if (free(i) && (best < 0 || Math.abs(desired[i]! - tot[i]!) > Math.abs(desired[best]! - tot[best]!)))
        best = i;
    }
    if (best < 0) break;
    const r0 = desired[best]! - tot[best]!;
    if (Math.abs(r0) < 0.75) break;
    // width: contiguous region with the same sign and ≥ half the deviation
    const okAt = (i: number) => {
      const r = desired[i]! - tot[i]!;
      return (
        Math.sign(r) === Math.sign(r0) && Math.abs(r) >= Math.abs(r0) / 2 && fs[i]! >= lo && fs[i]! <= hi
      );
    };
    let a = best;
    let b = best;
    while (a > 0 && okAt(a - 1)) a--;
    while (b < fs.length - 1 && okAt(b + 1)) b++;
    const bw = Math.max(1 / 12, Math.log2(fs[b]! / fs[a]!));
    const p = Math.pow(2, bw);
    const q = Math.max(0.5, Math.min(6, Math.sqrt(p) / (p - 1)));
    bands.push({ type: 'peaking', freq: fs[best]!, q, gainDb: 0 });
    resp.push([]);
    setGain(bands.length - 1, r0);
    refit();
  }

  // round for the wire, drop negligible bands, recompute everything from the final values
  const finalBands = bands
    .map((b) => ({
      type: b.type,
      freq: round(b.freq, 1),
      q: round(b.q, 0.01),
      gainDb: Math.trunc(b.gainDb * 10) / 10,
    }))
    .filter((b) => Math.abs(b.gainDb) >= 0.3);
  const eqAt = (f: number) =>
    (highpassHz ? biquadMagnitudeDb(designBiquad('highpass', highpassHz, Math.SQRT1_2, 0, sr), f, sr) : 0) +
    finalBands.reduce((s, b) => s + peakingDb(b, f, sr), 0);
  const eqDb = fs.map(eqAt);
  // headroom: preamp cancels the largest EQ gain anywhere (dense 1/96-oct scan), rounded down to 0.1 dB
  const maxGain = Math.max(0, ...logFreqs(20, Math.min(20000, sr * 0.49), 96).map(eqAt));
  const preampDb = Math.max(-12, -Math.ceil(maxGain * 10) / 10) || 0; // || 0 normalizes −0
  const predictedDb = fs.map((_, i) => measured.db[i]! + eqDb[i]! + preampDb);
  return {
    eq: { enabled: true, bands: finalBands, highpassHz, preampDb, source: 'measured' },
    predictedDb,
    rmsErrorBeforeDb: shapeRms(measured.db, targetDb, idx),
    rmsErrorAfterDb: shapeRms(predictedDb, targetDb, idx),
  };
}

/** Biquad cascade realizing a DeviceEq (HP first, then bands); preamp handled separately as gain. */
export function eqToBiquads(eq: DeviceEq, sampleRate: number): BiquadCoeffs[] {
  if (!eq.enabled) return [];
  const out: BiquadCoeffs[] = [];
  if (eq.highpassHz) out.push(designBiquad('highpass', eq.highpassHz, Math.SQRT1_2, 0, sampleRate));
  for (const b of eq.bands) out.push(designBiquad(b.type, b.freq, b.q, b.gainDb, sampleRate));
  return out;
}

/** Conservative fallback EQ when no mic measurement exists. */
export function classPresetEq(cls: DeviceClass): {
  eq: DeviceEq;
  bassCapable: boolean;
  rolloffHz: number | null;
} {
  const eq = (highpassHz: number | null, bands: EqBand[] = []): DeviceEq => ({
    enabled: true,
    bands,
    highpassHz,
    preampDb: -Math.max(0, ...bands.map((b) => b.gainDb)) || 0,
    source: 'preset',
  });
  switch (cls) {
    case 'phone':
      return {
        eq: eq(180, [{ type: 'peaking', freq: 3000, q: 1, gainDb: -2 }]),
        bassCapable: false,
        rolloffHz: 200,
      };
    case 'tablet':
      return { eq: eq(120), bassCapable: false, rolloffHz: 120 };
    case 'laptop':
      return {
        eq: eq(90, [{ type: 'lowshelf', freq: 200, q: 0.8, gainDb: 2 }]),
        bassCapable: false,
        rolloffHz: 90,
      };
    case 'desktop':
      return { eq: eq(null), bassCapable: true, rolloffHz: null };
    case 'bluetooth':
      return { eq: eq(60), bassCapable: true, rolloffHz: 60 };
    case 'unknown':
      return { eq: eq(100), bassCapable: false, rolloffHz: 100 };
  }
}
