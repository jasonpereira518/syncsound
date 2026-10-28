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
  /** start (or restart) playing `target` at exactly time T (a start whose latency the caller already drew) */
  startAt(target: number, T: number): void {
    this.basePos = target;
    this.baseT = T;
    this.pending = null;
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

/**
 * Songs back to back: each starts with a play request sent `startLead` before its room start time and landing after
 * the player's start latency; the first reading after the start (1.5 s later) teaches the lead, then seeks correct.
 * `keepLeads` = resetTrack() between songs (the fix) vs reset() (forgets the lead every song).
 */
function boundaries(seed: number, keepLeads: boolean) {
  const rng = makeRng(seed);
  const SONG_MS = 30_000;
  const SONGS = 10;
  const ctl = new RemoteSyncController();
  const boundaryErr: number[] = [];
  for (let k = 0; k < SONGS; k++) {
    const T0 = k * SONG_MS;
    if (keepLeads) ctl.resetTrack();
    else ctl.reset();
    const lead = ctl.stats().startLatencyMs;
    const latency = () => Math.min(500, Math.max(150, 300 + 80 * rng.gauss()));
    const player = new MockSdkPlayer(rng, { initialPosMs: 0, ratePpm: 0, seekLatency: latency, noiseMs: 10, quantumMs: 10 });
    // the start: requested at T0 − lead for position 0, so it lands `latency − lead` late
    const land = T0 - lead + latency();
    player.startAt(0, land);
    let startPending = true;
    let awaitingSeek = false;
    for (let T = T0 + 500; T < T0 + SONG_MS; T += POLL_MS) {
      const landed = player.advance(T);
      const expected = T - T0;
      const pos = player.truePos(T);
      if (T >= T0 + 1500 && startPending) {
        ctl.recordStartResult(expected - player.reported(T));
        startPending = false;
      } else if (landed && awaitingSeek) {
        ctl.recordSeekResult(expected - player.reported(T));
        awaitingSeek = false;
      }
      if (T >= T0 + 1500) {
        const d = ctl.update({ expectedPositionMs: expected, reportedPositionMs: player.reported(T), nowMs: T });
        if (d.action === 'seek') {
          player.seek(d.seekToMs!, T);
          awaitingSeek = true;
        }
      }
      if (k > 0 && T < T0 + 3000) boundaryErr.push(Math.abs(pos - expected));
    }
  }
  return { songs: SONGS, songMs: SONG_MS, startLatency: 'N(300, 80) clamped [150, 500] ms', boundaryAbsErrMs: stats(boundaryErr), learnedStartLeadMs: +ctl.stats().startLatencyMs.toFixed(1) };
}

/**
 * A device whose speaker sounds 200 ms after the player's position (Bluetooth). The driver aims the player at the
 * room position `compMs` ahead; what is heard is the player position minus the 200 ms sink delay.
 */
function bluetooth(seed: number, compMs: number) {
  const rng = makeRng(seed);
  const SINK_MS = 200;
  const player = new MockSdkPlayer(rng, { initialPosMs: 0, ratePpm: 100, seekLatency: () => Math.min(400, Math.max(150, 300 + 40 * rng.gauss())), noiseMs: 20, quantumMs: 10 });
  const ctl = new RemoteSyncController();
  ctl.seedLeads({ seekMs: 300 });
  let awaiting = false;
  const heard: number[] = [];
  for (let T = 0; T <= 120_000; T += POLL_MS) {
    const landed = player.advance(T);
    const expected = T + compMs;
    if (landed && awaiting) {
      ctl.recordSeekResult(expected - player.reported(T));
      awaiting = false;
    }
    const d = ctl.update({ expectedPositionMs: expected, reportedPositionMs: player.reported(T), nowMs: T });
    if (d.action === 'seek') {
      player.seek(d.seekToMs!, T);
      awaiting = true;
    }
    if (T >= SETTLE_MS) heard.push(Math.abs(player.truePos(T) - SINK_MS - T));
  }
  return { sinkDelayMs: SINK_MS, compensationMs: compMs, heardAbsErrMs: stats(heard) };
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

  it('track boundaries: 10 × 30 s songs, start latency N(300, 80): learned start lead kept across tracks', () => {
    const r = (keep: boolean) => boundaries(21, keep);
    const kept = r(true);
    const reset = r(false);
    results.boundaries = { keptLeads: kept, perTrackReset: reset };
    // after the first song, each song starts close to the room time instead of a full start latency late
    expect(kept.boundaryAbsErrMs.p95).toBeLessThan(150);
    expect(reset.boundaryAbsErrMs.p50).toBeGreaterThan(200);
    expect(kept.boundaryAbsErrMs.p50).toBeLessThan(reset.boundaryAbsErrMs.p50 / 2);
  });

  it('a Bluetooth speaker 200 ms behind: output compensation moves what is heard onto the room time', () => {
    const withComp = bluetooth(31, 200);
    const without = bluetooth(31, 0);
    results.bluetooth = { compensated: withComp, uncompensated: without };
    expect(withComp.heardAbsErrMs.p95).toBeLessThan(100);
    expect(without.heardAbsErrMs.p50).toBeGreaterThan(150);
  });

  it('writes results', () => {
    writeResult('remote', results);
  });
});
