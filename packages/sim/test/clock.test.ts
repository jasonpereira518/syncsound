import { describe, expect, it } from 'vitest';
import { SimClient, stats, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams, type Rng } from '../src/network';

const DURATION_MS = 120_000;
const PROBE_MS = 100;
const MAX_SLEW = 1; // ms/s, ClockSync default
const N_CLIENTS = 8;

interface ClientRun {
  baseRttMs: number;
  trueDriftPpm: number;
  estDriftPpm: number;
  errsAfterConverged: number[];
  errsAfterBurst: number[];
  /** probe intervals after convergence where the applied offset moved faster than slew + drift */
  stepsAfterConverged: number;
  maxSlewObservedMsPerSec: number;
  lost: number;
  sent: number;
}

function runClient(seed: number, net: NetParams, rng: Rng, durationMs: number): ClientRun {
  const trueDriftPpm = rng.uniform(-100, 100);
  const c = new SimClient({
    clock: { offsetMs: rng.uniform(-10_000, 10_000), driftPpm: trueDriftPpm },
    net,
    seed,
    joinT: ROOM_T0,
  });
  const run: ClientRun = {
    baseRttMs: net.baseRttMs,
    trueDriftPpm,
    estDriftPpm: NaN,
    errsAfterConverged: [],
    errsAfterBurst: [],
    stepsAfterConverged: 0,
    maxSlewObservedMsPerSec: 0,
    lost: 0,
    sent: 0,
  };
  let prevApplied: number | null = null;
  let prevDrift = 0;
  for (let t = 0; t <= durationMs; t += PROBE_MS) {
    const T = ROOM_T0 + t;
    c.advanceTo(T);
    if (!c.sync.estimate().converged) continue;
    const err = c.roomError(T);
    run.errsAfterConverged.push(err);
    if (t >= 2000) run.errsAfterBurst.push(err);
    const applied = c.appliedOffset(T);
    const estDrift = c.sync.estimate().driftPpm;
    if (prevApplied !== null) {
      // contract: the applied offset moves at most maxSlew on top of the estimator's own drift slope
      const slew =
        (Math.abs(applied - prevApplied - estDrift * 1e-6 * PROBE_MS) / PROBE_MS) * 1000 -
        (Math.abs(estDrift - prevDrift) * 1e-6 * PROBE_MS * 1000) / PROBE_MS;
      run.maxSlewObservedMsPerSec = Math.max(run.maxSlewObservedMsPerSec, slew);
      // 0.01 ms/s tolerance: epoch-ms floats resolve ~2.4e-4 ms, i.e. ~0.005 ms/s over a 100 ms probe
      if (slew > MAX_SLEW + 0.01) run.stepsAfterConverged++;
    }
    prevDrift = estDrift;
    prevApplied = applied;
  }
  run.estDriftPpm = c.sync.estimate().driftPpm;
  run.lost = c.lost;
  run.sent = c.sent;
  return run;
}

function scenario(seed: number, mkNet: (rng: Rng) => NetParams, durationMs = DURATION_MS) {
  const rng = makeRng(seed);
  const runs = Array.from({ length: N_CLIENTS }, (_, i) => runClient(seed * 1000 + i, mkNet(rng), rng, durationMs));
  const conv = runs.flatMap((r) => r.errsAfterConverged);
  const burst = runs.flatMap((r) => r.errsAfterBurst);
  const driftErr = runs.map((r) => r.estDriftPpm - r.trueDriftPpm);
  const summary = {
    clients: N_CLIENTS,
    durationMs,
    errorAfterConvergedMs: stats(conv),
    errorAfter2sMs: stats(burst),
    driftErrorPpm: stats(driftErr),
    stepsAfterConverged: runs.reduce((a, r) => a + r.stepsAfterConverged, 0),
    maxSlewObservedMsPerSec: Math.max(...runs.map((r) => r.maxSlewObservedMsPerSec)),
    packetsSent: runs.reduce((a, r) => a + r.sent, 0),
    packetsLost: runs.reduce((a, r) => a + r.lost, 0),
    perClient: runs.map((r) => ({
      baseRttMs: +r.baseRttMs.toFixed(1),
      trueDriftPpm: +r.trueDriftPpm.toFixed(2),
      estDriftPpm: +r.estDriftPpm.toFixed(2),
      errorMs: stats(r.errsAfterConverged),
    })),
  };
  return summary;
}

const results: Record<string, unknown> = {};

describe('ClockSync over a simulated network', () => {
  it('jitter-free symmetric RTT 20–80 ms, ±100 ppm drift → < 2 ms after convergence', { timeout: 20_000 }, () => {
    const s = scenario(1, (rng) => ({ baseRttMs: rng.uniform(20, 80) }));
    results.jitterFree = { params: 'symmetric, baseRtt U(20,80), no jitter/loss', ...s };
    expect(s.errorAfterConvergedMs.max).toBeLessThan(2);
    expect(s.driftErrorPpm.max).toBeLessThan(5);
    expect(s.stepsAfterConverged).toBe(0);
  });

  it('realistic jitter (σ 5–30 ms, 1% spikes ≤ 200 ms, 1% loss) → < 10 ms', { timeout: 20_000 }, () => {
    const s = scenario(2, (rng) => ({
      baseRttMs: rng.uniform(20, 80),
      jitterMs: rng.uniform(5, 30),
      spikeProb: 0.01,
      spikeMaxMs: 200,
      lossProb: 0.01,
    }));
    results.realistic = { params: 'baseRtt U(20,80), half-normal jitter σ U(5,30) per leg, 1% spikes U(0,200), 1% loss', ...s };
    expect(s.errorAfterConvergedMs.max).toBeLessThan(10);
    expect(s.stepsAfterConverged).toBe(0);
  });

  it('asymmetric delay biases the estimate by asymmetry/2 (NTP cannot observe it)', { timeout: 20_000 }, () => {
    const ASYM = 30;
    const s = scenario(3, (rng) => ({ baseRttMs: rng.uniform(40, 80), asymmetryMs: ASYM }));
    results.asymmetric = { params: `jitter-free, uplink − downlink = ${ASYM} ms`, expectedBiasMs: ASYM / 2, ...s };
    // the signed error is the theoretical bias: +asym/2 (uplink slower → offset over-estimated)
    expect(Math.abs(s.errorAfterConvergedMs.mean - ASYM / 2)).toBeLessThan(1);
    expect(Math.abs(s.errorAfterConvergedMs.max - ASYM / 2)).toBeLessThan(2);
  });

  it('drift estimate within ±5 ppm after 120 s (σ 1 ms LAN jitter); σ 5 ms needs longer', { timeout: 30_000 }, () => {
    const lossy = { spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
    const lan = scenario(4, (rng) => ({ baseRttMs: rng.uniform(5, 40), jitterMs: 1, ...lossy }));
    const wifi120 = scenario(6, (rng) => ({ baseRttMs: rng.uniform(20, 80), jitterMs: 5, ...lossy }));
    const wifi300 = scenario(6, (rng) => ({ baseRttMs: rng.uniform(20, 80), jitterMs: 5, ...lossy }), 300_000);
    results.driftLan120s = { params: 'baseRtt U(5,40), jitter σ 1 ms, 1% spikes, 1% loss, 120 s', ...lan };
    results.driftWifi120s = { params: 'baseRtt U(20,80), jitter σ 5 ms, 1% spikes, 1% loss, 120 s', ...wifi120 };
    results.driftWifi300s = { params: 'same as driftWifi120s, 300 s', ...wifi300 };
    expect(lan.driftErrorPpm.max).toBeLessThan(5);
    expect(wifi300.driftErrorPpm.max).toBeLessThan(5);
    for (const s of [lan, wifi120, wifi300]) expect(s.stepsAfterConverged).toBe(0);
  });

  it('reconnect (server clock jumps +4 s, client resets + re-bursts) re-converges', { timeout: 20_000 }, () => {
    const net: NetParams = { baseRttMs: 50, jitterMs: 10, spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
    const c = new SimClient({ clock: { offsetMs: 2500, driftPpm: 60 }, net, seed: 55, joinT: ROOM_T0 });
    const before: number[] = [];
    const after: number[] = [];
    let reconvergedAfterMs = NaN;
    for (let t = 0; t <= 90_000; t += PROBE_MS) {
      const T = ROOM_T0 + t;
      if (t === 60_000) {
        c.clock.p.offsetMs += 4000;
        c.rejoin(T);
      }
      c.advanceTo(T);
      if (!c.sync.estimate().converged) continue;
      const e = c.roomError(T);
      if (t < 60_000) before.push(e);
      else {
        if (Number.isNaN(reconvergedAfterMs)) reconvergedAfterMs = t - 60_000;
        after.push(e);
      }
    }
    results.reconnect = {
      params: 'baseRtt 50, jitter σ 10, 1% spikes, 1% loss; at t=60 s server clock +4000 ms, rejoin()',
      reconvergedAfterMs,
      errorBeforeMs: stats(before),
      errorAfterMs: stats(after),
    };
    expect(reconvergedAfterMs).toBeLessThan(1500);
    expect(stats(after).max).toBeLessThan(10);
  });

  it('writes results', () => {
    writeResult('clock', results);
  });
});
