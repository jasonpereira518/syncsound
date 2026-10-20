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
 * Maps local performance-clock ms ↔ AudioContext seconds via robust linear regression over recent
 * observations. Feed it `getOutputTimestamp()` pairs (performanceTime, contextTime) — which describe
 * when a context time is actually *heard* (so output latency is included) — or (performance.now(),
 * currentTime) as a fallback (then add baseLatency+outputLatency compensation separately).
 *
 * Fit: ctxSec = yMean + slope·(perfMs − xMean) on centred data, one MAD outlier-rejection pass (render-quantum
 * jitter ≈ 2.7 ms and OS scheduling spikes). The slope's deviation from nominal (1e-3 s/ms) is shrunk by its
 * standard error, dev·dev²/(dev²+SE²), so a short/noisy observation span falls back toward the nominal rate
 * instead of extrapolating a wild one (matters for late joins, where roomToCtx is evaluated seconds back). Call `reset()` after the context is suspended/resumed (the
 * audio clock stops while the perf clock keeps running, which breaks the linear model).
 *
 * Steps: the browser's output path can change latency abruptly (device re-open, buffer resize, route change —
 * seen as a +44 ms jump in headless Chromium when a recorder graph starts). A regression through a step yields a
 * wildly wrong slope for a whole window, so outliers are held back and STEP_CONFIRM consecutive mutually
 * consistent outliers shift the window's history onto the new regime (counted in `steps`).
 */
export class AudioClockMap {
  private perf: number[] = [];
  private ctx: number[] = [];
  private fit: LineFit | null = null;
  private pending: Array<{ perf: number; ctx: number; r: number }> = [];
  /** number of output-path discontinuities detected since the last reset */
  steps = 0;

  constructor(private readonly windowSize = 64) {}

  addObservation(perfMs: number, ctxSec: number): void {
    if (!Number.isFinite(perfMs) || !Number.isFinite(ctxSec)) return;
    if (this.fit && this.perf.length >= STEP_MIN_OBS) {
      const r = (ctxSec - this.perfToCtx(perfMs)) * 1000;
      if (Math.abs(r) > STEP_MS) {
        // keep only the trailing run of outliers that agree with this one
        this.pending = this.pending.filter((o) => Math.abs(o.r - r) <= STEP_SPREAD_MS);
        this.pending.push({ perf: perfMs, ctx: ctxSec, r });
        if (this.pending.length < STEP_CONFIRM) return; // hold back: spike or start of a step
        // a latency step is an offset change, not a rate change: shift history onto the new regime
        // (keeps the slope estimate and readiness) and append the confirming observations
        const shift = this.pending.reduce((a, o) => a + o.r, 0) / this.pending.length / 1000;
        this.ctx = this.ctx.map((c) => c + shift);
        for (const o of this.pending) {
          this.perf.push(o.perf);
          this.ctx.push(o.ctx);
        }
        while (this.perf.length > this.windowSize) {
          this.perf.shift();
          this.ctx.shift();
        }
        this.pending = [];
        this.steps++;
        this.refit();
        return;
      }
      this.pending = [];
    }
    this.perf.push(perfMs);
    this.ctx.push(ctxSec);
    if (this.perf.length > this.windowSize) {
      this.perf.shift();
      this.ctx.shift();
    }
    this.refit();
  }

  private refit(): void {
    const f = this.perf.length >= 2 ? fitLine(this.perf, this.ctx, 3, 1e-5) : null;
    // a degenerate fit (all observations at one perf instant) keeps the nominal 1 s / 1000 ms rate
    if (!f || !(f.slope > 0)) {
      this.fit = null;
      return;
    }
    const dev = f.slope - NOMINAL;
    const se2 = f.slopeSe * f.slopeSe;
    this.fit = { ...f, slope: NOMINAL + (dev * dev * dev) / (dev * dev + se2 || 1) };
  }

  ready(): boolean {
    return this.perf.length >= 4 && this.fit !== null;
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

  /** audio clock rate error vs performance clock, ppm (+ve: audio clock runs fast) */
  ratePpm(): number {
    return this.fit ? (this.fit.slope / NOMINAL - 1) * 1e6 : 0;
  }

  reset(): void {
    this.perf = [];
    this.ctx = [];
    this.fit = null;
    this.pending = [];
    this.steps = 0;
  }
}
