export interface RemoteSyncOptions {
  /** start correcting when |error| exceeds this (default 80 ms) */
  enterThresholdMs?: number;
  /** stop correcting once |error| is below this (default 30 ms) */
  exitThresholdMs?: number;
  /** minimum time between seeks (default 3000 ms) */
  minSeekIntervalMs?: number;
  /** consecutive over-threshold reports required before seeking (default 2) */
  confirmCount?: number;
}

export interface RemoteSyncInput {
  /** where the room timeline says the track should be, ms */
  expectedPositionMs: number;
  /** position reported by the SDK player, already extrapolated to nowMs, ms */
  reportedPositionMs: number;
  /** local ms */
  nowMs: number;
}

export interface RemoteSyncDecision {
  action: 'none' | 'seek';
  /** seek target including learned seek-latency lead */
  seekToMs?: number;
  /** reported − expected, ms (+ve = player ahead) */
  errorMs: number;
}

export interface RemoteSyncStats {
  meanAbsErrorMs: number;
  p95AbsErrorMs: number;
  seeks: number;
  seekLatencyMs: number;
  /** learned delay from a play request to audible playback (a new track loads, so it's longer than a seek) */
  startLatencyMs: number;
  samples: number;
}

/** what a device learned about its player; kept across tracks (and sessions) */
export interface RemoteLeads {
  seekMs: number;
  startMs: number;
}

/** EMA weight of each new seek-latency observation */
const LEAD_ALPHA = 0.3;
/** stats are computed over this many most recent readings */
const STATS_WINDOW = 1024;

/**
 * Class B (Spotify/Apple) seek-based sync with hysteresis and learned seek latency.
 *
 * Hysteresis: idle until `confirmCount` consecutive |error| > enter; then seek (at most once per
 * minSeekInterval, each seek needing `confirmCount` fresh confirmations) until |error| < exit.
 * Seek lead: the caller reports the residual after each seek via recordSeekResult (expected − reported from
 * the first reading after the seek resolved); lead ← lead + α·residual, i.e. an EMA of the total latency
 * (α = 1 for the first result, so the EMA starts at the first observed latency).
 */
export class RemoteSyncController {
  private readonly enter: number;
  private readonly exit: number;
  private readonly minInterval: number;
  private readonly confirm: number;
  private correcting = false;
  private count = 0;
  private lastSeek = -Infinity;
  private lead = 0;
  private leadInit = false;
  private startLead = 0;
  private startInit = false;
  private seeks = 0;
  private samples = 0;
  private errs: number[] = [];

  constructor(opts: RemoteSyncOptions = {}) {
    this.enter = opts.enterThresholdMs ?? 80;
    this.exit = opts.exitThresholdMs ?? 30;
    this.minInterval = opts.minSeekIntervalMs ?? 3000;
    this.confirm = Math.max(1, opts.confirmCount ?? 2);
  }

  update(input: RemoteSyncInput): RemoteSyncDecision {
    const errorMs = input.reportedPositionMs - input.expectedPositionMs;
    const abs = Math.abs(errorMs);
    this.samples++;
    this.errs.push(abs);
    if (this.errs.length > STATS_WINDOW) this.errs.shift();

    if (this.correcting && abs < this.exit) this.correcting = false;
    const over = abs > (this.correcting ? this.exit : this.enter);
    this.count = over ? this.count + 1 : 0;
    if (this.count >= this.confirm) this.correcting = true;

    if (this.correcting && this.count >= this.confirm && input.nowMs - this.lastSeek >= this.minInterval) {
      this.lastSeek = input.nowMs;
      this.count = 0;
      this.seeks++;
      return { action: 'seek', seekToMs: Math.max(0, input.expectedPositionMs + this.lead), errorMs };
    }
    return { action: 'none', errorMs };
  }

  /** after a seek, report residual error observed so the lead can be learned (ms, +ve = player behind) */
  recordSeekResult(residualErrorMs: number): void {
    if (!Number.isFinite(residualErrorMs)) return;
    // the EMA is seeded with the first observed latency, then smoothed
    this.lead = Math.max(0, this.lead + (this.leadInit ? LEAD_ALPHA : 1) * residualErrorMs);
    this.leadInit = true;
  }

  /** after a track start, report the residual error seen first (ms, +ve = player behind) to learn the start lead */
  recordStartResult(residualErrorMs: number): void {
    if (!Number.isFinite(residualErrorMs)) return;
    this.startLead = Math.max(0, this.startLead + (this.startInit ? LEAD_ALPHA : 1) * residualErrorMs);
    this.startInit = true;
  }

  exportLeads(): RemoteLeads {
    return { seekMs: this.lead, startMs: this.startLead };
  }

  /** seed both leads (e.g. from a previous session on this device); a later result still replaces a seed outright */
  seedLeads(l: Partial<RemoteLeads>): void {
    const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 5000;
    if (ok(l.seekMs)) this.lead = l.seekMs;
    if (ok(l.startMs)) this.startLead = l.startMs;
  }

  stats(): RemoteSyncStats {
    const n = this.errs.length;
    const sorted = [...this.errs].sort((a, b) => a - b);
    return {
      meanAbsErrorMs: n ? this.errs.reduce((a, b) => a + b, 0) / n : 0,
      p95AbsErrorMs: n ? sorted[Math.min(n - 1, Math.floor(0.95 * n))]! : 0,
      seeks: this.seeks,
      seekLatencyMs: this.lead,
      startLatencyMs: this.startLead,
      samples: this.samples,
    };
  }

  /** a new track: forget the correction state and per-track stats, keep what was learned about the player */
  resetTrack(): void {
    this.correcting = false;
    this.count = 0;
    this.lastSeek = -Infinity;
    this.seeks = 0;
    this.samples = 0;
    this.errs = [];
  }

  /** forget everything, including the learned leads */
  reset(): void {
    this.correcting = false;
    this.count = 0;
    this.lastSeek = -Infinity;
    this.lead = 0;
    this.leadInit = false;
    this.startLead = 0;
    this.startInit = false;
    this.seeks = 0;
    this.samples = 0;
    this.errs = [];
  }
}
