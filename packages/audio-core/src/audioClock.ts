import { fitLine, type LineFit } from './clock';

/** AudioContext seconds per performance ms at a perfect clock ratio */
const NOMINAL = 1e-3;

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
 */
export class AudioClockMap {
  private perf: number[] = [];
  private ctx: number[] = [];
  private fit: LineFit | null = null;

  constructor(private readonly windowSize = 64) {}

  addObservation(perfMs: number, ctxSec: number): void {
    if (!Number.isFinite(perfMs) || !Number.isFinite(ctxSec)) return;
    this.perf.push(perfMs);
    this.ctx.push(ctxSec);
    if (this.perf.length > this.windowSize) {
      this.perf.shift();
      this.ctx.shift();
    }
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
  }
}
