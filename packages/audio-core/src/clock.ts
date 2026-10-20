import { todo } from './todo';

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

/**
 * NTP-style clock estimator: sliding window, lowest-RTT-quartile median offset, linear-regression drift,
 * slewed (not stepped) corrections. Pure + deterministic: time only advances via sample timestamps.
 */
export class ClockSync {
  constructor(_opts: ClockSyncOptions = {}) {}
  addSample(_s: ClockSample): void {
    todo('ClockSync.addSample');
  }
  /** local client ms → room (server) ms */
  toRoomTime(_localMs: number): number {
    return todo('ClockSync.toRoomTime');
  }
  /** room (server) ms → local client ms */
  toLocalTime(_roomMs: number): number {
    return todo('ClockSync.toLocalTime');
  }
  estimate(): ClockEstimate {
    return todo('ClockSync.estimate');
  }
  reset(): void {
    todo('ClockSync.reset');
  }
}
