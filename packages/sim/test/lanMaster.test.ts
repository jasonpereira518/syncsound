import { describe, expect, it } from 'vitest';
import { ClockMapping, LAN_PING_MS, LAN_SYNC_OPTS } from '@syncsound/audio-core';
import { SimClient, stats, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams } from '../src/network';

const DURATION_MS = 180_000;
const PROBE_MS = 100;
const SETTLE_MS = 10_000;
const N = 6;

// Home devices on Wi-Fi reaching a cloud server: the WAN leg (incl. its asymmetry) is shared by every device,
// the Wi-Fi leg is per device. NTP can't see asymmetry, but a common bias doesn't separate devices; per-packet
// WAN queueing does, independently per device.
const wan: NetParams = { baseRttMs: 44, asymmetryMs: 6, jitterMs: 5, spikeProb: 0.02, spikeMaxMs: 120, lossProb: 0.01 };
const lan: NetParams = { baseRttMs: 6, jitterMs: 2, spikeProb: 0.02, spikeMaxMs: 30, lossProb: 0.01, serverProcMs: 0.2 };

/**
 * Pairwise spread (max − min room-time error across devices) per probe after settling, ms.
 * viaMaster: peers sync to the master's raw perf clock over the LAN, and the master shares its local → room
 * mapping (a ClockMapping snapshot, re-sent every second), so every device applies the *same* WAN estimate.
 */
function run(viaMaster: boolean): number[] {
  const rng = makeRng(99);
  const clock = () => ({ offsetMs: rng.uniform(-10_000, 10_000), driftPpm: rng.uniform(-100, 100) });
  const master = new SimClient({ clock: clock(), net: wan, seed: 1, joinT: ROOM_T0 });
  const peers = Array.from({ length: N - 1 }, (_, i) =>
    viaMaster
      ? new SimClient({ clock: clock(), net: lan, seed: 10 + i, joinT: ROOM_T0, reference: (T) => master.clock.local(T), pingIntervalMs: LAN_PING_MS, syncOpts: LAN_SYNC_OPTS })
      : new SimClient({ clock: clock(), net: wan, seed: 10 + i, joinT: ROOM_T0 }),
  );
  let mapping: ClockMapping | null = null;
  const spreads: number[] = [];
  for (let t = 0; t <= DURATION_MS; t += PROBE_MS) {
    const T = ROOM_T0 + t;
    master.advanceTo(T);
    for (const p of peers) p.advanceTo(T);
    // the snapshot reaches peers ~one LAN leg later; at 100 ms probes that's "next probe"
    const next = t % 1000 === 0 ? ClockMapping.of(master.sync) : null;
    if (t >= SETTLE_MS && mapping) {
      const errs = [master.roomError(T)];
      // peer room time = master mapping applied to the peer's estimate of the master's clock
      for (const p of peers) errs.push(mapping.toRoomTime(p.sync.toRoomTime(p.clock.local(T))) - T);
      if (!viaMaster) errs.splice(1, Infinity, ...peers.map((p) => p.roomError(T)));
      spreads.push(Math.max(...errs) - Math.min(...errs));
    }
    if (next) mapping = next;
  }
  return spreads;
}

describe('LAN clock master (peers sync to one in-home device over a DataChannel)', () => {
  it('keeps device-to-device spread < 0.5 ms p95 / < 1 ms max, beating every device syncing to the WAN server', { timeout: 60_000 }, () => {
    const direct = stats(run(false));
    const master = stats(run(true));
    writeResult('lanMaster', { params: { devices: N, wan, lan, durationMs: DURATION_MS, settleMs: SETTLE_MS }, directSpreadMs: direct, masterSpreadMs: master });
    expect(master.p95).toBeLessThan(0.5);
    expect(master.max).toBeLessThan(1);
    expect(master.p95).toBeLessThan(direct.p95);
  });
});
