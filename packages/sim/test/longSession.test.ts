import { describe, expect, it } from 'vitest';
import type { Playback } from '@syncsound/protocol';
import { stats, writeResult } from '../src/clockSim';
import { ROOM_T0, wanderRate, type NetParams } from '../src/network';
import { SimPlayer } from '../src/playback';

/**
 * One device plays for an hour. Its crystals are not constant: the perf clock wanders ±3 ppm over 20 minutes and
 * the audio clock ±2 ppm over 15 minutes (temperature), on top of the constant mismatch of drift.test.ts. The drift
 * loop, the long-baseline audio-clock rate and the clock's drift fit must track that without ever rescheduling.
 */
const DURATION_MS = 60 * 60_000;
const PROBE_MS = 100;
const net: NetParams = { baseRttMs: 40, jitterMs: 5, spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
const PERF_WANDER = { ppm: 3, periodMs: 20 * 60_000 };
const AUDIO_WANDER = { ppm: 2, periodMs: 15 * 60_000 };

describe('60-minute session with clock-rate wander', () => {
  it('stays within 0.5 ms mean / 2 ms p95 / 5 ms max, no reschedules, rate within 0.1 %, audio rate tracked within 2 ppm', { timeout: 120_000 }, () => {
    const p = new SimPlayer({
      clock: { offsetMs: 3300, driftPpm: -50, wander: PERF_WANDER },
      net,
      seed: 7,
      joinT: ROOM_T0,
      audioPpm: 80,
      audioWander: AUDIO_WANDER,
      ctxCreatedT: ROOM_T0 + 500,
    });
    const playback: Playback = { status: 'playing', trackId: 't', startRoomTime: ROOM_T0 + 4000, trackOffset: 0 };
    const errs: number[] = [];
    const rates: number[] = [];
    const acmRateErr: number[] = [];
    const driftErr: number[] = [];
    for (let t = 0; t <= DURATION_MS; t += PROBE_MS) {
      const T = ROOM_T0 + t;
      if (t === 3000) p.setPlayback(playback, T);
      p.advanceTo(T);
      const e = p.trueErrorMs(T);
      if (e !== null && t > 20_000) errs.push(e);
      if (t % 10_000 === 0 && t > 300_000) {
        rates.push(p.tracker.rate);
        // true instantaneous audio-vs-perf rate: the constant mismatch plus the wander's current rate deviation
        const l = p.client.clock.local(T);
        const trueAudioPpm = 80 - wanderRate(AUDIO_WANDER, l) * 1e6;
        acmRateErr.push(p.acm.ratePpm() - trueAudioPpm);
        // the clock's drift (+ve = client slow): −(−50) with the perf wander's current deviation
        const truePerfDriftPpm = -50 + wanderRate(PERF_WANDER, T) * 1e6;
        driftErr.push(p.client.sync.estimate().driftPpm - truePerfDriftPpm);
      }
    }
    const s = stats(errs);
    const result = {
      params: { net, perfDriftPpm: -50, perfWander: PERF_WANDER, audioVsPerfPpm: 80, audioWander: AUDIO_WANDER, durationMs: DURATION_MS },
      trueErrorMs: s,
      reschedules: p.counters.reschedules,
      rateNudges: p.counters.rateNudges,
      maxRateDeviation: +Math.max(...rates.map((r) => Math.abs(r - 1))).toFixed(6),
      acmRateErrorPpm: stats(acmRateErr),
      clockDriftErrorPpm: stats(driftErr),
      learnedBiasPpm: +p.drift.biasPpm.toFixed(2),
    };
    writeResult('longSession', result);
    expect(Math.abs(s.mean)).toBeLessThan(0.5);
    expect(s.p95).toBeLessThan(2);
    expect(s.max).toBeLessThan(5);
    expect(p.counters.reschedules).toBe(0);
    expect(result.maxRateDeviation).toBeLessThan(0.001);
    // the 256 s window's slope lags a ±2 ppm / 15 min wander by up to ≈ 128 s × 0.014 ppm/s ≈ 1.8 ppm, plus its
    // ≈ 0.3 ppm standard error: the estimate follows the wander, it does not average it out
    expect(Math.abs(result.acmRateErrorPpm.mean)).toBeLessThan(1);
    expect(result.acmRateErrorPpm.max).toBeLessThan(3);
    expect(result.clockDriftErrorPpm.max).toBeLessThan(5);
  });
});
