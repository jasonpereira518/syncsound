import { describe, expect, it } from 'vitest';
import type { Playback } from '@syncsound/protocol';
import { stats, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams } from '../src/network';
import { SimPlayer } from '../src/playback';

/**
 * Pause, then resume minutes later. While paused the room is silent, so a hidden tab's pings are throttled
 * (Chrome: 1 Hz; one a minute after five minutes), a phone may sleep, iOS suspends the AudioContext. On resume the
 * tab re-bursts the clock (never resetting it) and the host presses play. The questions: does every device land on
 * the new timeline at once, did the clock step or reschedule, and is the sync as tight as before the pause?
 */
const PROBE_MS = 100;
const LOSSY = { spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
const WIFI = (() => {
  const r = makeRng(7);
  return [0, 1, 2, 3].map(() => +r.uniform(3, 6).toFixed(2));
})();
interface Spec {
  name: string;
  latencyMs: number;
  offsetMs: number;
  driftPpm: number;
  audioPpm: number;
  net: NetParams;
}
const DEVICES: Spec[] = [
  { name: 'phone', latencyMs: 10, offsetMs: 3200, driftPpm: 35, audioPpm: 20, net: { baseRttMs: 30, jitterMs: WIFI[0]!, ...LOSSY } },
  { name: 'laptop', latencyMs: 40, offsetMs: -7900, driftPpm: -80, audioPpm: -45, net: { baseRttMs: 60, jitterMs: WIFI[1]!, ...LOSSY } },
  { name: 'bt-speaker', latencyMs: 180, offsetMs: 9500, driftPpm: 100, audioPpm: 80, net: { baseRttMs: 25, jitterMs: WIFI[2]!, ...LOSSY } },
  { name: 'tablet', latencyMs: 25, offsetMs: -1100, driftPpm: -20, audioPpm: 10, net: { baseRttMs: 80, jitterMs: WIFI[3]!, ...LOSSY } },
];
const CAL_ERR_MS = 0.5;
const PLAY_AT = 5000;
/** a minute of play first, so the drift loops have learned their clock-rate bias (as in any real session) */
const PAUSE_AT = 65_000;
const BEFORE_WINDOW_MS = 20_000;
const SCHEDULE_DELAY_MS = 50;
const LEAD_MS = 400;
const AFTER_MS = 60_000;
/** ClockSync's slew contract (ms per s) plus a tolerance for the drift slope and float noise */
const MAX_SLEW = 1;

interface Scenario {
  pauseMs: number;
  /** host presses play this long after the tab became visible again */
  pressAfterMs: number;
  /** ping interval while paused (ms since the pause) — null: asleep, no pings */
  pingsWhilePaused: (sincePauseMs: number) => number | null;
  /** the device slept: its performance clock stopped for the whole pause (and, as on any sleeping device, its
   * AudioContext was suspended too — the engine resets the audio-clock map when it comes back) */
  sleep?: boolean;
  /** the AudioContext alone was suspended for the pause (iOS background), clocks kept running */
  suspend?: boolean;
}

function run(sc: Scenario, seed = 1) {
  const rng = makeRng(seed);
  const pauseT = ROOM_T0 + PAUSE_AT;
  const resumeT = pauseT + sc.pauseMs;
  const players = DEVICES.map(
    (d, i) =>
      new SimPlayer({
        clock: { offsetMs: d.offsetMs, driftPpm: d.driftPpm },
        net: d.net,
        seed: seed * 100 + i,
        joinT: ROOM_T0,
        audioPpm: d.audioPpm,
        latencyMs: d.latencyMs,
        calibratedMs: d.latencyMs + rng.uniform(-CAL_ERR_MS, CAL_ERR_MS),
        pingIntervalAt: (T) => (T >= pauseT && T < resumeT ? sc.pingsWhilePaused(T - pauseT) : 1000),
      }),
  );
  const pb1: Playback = { status: 'playing', trackId: 't', startRoomTime: ROOM_T0 + PLAY_AT + LEAD_MS, trackOffset: 0 };
  const pausedOffset = (pauseT + LEAD_MS - pb1.startRoomTime) / 1000;
  const pb2: Playback = { status: 'paused', trackId: 't', startRoomTime: pauseT + LEAD_MS, trackOffset: pausedOffset };
  const pressT = resumeT + sc.pressAfterMs;
  const S = pressT + LEAD_MS;
  const pb3: Playback = { status: 'playing', trackId: 't', startRoomTime: S, trackOffset: pausedOffset };
  const endT = S + AFTER_MS;
  if (sc.suspend) for (const p of players) p.suspend(pauseT + 1000, resumeT);
  if (sc.sleep) for (const p of players) p.sleep(pauseT + 1000, resumeT);

  const before: number[] = [];
  const spreadBefore: number[] = [];
  const errAtStart: number[] = [];
  const after: number[] = [];
  const spreadAfter: number[] = [];
  const steps = players.map(() => 0);
  const prevApplied = players.map(() => NaN);
  const prevDrift = players.map(() => 0);
  const prevT = players.map(() => NaN);
  const driftBeforeSleep = players.map(() => NaN);
  let reacquiredAfterMs = NaN;
  let scheduled = { play: false, pause: false, resume: false, resync: false };
  for (let T = ROOM_T0; T <= endT; T += PROBE_MS) {
    if (!scheduled.play && T >= ROOM_T0 + PLAY_AT + SCHEDULE_DELAY_MS) {
      scheduled = { ...scheduled, play: true };
      for (const p of players) p.setPlayback(pb1, T);
    }
    if (!scheduled.pause && T >= pauseT + SCHEDULE_DELAY_MS) {
      scheduled = { ...scheduled, pause: true };
      for (const p of players) p.setPlayback(pb2, T);
    }
    if (!scheduled.resync && T >= resumeT) {
      scheduled = { ...scheduled, resync: true };
      for (const [i, p] of players.entries()) {
        driftBeforeSleep[i] = p.client.sync.estimate().driftPpm;
        p.resync(T);
      }
    }
    if (!scheduled.resume && T >= pressT + SCHEDULE_DELAY_MS) {
      scheduled = { ...scheduled, resume: true };
      for (const p of players) p.setPlayback(pb3, T);
    }
    for (const p of players) p.advanceTo(T);

    const errs = players.map((p) => p.trueErrorMs(T));
    const live = errs.filter((e): e is number => e !== null);
    if (T > pauseT - BEFORE_WINDOW_MS && T < pauseT && live.length === players.length) {
      before.push(...live);
      spreadBefore.push(Math.max(...live) - Math.min(...live));
    }
    if (T > S && live.length === players.length) {
      if (T <= S + 1000) errAtStart.push(...live);
      after.push(...live);
      spreadAfter.push(Math.max(...live) - Math.min(...live));
    }
    // clock steps after the resume (the applied offset moving faster than slew + drift)
    for (const [i, p] of players.entries()) {
      const applied = p.client.appliedOffset(T);
      const drift = p.client.sync.estimate().driftPpm;
      if (T >= resumeT && !Number.isNaN(prevApplied[i]!)) {
        const dt = T - prevT[i]!;
        const moved = Math.abs(applied - prevApplied[i]! - drift * 1e-6 * dt) - Math.abs(drift - prevDrift[i]!) * 1e-6 * dt;
        if (moved / dt > (MAX_SLEW + 0.05) / 1000) steps[i]!++;
      }
      prevApplied[i] = applied;
      prevDrift[i] = drift;
      prevT[i] = T;
      if (sc.sleep && Number.isNaN(reacquiredAfterMs) && T >= resumeT && players.every((q) => Math.abs(q.client.roomError(T)) < 10)) reacquiredAfterMs = T - resumeT;
    }
  }
  const driftErr = players.map((p, i) => p.client.sync.estimate().driftPpm - (sc.sleep ? driftBeforeSleep[i]! : DEVICES[i]!.driftPpm));
  return {
    scenario: { pauseMs: sc.pauseMs, pressAfterMs: sc.pressAfterMs, sleep: !!sc.sleep, suspend: !!sc.suspend },
    beforePause: { errorMs: stats(before), spreadMs: stats(spreadBefore) },
    atResume: { maxAbsErrorFirstSecondMs: errAtStart.length ? +Math.max(...errAtStart.map(Math.abs)).toFixed(3) : NaN, reacquiredAfterMs },
    afterResume: { errorMs: stats(after), spreadMs: stats(spreadAfter) },
    stepsAfterResume: steps,
    reschedules: players.map((p) => p.counters.reschedules),
    forcedRebuilds: players.map((p) => p.counters.forcedRebuilds),
    lateStarts: players.map((p) => p.counters.lateStarts),
    resyncShiftsMs: players.map((p) => p.counters.resyncShiftsMs.map((s) => +s.toFixed(3))),
    driftErrorPpm: driftErr.map((d) => +d.toFixed(2)),
    readyAfterSuspendMs: players.map((p) => (p.counters.readyAfterSuspendT === null ? null : p.counters.readyAfterSuspendT - resumeT)),
    pingsWhilePaused: players.map((p) => p.client.pingLog.filter((t) => t >= pauseT && t < resumeT).length),
  };
}

const results: Record<string, unknown> = {};

describe('pause → resume minutes later (4 Wi-Fi devices, hidden tab)', () => {
  it('5 min paused, 1 Hz pings: resumes on the timeline with no clock step and no reschedule', { timeout: 60_000 }, () => {
    const r = run({ pauseMs: 5 * 60_000, pressAfterMs: 2000, pingsWhilePaused: () => 1000 });
    results.pause5min = r;
    expect(r.atResume.maxAbsErrorFirstSecondMs).toBeLessThan(2);
    expect(r.afterResume.spreadMs.p95).toBeLessThan(2);
    expect(r.afterResume.errorMs.p95).toBeLessThan(2);
    expect(r.stepsAfterResume.every((s) => s === 0)).toBe(true);
    expect(r.reschedules.every((n) => n === 0)).toBe(true);
    expect(r.forcedRebuilds.every((n) => n === 0)).toBe(true);
    expect(r.lateStarts.every((n) => n === 0)).toBe(true);
  });

  it('play pressed 300 ms after the tab returns (mid-burst): the schedule is not late and lands within 2 ms', { timeout: 60_000 }, () => {
    const r = run({ pauseMs: 5 * 60_000, pressAfterMs: 300, pingsWhilePaused: () => 1000 });
    results.pause5minMidBurst = r;
    expect(r.atResume.maxAbsErrorFirstSecondMs).toBeLessThan(2);
    expect(r.lateStarts.every((n) => n === 0)).toBe(true);
    expect(r.reschedules.every((n) => n === 0)).toBe(true);
  });

  it('30 min paused, pings 1 Hz for 5 min then one a minute: the extrapolated mapping holds, at most one step', { timeout: 60_000 }, () => {
    const r = run({ pauseMs: 30 * 60_000, pressAfterMs: 2000, pingsWhilePaused: (t) => (t < 5 * 60_000 ? 1000 : 60_000) });
    results.pause30minThrottled = r;
    expect(r.pingsWhilePaused.every((n) => n < 340)).toBe(true); // ≈ 300 + 25, not 1800
    expect(r.atResume.maxAbsErrorFirstSecondMs).toBeLessThan(3);
    expect(r.afterResume.errorMs.p95).toBeLessThan(2);
    expect(r.driftErrorPpm.every((d) => Math.abs(d) < 5)).toBe(true);
    expect(r.stepsAfterResume.every((s) => s <= 1)).toBe(true);
    expect(r.reschedules.every((n) => n === 0)).toBe(true);
  });

  it('devices asleep for 30 min (clocks stopped, no pings, contexts suspended) re-acquire within the burst and keep their drift', { timeout: 60_000 }, () => {
    const r = run({ pauseMs: 30 * 60_000, pressAfterMs: 2000, pingsWhilePaused: () => null, sleep: true });
    results.sleep30min = r;
    expect(r.pingsWhilePaused.every((n) => n === 0)).toBe(true);
    expect(r.atResume.reacquiredAfterMs).toBeLessThan(500);
    expect(r.readyAfterSuspendMs.every((ms) => ms !== null && ms <= 1000)).toBe(true);
    expect(r.atResume.maxAbsErrorFirstSecondMs).toBeLessThan(2);
    expect(r.driftErrorPpm.every((d) => Math.abs(d) < 5)).toBe(true);
    expect(r.reschedules.every((n) => n === 0)).toBe(true);
  });

  it('the AudioContext was suspended for the pause (iOS): ready again within 1 s, resumes within 2 ms', { timeout: 60_000 }, () => {
    const r = run({ pauseMs: 30 * 60_000, pressAfterMs: 2000, pingsWhilePaused: () => 1000, suspend: true });
    results.suspend30min = r;
    expect(r.readyAfterSuspendMs.every((ms) => ms !== null && ms <= 1000)).toBe(true);
    expect(r.atResume.maxAbsErrorFirstSecondMs).toBeLessThan(2);
    expect(r.reschedules.every((n) => n === 0)).toBe(true);
  });

  it('writes results', () => {
    writeResult('pauseResume', { devices: DEVICES, calibrationErrorMs: `±${CAL_ERR_MS}`, probeMs: PROBE_MS, afterResumeMs: AFTER_MS, ...results });
  });
});
