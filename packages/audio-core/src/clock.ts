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
}

/** what the engine needs from a clock: ClockSync itself, or the LAN ClockLink composed on top of one */
export interface RoomClock {
  toRoomTime(localMs: number): number;
  toLocalTime(roomMs: number): number;
  estimate(): ClockEstimate;
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
}

export const sampleRtt = (s: ClockSample) => s.t3 - s.t0 - (s.tsSend - s.tsRecv);
export const sampleOffset = (s: ClockSample) => (s.tsRecv - s.t0 + (s.tsSend - s.t3)) / 2;

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
 * Least-squares line on centred data (numerically stable for epoch-sized x/y), then one pass of outlier
 * rejection: points with |residual| > k·1.4826·MAD (floored at `minResidual`) are dropped and the line refit.
 */
export function fitLine(xs: number[], ys: number[], k = 3, minResidual = 1e-9): LineFit {
  if (xs.length === 0) return { xMean: 0, yMean: 0, slope: 0, slopeSe: 0, n: 0 };
  const all = xs.map(() => true);
  const first = lsq(xs, ys, all);
  if (xs.length < 4) return first;
  const res = xs.map((x, i) => ys[i]! - (first.yMean + first.slope * (x - first.xMean)));
  const mad = median(res.map(Math.abs));
  const lim = Math.max(k * 1.4826 * mad, minResidual);
  const keep = res.map((r) => Math.abs(r) <= lim);
  return keep.filter(Boolean).length >= 2 ? lsq(xs, ys, keep) : first;
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
export class ClockMapping {
  constructor(readonly data: ClockMappingData) {}

  /** snapshot of `sync`'s current mapping, or null before its first sample */
  static of(sync: ClockSync): ClockMapping | null {
    const d = sync.mapping();
    return d ? new ClockMapping(d) : null;
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
/** below this history span the drift estimate is not updated (0 after reset) */
const DRIFT_MIN_SPAN_MS = 2_000;

/**
 * NTP-style clock estimator: sliding window, lowest-RTT-quartile median offset, linear-regression drift,
 * slewed (not stepped) corrections. Pure + deterministic: time only advances via sample timestamps.
 *
 * Conventions: offset = server − client (ms); `toRoomTime(l) = l + applied(l)`. Drift (ppm) is the slope
 * of the offset vs local time (+ve = client runs slow). Every estimate steps until (and including) the one
 * at which `converged` first becomes true; afterwards changes are slewed at ≤ maxSlewMsPerSec (on top of the
 * drift slope) unless |target − applied| > stepThresholdMs. Call `reset()` after a reconnect.
 */
export class ClockSync implements RoomClock {
  private readonly windowSize: number;
  private readonly bestFraction: number;
  private readonly slewPerMs: number;
  private readonly stepThresholdMs: number;
  private readonly minSamples: number;

  private win: Pt[] = [];
  private hist: Pt[] = [];
  private driftPpm = 0;
  private jitterMs = 0;
  private lastT = -Infinity;
  private applied: Applied | null = null;
  private convergedOnce = false;

  constructor(opts: ClockSyncOptions = {}) {
    this.windowSize = opts.windowSize ?? 64;
    this.bestFraction = opts.bestFraction ?? 0.25;
    this.slewPerMs = (opts.maxSlewMsPerSec ?? 1) / 1000;
    this.stepThresholdMs = opts.stepThresholdMs ?? 50;
    this.minSamples = opts.minSamples ?? 8;
  }

  addSample(s: ClockSample): void {
    const rtt = sampleRtt(s);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    const p: Pt = { t: (s.t0 + s.t3) / 2, rtt, off: sampleOffset(s) };

    this.win.push(p);
    if (this.win.length > this.windowSize) this.win.shift();

    this.hist.push(p);
    if (this.hist.length > DRIFT_HISTORY) this.hist.shift();
    this.updateDrift();

    // Best subset by RTT; offsets detrended to the newest sample time so drift doesn't bias the median.
    const tRef = p.t;
    const sd = this.driftPpm * 1e-6;
    const nBest = Math.min(this.win.length, Math.max(3, Math.ceil(this.win.length * this.bestFraction)));
    // ties (e.g. a jitter-free path) prefer the newest samples
    const best = [...this.win].sort((a, b) => a.rtt - b.rtt || b.t - a.t).slice(0, nBest);
    const detr = best.map((q) => q.off + sd * (tRef - q.t));
    const base = median(detr);
    const mean = detr.reduce((a, b) => a + b, 0) / detr.length;
    this.jitterMs = Math.sqrt(detr.reduce((a, b) => a + (b - mean) ** 2, 0) / detr.length);

    const tNow = Math.max(s.t3, this.lastT);
    this.lastT = tNow;
    const target = base + sd * (tNow - tRef);
    const converged = this.win.length >= this.minSamples;
    const stepAnyway = !this.applied || !this.convergedOnce;
    if (converged) this.convergedOnce = true;

    const cur = this.applied ? this.appliedAt(tNow) : target;
    const delta = target - cur;
    if (stepAnyway || Math.abs(delta) > this.stepThresholdMs || this.slewPerMs <= 0) {
      this.applied = { t0: tNow, a0: target, s1: sd, tEnd: Infinity, s2: sd };
    } else {
      this.applied = {
        t0: tNow,
        a0: cur,
        s1: sd + Math.sign(delta) * this.slewPerMs,
        tEnd: tNow + Math.abs(delta) / this.slewPerMs,
        s2: sd,
      };
    }
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
    const prior = (DRIFT_PRIOR_PPM * 1e-6) ** 2;
    this.driftPpm = ((slope * prior) / (prior + se2)) * 1e6;
  }

  private appliedAt(t: number): number {
    return this.applied ? offsetAt(this.applied, t) : 0;
  }

  /** copy of the current local → room mapping (null before the first sample) */
  mapping(): ClockMappingData | null {
    return this.applied ? { ...this.applied } : null;
  }

  /** local client ms → room (server) ms */
  toRoomTime(localMs: number): number {
    return localMs + this.appliedAt(localMs);
  }

  /** room (server) ms → local client ms (exact inverse of toRoomTime for the current state) */
  toLocalTime(roomMs: number): number {
    return this.applied ? inverse(this.applied, roomMs) : roomMs;
  }

  estimate(): ClockEstimate {
    return {
      offsetMs: this.applied ? this.appliedAt(this.lastT) : 0,
      rttMs: this.win.length ? Math.min(...this.win.map((p) => p.rtt)) : 0,
      jitterMs: this.jitterMs,
      driftPpm: this.driftPpm,
      samples: this.win.length,
      converged: this.win.length >= this.minSamples,
    };
  }

  reset(): void {
    this.win = [];
    this.hist = [];
    this.driftPpm = 0;
    this.jitterMs = 0;
    this.lastT = -Infinity;
    this.applied = null;
    this.convergedOnce = false;
  }
}
