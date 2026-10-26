/**
 * The simulated living room of the tune sims (docs/CALIBRATION.md): 6 × 5 m with first-order wall + floor
 * reflections, four stereo laptops (two speakers ±13 cm, one side-firing so its floor bounce is louder than the
 * direct sound) and a laptop driving a Bluetooth speaker across the room (180 ms). Every laptop records its own
 * mic; rows → solveTune; the tune is then applied at a later instant with fresh clock errors and scored where it
 * matters: at the listener's head. `tune()` draws its random numbers in a fixed order so a caller may override
 * parts (emission timing, recorder maps) without changing the rest.
 */
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
import { renderListenerRecording, SIM_SR, type SimReflections, type SimSpeaker } from './acoustics';

export const SR = SIM_SR;
export const REFL: SimReflections = { room: { width: 6, depth: 5 }, wallGain: 0.4, heightM: 0.75, floorGain: 0.7 };
export const STEREO = 0.13;
/** per-device clock error at tune time and again at play time, ms (σ matched to lanMaster.test's device-to-device spread) */
export const CLOCK_SIGMA_MS = 0.11;

export interface Laptop {
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
export const ROOM: Laptop[] = [
  { id: 'L', pos: { x: 0, y: 1.2 }, outMs: 30, inMs: 12, filters: lap(160, 4000, 5) },
  { id: 'A', pos: { x: -2.0, y: -1.6 }, outMs: 45, inMs: 20, filters: lap(140, 2500, -4) },
  { id: 'B', pos: { x: 2.1, y: -1.4 }, outMs: 25, inMs: 8, directGain: 0.5, filters: lap(200, 6000, 3) },
  { id: 'C', pos: { x: 2.3, y: 1.8 }, outMs: 60, inMs: 15, filters: lap(120, 1200, -3) },
  { id: 'bt', pos: { x: -2.4, y: 1.5 }, speaker: { x: -1.0, y: -2.0 }, outMs: 180, inMs: 25, filters: [designBiquad('highshelf', 5000, 0.8, -6, SR)] },
];
/** the listener's head: 0.4 m behind the tuning laptop (front is −y) */
export const HEAD: Vec2 = { x: ROOM[0]!.pos.x, y: ROOM[0]!.pos.y + 0.4 };

export const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
/** what a listener at p hears first from a device: its nearer speaker */
export const nearest = (x: Laptop, p: Vec2) =>
  x.speaker ? d(x.speaker, p) : Math.min(d({ x: x.pos.x - STEREO, y: x.pos.y }, p), d({ x: x.pos.x + STEREO, y: x.pos.y }, p));
/** the user's rough layout: truth ± ~30 cm */
export const rough = (rnd: () => number, room: Laptop[] = ROOM) =>
  Object.fromEntries(room.map((x) => [x.id, { x: (x.speaker ?? x.pos).x + 0.3 * gauss(rnd), y: (x.speaker ?? x.pos).y + 0.3 * gauss(rnd) }]));
/** the same laptop (or its Bluetooth speaker) carried `by` metres */
export const carried = (x: Laptop, by: Vec2): Laptop =>
  x.speaker ? { ...x, speaker: { x: x.speaker.x + by.x, y: x.speaker.y + by.y } } : { ...x, pos: { x: x.pos.x + by.x, y: x.pos.y + by.y } };

export interface TuneOptions {
  seed: number;
  /** align at the head (the app) or, as a control, at the mic itself */
  placeHead?: boolean;
  /** the listener's own speaker reads this many dB off its near-field prior */
  selfGainDbL?: number;
  /** plan start, room ms */
  startRoomTime?: number;
  /** each device's emission timing error (true emission − scheduled, before its output latency), ms; default: a
   * fresh N(0, CLOCK_SIGMA_MS) clock error per device, as the i.i.d. model */
  emitErrorMs?: Record<string, number>;
  /** each recorder's true audio rate vs room time, ppm; default: U(±50) */
  recorderPpm?: Record<string, number>;
  /** each recorder's sample-index → room-ms map; default: the recorder's own rate known to ±20 ppm */
  recorderMap?: Record<string, (idx: number) => number>;
  /** the devices and where they really are; default ROOM */
  room?: Laptop[];
}

export interface TuneRun {
  report: TuneReport;
  rnd: () => number;
  /** what a mic AT THE TRUE HEAD hears from each device (reference levels) */
  headLevels: Record<string, number>;
  plan: CalibrationPlan;
  /** the clock errors drawn (used unless overridden) */
  clock1: Record<string, number>;
  ppm: Record<string, number>;
  /** the recorders' own rate estimates in the default map, 1 + (ppm + error)·1e-6 */
  rate: Record<string, number>;
}

export function tune(o: TuneOptions): TuneRun {
  const room = o.room ?? ROOM;
  const rnd = mulberry32(o.seed);
  const clock1 = Object.fromEntries(room.map((x) => [x.id, CLOCK_SIGMA_MS * gauss(rnd)]));
  const ppmDrawn = Object.fromEntries(room.map((x) => [x.id, 50 * (2 * rnd() - 1)]));
  const ppmErr = Object.fromEntries(room.map((x) => [x.id, 20 * (2 * rnd() - 1)]));
  const ppm = { ...ppmDrawn, ...o.recorderPpm };
  const slots = buildTuneSlots(room.map((x) => x.id));
  const plan: CalibrationPlan = { id: `t${o.seed}`, listenerId: 'L', startRoomTime: o.startRoomTime ?? 2_000_000, slots, recorders: 'all' };
  // a device whose clock reads c ms ahead emits c ms early (ε = out − c) and stamps what it hears c ms late (λ = in + c)
  const emitErr = (id: string) => o.emitErrorMs?.[id] ?? -clock1[id]!;
  const speakers: SimSpeaker[] = room.map((x) => ({
    id: x.id,
    filters: x.filters,
    gain: 0.8,
    latencyMs: x.outMs + emitErr(x.id),
    position: x.pos,
    ...(x.speaker ? { speakerPosition: x.speaker } : { stereoHalfWidthM: STEREO }),
    ...(x.directGain ? { directGain: x.directGain } : {}),
    ...(x.id === 'L' && o.selfGainDbL ? { selfGainDb: o.selfGainDbL } : {}),
  }));
  const rows: RowsByRecorder = {};
  const rate: Record<string, number> = {};
  let listener: ReturnType<typeof analyzeRecording> | null = null;
  for (const r of room) {
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
      seed: o.seed * 31 + r.id.charCodeAt(0),
    });
    rate[r.id] = 1 + (ppm[r.id]! + ppmErr[r.id]!) * 1e-6; // the recorder's own (imperfect) rate estimate
    const toRoomMs = o.recorderMap?.[r.id] ?? ((i: number) => plan.startRoomTime + (i / (SR * rate[r.id]!)) * 1000);
    const a = analyzeRecording({ plan, recording, sampleRate: SR, toRoomMs });
    rows[r.id] = a.rows;
    if (r.id === 'L') listener = a;
  }
  const scene = { devices: rough(rnd, room), listener: { x: 0, y: 2 } };
  const report = solveTune({
    rows,
    listenerId: 'L',
    responses: listener!.responses,
    broadbandSnrDb: listener!.broadbandSnrDb,
    sampleRate: SR,
    scene,
    deviceIds: room.map((x) => x.id),
    placeHead: true,
    detached: room.filter((x) => x.speaker).map((x) => x.id),
  });
  // control: align at the mic itself (no head model)
  if (o.placeHead === false) report.listener = report.positions['L']!;
  // reference levels: what a mic AT THE TRUE HEAD hears from each device (same room, same analysis)
  const atHead = renderListenerRecording({
    plan,
    speakers,
    listener: HEAD,
    sampleRate: SR,
    durationMs: calibrationRecordingMs(slots),
    inputLatencyMs: 10,
    noiseDb: -60,
    roomNoiseDb: -50,
    reflections: REFL,
    seed: o.seed * 31 + 7,
  });
  const headRows = analyzeRecording({ plan, recording: atHead, sampleRate: SR, toRoomMs: (i) => plan.startRoomTime + (i / SR) * 1000 }).rows;
  return { report, rnd, headLevels: Object.fromEntries(headRows.map((r) => [r.emitterId, r.levelDb!])), plan, clock1, ppm, rate };
}

/**
 * Play at a later instant: arrival at the TRUE head of each device's sound, ms. `playErrorMs` = each device's
 * clock error then (+ve: its clock reads ahead, so it plays early); default: fresh N(0, CLOCK_SIGMA_MS) draws.
 */
export function arrivalsAtHead(report: TuneReport, rnd: () => number, playErrorMs?: Record<string, number>): number[] {
  return arrivalsAtHeadWith({
    scene: { devices: report.positions, listener: report.listener },
    cal: Object.fromEntries(report.devices.map((r) => [r.deviceId, r.relativeLatencyMs])),
    playErrorMs: Object.fromEntries(ROOM.map((x) => [x.id, playErrorMs?.[x.id] ?? CLOCK_SIGMA_MS * gauss(rnd)])),
  });
}

/**
 * The same, with everything the app can get wrong spelled out: the scene as the host has edited it (the engine's
 * `propagationDelays` run on it), each device's compensation as the server derived it (null = untuned → 0), the
 * devices where they REALLY are (default ROOM) and each device's clock error at play time.
 */
export function arrivalsAtHeadWith(o: {
  scene: { devices: Record<string, Vec2>; listener: Vec2 };
  cal: Record<string, number | null>;
  playErrorMs: Record<string, number>;
  room?: Laptop[];
}): number[] {
  const room = o.room ?? ROOM;
  const delays = propagationDelays(o.scene as never, room.map((x) => x.id));
  return room.map(
    (x) => x.outMs - o.playErrorMs[x.id]! - (o.cal[x.id] ?? 0) + (delays[x.id] ?? 0) * 1000 + (nearest(x, HEAD) / SPEED_OF_SOUND) * 1000,
  );
}

export const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.95 * xs.length))]!;
export const pairwise = (t: number[]) => t.flatMap((a, i) => t.slice(i + 1).map((b) => Math.abs(a - b)));
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
