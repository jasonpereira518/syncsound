import { describe, expect, it } from 'vitest';
import type { Playback } from '@syncsound/protocol';
import { stats, writeResult } from '../src/clockSim';
import { ROOM_T0, type NetParams } from '../src/network';
import { SimPlayer } from '../src/playback';

/**
 * A tab switch while playing: the app re-bursts the clock when the tab is visible again. Before, that reset the
 * estimator (drift restarted from 0, the mapping stepped, the source was rebuilt with a crossfade) even after a
 * one-second switch. Now the burst re-checks the mapping and leaves playback alone when nothing moved.
 */
const DURATION_MS = 300_000;
const PROBE_MS = 100;
const LOSSY = { spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
const DEVICES = [
  { name: 'phone', offsetMs: 3200, driftPpm: 35, audioPpm: 20, net: { baseRttMs: 30, jitterMs: 5, ...LOSSY } as NetParams },
  { name: 'laptop', offsetMs: -7900, driftPpm: -80, audioPpm: -45, net: { baseRttMs: 60, jitterMs: 5, ...LOSSY } as NetParams },
];
const MAX_SLEW = 1;

describe('resync without reset (tab switches while playing)', () => {
  it('a 1 s switch and a 30 s background spell cause no clock step, no reschedule and no rebuild', { timeout: 60_000 }, () => {
    const hiddenFrom = ROOM_T0 + 200_000;
    const hiddenTo = ROOM_T0 + 230_000;
    const players = DEVICES.map(
      (d, i) =>
        new SimPlayer({
          clock: { offsetMs: d.offsetMs, driftPpm: d.driftPpm },
          net: d.net,
          seed: 300 + i,
          joinT: ROOM_T0,
          audioPpm: d.audioPpm,
          // hidden: Chrome keeps 1 Hz for the first five minutes
          pingIntervalAt: () => 1000,
        }),
    );
    const playback: Playback = { status: 'playing', trackId: 't', startRoomTime: ROOM_T0 + 5400, trackOffset: 0 };
    const errs: number[] = [];
    const spread: number[] = [];
    const steps = players.map(() => 0);
    const prev = players.map(() => ({ applied: NaN, drift: 0 }));
    const resyncAt = [ROOM_T0 + 120_000, hiddenTo];
    for (let t = 0; t <= DURATION_MS; t += PROBE_MS) {
      const T = ROOM_T0 + t;
      if (t === 5100) for (const p of players) p.setPlayback(playback, T);
      if (resyncAt.includes(T)) for (const p of players) p.resync(T);
      for (const p of players) p.advanceTo(T);
      const live = players.map((p) => p.trueErrorMs(T)).filter((e): e is number => e !== null);
      if (t > 20_000 && live.length === players.length) {
        errs.push(...live);
        spread.push(Math.max(...live) - Math.min(...live));
      }
      for (const [i, p] of players.entries()) {
        const applied = p.client.appliedOffset(T);
        const drift = p.client.sync.estimate().driftPpm;
        const q = prev[i]!;
        if (t > 20_000 && !Number.isNaN(q.applied)) {
          const moved = Math.abs(applied - q.applied - drift * 1e-6 * PROBE_MS) - Math.abs(drift - q.drift) * 1e-6 * PROBE_MS;
          if (moved / PROBE_MS > (MAX_SLEW + 0.05) / 1000) steps[i]!++;
        }
        q.applied = applied;
        q.drift = drift;
      }
    }
    void hiddenFrom;
    const result = {
      params: { devices: DEVICES, durationMs: DURATION_MS, resyncAtMs: resyncAt.map((T) => T - ROOM_T0), hiddenMs: [hiddenFrom - ROOM_T0, hiddenTo - ROOM_T0] },
      trueErrorMs: stats(errs),
      spreadMs: stats(spread),
      stepsAfter20s: steps,
      resyncShiftsMs: players.map((p) => p.counters.resyncShiftsMs.map((s) => +s.toFixed(3))),
      reschedules: players.map((p) => p.counters.reschedules),
      forcedRebuilds: players.map((p) => p.counters.forcedRebuilds),
      driftPpm: players.map((p) => +p.client.sync.estimate().driftPpm.toFixed(2)),
    };
    writeResult('resync', result);
    expect(steps.every((s) => s === 0)).toBe(true);
    expect(result.resyncShiftsMs.flat().every((s) => Math.abs(s) < 2)).toBe(true);
    expect(result.reschedules.every((n) => n === 0)).toBe(true);
    expect(result.forcedRebuilds.every((n) => n === 0)).toBe(true);
    expect(result.trueErrorMs.p95).toBeLessThan(2);
    // the drift history survived both bursts: the estimates still sit on the true values
    expect(Math.abs(result.driftPpm[0]! - 35)).toBeLessThan(5);
    expect(Math.abs(result.driftPpm[1]! + 80)).toBeLessThan(5);
  });
});
