import { todo } from './todo';

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
  errorMs: number;
}

export interface RemoteSyncStats {
  meanAbsErrorMs: number;
  p95AbsErrorMs: number;
  seeks: number;
  seekLatencyMs: number;
  samples: number;
}

/** Class B (Spotify/Apple) seek-based sync with hysteresis and learned seek latency. */
export class RemoteSyncController {
  constructor(_opts: RemoteSyncOptions = {}) {}
  update(_input: RemoteSyncInput): RemoteSyncDecision {
    return todo('RemoteSyncController.update');
  }
  /** after a seek, report residual error observed so the lead can be learned (ms, +ve = player behind) */
  recordSeekResult(_residualErrorMs: number): void {
    todo('RemoteSyncController.recordSeekResult');
  }
  stats(): RemoteSyncStats {
    return todo('RemoteSyncController.stats');
  }
  reset(): void {
    todo('RemoteSyncController.reset');
  }
}
