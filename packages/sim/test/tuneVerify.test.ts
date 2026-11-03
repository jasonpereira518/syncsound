import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { p95, r3, tuneRounds, verifyRoom } from '../src/tuneRoom';

// The check after a tune (docs/CALIBRATION.md "Verification"): every device clicks through its full compensation,
// the listener's mic records, `verifyTune` corrects a steady device that lands off. Round-based tunes of the sim
// room (tuneRounds.test.ts), checked at a later instant with fresh clock errors, then scored at the true head.

const SEEDS = Array.from({ length: 8 }, (_, i) => i + 1);
const results: Record<string, unknown> = {};
const LONG = 180_000;

describe('tune verification (sim room)', () => {
  const tuned = SEEDS.map((seed) => ({ seed, run: tuneRounds({ seed }) }));

  it(
    'a room as tuned needs no correction',
    () => {
      const v = tuned.map(({ seed, run }) => verifyRoom(run.report, run.rnd, { seed }));
      const offsets = v.flatMap((x) => Object.values(x.verification.offsetMs).map(Math.abs));
      results.asTuned = {
        corrected: v.filter((x) => x.verification.corrected).length,
        offsetMs: { p95: r3(p95(offsets)), max: r3(Math.max(...offsets)) },
        headP95Ms: r3(p95(v.flatMap((x) => x.before))),
      };
      console.log('as tuned', results.asTuned);
      expect(v.filter((x) => x.verification.corrected).length).toBe(0);
    },
    LONG,
  );

  it(
    'an output step the tune never saw (+3 ms on one laptop) is found and corrected',
    () => {
      const v = tuned.map(({ seed, run }) => verifyRoom(run.report, run.rnd, { seed, stepMs: { C: 3 } }));
      const before = p95(v.flatMap((x) => x.before));
      const after = p95(v.flatMap((x) => x.after));
      results.stepOnC = { corrected: v.filter((x) => x.verification.corrected).length, headP95Ms: { before: r3(before), after: r3(after) } };
      console.log('step', results.stepOnC);
      expect(v.every((x) => x.verification.corrected !== null)).toBe(true);
      expect(before).toBeGreaterThan(2);
      expect(after).toBeLessThan(1);
    },
    LONG,
  );

  it('writes metrics', () => {
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/tuneVerify.json', import.meta.url),
      JSON.stringify({ description: 'the check after a tune (see tuneRoom.ts verifyRoom)', seeds: SEEDS.length, ...results }, null, 2) + '\n',
    );
  });
});
