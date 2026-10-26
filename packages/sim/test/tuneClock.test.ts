import { describe, expect, it } from 'vitest';
import {
  AudioClockMap,
  ClockMapping,
  clockSettled,
  frozenRoomMap,
  LAN_PING_MS,
  LAN_SYNC_OPTS,
  type RoomClock,
} from '@syncsound/audio-core';
import { AudioClockModel, SimClient, stats, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams } from '../src/network';
import { arrivalsAtHead, p95, pairwise, r3, ROOM, SR, tune } from '../src/tuneRoom';

/**
 * The tune of tune.test.ts, but every device's clocks are REAL: a ClockSync over a simulated network (joined 5–20 s
 * before the tune, i.e. still converging/slewing, as in the setup wizard) and an AudioClockMap fed at 4 Hz. Each
 * device schedules its chime through its live clock; each recorder maps its recording through a frozen map;
 * play-time arrivals use each device's live clock a minute later.
 *
 * Pipelines: `new` = the app since S2 (wait for `clockSettled`, the analytic `frozenRoomMap`, and on the LAN the
 * master's mapping pinned for the plan); `old` = the app before (start as soon as the clock has 8 samples, a 1 s
 * finite difference over the live clocks for the recorder map, live 500 ms snapshots). Variants: every device on the
 * server clock (WAN), and a LAN clock master (the listener) with its peers over the LAN.
 */
const SEEDS = [1, 2, 3, 4, 5, 6];
const wan: NetParams = { baseRttMs: 44, asymmetryMs: 6, jitterMs: 5, spikeProb: 0.02, spikeMaxMs: 120, lossProb: 0.01 };
const lan: NetParams = { baseRttMs: 6, jitterMs: 2, spikeProb: 0.02, spikeMaxMs: 30, lossProb: 0.01, serverProcMs: 0.2 };
/** the app's settle waits: soft criteria up to 20 s (then a warning), hard criteria up to 30 s (then an error) */
const SETTLE_SOFT_MS = 20_000;
const SETTLE_HARD_MS = 30_000;
const LEAD_MS = 3500;
const EMIT_AHEAD_MS = 1500;
const FREEZE_BEFORE_MS = 300;
const PLAY_AFTER_MS = 60_000;
const OBS_MS = 250;
const MAP_RESEND_MS = 500;

type Variant = 'wan' | 'lan';
interface Pipeline {
  gate: boolean;
  analytic: boolean;
  hold: boolean;
}
const NEW: Pipeline = { gate: true, analytic: true, hold: true };
const OLD: Pipeline = { gate: false, analytic: false, hold: false };
const NO_HOLD: Pipeline = { gate: true, analytic: true, hold: false };

interface Dev {
  id: string;
  wan: SimClient;
  lan: SimClient | null;
  audio: AudioClockModel;
  acm: AudioClockMap;
  audioPpm: number;
  rng: ReturnType<typeof makeRng>;
}

function run(seed: number, variant: Variant, pipe: Pipeline) {
  const rng = makeRng(seed * 977 + (variant === 'lan' ? 1 : 0));
  const T0 = ROOM_T0;
  const pressT = T0 + 20_000; // the listener taps Tune 20 s after the first device joined
  const devs: Dev[] = ROOM.map((x, i) => {
    const clock = { offsetMs: rng.uniform(-10_000, 10_000), driftPpm: rng.uniform(-100, 100) };
    const joinT = pressT - rng.uniform(5000, 20_000);
    const w = new SimClient({ clock, net: wan, seed: seed * 100 + i, joinT });
    const isMaster = variant === 'lan' && x.id === 'L';
    const l =
      variant === 'lan' && !isMaster
        ? new SimClient({ clock, net: { ...lan }, seed: seed * 100 + 50 + i, joinT: joinT + 500, reference: (T) => devs[0]!.wan.clock.local(T), pingIntervalMs: LAN_PING_MS, syncOpts: LAN_SYNC_OPTS })
        : null;
    const audioPpm = rng.uniform(-100, 100);
    return { id: x.id, wan: w, lan: l, audio: new AudioClockModel(w.clock, audioPpm, joinT), acm: new AudioClockMap(), audioPpm, rng: makeRng(seed * 7 + i) };
  });
  let mapping: ClockMapping | null = null; // the master's latest snapshot (re-sent every 500 ms)
  let held: ClockMapping | null = null; // pinned for the plan
  let lastSnapshotT = -Infinity;
  const nextObs = devs.map((dv) => dv.audio.createdT);
  const advance = (T: number) => {
    for (const [i, dv] of devs.entries()) {
      dv.wan.advanceTo(T);
      dv.lan?.advanceTo(T);
      while (nextObs[i]! <= T) {
        const o = dv.audio.observe(nextObs[i]!, dv.rng);
        if (o) dv.acm.addObservation(o.perfMs, o.ctxSec);
        nextObs[i]! += OBS_MS;
      }
    }
    if (variant === 'lan' && T - lastSnapshotT >= MAP_RESEND_MS) {
      mapping = ClockMapping.of(devs[0]!.wan.sync) ?? mapping;
      lastSnapshotT = T;
    }
  };
  /** a device's room clock: the master's live sync, the pinned mapping while holding, or the latest snapshot ∘ LAN */
  const roomClock = (dv: Dev, useHeld: boolean): RoomClock => {
    const m = useHeld && held ? held : mapping;
    if (variant === 'wan' || (dv.id === 'L' && !(useHeld && held))) return dv.wan.sync;
    if (dv.id === 'L') return { toRoomTime: (l) => m!.toRoomTime(l), toLocalTime: (r) => m!.toLocalTime(r), estimate: () => dv.wan.sync.estimate(), frozenAt: () => m! };
    const lanSync = dv.lan!.sync;
    return {
      toRoomTime: (l) => m!.toRoomTime(lanSync.toRoomTime(l)),
      toLocalTime: (r) => lanSync.toLocalTime(m!.toLocalTime(r)),
      estimate: () => lanSync.estimate(),
      frozenAt: (l) => {
        const f = lanSync.frozenAt(l);
        return { toRoomTime: (x) => m!.toRoomTime(f.toRoomTime(x)), toLocalTime: (r) => f.toLocalTime(m!.toLocalTime(r)) };
      },
    };
  };

  // 1. the listener's clocks: wait for them to settle (the app's gate), or just for 8 samples (the old app)
  let T = T0;
  for (; T < pressT; T += 100) advance(T);
  const L = devs[0]!;
  let settleWaitMs = 0;
  let settleTimedOut = false;
  if (pipe.gate) {
    for (;;) {
      advance(T);
      const e = L.wan.sync.estimate();
      const v = clockSettled({ converged: e.converged, ageMs: e.ageMs, jitterMs: e.jitterMs, pendingSlewMs: e.pendingSlewMs, driftSePpm: e.driftSePpm, link: 'none', audioRateSePpm: L.acm.longRate()?.sePpm ?? null });
      settleWaitMs = T - pressT;
      if (v.ok || (!v.hard && settleWaitMs >= SETTLE_SOFT_MS)) break;
      if (settleWaitMs >= SETTLE_HARD_MS) {
        settleTimedOut = true;
        break;
      }
      T += 250;
    }
  }
  const startRoomTime = T + LEAD_MS;
  if (pipe.hold) held = mapping; // the plan arrives: the master pins its mapping

  // 2. every device schedules its chime 1.5 s ahead on its clock; recorders freeze their maps 300 ms before the start
  const slotStart = (i: number) => startRoomTime + 500 + i * 1550;
  const emitErr: Record<string, number> = {};
  const recMaps: Record<string, (idx: number) => number> = {};
  const rateErrPpm: number[] = [];
  const truePpm = (dv: Dev) => ((1 + dv.audioPpm * 1e-6) * (1 - dv.wan.clock.p.driftPpm * 1e-6) - 1) * 1e6;
  const frozenT = startRoomTime - FREEZE_BEFORE_MS;
  const lastSlot = slotStart(ROOM.length - 1);
  let frozen = false;
  const emitted = ROOM.map(() => false);
  const detail: Record<string, Record<string, number | boolean | null>> = Object.fromEntries(devs.map((dv) => [dv.id, {}]));
  for (; T <= lastSlot + 100; T += 100) {
    advance(T);
    if (!frozen && T >= frozenT) {
      frozen = true;
      for (const dv of devs) {
        const l = dv.wan.clock.local(T);
        const startCtx = dv.audio.ctx(startRoomTime);
        const perfAtStartCtx = dv.acm.ctxToPerf(startCtx);
        const clock = roomClock(dv, pipe.hold);
        let map: (idx: number) => number;
        if (pipe.analytic) map = frozenRoomMap({ startCtx, sampleRate: SR, audio: { perfAtStartCtx, ctxPerPerfMs: dv.acm.slope() }, clock: clock.frozenAt(l) });
        else {
          // the old way: a 1 s finite difference through the live clocks
          const r0 = clock.toRoomTime(perfAtStartCtx);
          const perIdx = (clock.toRoomTime(dv.acm.ctxToPerf(startCtx + 1)) - r0) / SR;
          map = (idx) => r0 + idx * perIdx;
        }
        recMaps[dv.id] = map;
        const trueMsPerIdx = 1000 / (SR * (1 + truePpm(dv) * 1e-6));
        const rateErr = ((map(8 * SR) - map(0)) / (8 * SR) / trueMsPerIdx - 1) * 1e6;
        rateErrPpm.push(rateErr);
        Object.assign(detail[dv.id]!, {
          wanErrAtFreezeMs: r3(dv.wan.sync.toRoomTime(l) - T),
          lanErrAtFreezeMs: dv.lan ? r3(dv.lan.sync.toRoomTime(l) - devs[0]!.wan.clock.local(T)) : null,
          acmSlopeErrPpm: r3((dv.acm.slope() / 1e-3 / (1 + dv.audioPpm * 1e-6) - 1) * 1e6),
          acmLong: dv.acm.longRate() !== null,
          pendingSlewMs: r3(dv.wan.sync.estimate().pendingSlewMs),
          rateErrPpm: r3(rateErr),
        });
      }
    }
    for (const [i, dv] of devs.entries()) {
      const R = slotStart(i);
      if (!emitted[i] && T >= R - EMIT_AHEAD_MS) {
        emitted[i] = true;
        const ctxWhen = dv.acm.perfToCtx(roomClock(dv, pipe.hold).toLocalTime(R));
        emitErr[dv.id] = dv.audio.trueTime(ctxWhen) - R;
        detail[dv.id]!.emitErrMs = r3(emitErr[dv.id]!);
      }
    }
  }
  held = null;

  // 3. play a minute later: each device's live clock error then
  for (; T <= lastSlot + PLAY_AFTER_MS; T += 100) advance(T);
  const playErr = Object.fromEntries(devs.map((dv) => [dv.id, roomClock(dv, false).toRoomTime(dv.wan.clock.local(T)) - T]));
  for (const dv of devs) detail[dv.id]!.playErrMs = r3(playErr[dv.id]!);

  // 4. the acoustics + solve
  const { report, rnd } = tune({
    seed,
    placeHead: true,
    startRoomTime,
    emitErrorMs: emitErr,
    recorderPpm: Object.fromEntries(devs.map((dv) => [dv.id, truePpm(dv)])),
    recorderMap: recMaps,
  });
  const laptops = ROOM.filter((x) => !x.speaker);
  const dist = laptops.flatMap((a) => laptops.filter((b) => a.id < b.id).map((b) => Math.abs((report.distancesM[a.id]?.[b.id] ?? NaN) - Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y))));
  const arrivals = arrivalsAtHead(report, rnd, playErr);
  return { settleWaitMs, settleTimedOut, rateErrPpm, pairs: pairwise(arrivals), arrivals: arrivals.map(r3), dist, heard: report.devices.every((x) => x.heard), detail };
}

function summarize(runs: ReturnType<typeof run>[]) {
  const pairs = runs.flatMap((r) => r.pairs);
  const sorted = [...pairs].sort((a, b) => a - b);
  return {
    settleWaitMs: stats(runs.map((r) => r.settleWaitMs)),
    settleTimedOut: runs.filter((r) => r.settleTimedOut).length,
    recorderRateErrorPpm: stats(runs.flatMap((r) => r.rateErrPpm)),
    headAlignmentMs: { p50: r3(sorted[sorted.length >> 1]!), p95: r3(p95(pairs)), max: r3(Math.max(...pairs)) },
    distanceErrorM: { p95: r3(p95(runs.flatMap((r) => r.dist))), max: r3(Math.max(...runs.flatMap((r) => r.dist))) },
    allHeard: runs.every((r) => r.heard),
    perSeed: runs.map((r) => ({ settleWaitMs: r.settleWaitMs, arrivals: r.arrivals, detail: r.detail })),
  };
}

const results: Record<string, unknown> = {};

describe('tune with real, still-converging clocks (ClockSync + AudioClockMap, joined 5–20 s before the tune)', () => {
  it('LAN clock master: the new pipeline keeps every pair within 1 ms at the head; the old one does not', { timeout: 240_000 }, () => {
    const fresh = summarize(SEEDS.map((seed) => run(seed, 'lan', NEW)));
    const old = summarize(SEEDS.map((seed) => run(seed, 'lan', OLD)));
    const noHold = summarize(SEEDS.map((seed) => run(seed, 'lan', NO_HOLD)));
    results.lan = { new: fresh, old, noHold };
    expect(fresh.allHeard).toBe(true);
    expect(fresh.settleTimedOut).toBe(0);
    expect(fresh.settleWaitMs.p95).toBeLessThan(SETTLE_SOFT_MS + 1);
    expect(fresh.headAlignmentMs.p95).toBeLessThan(1);
    expect(fresh.distanceErrorM.max).toBeLessThan(0.15);
    expect(old.headAlignmentMs.p95).toBeGreaterThan(fresh.headAlignmentMs.p95);
    expect(old.recorderRateErrorPpm.p95).toBeGreaterThan(fresh.recorderRateErrorPpm.p95);
    expect(fresh.headAlignmentMs.p95).toBeLessThanOrEqual(noHold.headAlignmentMs.p95 + 0.05);
  });

  it('every device on the server clock: clock-limited (the WAN estimate moves ~1 ms in a minute), still better than before', { timeout: 240_000 }, () => {
    const fresh = summarize(SEEDS.map((seed) => run(seed, 'wan', NEW)));
    const old = summarize(SEEDS.map((seed) => run(seed, 'wan', OLD)));
    results.wan = { new: fresh, old };
    expect(fresh.allHeard).toBe(true);
    expect(fresh.headAlignmentMs.p95).toBeLessThan(3);
    expect(fresh.headAlignmentMs.p95).toBeLessThanOrEqual(old.headAlignmentMs.p95 + 0.1);
    expect(old.recorderRateErrorPpm.p95).toBeGreaterThan(fresh.recorderRateErrorPpm.p95);
  });

  it('writes results', () => {
    writeResult('tuneClock', { seeds: SEEDS.length, wan, lan, leadMs: LEAD_MS, playAfterMs: PLAY_AFTER_MS, settleSoftMs: SETTLE_SOFT_MS, settleHardMs: SETTLE_HARD_MS, ...results });
  });
});
