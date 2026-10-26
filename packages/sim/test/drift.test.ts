import { describe, expect, it } from 'vitest';
import { AudioClockMap, DriftController, PlaybackTracker, computeStart, positionAt } from '@syncsound/audio-core';
import type { Playback } from '@syncsound/protocol';
import { AudioClockModel, SimClient, stats, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams } from '../src/network';

const TICK_MS = 500;
const PROBE_MS = 100;
const DURATION_MS = 10 * 60_000;

describe('drift control loop (10 simulated minutes)', () => {
  it('keeps playback within < 0.5 ms mean bias / < 1 ms RMS / < 5 ms max of the room timeline, no reschedules', { timeout: 30_000 }, () => {
    const rng = makeRng(42);
    const net: NetParams = { baseRttMs: 40, jitterMs: 5, spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
    const params = { perfDriftPpm: -50, audioVsPerfPpm: 80, offsetMs: 3300, net };
    const client = new SimClient({ clock: { offsetMs: params.offsetMs, driftPpm: params.perfDriftPpm }, net, seed: 7, joinT: ROOM_T0 });
    const audio = new AudioClockModel(client.clock, params.audioVsPerfPpm, ROOM_T0 + 500);
    const acm = new AudioClockMap();
    const ctl = new DriftController();
    const tracker = new PlaybackTracker();
    const playback: Playback = { status: 'playing', trackId: 't', startRoomTime: ROOM_T0 + 4000, trackOffset: 0 };

    const roomToCtx = (room: number) => acm.perfToCtx(client.sync.toLocalTime(room));
    const schedule = (T: number) => {
      const d = computeStart({ startRoomTime: playback.startRoomTime, trackOffset: playback.trackOffset, roomToCtx, nowCtx: audio.currentTime(T), compensationSec: 0 });
      if (!d) throw new Error('track ended');
      tracker.start(d.when, d.offset);
    };

    let rateNudges = 0;
    let reschedules = 0;
    let firstCorrectionT = Infinity;
    const trueErrAll: number[] = [];
    const trueErrAfterFirst: number[] = [];
    const perceived: number[] = [];
    const rates: number[] = [];

    for (let t = 0; t <= DURATION_MS; t += PROBE_MS) {
      const T = ROOM_T0 + t;
      client.advanceTo(T);
      if (T >= audio.createdT && t % TICK_MS === 0) {
        const o = audio.observe(T, rng);
        if (o) acm.addObservation(o.perfMs, o.ctxSec);
      }
      if (t === 3000) schedule(T);
      if (!tracker.active) continue;

      if (T >= playback.startRoomTime && t % TICK_MS === 0 && t > 3000) {
        const ctxNow = audio.currentTime(T);
        const actual = tracker.positionAt(ctxNow);
        const expected = positionAt(playback, client.sync.toRoomTime(acm.ctxToPerf(ctxNow)));
        const dec = ctl.update((actual - expected) * 1000);
        perceived.push(dec.errorMs);
        if (dec.action !== 'none') firstCorrectionT = Math.min(firstCorrectionT, T);
        if (dec.action === 'reschedule') {
          reschedules++;
          schedule(T);
        } else if (dec.rate !== tracker.rate) {
          if (dec.action === 'rate') rateNudges++;
          tracker.setRate(ctxNow, dec.rate);
        }
        rates.push(dec.rate);
      }
      if (T >= playback.startRoomTime) {
        // truth: what the source is actually playing (true ctx) vs where the room timeline is
        const err = (tracker.positionAt(audio.ctx(T)) - positionAt(playback, T)) * 1000;
        trueErrAll.push(err);
        if (T > firstCorrectionT) trueErrAfterFirst.push(err);
      }
    }

    const after = stats(trueErrAfterFirst);
    const result = {
      params: { ...params, tickMs: TICK_MS, durationMs: DURATION_MS, acmObservationEveryMs: TICK_MS, quantumJitter: '±½ quantum (2.67 ms p-p)', osHiccups: '2% of observations, perf stamp 5–30 ms late' },
      trueErrorAllMs: stats(trueErrAll),
      trueErrorAfterFirstCorrectionMs: after,
      perceivedErrorMs: stats(perceived),
      firstCorrectionAtSec: (firstCorrectionT - playback.startRoomTime) / 1000,
      rateNudges,
      reschedules,
      ticks: perceived.length,
      ticksWithRate1: rates.filter((r) => r === 1).length,
      maxRateDeviation: Math.max(...rates.map((r) => Math.abs(r - 1))),
      acmRatePpm: +acm.ratePpm().toFixed(2),
      clockDriftPpm: +client.sync.estimate().driftPpm.toFixed(2),
    };
    writeResult('drift', result);
    expect(Math.abs(after.mean)).toBeLessThan(0.5);
    expect(after.rms).toBeLessThan(1);
    expect(after.max).toBeLessThan(5);
    expect(reschedules).toBe(0);
  });
});
