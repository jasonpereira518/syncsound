import { describe, expect, it } from 'vitest';
import { ClockMapping, LAN_PING_MS, LAN_SYNC_OPTS } from '@syncsound/audio-core';
import { SimClient, stats, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams } from '../src/network';

/**
 * The LAN clock master leaves mid-song. Its peers notice the silence after STALE_MS, fall back to their own
 * server-clock estimate (a step of whatever the two estimates differ by), the server notices the master's socket
 * is gone after its heartbeat, a new master is elected, and the peers re-link to it — ready only after
 * READY_HOLD_MS of health. Measured: the largest step any device sees, the recovery time, and the spread afterwards.
 */
const DURATION_MS = 180_000;
const PROBE_MS = 100;
const N = 6;
const LEAVE_AT = 90_000;
const HEARTBEAT_MS = 20_000; // the server marks the master gone this much later (15 s heartbeat + slack)
const STALE_MS = 3000;
const MAP_STALE_MS = 15_000;
const READY_HOLD_MS = 2000;
const MIN_LAN_SAMPLES = 8;

const wan: NetParams = { baseRttMs: 44, asymmetryMs: 6, jitterMs: 5, spikeProb: 0.02, spikeMaxMs: 120, lossProb: 0.01 };
const lanBase: NetParams = { baseRttMs: 6, jitterMs: 2, spikeProb: 0.02, spikeMaxMs: 30, lossProb: 0.01, serverProcMs: 0.2 };

interface Peer {
  wan: SimClient;
  lan: SimClient | null;
  lanNet: NetParams;
  mapping: ClockMapping | null;
  mappingAt: number;
  healthySince: number | null;
  joinedLanAt: number;
}

function lanClient(peer: Peer, master: SimClient, T: number, seed: number): SimClient {
  const net = { ...lanBase };
  peer.lanNet = net;
  return new SimClient({ clock: peer.wan.p.clock, net, seed, joinT: T, reference: (t) => master.clock.local(t), pingIntervalMs: LAN_PING_MS, syncOpts: LAN_SYNC_OPTS });
}

/** the ClockLink readiness rule: converged LAN estimate, a pong within STALE_MS, a mapping within MAP_STALE_MS, held READY_HOLD_MS */
function ready(peer: Peer, T: number): boolean {
  const lan = peer.lan;
  const healthy = !!lan && lan.sync.estimate().samples >= MIN_LAN_SAMPLES && T - lan.lastPongT < STALE_MS && !!peer.mapping && T - peer.mappingAt < MAP_STALE_MS;
  if (!healthy) {
    peer.healthySince = null;
    return false;
  }
  peer.healthySince ??= T;
  return T - peer.healthySince >= READY_HOLD_MS;
}

describe('LAN clock master leaves mid-song', () => {
  it('peers fall back to the server clock with a bounded step, re-link to the new master and recover sub-ms spread', { timeout: 120_000 }, () => {
    const rng = makeRng(99);
    const clock = () => ({ offsetMs: rng.uniform(-10_000, 10_000), driftPpm: rng.uniform(-100, 100) });
    const all: Peer[] = Array.from({ length: N }, (_, i) => ({
      wan: new SimClient({ clock: clock(), net: wan, seed: 1 + i, joinT: ROOM_T0 }),
      lan: null,
      lanNet: lanBase,
      mapping: null,
      mappingAt: -Infinity,
      healthySince: null,
      joinedLanAt: ROOM_T0,
    }));
    let masterIdx = 0;
    for (const [i, p] of all.entries()) if (i !== masterIdx) p.lan = lanClient(p, all[masterIdx]!.wan, ROOM_T0, 10 + i);

    const errBefore: number[] = [];
    const spreadBefore: number[] = [];
    const spreadAfter: number[] = [];
    const maxStep = all.map(() => 0);
    const prevErr = all.map(() => NaN);
    const prevDrift = all.map(() => 0);
    let allReadyAt = NaN;
    let masterGoneAt = NaN;
    let fallbackAt = NaN;
    const pathLog: Array<{ t: number; ready: boolean[] }> = [];

    for (let t = 0; t <= DURATION_MS; t += PROBE_MS) {
      const T = ROOM_T0 + t;
      if (t === LEAVE_AT) {
        // the master's tab closed: no more pongs, no more mappings
        for (const p of all) if (p.lan) p.lanNet.lossProb = 1;
        masterGoneAt = T;
      }
      if (t === LEAVE_AT + HEARTBEAT_MS) {
        // the server dropped it; everyone elects the lowest remaining id
        masterIdx = 1;
        for (const [i, p] of all.entries()) {
          p.mapping = null;
          p.mappingAt = -Infinity;
          p.healthySince = null;
          p.lan = i === masterIdx ? null : lanClient(p, all[masterIdx]!.wan, T, 30 + i);
          p.joinedLanAt = T;
        }
      }
      for (const p of all) {
        p.wan.advanceTo(T);
        p.lan?.advanceTo(T);
      }
      // the master shares its mapping once a second (timer) — peers of a gone master receive nothing
      if (t % 1000 === 0 && (t < LEAVE_AT || t >= LEAVE_AT + HEARTBEAT_MS)) {
        const m = ClockMapping.of(all[masterIdx]!.wan.sync);
        for (const [i, p] of all.entries())
          if (i !== masterIdx && m) {
            p.mapping = m;
            p.mappingAt = T;
          }
      }
      const readiness = all.map((p, i) => i !== masterIdx && ready(p, T));
      const errs = all.map((p, i) => {
        if (i === masterIdx || !readiness[i]) return p.wan.roomError(T);
        return p.mapping!.toRoomTime(p.lan!.sync.toRoomTime(p.wan.clock.local(T))) - T;
      });
      if (t >= 10_000) {
        const spread = Math.max(...errs) - Math.min(...errs);
        if (t < LEAVE_AT) {
          errBefore.push(...errs);
          spreadBefore.push(spread);
        }
        if (!Number.isNaN(allReadyAt) && t >= allReadyAt - ROOM_T0 + 5000) spreadAfter.push(spread);
        for (const [i, e] of errs.entries()) {
          const drift = all[i]!.wan.sync.estimate().driftPpm;
          if (!Number.isNaN(prevErr[i]!)) maxStep[i] = Math.max(maxStep[i]!, Math.abs(e - prevErr[i]!) - Math.abs(drift - prevDrift[i]!) * 1e-6 * PROBE_MS);
          prevErr[i] = e;
          prevDrift[i] = drift;
        }
      }
      if (t > LEAVE_AT && Number.isNaN(fallbackAt) && readiness.every((r, i) => i === 0 || !r)) fallbackAt = T;
      if (t > LEAVE_AT + HEARTBEAT_MS && Number.isNaN(allReadyAt) && readiness.every((r, i) => i === masterIdx || r)) allReadyAt = T;
      if (t % 1000 === 0) pathLog.push({ t, ready: readiness });
    }
    const result = {
      params: { devices: N, wan, lan: lanBase, leaveAtMs: LEAVE_AT, heartbeatMs: HEARTBEAT_MS, staleMs: STALE_MS, readyHoldMs: READY_HOLD_MS },
      beforeLeave: { errorMs: stats(errBefore), spreadMs: stats(spreadBefore) },
      fallbackAfterMs: fallbackAt - masterGoneAt,
      recoveredAfterMs: allReadyAt - masterGoneAt,
      maxStepMs: maxStep.map((s) => +s.toFixed(3)),
      afterRecovery: { spreadMs: stats(spreadAfter) },
    };
    writeResult('lanFailover', result);
    expect(result.fallbackAfterMs).toBeLessThanOrEqual(STALE_MS + PROBE_MS);
    expect(result.recoveredAfterMs).toBeLessThan(25_000);
    expect(Math.max(...result.maxStepMs)).toBeLessThanOrEqual(5);
    expect(result.afterRecovery.spreadMs.p95).toBeLessThan(0.5);
    expect(result.afterRecovery.spreadMs.max).toBeLessThan(1);
  });
});
