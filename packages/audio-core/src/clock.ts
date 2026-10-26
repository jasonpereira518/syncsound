/** One NTP-style exchange. t0/t3 on the client clock, tsRecv/tsSend on the server clock. All ms. */
export interface ClockSample {
  t0: number;
  tsRecv: number;
  tsSend: number;
  t3: number;
}

export interface ClockEstimate {
  /** server − client, ms (slewed value actually used by toRoomTime at the latest sample time) */
  offsetMs: number;
  /** best (min) RTT in the window, ms */
  rttMs: number;
  /** stddev of offsets among the lowest-RTT subset, ms */
  jitterMs: number;
  /** estimated client clock drift vs server, parts per million (+ve: client runs slow vs server) */
  driftPpm: number;
  samples: number;
  /** true once enough low-RTT samples are in the window to trust the estimate */
  converged: boolean;
  /** target − applied offset still being slewed in, ms (0 right after a step) */
  pendingSlewMs: number;
  /** standard error of the drift estimate, ppm (Infinity until a drift has been fitted) */
  driftSePpm: number;
  /** local ms between the mapping's last (re)acquisition — a reset, or a step after a sample gap — and the latest sample */
  ageMs: number;
  /** number of reset() calls so far (a calibration run spanning one is invalid) */
  resets: number;
}

/** local ↔ room mapping without an estimate: a frozen snapshot, or one clock composed on another */
export interface TimeMap {
  toRoomTime(localMs: number): number;
  toLocalTime(roomMs: number): number;
}

/** what the engine needs from a clock: ClockSync itself, or the LAN ClockLink composed on top of one */
export interface RoomClock extends TimeMap {
  estimate(): ClockEstimate;
  /**
   * A frozen, de-slewed linear copy of the current mapping anchored at `localMs` (drift slope only, never a pending
   * slew): what a calibration recording maps its samples through, so the room clock's catch-up can't leak into it.
   */
  frozenAt(localMs: number): TimeMap;
}

export interface ClockSyncOptions {
  /** sliding window size (default 64) */
  windowSize?: number;
  /** fraction of lowest-RTT samples used for the median (default 0.25) */
  bestFraction?: number;
  /** max slew rate of the applied offset, ms per second of local time (default 1) */
  maxSlewMsPerSec?: number;
  /** step instead of slew when |target − applied| exceeds this, ms (default 50) */
  stepThresholdMs?: number;
  /** min samples before converged (default 8) */
  minSamples?: number;
  /** window samples older than this are dropped, ms (default 300 000: at one ping a minute a count-bounded window
   * would span an hour and outvote a fresh burst) */
  maxSampleAgeMs?: number;
  /** after a sample gap (or rebase()), step onto the new samples when they disagree with the extrapolated mapping
   * by more than this, ms (default 3) */
  gapStepThresholdMs?: number;
}

export const sampleRtt = (s: ClockSample) => s.t3 - s.t0 - (s.tsSend - s.tsRecv);
export const sampleOffset = (s: ClockSample) => (s.tsRecv - s.t0 + (s.tsSend - s.t3)) / 2;

/** ping burst at connect / resync: count and spacing (the sims use the same) */
export const CLOCK_BURST_COUNT = 25;
export const CLOCK_BURST_GAP_MS = 40;
/** a pause in samples longer than this (hidden tab at one ping a minute, sleep, reconnect) starts a re-acquisition */
export const SAMPLE_GAP_MS = 10_000;

export interface LineFit {
  /** y ≈ yMean + slope·(x − xMean) */
  xMean: number;
  yMean: number;
  slope: number;
  /** standard error of the slope (0 when n ≤ 2) */
  slopeSe: number;
  /** points kept after outlier rejection */
  n: number;
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function lsq(xs: number[], ys: number[], keep: boolean[]): LineFit {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!keep[i]) continue;
    n++;
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const xMean = sx / n;
  const yMean = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!keep[i]) continue;
    const dx = xs[i]! - xMean;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - yMean);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let ssr = 0;
  for (let i = 0; i < xs.length; i++) if (keep[i]) ssr += (ys[i]! - yMean - slope * (xs[i]! - xMean)) ** 2;
  const slopeSe = n > 2 && sxx > 0 ? Math.sqrt(ssr / (n - 2) / sxx) : 0;
  return { xMean, yMean, slope, slopeSe, n };
}

/**
 * Least-squares line on centred data (numerically stable for epoch-sized x/y) after one pass of outlier
 * rejection: points with |residual| > k·1.4826·MAD (floored at `minResidual`) are dropped and the line refit.
 * The residuals are taken against a robust initial line (median slope over half-spaced pairs, median intercept),
 * not a first least-squares fit: a single late timestamp at the end of a short window has enough leverage to bend
 * that first fit so far that the MAD test, measured from it, cannot see the outlier — and every later good
 * observation then looks like one.
 */
export function fitLine(xs: number[], ys: number[], k = 3, minResidual = 1e-9): LineFit {
  const n = xs.length;
  if (n === 0) return { xMean: 0, yMean: 0, slope: 0, slopeSe: 0, n: 0 };
  const all = xs.map(() => true);
  if (n < 4) return lsq(xs, ys, all);
  const h = n >> 1;
  const slopes: number[] = [];
  for (let i = 0; i + h < n; i++) {
    const dx = xs[i + h]! - xs[i]!;
    if (dx !== 0) slopes.push((ys[i + h]! - ys[i]!) / dx);
  }
  const s0 = slopes.length ? median(slopes) : 0;
  let xm = 0;
  for (const x of xs) xm += x;
  xm /= n;
  const b0 = median(xs.map((x, i) => ys[i]! - s0 * (x - xm)));
  const res = xs.map((x, i) => ys[i]! - (b0 + s0 * (x - xm)));
  const mad = median(res.map(Math.abs));
  const lim = Math.max(k * 1.4826 * mad, minResidual);
  const keep = res.map((r) => Math.abs(r) <= lim);
  return keep.filter(Boolean).length >= 2 ? lsq(xs, ys, keep) : lsq(xs, ys, all);
}

interface Pt {
  /** local time of the exchange midpoint, ms */
  t: number;
  rtt: number;
  off: number;
}

/**
 * Piecewise-linear applied offset: slope s1 (drift ± slew) from (t0,a0) until tEnd, then slope s2 (drift).
 * Before t0 the drift slope s2 is extrapolated backwards (never the slew: a late joiner evaluates room times
 * seconds in the past, and extrapolating a 1 ms/s slew back would add ms of error).
 */
export interface ClockMappingData {
  t0: number;
  a0: number;
  s1: number;
  tEnd: number;
  s2: number;
}
type Applied = ClockMappingData;

function offsetAt(a: Applied, t: number): number {
  if (t < a.t0) return a.a0 + a.s2 * (t - a.t0);
  if (t <= a.tEnd) return a.a0 + a.s1 * (t - a.t0);
  return a.a0 + a.s1 * (a.tEnd - a.t0) + a.s2 * (t - a.tEnd);
}

function inverse(a: Applied, roomMs: number): number {
  if (roomMs < a.t0 + a.a0) return (roomMs - a.a0 + a.s2 * a.t0) / (1 + a.s2);
  const l1 = (roomMs - a.a0 + a.s1 * a.t0) / (1 + a.s1);
  if (l1 <= a.tEnd) return l1;
  const aEnd = a.a0 + a.s1 * (a.tEnd - a.t0);
  return (roomMs - aEnd + a.s2 * a.tEnd) / (1 + a.s2);
}

/** LAN clock-master link (DataChannel): ping every 100 ms, 128-sample window (~13 s). Tuned in sim/lanMaster. */
export const LAN_PING_MS = 100;
export const LAN_SYNC_OPTS: ClockSyncOptions = { windowSize: 128 };

/**
 * A frozen copy of a ClockSync's local → room mapping. The LAN clock master shares its mapping so every device
 * applies the *same* WAN estimate on top of its (much tighter) LAN estimate of the master's clock.
 */
export class ClockMapping implements TimeMap {
  constructor(readonly data: ClockMappingData) {}

  /** snapshot of `sync`'s current mapping, or null before its first sample */
  static of(sync: ClockSync): ClockMapping | null {
    const d = sync.mapping();
    return d ? new ClockMapping(d) : null;
  }

  /** applied offset (room − local) at a local time */
  offsetAt(localMs: number): number {
    return offsetAt(this.data, localMs);
  }

  toRoomTime(localMs: number): number {
    return localMs + offsetAt(this.data, localMs);
  }

  toLocalTime(roomMs: number): number {
    return inverse(this.data, roomMs);
  }
}

// Drift is fitted over a much longer history than the offset window (long baseline → low ppm noise), as an
// RTT-weighted least-squares line: a sample whose RTT exceeds the history minimum by x has |offset error| ≤ x/2,
// so weight ∝ 1/(x + DRIFT_X0)². Spikes get ~zero weight; jitter is symmetric so the fit stays unbiased.
// The slope is shrunk toward 0 by its (sandwich) standard error against a physical prior on relative crystal
// drift: slope·P/(P+SE²), P = DRIFT_PRIOR_PPM² (posterior mean). A short/noisy history yields ≈0 instead of a
// wild value (which the median detrend would multiply by the window age); a clean history is used ~fully.
const DRIFT_HISTORY = 512;
const DRIFT_X0_MS = 1;
const DRIFT_PRIOR_PPM = 100;
/** after a clock jump the previous drift estimate is carried over as a prior this tight (the crystal didn't change) */
const DRIFT_CARRY_PRIOR_PPM = 10;
/** below this history span the drift estimate is not updated (0 after reset) */
const DRIFT_MIN_SPAN_MS = 2_000;

/**
 * NTP-style clock estimator: sliding window, lowest-RTT-quartile median offset, linear-regression drift,
 * slewed (not stepped) corrections. Pure + deterministic: time only advances via sample timestamps.
 *
 * Conventions: offset = server − client (ms); `toRoomTime(l) = l + applied(l)`. Drift (ppm) is the slope
 * of the offset vs local time (+ve = client runs slow). Every estimate steps until (and including) the one
 * at which `converged` first becomes true; afterwards changes are slewed at ≤ maxSlewMsPerSec (on top of the
 * drift slope) unless |target − applied| > stepThresholdMs.
 *
 * Re-acquisition: after a gap in samples longer than SAMPLE_GAP_MS (hidden tab, sleep, reconnect) or an explicit
 * `rebase()`, the next `minSamples` samples are judged on their own. If they disagree with the extrapolated
 * mapping by more than gapStepThresholdMs the mapping steps onto them at once, the pre-gap window is dropped and
 * the pre-gap drift history is shifted by the same amount (a clock jump moves the offset, not the crystal rate), so
 * the drift baseline survives. If they agree, nothing is forgotten. `reset()` is for a genuinely new reference
 * clock (a different LAN master), not for reconnects.
 */
export class ClockSync implements RoomClock {
  private readonly windowSize: number;
  private readonly bestFraction: number;
  private readonly slewPerMs: number;
  private readonly stepThresholdMs: number;
  private readonly minSamples: number;
  private readonly maxSampleAgeMs: number;
  private readonly gapStepMs: number;

  private win: Pt[] = [];
  private hist: Pt[] = [];
  private driftPpm = 0;
  private driftSePpm = Infinity;
  private jitterMs = 0;
  private lastT = -Infinity;
  private lastSampleT = -Infinity;
  private epochT = -Infinity;
  private applied: Applied | null = null;
  private convergedOnce = false;
  private pendingSlew = 0;
  private regimeStart: number | null = null;
  private armed = false;
  private resetCount = 0;
  private driftPrior = { meanPpm: 0, varPpm2: DRIFT_PRIOR_PPM ** 2 };

  constructor(opts: ClockSyncOptions = {}) {
    this.windowSize = opts.windowSize ?? 64;
    this.bestFraction = opts.bestFraction ?? 0.25;
    this.slewPerMs = (opts.maxSlewMsPerSec ?? 1) / 1000;
    this.stepThresholdMs = opts.stepThresholdMs ?? 50;
    this.minSamples = opts.minSamples ?? 8;
    this.maxSampleAgeMs = opts.maxSampleAgeMs ?? 300_000;
    this.gapStepMs = opts.gapStepThresholdMs ?? 3;
  }

  addSample(s: ClockSample): void {
    const rtt = sampleRtt(s);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    const p: Pt = { t: (s.t0 + s.t3) / 2, rtt, off: sampleOffset(s) };

    // a long silence or an explicit rebase(): the next minSamples decide the mapping afresh
    if (this.armed || (this.lastSampleT > -Infinity && p.t - this.lastSampleT > SAMPLE_GAP_MS)) this.regimeStart = p.t;
    this.armed = false;
    this.lastSampleT = Math.max(this.lastSampleT, p.t);
    if (this.epochT === -Infinity) this.epochT = p.t;

    this.win.push(p);
    if (this.win.length > this.windowSize) this.win.shift();
    const minT = p.t - this.maxSampleAgeMs;
    if (this.win[0]!.t < minT) this.win = this.win.filter((q) => q.t >= minT);

    this.hist.push(p);
    if (this.hist.length > DRIFT_HISTORY) this.hist.shift();

    let subset = this.win;
    let regime: number | null = null;
    if (this.regimeStart !== null) {
      const start = this.regimeStart;
      const cands = this.win.filter((q) => q.t >= start);
      if (cands.length >= this.minSamples) {
        subset = cands;
        regime = start;
        this.regimeStart = null;
      }
    }
    const tNow = Math.max(s.t3, this.lastT);
    this.lastT = tNow;
    if (this.regimeStart !== null && this.applied && this.convergedOnce) {
      // re-acquisition pending: hold the mapping (drift extrapolation) and the drift fit until the new samples
      // can decide on their own — a few post-gap samples would otherwise bend both toward a half-step
      return;
    }

    // the drift is refitted after the step decision below: a jump must be judged, and the old estimate carried
    // over, before the new regime's samples can contaminate the fit
    const sd = this.driftPpm * 1e-6;
    const base = this.bestMedian(subset, p.t, sd);
    const target = base + sd * (tNow - p.t);
    const converged = this.win.length >= this.minSamples;
    const stepAnyway = !this.applied || !this.convergedOnce;
    if (converged) this.convergedOnce = true;

    const cur = this.applied ? this.appliedAt(tNow) : target;
    const delta = target - cur;
    const regimeStep = regime !== null && !stepAnyway && Math.abs(delta) > this.gapStepMs;
    const jump = !stepAnyway && !regimeStep && Math.abs(delta) > this.stepThresholdMs;
    if (regimeStep || jump) {
      // A clock jump moves the offset, not the crystal rate: drop the old regime's samples and carry the drift
      // estimate into the new history as a tight prior. (Shifting the old samples by `delta` instead would carry
      // the burst's own noise — ms on a jittery path — into the slope: tens of ppm over a short baseline.)
      // After a gap the old samples are the pre-gap ones; a jump seen through a mixed window is sorted by
      // distance from the mapping applied until now.
      let keep: (q: Pt) => boolean;
      if (regimeStep) {
        this.win = subset;
        keep = (q) => q.t >= regime!;
      } else {
        const prev = this.applied!;
        const lim = Math.abs(delta) / 2;
        keep = (q) => Math.abs(q.off - offsetAt(prev, q.t)) >= lim;
      }
      this.hist = this.hist.filter(keep);
      this.driftPrior = { meanPpm: this.driftPpm, varPpm2: DRIFT_CARRY_PRIOR_PPM ** 2 };
      this.driftSePpm = DRIFT_CARRY_PRIOR_PPM;
      this.epochT = tNow;
    }
    this.updateDrift();
    const slope = this.driftPpm * 1e-6;
    if (stepAnyway || regimeStep || jump || this.slewPerMs <= 0) {
      this.applied = { t0: tNow, a0: target, s1: slope, tEnd: Infinity, s2: slope };
      this.pendingSlew = 0;
    } else {
      this.applied = {
        t0: tNow,
        a0: cur,
        s1: slope + Math.sign(delta) * this.slewPerMs,
        tEnd: tNow + Math.abs(delta) / this.slewPerMs,
        s2: slope,
      };
      this.pendingSlew = delta;
    }
  }

  /** median of the lowest-RTT subset of `pts`, detrended to `tRef` with drift slope `sd`; updates jitterMs */
  private bestMedian(pts: Pt[], tRef: number, sd: number): number {
    const nBest = Math.min(pts.length, Math.max(3, Math.ceil(pts.length * this.bestFraction)));
    // ties (e.g. a jitter-free path) prefer the newest samples
    const best = [...pts].sort((a, b) => a.rtt - b.rtt || b.t - a.t).slice(0, nBest);
    const detr = best.map((q) => q.off + sd * (tRef - q.t));
    const mean = detr.reduce((a, b) => a + b, 0) / detr.length;
    this.jitterMs = Math.sqrt(detr.reduce((a, b) => a + (b - mean) ** 2, 0) / detr.length);
    return median(detr);
  }

  private updateDrift(): void {
    const h = this.hist;
    if (h.length < 4 || h[h.length - 1]!.t - h[0]!.t < DRIFT_MIN_SPAN_MS) return;
    let minRtt = Infinity;
    for (const q of h) minRtt = Math.min(minRtt, q.rtt);
    const t0 = h[0]!.t;
    const o0 = h[0]!.off;
    let sw = 0;
    let st = 0;
    let so = 0;
    const w = h.map((q) => 1 / (q.rtt - minRtt + DRIFT_X0_MS) ** 2);
    h.forEach((q, i) => {
      sw += w[i]!;
      st += w[i]! * (q.t - t0);
      so += w[i]! * (q.off - o0);
    });
    const tm = st / sw;
    const om = so / sw;
    let stt = 0;
    let sto = 0;
    h.forEach((q, i) => {
      const dt = q.t - t0 - tm;
      stt += w[i]! * dt * dt;
      sto += w[i]! * dt * (q.off - o0 - om);
    });
    if (!(stt > 0)) return;
    const slope = sto / stt;
    // heteroskedasticity-robust (sandwich) SE: does not trust the weight model to be the true variance
    let v = 0;
    h.forEach((q, i) => {
      const dt = q.t - t0 - tm;
      v += (w[i]! * dt * (q.off - o0 - om - slope * dt)) ** 2;
    });
    const se2 = v / (stt * stt);
    // posterior mean under the prior N(meanPpm, varPpm2): the session prior is 0 ± 100 ppm; after a clock jump the
    // previous estimate ± DRIFT_CARRY_PRIOR_PPM, so the new (short) history starts from what was already known
    const prior = this.driftPrior.varPpm2 * 1e-12;
    const mean = this.driftPrior.meanPpm * 1e-6;
    this.driftPpm = ((slope * prior + mean * se2) / (prior + se2)) * 1e6;
    this.driftSePpm = Math.sqrt((prior * se2) / (prior + se2)) * 1e6;
  }

  private appliedAt(t: number): number {
    return this.applied ? offsetAt(this.applied, t) : 0;
  }

  /** copy of the current local → room mapping (null before the first sample) */
  mapping(): ClockMappingData | null {
    return this.applied ? { ...this.applied } : null;
  }

  /** the mapping with any pending slew removed, anchored at the applied offset at `localMs` (identity before any sample) */
  frozenMapping(localMs: number): ClockMappingData {
    const s2 = this.applied?.s2 ?? 0;
    return { t0: localMs, a0: this.appliedAt(localMs), s1: s2, tEnd: Infinity, s2 };
  }

  frozenAt(localMs: number): TimeMap {
    return new ClockMapping(this.frozenMapping(localMs));
  }

  /** local client ms → room (server) ms */
  toRoomTime(localMs: number): number {
    return localMs + this.appliedAt(localMs);
  }

  /** room (server) ms → local client ms (exact inverse of toRoomTime for the current state) */
  toLocalTime(roomMs: number): number {
    return this.applied ? inverse(this.applied, roomMs) : roomMs;
  }

  /** how far the mapping has moved at `atLocalMs` since the snapshot `m` was taken, ms */
  shiftSince(m: ClockMappingData, atLocalMs: number): number {
    return this.appliedAt(atLocalMs) - offsetAt(m, atLocalMs);
  }

  /**
   * Re-acquire without forgetting: the next minSamples samples (a burst) are judged on their own and the mapping
   * steps onto them only if they disagree with it (see the class comment). Use at reconnect and when a tab becomes
   * visible again; the window, drift history and mapping all survive when the clocks haven't moved.
   */
  rebase(): void {
    this.armed = true;
  }

  estimate(): ClockEstimate {
    return {
      offsetMs: this.applied ? this.appliedAt(this.lastT) : 0,
      rttMs: this.win.length ? Math.min(...this.win.map((p) => p.rtt)) : 0,
      jitterMs: this.jitterMs,
      driftPpm: this.driftPpm,
      samples: this.win.length,
      converged: this.win.length >= this.minSamples,
      pendingSlewMs: this.pendingSlew,
      driftSePpm: this.driftSePpm,
      ageMs: this.lastT === -Infinity ? 0 : this.lastT - this.epochT,
      resets: this.resetCount,
    };
  }

  /** forget everything: only for a new reference clock (a different LAN master); reconnects use rebase() */
  reset(): void {
    this.win = [];
    this.hist = [];
    this.driftPpm = 0;
    this.driftSePpm = Infinity;
    this.jitterMs = 0;
    this.lastT = -Infinity;
    this.lastSampleT = -Infinity;
    this.epochT = -Infinity;
    this.applied = null;
    this.convergedOnce = false;
    this.pendingSlew = 0;
    this.regimeStart = null;
    this.armed = false;
    this.driftPrior = { meanPpm: 0, varPpm2: DRIFT_PRIOR_PPM ** 2 };
    this.resetCount++;
  }
}
