import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TUNE_AGREE_MS } from '@syncsound/audio-core';
import { p95, r3, ROOM, scoreRounds } from '../src/tuneRoom';

// A tune in rounds (docs/CALIBRATION.md "Rounds", packages/sim/src/tuneRoom.ts `tuneRounds`): round 0 is the
// all-recorders tune of tune.test.ts; listener-only rounds then replay the devices that aren't confirmed, each round
// with fresh clock errors on every device and a fresh frozen map at the listener. Scored at the true head with the
// same fresh play-time clock errors for the rounds result and for round 0 alone (the tune before rounds).
// tuneRoundsFaults.test.ts covers a blocked speaker and a jittering Bluetooth output.

const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const ids = ROOM.map((x) => x.id);
/** each device, each round, is not heard with this probability (muted, volume down, a cough over its chime) */
const MISS = 0.15;
const misses = (_k: number, rnd: () => number) => ({ muted: ids.filter(() => rnd() < MISS) });
const results: Record<string, unknown> = {};
const LONG = 180_000;

describe('tune rounds (sim room, 4 laptops + a Bluetooth speaker)', () => {
  it(
    'a clean room confirms the laptops in two rounds and the Bluetooth speaker in a third, no worse than one chime each',
    () => {
      const s = scoreRounds(SEEDS, {});
      // round 2 replays only the anchor and the Bluetooth output (it confirms on three readings)
      for (const x of s) expect(x.run.rounds.map((r) => r.emitters.length)).toEqual([ids.length, ids.length, 2]);
      const rounds = p95(s.flatMap((x) => x.pairs.rounds));
      const single = p95(s.flatMap((x) => x.pairs.single));
      // honest repeats: how far a device's second reading is from its first (sets TUNE_AGREE_MS)
      const repeat = s.flatMap((x) => x.run.progress.devices.map((d) => Math.abs(d.measurementsMs[1]! - d.measurementsMs[0]!)));
      results.clean = { headP95Ms: { rounds: r3(rounds), single: r3(single) }, repeatDiffMs: { p95: r3(p95(repeat)), max: r3(Math.max(...repeat)) } };
      expect(s.every((x) => x.run.progress.devices.every((d) => d.state === 'in-sync'))).toBe(true);
      expect(Math.max(...repeat)).toBeLessThanOrEqual(TUNE_AGREE_MS);
      expect(rounds).toBeLessThan(1);
      expect(rounds).toBeLessThanOrEqual(single + 0.05);
    },
    LONG,
  );

  it(
    `${MISS * 100} % of chimes missed: rounds time every device where one chime each misses some in a third of runs`,
    () => {
      const s = scoreRounds(SEEDS, { perRound: misses });
      const timed = s.filter((x) => x.allTimed.rounds).length / s.length;
      const timedSingle = s.filter((x) => x.allTimed.single).length / s.length;
      const settled = s.filter((x) => x.settled).length / s.length;
      const rounds = p95(s.flatMap((x) => x.pairs.rounds));
      results.misses = {
        allTimed: { rounds: timed, single: timedSingle },
        allSettled: settled,
        roundsUsed: s.map((x) => x.run.rounds.length),
        headP95Ms: r3(rounds),
      };
      expect(timed).toBe(1);
      expect(timedSingle).toBeLessThan(0.9);
      expect(settled).toBeGreaterThanOrEqual(0.8);
      expect(rounds).toBeLessThan(1);
    },
    LONG,
  );

  it(
    "each round's clock offset at the listener cancels against the anchor (control: raw arrivals don't)",
    () => {
      // WAN-like listener clocks (σ 2 ms per round) plus misses, so devices are measured in different rounds
      const s = scoreRounds(SEEDS, { perRound: misses, listenerOffsetSigmaMs: 2 });
      const anchored = p95(s.flatMap((x) => x.pairs.rounds));
      const naive = p95(s.flatMap((x) => x.pairs.naive));
      results.listenerOffsets = { sigmaMs: 2, headP95Ms: { anchored: r3(anchored), naive: r3(naive) } };
      expect(anchored).toBeLessThan(1);
      expect(naive).toBeGreaterThan(1);
    },
    LONG,
  );

  it('writes metrics', () => {
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/tuneRounds.json', import.meta.url),
      JSON.stringify({ description: 'tune in rounds vs one chime each (see tuneRoom.ts tuneRounds)', seeds: SEEDS.length, ...results }, null, 2) + '\n',
    );
  });
});
