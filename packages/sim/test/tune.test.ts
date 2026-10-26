import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { arrivalsAtHead, d, p95, pairwise, r3, ROOM, tune } from '../src/tuneRoom';

// Calibration v3 end to end (docs/CALIBRATION.md, packages/sim/src/tuneRoom.ts): every laptop records its own mic,
// rows → solveTune, then the tune is applied at a LATER instant with fresh clock errors and scored where it
// matters: at the listener's head. Clock errors here are i.i.d. N(0, 0.11 ms) per device at tune time and again at
// play time; tuneClock.test.ts runs the same room on real, converging ClockSync / AudioClockMap instances.

const results: Record<string, unknown> = {};

describe('tune v3 (end to end, reflective room, 4 laptops + a Bluetooth speaker)', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6];
  const runs = SEEDS.map((seed) => tune({ seed, placeHead: true }));
  const controls = SEEDS.map((seed) => tune({ seed, placeHead: false }));
  const misread = SEEDS.map((seed) => tune({ seed, placeHead: true, selfGainDbL: -8 }));

  it('ranges the laptops (within their speaker spread) and leaves the Bluetooth speaker hand-placed', () => {
    const errs: number[] = [];
    for (const { report } of runs) {
      const laptops = ROOM.filter((x) => !x.speaker);
      for (const a of laptops)
        for (const b of laptops) {
          if (a.id >= b.id) continue;
          const got = report.distancesM[a.id]?.[b.id];
          expect(got).toBeDefined();
          errs.push(Math.abs(got! - d(a.pos, b.pos)));
        }
      expect(report.distancesM['bt']).toBeUndefined();
      expect(report.devices.find((x) => x.deviceId === 'bt')!.ranged).toBe(false);
      expect(report.devices.every((x) => x.heard)).toBe(true);
    }
    results.distanceErrorM = { p95: r3(p95(errs)), max: r3(Math.max(...errs)) };
    // a laptop's two speakers sit ±13 cm apart and the first arrival comes from the nearer one
    expect(Math.max(...errs)).toBeLessThan(0.15);
  });

  it('every pair of devices arrives at the head within 1 ms (p95), with fresh clock errors at play time', () => {
    const pairs = runs.flatMap(({ report, rnd }) => pairwise(arrivalsAtHead(report, rnd)));
    const sorted = [...pairs].sort((a, b) => a - b);
    results.headAlignmentMs = { p50: r3(sorted[sorted.length >> 1]!), p95: r3(p95(pairs)), max: r3(Math.max(...pairs)), pairs: pairs.length };
    expect(p95(pairs)).toBeLessThan(1);
  });

  it('control: aligning at the mic instead of the head misses by ~1 ms — the head model is doing real work', () => {
    const pairs = controls.flatMap(({ report, rnd }) => pairwise(arrivalsAtHead(report, rnd)));
    results.controlAtMicMs = { p95: r3(p95(pairs)), max: r3(Math.max(...pairs)) };
    expect(p95(pairs)).toBeGreaterThan(0.6);
    expect(p95(pairs)).toBeGreaterThan(2 * (results.headAlignmentMs as { p95: number }).p95);
  });

  it('levels at the head: each device within ±2 dB of what a mic at the true head measures (mean removed)', () => {
    const errs: number[] = [];
    for (const { report, headLevels } of runs) {
      const diff = ROOM.map((x) => report.devices.find((r) => r.deviceId === x.id)!.levelDb! - headLevels[x.id]!);
      const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
      errs.push(...diff.map((e) => Math.abs(e - mean)));
    }
    results.headLevelErrorDb = { p95: r3(p95(errs)), max: r3(Math.max(...errs)) };
    expect(Math.max(...errs)).toBeLessThan(2);
  });

  it("a listener laptop whose own speaker reads 8 dB quiet (near-field prior off) doesn't move anyone else's trim", () => {
    const shifts: number[] = [];
    for (const [k, { report }] of misread.entries()) {
      const base = runs[k]!.report;
      expect(report.devices.every((x) => x.heard)).toBe(true);
      for (const x of ROOM) if (x.id !== 'L') shifts.push(Math.abs(report.trims[x.id]! - base.trims[x.id]!));
      // the listener itself is boosted instead of dragging everyone down
      expect(report.trims['L']!).toBeGreaterThan(base.trims['L']!);
    }
    results.listenerSelfMisreadTrimShiftDb = { max: r3(Math.max(...shifts)) };
    expect(Math.max(...shifts)).toBeLessThan(0.5);
  });

  it('writes metrics', () => {
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/tune.json', import.meta.url),
      JSON.stringify({ description: 'calibration v3 end-to-end sim (see tuneRoom.ts)', seeds: SEEDS.length, ...results }, null, 2) + '\n',
    );
  });
});
