import { describe, expect, it } from 'vitest';
import type { CalibrationPlan, CalibrationRow, Vec2 } from '@syncsound/protocol';
import { cascadeMagnitudeDb, designBiquad, processCascade } from './biquad';
import { analyzeRecording, beepBeep, buildTuneSlots, calibrationRecordingMs, SELF_OFFSET_M, solveTune, type RowsByRecorder, type TuneReport } from './calibration';
import { smoothFractionalOctave } from './measure';
import { calibrationSignal } from './signals';
import { propagationDelays, SPEED_OF_SOUND } from './spatial';

const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

interface Dev {
  id: string;
  /** the laptop (its mic, and its built-in speaker) */
  pos: Vec2;
  /** a speaker that isn't built in (Bluetooth across the room) */
  speaker?: Vec2;
  epsMs: number;
  lambdaMs: number;
  /** source level at 1 m / mic gain, dB */
  p: number;
  g: number;
  /** false = emits but doesn't record */
  mic?: boolean;
}

/** exact rows M(r,e) = ε_e + λ_r + d(speaker_e, mic_r)/c; a built-in speaker sits SELF_OFFSET_M from its own mic */
function rowsFor(devs: Dev[]): RowsByRecorder {
  const rows: RowsByRecorder = {};
  for (const r of devs) {
    if (r.mic === false) continue;
    rows[r.id] = devs.map((e): CalibrationRow => {
      const dist = e.speaker ? d(e.speaker, r.pos) : e.id === r.id ? SELF_OFFSET_M : d(e.pos, r.pos);
      return {
        emitterId: e.id,
        mMs: e.epsMs + r.lambdaMs + (dist / SPEED_OF_SOUND) * 1000,
        levelDb: e.p + r.g - 20 * Math.log10(dist),
        directDb: e.p + r.g - 20 * Math.log10(dist),
        snrDb: 60,
        clipped: false,
      };
    });
  }
  return rows;
}

const room: Dev[] = [
  { id: 'L', pos: { x: 0, y: 1 }, epsMs: 12, lambdaMs: 40, p: 0, g: 0 },
  { id: 'A', pos: { x: -2, y: -1.5 }, epsMs: 30, lambdaMs: -7, p: -3, g: 4 },
  { id: 'B', pos: { x: 2.2, y: -1.2 }, epsMs: 5, lambdaMs: 15, p: 2, g: -6 },
  { id: 'C', pos: { x: 1.8, y: 2.6 }, epsMs: 21, lambdaMs: 3, p: -1, g: 1 },
];
const exact = (devs: Dev[]) => Object.fromEntries(devs.map((x) => [x.id, x.speaker ?? x.pos]));
/** the user's rough layout: truth plus up to ~30 cm of placement error */
const rough = (devs: Dev[]) =>
  Object.fromEntries(devs.map((x, i) => [x.id, { x: x.pos.x + 0.3 * Math.sin(i * 1.7), y: x.pos.y + 0.3 * Math.cos(i * 2.3) }]));

/**
 * Spread of arrival times at the solved head: device i starts cal_i earlier, waits its propagation delay, then
 * travels its distance to the head. The solve is a rigid transform of the truth, so distances in the solved frame
 * are the true ones (laptop speakers sit at their laptops).
 */
function headSpreadMs(devs: Dev[], rep: TuneReport) {
  const ids = devs.map((x) => x.id);
  const delays = propagationDelays({ devices: rep.positions, listener: rep.listener } as never, ids);
  const t = devs.map((x) => {
    const cal = rep.devices.find((r) => r.deviceId === x.id)!.relativeLatencyMs!;
    return x.epsMs - cal + delays[x.id]! * 1000 + (d(rep.positions[x.id]!, rep.listener) / SPEED_OF_SOUND) * 1000;
  });
  return Math.max(...t) - Math.min(...t);
}

const solve = (devs: Dev[], devices = rough(devs), rows = rowsFor(devs), placeHead = true, listener = { x: 0, y: 2 }) =>
  solveTune({ rows, listenerId: 'L', responses: {}, sampleRate: 48000, scene: { devices, listener }, deviceIds: devs.map((x) => x.id), placeHead });

describe('beepBeep', () => {
  it('recovers every pairwise distance exactly; clocks and latencies cancel', () => {
    const dist = beepBeep(rowsFor(room));
    for (const a of room)
      for (const b of room) if (a !== b) expect(dist[a.id]![b.id]).toBeCloseTo(d(a.pos, b.pos), 9);
  });

  it("skips a device whose speaker isn't at its own mic (Bluetooth across the room)", () => {
    const devs = [...room.slice(0, 3), { ...room[3]!, speaker: { x: -1, y: 3 } }];
    const dist = beepBeep(rowsFor(devs));
    expect(dist['C']).toBeUndefined();
    expect(dist['A']!['B']).toBeCloseTo(d(room[1]!.pos, room[2]!.pos), 9);
  });

  it('never ranges a device flagged as detached', () => {
    expect(beepBeep(rowsFor(room), ['C'])['C']).toBeUndefined();
  });
});

describe('solveTune', () => {
  it('measures the layout and keeps the user orientation', () => {
    const rep = solve(room);
    for (const a of room)
      for (const b of room)
        if (a !== b) expect(Math.abs(d(rep.positions[a.id]!, rep.positions[b.id]!) - d(a.pos, b.pos))).toBeLessThan(0.001);
    expect(rep.stress!).toBeLessThan(1e-4);
    expect(rep.devices.every((x) => x.ranged && x.heard)).toBe(true);
    const m = rough(room);
    for (const x of room) expect(d(rep.positions[x.id]!, m[x.id]!)).toBeLessThan(0.45);
  });

  it('keeps a mirrored user layout mirrored (left/right never flips)', () => {
    const mirrored = Object.fromEntries(Object.entries(exact(room)).map(([id, p]) => [id, { x: -p.x, y: p.y }]));
    const rep = solve(room, mirrored);
    for (const x of room) expect(d(rep.positions[x.id]!, mirrored[x.id]!)).toBeLessThan(0.001);
  });

  it('puts the head 0.4 m behind the tuning laptop and aligns every device there', () => {
    const rep = solve(room);
    expect(d(rep.listener, rep.positions['L']!)).toBeCloseTo(0.4, 9);
    expect(rep.listener.y).toBeGreaterThan(rep.positions['L']!.y); // behind = +y (front is −y)
    expect(headSpreadMs(room, rep)).toBeLessThan(0.01);
  });

  it('times a detached Bluetooth speaker from its hand placement', () => {
    const bt: Dev = { id: 'BT', pos: { x: -2.5, y: 2 }, speaker: { x: -2.5, y: 2 }, epsMs: 210, lambdaMs: 0, p: 3, g: 0, mic: false };
    const devs = [...room, bt];
    const rep = solve(devs, exact(devs)); // exact placement → the solved frame is the true one
    const b = rep.devices.find((x) => x.deviceId === 'BT')!;
    expect(b.heard).toBe(true);
    expect(b.ranged).toBe(false);
    expect(rep.positions['BT']).toEqual(bt.speaker);
    expect(rep.warnings.some((w) => w.includes('Placed by hand (not measured): BT'))).toBe(true);
    expect(headSpreadMs(devs, rep)).toBeLessThan(0.01);
  });

  it('works with two laptops: distance along the user-placed bearing, timing exact', () => {
    const two = room.slice(0, 2);
    const rep = solve(two);
    expect(d(rep.positions['L']!, rep.positions['A']!)).toBeCloseTo(d(two[0]!.pos, two[1]!.pos), 6);
    expect(rep.stress).toBeNull();
    expect(headSpreadMs(two, rep)).toBeLessThan(0.01);
  });

  it('reports an unheard device and keeps going', () => {
    const rows = rowsFor(room);
    rows['L'] = rows['L']!.map((r) => (r.emitterId === 'B' ? { ...r, mMs: null, levelDb: null } : r));
    const rep = solve(room, rough(room), rows);
    const b = rep.devices.find((x) => x.deviceId === 'B')!;
    expect(b.heard).toBe(false);
    expect(b.relativeLatencyMs).toBeNull();
    expect(rep.warnings.some((w) => w.includes("Couldn't hear B"))).toBe(true);
    expect(Math.min(...rep.devices.filter((x) => x.heard).map((x) => x.relativeLatencyMs!))).toBe(0);
  });

  it('quick tune (listener rows only) reuses positions, leaves the head alone, same timing', () => {
    const full = solve(room);
    const rep = solve(room, full.positions, { L: rowsFor(room)['L']! }, false, full.listener);
    expect(rep.positions).toEqual(full.positions);
    expect(rep.listener).toEqual(full.listener);
    for (const x of rep.devices)
      expect(x.relativeLatencyMs!).toBeCloseTo(full.devices.find((f) => f.deviceId === x.deviceId)!.relativeLatencyMs!, 9);
  });

  it('levels at the head: the listener laptop is corrected from near-field to head distance', () => {
    const rep = solve(room, exact(room));
    const lvl = (id: string) => rep.devices.find((x) => x.deviceId === id)!.levelDb!;
    // L at its own mic: p + g − 20·log(0.1); at the head (0.4 m): p + g − 20·log(0.4)
    expect(lvl('L')).toBeCloseTo(-20 * Math.log10(0.4), 6);
    const a = room[1]!;
    expect(lvl('A')).toBeCloseTo(a.p + room[0]!.g - 20 * Math.log10(d(a.pos, rep.listener)), 6);
  });

  it("levels to the other devices' median: a misread listener self level never moves anyone else's trim", () => {
    const base = solve(room, exact(room));
    for (const shift of [-10, 10]) {
      const rows = rowsFor(room);
      rows['L'] = rows['L']!.map((r) => (r.emitterId === 'L' ? { ...r, levelDb: r.levelDb! + shift } : r));
      const rep = solve(room, exact(room), rows);
      for (const id of ['A', 'B', 'C']) expect(rep.trims[id]).toBeCloseTo(base.trims[id]!, 9);
      expect(rep.trims['L']).toBeCloseTo(Math.max(-24, Math.min(6, base.trims['L']! - shift)), 9);
    }
    // meet in the middle: someone is cut, someone boosted, nobody past +6 dB
    const t = Object.values(base.trims);
    expect(Math.max(...t)).toBeGreaterThan(0);
    expect(Math.min(...t)).toBeLessThan(0);
    expect(Math.max(...t)).toBeLessThanOrEqual(6);
  });
});

describe('analyzeRecording (tune signal)', () => {
  const SR = 48000;
  const cs = [designBiquad('highpass', 150, Math.SQRT1_2, 0, SR), designBiquad('peaking', 4000, 1.2, 6, SR)];
  const other = [designBiquad('highpass', 400, Math.SQRT1_2, 0, SR), designBiquad('peaking', 2000, 1, -6, SR)];

  it("measures a late device whose response segment reaches into the next slot's (identical) signal", () => {
    const slots = buildTuneSlots(['A', 'B']);
    const plan: CalibrationPlan = { id: 'p', listenerId: 'A', startRoomTime: 0, slots };
    const rec = new Float32Array(Math.round((calibrationRecordingMs(slots) / 1000) * SR));
    const put = (filters: typeof cs, atMs: number, gain: number) => {
      const x = processCascade(filters, calibrationSignal('tune', 0, SR));
      const at = Math.round((atMs / 1000) * SR);
      x.forEach((v, i) => (rec[at + i] = rec[at + i]! + gain * v));
    };
    put(cs, slots[0]!.offsetMs + 300, 0.5); // A: 300 ms of unreported (Bluetooth-class) latency
    put(other, slots[1]!.offsetMs, 0.5); // B: on time, so A's segment holds B's first ~240 ms
    const a = analyzeRecording({ plan, recording: rec, sampleRate: SR, toRoomMs: (i) => (i / SR) * 1000 });
    expect(a.rows[0]!.mMs!).toBeCloseTo(300, 1);
    expect(Math.abs(a.rows[1]!.mMs!)).toBeLessThan(0.1);
    const r = a.responses['A']!;
    const want = smoothFractionalOctave({ freqs: r.freqs, db: r.freqs.map((f) => 20 * Math.log10(0.5) + cascadeMagnitudeDb(cs, f, SR)) }, 6);
    r.freqs.forEach((f, i) => {
      if (f >= 40) expect(Math.abs(r.db[i]! - want.db[i]!)).toBeLessThan(0.5);
    });
  });
});
