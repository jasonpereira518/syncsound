import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@syncsound/protocol';
import { deriveCalibratedLatency, SPEED_OF_SOUND } from '@syncsound/audio-core';
import { arrivalsAtHeadWith, carried, CLOCK_SIGMA_MS, gauss, p95, pairwise, r3, ROOM, tune, type TuneRun } from '../src/tuneRoom';

// A tune that stays valid when the picture changes (docs/CALIBRATION.md §Staying in tune). The server keeps each
// device's raw arrival at the listener's mic plus where it was, and re-derives the compensation from the CURRENT
// scene (audio-core `deriveCalibratedLatency`) so that a layout change, a drag or an auto-placement moves the
// compensation by exactly what the engine's propagation delay moves: the sound still reaches the head when it did.
// Scored at the true head with fresh clock errors, against the control of what the app did before (a frozen value
// solved at tune time + propagation delays recomputed on the edited picture).

const SEEDS = [1, 2, 3, 4, 5, 6];
const results: Record<string, unknown> = {};
const msPerM = 1000 / SPEED_OF_SOUND;

const tuneRef = (run: TuneRun) => ({ id: run.plan.id, listenerId: 'L', mic: run.report.positions['L']!, positions: run.report.positions });
const tuned = (run: TuneRun) => run.report.devices.map((d) => ({ id: d.deviceId, tuneArrivalMs: d.arrivalMs, tuneId: run.plan.id }));
const frozen = (run: TuneRun) => Object.fromEntries(run.report.devices.map((d) => [d.deviceId, d.relativeLatencyMs]));
const playErrors = (rnd: () => number) => Object.fromEntries(ROOM.map((x) => [x.id, CLOCK_SIGMA_MS * gauss(rnd)]));
/** a 1 m drag in a seeded direction */
const unit = (rnd: () => number): Vec2 => {
  const a = 2 * Math.PI * rnd();
  return { x: Math.cos(a), y: Math.sin(a) };
};
const shift = (p: Vec2, by: Vec2): Vec2 => ({ x: p.x + by.x, y: p.y + by.y });

describe('tune invariant: the compensation follows picture edits, the sound stays aligned at the head', () => {
  const runs = SEEDS.map((seed) => tune({ seed, placeHead: true }));

  it('re-deriving at the unchanged scene reproduces the solver’s own compensation', () => {
    for (const run of runs) {
      const scene = { devices: run.report.positions, listener: run.report.listener };
      const cal = deriveCalibratedLatency(tuned(run), tuneRef(run), scene.devices, scene.listener);
      for (const d of run.report.devices) expect(cal[d.deviceId]).toBeCloseTo(d.relativeLatencyMs!, 9);
    }
  });

  it('dragging a ranged laptop and the hand-placed Bluetooth speaker 1 m on the picture (nothing moved): still < 1 ms p95; the old frozen value misses by the air path', () => {
    const base: number[] = [];
    const derived: number[] = [];
    const control: number[] = [];
    let worstShift = 0;
    for (const run of runs) {
      const err = playErrors(run.rnd);
      const scene0 = { devices: run.report.positions, listener: run.report.listener };
      const before = arrivalsAtHeadWith({ scene: scene0, cal: frozen(run), playErrorMs: err });
      base.push(...pairwise(before));
      const devices = { ...scene0.devices, C: shift(scene0.devices['C']!, unit(run.rnd)), bt: shift(scene0.devices['bt']!, unit(run.rnd)) };
      const scene = { devices, listener: scene0.listener };
      const cal = deriveCalibratedLatency(tuned(run), tuneRef(run), scene.devices, scene.listener);
      const after = arrivalsAtHeadWith({ scene, cal, playErrorMs: err });
      derived.push(...pairwise(after));
      // exact: every device's arrival is what it was before the drag (up to a common shift from the farthest device)
      const diff = after.map((a, i) => a - before[i]!);
      worstShift = Math.max(worstShift, Math.max(...diff) - Math.min(...diff));
      control.push(...pairwise(arrivalsAtHeadWith({ scene, cal: frozen(run), playErrorMs: err })));
    }
    results.dragOnPicture = {
      baselineMs: { p95: r3(p95(base)), max: r3(Math.max(...base)) },
      derivedMs: { p95: r3(p95(derived)), max: r3(Math.max(...derived)), changeFromBaselineMaxMs: r3(worstShift) },
      frozenControlMs: { p95: r3(p95(control)), max: r3(Math.max(...control)) },
    };
    expect(worstShift).toBeLessThan(1e-6);
    expect(p95(derived)).toBeLessThan(1);
    expect(p95(control)).toBeGreaterThan(2);
  });

  it('a layout reset that re-places the hand-placed speaker at a canonical slot 2 m away changes nothing either', () => {
    const derived: number[] = [];
    for (const run of runs) {
      const err = playErrors(run.rnd);
      const scene0 = { devices: run.report.positions, listener: run.report.listener };
      const before = arrivalsAtHeadWith({ scene: scene0, cal: frozen(run), playErrorMs: err });
      const slot = shift(scene0.listener, { x: -1.4, y: -1.4 }); // a stereo-ish slot, ~2 m off
      const scene = { devices: { ...scene0.devices, bt: slot }, listener: scene0.listener };
      const after = arrivalsAtHeadWith({ scene, cal: deriveCalibratedLatency(tuned(run), tuneRef(run), scene.devices, scene.listener), playErrorMs: err });
      const diff = after.map((a, i) => a - before[i]!);
      derived.push(Math.max(...diff) - Math.min(...diff));
    }
    results.layoutReset = { changeFromBaselineMaxMs: r3(Math.max(...derived)) };
    expect(Math.max(...derived)).toBeLessThan(1e-6);
  });

  it('a laptop carried 1 m across the room (and dragged to match) is off by its air path until the next tune, which fixes it', { timeout: 240_000 }, () => {
    const moved: number[] = [];
    const retuned: number[] = [];
    for (const run of runs) {
      const by = unit(run.rnd);
      const err = playErrors(run.rnd);
      const room = ROOM.map((x) => (x.id === 'C' ? carried(x, by) : x));
      // the host drags C to where it now really is; the tune's arrival was measured where it was
      const scene = { devices: { ...run.report.positions, C: shift(run.report.positions['C']!, by) }, listener: run.report.listener };
      const cal = deriveCalibratedLatency(tuned(run), tuneRef(run), scene.devices, scene.listener);
      const t = arrivalsAtHeadWith({ scene, cal, playErrorMs: err, room });
      const others = t.filter((_, i) => ROOM[i]!.id !== 'C');
      const mean = others.reduce((a, b) => a + b, 0) / others.length;
      moved.push(Math.abs(t[ROOM.findIndex((x) => x.id === 'C')]! - mean));
      // one tap later: a new tune in the moved room
      const again = tune({ seed: 100 + runs.indexOf(run), placeHead: true, room });
      const scene2 = { devices: again.report.positions, listener: again.report.listener };
      const cal2 = deriveCalibratedLatency(tuned(again), tuneRef(again), scene2.devices, scene2.listener);
      retuned.push(...pairwise(arrivalsAtHeadWith({ scene: scene2, cal: cal2, playErrorMs: playErrors(again.rnd), room })));
    }
    results.carriedLaptop = {
      note: 'the moved device vs the mean of the others, before anyone tunes again; the limit is physical (its chime was measured 1 m away)',
      untilRetunedMs: { p95: r3(p95(moved)), max: r3(Math.max(...moved)), airPathOf1mMs: r3(msPerM) },
      afterRetuneMs: { p95: r3(p95(retuned)), max: r3(Math.max(...retuned)) },
    };
    expect(p95(moved)).toBeGreaterThan(1); // a real, documented limit (docs/LIMITATIONS.md): no silent fix exists
    expect(Math.max(...moved)).toBeLessThan(msPerM + 1);
    expect(p95(retuned)).toBeLessThan(1);
  });

  it('writes metrics', () => {
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/tuneInvariant.json', import.meta.url),
      JSON.stringify({ description: 'tune invariant under picture edits and a physical move (see tuneRoom.ts)', seeds: SEEDS.length, ...results }, null, 2) + '\n',
    );
  });
});
