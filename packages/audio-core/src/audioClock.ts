import { fitLine, type LineFit } from './clock';

/** AudioContext seconds per performance ms at a perfect clock ratio */
const NOMINAL = 1e-3;
/** residual (ms) beyond which an observation may be a step in the output path (> 2 render quanta) */
const STEP_MS = 6;
/** consecutive outliers that confirm a step… */
const STEP_CONFIRM = 3;
/** …and must agree with each other within this (a real step shifts every residual equally; OS scheduling
 * hiccups are random 5–30 ms), ms */
const STEP_SPREAD_MS = 3;
/** observations needed before steps are considered (early fits are too crude to judge residuals) */
const STEP_MIN_OBS = 8;
/**
 * Consecutive outliers that never confirm a step mean the fit itself is wrong (a step inside the first
 * observations bends its slope, and every later residual then grows past the last by more than
 * STEP_SPREAD_MS): after this many (2 s at 4 Hz) the map is rebuilt from them.
 */
const LOCK_LOST_OBS = 8;
/** long-baseline rate: up to this many observations (256 s at 4 Hz)… */
export const LONG_RATE_WINDOW = 1024;
/** …used for the slope once it holds this many observations spanning at least this long. With ±½ render quantum
 * of timestamp jitter the slope's standard error is ≈ 4 ppm at 30 s, 3 ppm at 60 s and 0.3 ppm at 256 s; the
 * 16 s short window alone gives ≈ 20 ppm (and is shrunk toward nominal accordingly). */
export const LONG_RATE_MIN_OBS = 64;
export const LONG_RATE_MIN_SPAN_MS = 30_000;

/** the long-baseline audio-clock rate in use */
export interface AudioRate {
  /** AudioContext seconds per performance ms (the slope the map predicts with) */
  ctxPerPerfMs: number;
  /** standard error of that slope, ppm */
  sePpm: number;
  spanMs: number;
  n: number;
}

/**
 * Maps local performance-clock ms ↔ AudioContext seconds via robust linear regression over recent
 * observations. Feed it `getOutputTimestamp()` pairs (performanceTime, contextTime) — which describe
 * when a context time is actually *heard* (so output latency is included) — or (performance.now(),
 * currentTime) as a fallback (then add baseLatency+outputLatency compensation separately).
 *
 * Fit: ctxSec = yMean + slope·(perfMs − xMean) on centred data, one MAD outlier-rejection pass (render-quantum
 * jitter ≈ 2.7 ms and OS scheduling spikes). The offset comes from the short window (64 observations); the slope
 * comes from a long window (up to LONG_RATE_WINDOW observations, once LONG_RATE_MIN_OBS / LONG_RATE_MIN_SPAN_MS
 * are met) and, either way, its deviation from nominal (1e-3 s/ms) is shrunk by its standard error,
 * dev·dev²/(dev²+SE²), so a short/noisy observation span falls back toward the nominal rate instead of
 * extrapolating a wild one (matters for late joins, where roomToCtx is evaluated seconds back). Call `reset()`
 * after the context is suspended/resumed (the audio clock stops while the perf clock keeps running, which breaks
 * the linear model).
 *
 * Steps: the browser's output path can change latency abruptly (device re-open, buffer resize, route change —
 * seen as a +44 ms jump in headless Chromium when a recorder graph starts). A regression through a step yields a
 * wildly wrong slope for a whole window, so outliers are held back and STEP_CONFIRM consecutive mutually
 * consistent outliers shift both windows' history onto the new regime (counted in `steps`). A run of
 * LOCK_LOST_OBS outliers that never agree means the fit itself is bent (a step among its first observations):
 * the map is rebuilt from that run (also counted in `steps`).
 */
export class AudioClockMap {
  private perf: number[] = [];
  private ctx: number[] = [];
  private longPerf: number[] = [];
  private longCtx: number[] = [];
  private fit: LineFit | null = null;
  private long: LineFit | null = null;
  private pending: Array<{ perf: number; ctx: number; r: number }> = [];
  /** every consecutive outlier, agreeing or not (lost-lock detection) */
  private outliers: Array<{ perf: number; ctx: number }> = [];
  /** number of output-path discontinuities detected since the last reset */
  steps = 0;

  constructor(private readonly windowSize = 64) {}

  addObservation(perfMs: number, ctxSec: number): void {
    if (!Number.isFinite(perfMs) || !Number.isFinite(ctxSec)) return;
    if (this.fit && this.perf.length >= STEP_MIN_OBS) {
      const r = (ctxSec - this.perfToCtx(perfMs)) * 1000;
      if (Math.abs(r) > STEP_MS) {
        this.outliers.push({ perf: perfMs, ctx: ctxSec });
        if (this.outliers.length >= LOCK_LOST_OBS) {
          // lost lock: the fit, not the output, is wrong. Start over from the recent observations (the long
          // window too: its history was fitted through the same bend)
          const recent = this.outliers;
          this.perf = [];
          this.ctx = [];
          this.longPerf = [];
          this.longCtx = [];
          this.pending = [];
          this.outliers = [];
          for (const o of recent) this.push(o.perf, o.ctx);
          this.steps++;
          this.refit();
          return;
        }
        // keep only the trailing run of outliers that agree with this one
        this.pending = this.pending.filter((o) => Math.abs(o.r - r) <= STEP_SPREAD_MS);
        this.pending.push({ perf: perfMs, ctx: ctxSec, r });
        if (this.pending.length < STEP_CONFIRM) return; // hold back: spike or start of a step
        // a latency step is an offset change, not a rate change: shift history onto the new regime
        // (keeps the slope estimate and readiness) and append the confirming observations
        const shift = this.pending.reduce((a, o) => a + o.r, 0) / this.pending.length / 1000;
        this.ctx = this.ctx.map((c) => c + shift);
        this.longCtx = this.longCtx.map((c) => c + shift);
        for (const o of this.pending) this.push(o.perf, o.ctx);
        this.pending = [];
        this.outliers = [];
        this.steps++;
        this.refit();
        return;
      }
      this.pending = [];
      this.outliers = [];
    }
    this.push(perfMs, ctxSec);
    this.refit();
  }

  private push(perfMs: number, ctxSec: number): void {
    this.perf.push(perfMs);
    this.ctx.push(ctxSec);
    if (this.perf.length > this.windowSize) {
      this.perf.shift();
      this.ctx.shift();
    }
    this.longPerf.push(perfMs);
    this.longCtx.push(ctxSec);
    if (this.longPerf.length > LONG_RATE_WINDOW) {
      this.longPerf.shift();
      this.longCtx.shift();
    }
  }

  private refit(): void {
    const f = this.perf.length >= 2 ? fitLine(this.perf, this.ctx, 3, 1e-5) : null;
    // a degenerate fit (all observations at one perf instant) keeps the nominal 1 s / 1000 ms rate
    if (!f || !(f.slope > 0)) {
      this.fit = null;
      this.long = null;
      return;
    }
    let long: LineFit | null = null;
    const n = this.longPerf.length;
    if (n >= LONG_RATE_MIN_OBS && this.longPerf[n - 1]! - this.longPerf[0]! >= LONG_RATE_MIN_SPAN_MS) {
      const lf = fitLine(this.longPerf, this.longCtx, 3, 1e-5);
      if (lf.slope > 0) long = lf;
    }
    this.long = long;
    const src = long ?? f;
    const dev = src.slope - NOMINAL;
    const se2 = src.slopeSe * src.slopeSe;
    this.fit = { ...f, slope: NOMINAL + (dev * dev * dev) / (dev * dev + se2 || 1) };
  }

  ready(): boolean {
    return this.perf.length >= 4 && this.fit !== null;
  }

  /** observations held back as a possible step (0 when the map is on its regime) */
  pendingSteps(): number {
    return this.pending.length;
  }

  private line(): LineFit {
    if (this.fit) return this.fit;
    const n = this.perf.length;
    return n ? { xMean: this.perf[n - 1]!, yMean: this.ctx[n - 1]!, slope: NOMINAL, slopeSe: 0, n: 1 } : { xMean: 0, yMean: 0, slope: NOMINAL, slopeSe: 0, n: 0 };
  }

  perfToCtx(perfMs: number): number {
    const l = this.line();
    return l.yMean + l.slope * (perfMs - l.xMean);
  }

  ctxToPerf(ctxSec: number): number {
    const l = this.line();
    return l.xMean + (ctxSec - l.yMean) / l.slope;
  }

  /** audio clock rate error vs performance clock, ppm (+ve: audio clock runs fast); the slope in use */
  ratePpm(): number {
    return this.fit ? (this.fit.slope / NOMINAL - 1) * 1e6 : 0;
  }

  /** AudioContext seconds per performance ms in use (the long-baseline slope once available, else the short one) */
  slope(): number {
    return this.line().slope;
  }

  /** the long-baseline rate, or null while the long window is still too short to beat the short one */
  longRate(): AudioRate | null {
    const l = this.long;
    if (!l || !this.fit) return null;
    const n = this.longPerf.length;
    return { ctxPerPerfMs: this.fit.slope, sePpm: (l.slopeSe / NOMINAL) * 1e6, spanMs: this.longPerf[n - 1]! - this.longPerf[0]!, n: l.n };
  }

  reset(): void {
    this.perf = [];
    this.ctx = [];
    this.longPerf = [];
    this.longCtx = [];
    this.fit = null;
    this.long = null;
    this.pending = [];
    this.outliers = [];
    this.steps = 0;
  }
}
