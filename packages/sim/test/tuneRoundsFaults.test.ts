import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TUNE_AGREE_MS } from '@syncsound/audio-core';
import { gauss, p95, r3, scoreRounds } from '../src/tuneRoom';

// Tune rounds against the faults one chime can't see (tuneRounds.test.ts has the room and the scoring): a speaker
// whose direct path is blocked in round 0 (someone standing in front of it: a reflection is taken for the direct
// sound) and a Bluetooth output whose latency jitters from round to round.

const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const results: Record<string, unknown> = {};
const LONG = 180_000;

describe('tune rounds: faults', () => {
  it(
    'a speaker blocked during round 0: one chime each misses the target, rounds outvote the bad reading',
    () => {
      const s = scoreRounds(SEEDS, { perRound: (k) => (k === 0 ? { blocked: ['B'] } : {}) });
      const rounds = p95(s.flatMap((x) => x.pairs.rounds));
      const single = p95(s.flatMap((x) => x.pairs.single));
      const off = s.map((x) => {
        const b = x.run.progress.devices.find((d) => d.deviceId === 'B')!;
        return Math.abs(b.measurementsMs[0]! - b.valueMs!);
      });
      results.blocked = { headP95Ms: { rounds: r3(rounds), single: r3(single) }, blockedReadingOffMs: { min: r3(Math.min(...off)), max: r3(Math.max(...off)) } };
      expect(single).toBeGreaterThan(1);
      expect(rounds).toBeLessThan(1);
      // the blocked reading is further off than honest repeats ever are, so it never confirms itself
      expect(Math.min(...off)).toBeGreaterThan(TUNE_AGREE_MS);
    },
    LONG,
  );

  it(
    'a Bluetooth output jittering σ 3 ms per round is reported as varying, timed by the median of its readings',
    () => {
      const s = scoreRounds(SEEDS, { perRound: (_k, rnd) => ({ extraOutMs: { bt: 3 * gauss(rnd) } }) });
      const bt = s.map((x) => x.run.progress.devices.find((d) => d.deviceId === 'bt')!);
      const varies = bt.filter((d) => d.state === 'varies').length / bt.length;
      const spreads = bt.filter((d) => d.state === 'varies').map((d) => d.spreadMs!);
      const rounds = p95(s.flatMap((x) => x.pairs.rounds));
      const single = p95(s.flatMap((x) => x.pairs.single));
      results.bluetoothJitter = {
        sigmaMs: 3,
        variesShare: varies,
        spreadMs: { min: r3(Math.min(...spreads)), max: r3(Math.max(...spreads)) },
        headP95Ms: { rounds: r3(rounds), single: r3(single) },
      };
      expect(varies).toBeGreaterThanOrEqual(0.8);
      // the laptops still confirm
      expect(s.every((x) => x.run.progress.devices.filter((d) => d.deviceId !== 'bt').every((d) => d.state === 'in-sync'))).toBe(true);
      expect(rounds).toBeLessThan(single);
    },
    LONG,
  );

  it('writes metrics', () => {
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/tuneRoundsFaults.json', import.meta.url),
      JSON.stringify({ description: 'tune rounds: blocked speaker, Bluetooth jitter (see tuneRoom.ts tuneRounds)', seeds: SEEDS.length, ...results }, null, 2) + '\n',
    );
  });
});
