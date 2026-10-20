import { describe, expect, it } from 'vitest';
import { RemoteSyncController } from '@syncsound/audio-core';
import { stats, writeResult } from '../src/clockSim';
import { makeRng, type Rng } from '../src/network';

/** Mock Spotify/MusicKit player: async seeks with latency, drifting playback, quantised + noisy position reports. */
class MockSdkPlayer {
  private basePos: number;
  private baseT = 0;
  private pending: { target: number; landT: number } | null = null;
  seeksIssued = 0;
  constructor(
    private readonly rng: Rng,
    private readonly p: { initialPosMs: number; ratePpm: number; seekLatency: () => number; noiseMs: number; quantumMs: number },
  ) {
    this.basePos = p.initialPosMs;
  }
  truePos(T: number): number {
    return this.basePos + (T - this.baseT) * (1 + this.p.ratePpm * 1e-6);
  }
  seek(target: number, T: number): void {
    this.seeksIssued++;
    this.pending = { target, landT: T + this.p.seekLatency() };
  }
  /** advance to T; true if a pending seek landed */
  advance(T: number): boolean {
    if (!this.pending || T < this.pending.landT) return false;
    this.basePos = this.pending.target;
    this.baseT = this.pending.landT;
    this.pending = null;
    return true;
  }
  stall(ms: number, T: number): void {
    this.basePos = this.truePos(T) - ms;
    this.baseT = T;
  }
  reported(T: number): number {
    const noisy = this.truePos(T) + this.rng.uniform(-this.p.noiseMs, this.p.noiseMs);
    return Math.round(noisy / this.p.quantumMs) * this.p.quantumMs;
  }
}

const POLL_MS = 500;
const DURATION_MS = 10 * 60_000;
const SETTLE_MS = 20_000;

function run(name: string, seed: number, seekLatency: (rng: Rng) => number, latencyDesc: string) {
  const rng = makeRng(seed);
  const params = { initialPosMs: -650, ratePpm: 300, noiseMs: 20, quantumMs: 10, stallAtMs: 300_000, stallMs: 400 };
  const player = new MockSdkPlayer(rng, { ...params, seekLatency: () => seekLatency(rng) });
  const ctl = new RemoteSyncController();
  let awaitingResult = false;
  let firstWithin30 = NaN;
  const trueErr: number[] = [];
  const seekTimes: number[] = [];
  for (let T = 0; T <= DURATION_MS; T += POLL_MS) {
    if (T === params.stallAtMs) player.stall(params.stallMs, T);
    const landed = player.advance(T);
    const expected = T;
    const reported = player.reported(T);
    if (landed && awaitingResult) {
      ctl.recordSeekResult(expected - reported);
      awaitingResult = false;
    }
    const d = ctl.update({ expectedPositionMs: expected, reportedPositionMs: reported, nowMs: T });
    if (d.action === 'seek') {
      player.seek(d.seekToMs!, T);
      seekTimes.push(T);
      awaitingResult = true;
    }
    const e = player.truePos(T) - expected;
    if (Number.isNaN(firstWithin30) && Math.abs(e) < 30) firstWithin30 = T;
    if (T >= SETTLE_MS) trueErr.push(e);
  }
  const s = ctl.stats();
  const gaps = seekTimes.slice(1).map((t, i) => t - seekTimes[i]!);
  return {
    name,
    params: { ...params, seekLatency: latencyDesc, pollMs: POLL_MS, durationMs: DURATION_MS, controller: 'defaults (enter 80, exit 30, confirm 2, min interval 3 s)' },
    trueErrorAfter20sMs: stats(trueErr),
    controllerStats: { ...s, meanAbsErrorMs: +s.meanAbsErrorMs.toFixed(2), p95AbsErrorMs: +s.p95AbsErrorMs.toFixed(2), seekLatencyMs: +s.seekLatencyMs.toFixed(1) },
    seeks: seekTimes.length,
    seekTimesSec: seekTimes.map((t) => t / 1000),
    minGapBetweenSeeksMs: gaps.length ? Math.min(...gaps) : null,
    firstWithin30msAtSec: firstWithin30 / 1000,
  };
}

const results: Record<string, unknown> = {};

describe('RemoteSyncController vs a mock SDK player (10 simulated minutes)', () => {
  it('consistent seek latency (300 ms mean, σ 40 ms, clamped 150–400): converges, p95 < 100 ms, no thrash', () => {
    const r = run('consistent', 11, (rng) => Math.min(400, Math.max(150, 300 + 40 * rng.gauss())), 'N(300, 40) clamped [150, 400] ms');
    results.consistentLatency = r;
    expect(r.firstWithin30msAtSec).toBeLessThan(15);
    expect(r.trueErrorAfter20sMs.p95).toBeLessThan(100);
    expect(r.minGapBetweenSeeksMs ?? Infinity).toBeGreaterThanOrEqual(3000);
    expect(Math.abs(r.controllerStats.seekLatencyMs - 300)).toBeLessThan(60);
    expect(r.seeks).toBeLessThan(20);
  });

  it('erratic seek latency U(150, 400) ms: still p95 < 100 ms, seek count bounded', () => {
    const r = run('erratic', 12, (rng) => rng.uniform(150, 400), 'U(150, 400) ms');
    results.erraticLatency = r;
    expect(r.trueErrorAfter20sMs.p95).toBeLessThan(100);
    expect(r.minGapBetweenSeeksMs ?? Infinity).toBeGreaterThanOrEqual(3000);
    expect(r.seeks).toBeLessThan(40);
  });

  it('writes results', () => {
    writeResult('remote', results);
  });
});
