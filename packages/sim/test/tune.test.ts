import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import {
  analyzeRecording,
  buildTuneSlots,
  calibrationRecordingMs,
  designBiquad,
  mulberry32,
  propagationDelays,
  solveTune,
  SPEED_OF_SOUND,
  type RowsByRecorder,
  type TuneReport,
} from '@syncsound/audio-core';
import { renderListenerRecording, SIM_SR, type SimReflections, type SimSpeaker } from '../src/acoustics';

// Calibration v3 end to end (docs/CALIBRATION.md): every laptop records its own mic, rows → solveTune, then the
// tune is applied at a LATER instant with fresh clock errors and scored where it matters: at the listener's head.
//
// Room: 6 × 5 m, first-order wall + floor reflections. Four stereo laptops (two speakers ±13 cm), one side-firing
// (its floor bounce is louder than the direct sound), plus a laptop driving a Bluetooth speaker across the room
// (180 ms output latency; it reports its Bluetooth output, as the app's recorders do). Per device: output latency, mic input
// latency, recorder clock rate ±50 ppm known to ±20 ppm, and a clock error ~N(0, 0.11 ms) drawn afresh at tune time
// and at play time (σ matched to lanMaster.test's device-to-device spread, p95 ≈ 0.41 ms over 6 devices).

const SR = SIM_SR;
const REFL: SimReflections = { room: { width: 6, depth: 5 }, wallGain: 0.4, heightM: 0.75, floorGain: 0.7 };
const STEREO = 0.13;
const CLOCK_SIGMA_MS = 0.11;

interface Laptop {
  id: string;
  pos: Vec2;
  /** a Bluetooth speaker this laptop plays through */
  speaker?: Vec2;
  outMs: number;
  inMs: number;
  directGain?: number;
  filters: SimSpeaker['filters'];
}
const lap = (hp: number, peakHz: number, peakDb: number) => [
  designBiquad('highpass', hp, Math.SQRT1_2, 0, SR),
  designBiquad('peaking', peakHz, 1.2, peakDb, SR),
];
const ROOM: Laptop[] = [
  { id: 'L', pos: { x: 0, y: 1.2 }, outMs: 30, inMs: 12, filters: lap(160, 4000, 5) },
  { id: 'A', pos: { x: -2.0, y: -1.6 }, outMs: 45, inMs: 20, filters: lap(140, 2500, -4) },
  { id: 'B', pos: { x: 2.1, y: -1.4 }, outMs: 25, inMs: 8, directGain: 0.5, filters: lap(200, 6000, 3) },
  { id: 'C', pos: { x: 2.3, y: 1.8 }, outMs: 60, inMs: 15, filters: lap(120, 1200, -3) },
  { id: 'bt', pos: { x: -2.4, y: 1.5 }, speaker: { x: -1.0, y: -2.0 }, outMs: 180, inMs: 25, filters: [designBiquad('highshelf', 5000, 0.8, -6, SR)] },
];
/** the listener's head: 0.4 m behind the tuning laptop (front is −y) */
const HEAD: Vec2 = { x: ROOM[0]!.pos.x, y: ROOM[0]!.pos.y + 0.4 };

const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
/** what a listener at p hears first from a device: its nearer speaker */
const nearest = (x: Laptop, p: Vec2) =>
  x.speaker ? d(x.speaker, p) : Math.min(d({ x: x.pos.x - STEREO, y: x.pos.y }, p), d({ x: x.pos.x + STEREO, y: x.pos.y }, p));
/** the user's rough layout: truth ± ~30 cm */
const rough = (rnd: () => number) =>
  Object.fromEntries(ROOM.map((x) => [x.id, { x: (x.speaker ?? x.pos).x + 0.3 * gauss(rnd), y: (x.speaker ?? x.pos).y + 0.3 * gauss(rnd) }]));

function tune(seed: number, placeHead: boolean) {
  const rnd = mulberry32(seed);
  const clock1 = Object.fromEntries(ROOM.map((x) => [x.id, CLOCK_SIGMA_MS * gauss(rnd)]));
  const ppm = Object.fromEntries(ROOM.map((x) => [x.id, 50 * (2 * rnd() - 1)]));
  const ppmErr = Object.fromEntries(ROOM.map((x) => [x.id, 20 * (2 * rnd() - 1)]));
  const slots = buildTuneSlots(ROOM.map((x) => x.id));
  const plan: CalibrationPlan = { id: `t${seed}`, listenerId: 'L', startRoomTime: 2_000_000, slots, recorders: 'all' };
  // a device whose clock reads c ms ahead emits c ms early (ε = out − c) and stamps what it hears c ms late (λ = in + c)
  const speakers: SimSpeaker[] = ROOM.map((x) => ({
    id: x.id,
    filters: x.filters,
    gain: 0.8,
    latencyMs: x.outMs - clock1[x.id]!,
    position: x.pos,
    ...(x.speaker ? { speakerPosition: x.speaker } : { stereoHalfWidthM: STEREO }),
    ...(x.directGain ? { directGain: x.directGain } : {}),
  }));
  const rows: RowsByRecorder = {};
  let listener: ReturnType<typeof analyzeRecording> | null = null;
  for (const r of ROOM) {
    const recording = renderListenerRecording({
      plan,
      speakers,
      listener: r.pos,
      selfId: r.id,
      sampleRate: SR,
      durationMs: calibrationRecordingMs(slots),
      inputLatencyMs: r.inMs + clock1[r.id]!,
      noiseDb: -60,
      roomNoiseDb: -50,
      reflections: REFL,
      ppm: ppm[r.id]!,
      seed: seed * 31 + r.id.charCodeAt(0),
    });
    const rate = 1 + (ppm[r.id]! + ppmErr[r.id]!) * 1e-6; // the recorder's own (imperfect) rate estimate
    const a = analyzeRecording({ plan, recording, sampleRate: SR, toRoomMs: (i) => plan.startRoomTime + (i / (SR * rate)) * 1000 });
    rows[r.id] = a.rows;
    if (r.id === 'L') listener = a;
  }
  const scene = { devices: rough(rnd), listener: { x: 0, y: 2 } };
  const report = solveTune({
    rows,
    listenerId: 'L',
    responses: listener!.responses,
    broadbandSnrDb: listener!.broadbandSnrDb,
    sampleRate: SR,
    scene,
    deviceIds: ROOM.map((x) => x.id),
    placeHead: true,
    detached: ROOM.filter((x) => x.speaker).map((x) => x.id),
  });
  // control: align at the mic itself (no head model)
  if (!placeHead) report.listener = report.positions['L']!;
  return { report, rnd };
}

/** play at a later instant: fresh clock errors; arrival at the TRUE head of each device's sound, ms */
function arrivalsAtHead(report: TuneReport, rnd: () => number) {
  const ids = ROOM.map((x) => x.id);
  const delays = propagationDelays({ devices: report.positions, listener: report.listener } as never, ids);
  return ROOM.map((x) => {
    const clock2 = CLOCK_SIGMA_MS * gauss(rnd);
    const cal = report.devices.find((r) => r.deviceId === x.id)!.relativeLatencyMs!;
    return x.outMs - clock2 - cal + delays[x.id]! * 1000 + (nearest(x, HEAD) / SPEED_OF_SOUND) * 1000;
  });
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.95 * xs.length))]!;
const pairwise = (t: number[]) => t.flatMap((a, i) => t.slice(i + 1).map((b) => Math.abs(a - b)));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const results: Record<string, unknown> = {};

describe('tune v3 (end to end, reflective room, 4 laptops + a Bluetooth speaker)', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6];
  const runs = SEEDS.map((s) => tune(s, true));
  const controls = SEEDS.map((s) => tune(s, false));

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

  it('writes metrics', () => {
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/tune.json', import.meta.url),
      JSON.stringify({ description: 'calibration v3 end-to-end sim (see tune.test.ts header)', seeds: SEEDS.length, ...results }, null, 2) + '\n',
    );
  });
});
