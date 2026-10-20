import { todo } from './todo';

/**
 * Maps local performance-clock ms ↔ AudioContext seconds via robust linear regression over recent
 * observations. Feed it `getOutputTimestamp()` pairs (performanceTime, contextTime) — which describe
 * when a context time is actually *heard* (so output latency is included) — or (performance.now(),
 * currentTime) as a fallback (then add baseLatency+outputLatency compensation separately).
 */
export class AudioClockMap {
  constructor(_windowSize = 64) {}
  addObservation(_perfMs: number, _ctxSec: number): void {
    todo('AudioClockMap.addObservation');
  }
  ready(): boolean {
    return todo('AudioClockMap.ready');
  }
  perfToCtx(_perfMs: number): number {
    return todo('AudioClockMap.perfToCtx');
  }
  ctxToPerf(_ctxSec: number): number {
    return todo('AudioClockMap.ctxToPerf');
  }
  /** audio clock rate error vs performance clock, ppm */
  ratePpm(): number {
    return todo('AudioClockMap.ratePpm');
  }
  reset(): void {
    todo('AudioClockMap.reset');
  }
}
