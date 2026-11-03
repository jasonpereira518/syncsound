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
  agreeing,
  analyzeRecording,
  analyzeSyncMeasurement,
  buildSyncMeasurementSlots,
  buildTuneSlots,
  calibrationRecordingMs,
  expectedArrivalMs,
  designBiquad,
  medianOf,
  mergeTuneRounds,
  mulberry32,
  nextRoundEmitters,
  propagationDelays,
  solveTune,
  SPEED_OF_SOUND,
  SYNC_SEARCH_LATE_MS,
  SYNC_STAGGER_MS,
  TUNE_CONFIRM_BLUETOOTH,
  tuneProgress,
  VERIFY_CLICKS,
  verifyTune,
  type RowsByRecorder,
  type TuneProgress,
  type TuneReport,
  type TuneRound,
  type TuneVerification,
} from '@syncsound/audio-core';
import { renderListenerRecording, SIM_SR, type SimReflections, type SimSpeaker } from './acoustics';

export const SR = SIM_SR;
/** direct-path gain of a speaker someone stands in front of (−26 dB: its strongest reflection arrives first) */
export const BLOCKED_GAIN = 0.05;
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
  /** devices that don't play audibly this run (muted, volume down) */
  muted?: string[];
  /** devices whose direct path is blocked this run (someone in front of it): a reflection arrives first */
  blocked?: string[];
  /** extra output latency this run, ms (a Bluetooth speaker's jitter) */
  extraOutMs?: Record<string, number>;
  /** skip the reference recording at the true head (`headLevels` is then empty) */
  noHeadLevels?: boolean;
}

export interface TuneRun {
  report: TuneReport;
  rnd: () => number;
  /** what a mic AT THE TRUE HEAD hears from each device (reference levels) */
  headLevels: Record<string, number>;
  plan: CalibrationPlan;
  /** every recorder's rows, the listener's own analysis and the layout the solve started from */
  rows: RowsByRecorder;
  listener: ReturnType<typeof analyzeRecording>;
  scene: { devices: Record<string, Vec2>; listener: Vec2 };
  /** the clock errors drawn (used unless overridden) */
  clock1: Record<string, number>;
  ppm: Record<string, number>;
  /** the recorders' own rate estimates in the default map, 1 + (ppm + error)·1e-6 */
  rate: Record<string, number>;
}

type RunKnobs = Pick<TuneOptions, 'muted' | 'blocked' | 'extraOutMs' | 'selfGainDbL'>;

/** a device's speaker in one run: its output latency plus this run's emission error, and what goes wrong this run */
function simSpeaker(x: Laptop, emitErrMs: number, o: RunKnobs): SimSpeaker {
  return {
    id: x.id,
    filters: x.filters,
    gain: 0.8,
    latencyMs: x.outMs + emitErrMs + (o.extraOutMs?.[x.id] ?? 0),
    position: x.pos,
    ...(x.speaker ? { speakerPosition: x.speaker } : { stereoHalfWidthM: STEREO }),
    ...(o.blocked?.includes(x.id) ? { directGain: BLOCKED_GAIN } : x.directGain ? { directGain: x.directGain } : {}),
    ...(o.muted?.includes(x.id) ? { audible: false } : {}),
    ...(x.id === 'L' && o.selfGainDbL ? { selfGainDb: o.selfGainDbL } : {}),
  };
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
  const speakers: SimSpeaker[] = room.map((x) => simSpeaker(x, emitErr(x.id), o));
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
  if (o.noHeadLevels) return { report, rnd, headLevels: {}, plan, rows, listener: listener!, scene, clock1, ppm, rate };
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
  return {
    report,
    rnd,
    headLevels: Object.fromEntries(headRows.map((r) => [r.emitterId, r.levelDb!])),
    plan,
    rows,
    listener: listener!,
    scene,
    clock1,
    ppm,
    rate,
  };
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

export interface RoundsOptions {
  seed: number;
  /** what goes wrong in round k: who is muted or blocked, extra output latency (drawn from the run's own stream) */
  perRound?: (k: number, rnd: () => number) => Pick<TuneOptions, 'muted' | 'blocked' | 'extraOutMs'>;
  /** σ of the listener's clock offset in each round's frozen map, ms; default CLOCK_SIGMA_MS */
  listenerOffsetSigmaMs?: number;
  room?: Laptop[];
}

export interface RoundsRun {
  /** the tune in rounds: round 0's rows for ranging, the merged listener row for timing */
  report: TuneReport;
  /** round 0 alone (one chime per device: the tune before rounds) */
  single: TuneReport;
  /** control: every device timed by the median of its raw arrivals, without referencing the anchor */
  naive: TuneReport;
  rounds: TuneRound[];
  progress: TuneProgress;
  rnd: () => number;
}

/**
 * A tune in rounds, as the listener's controller runs it: round 0 is `tune()` (every recorder, ranging); while
 * `nextRoundEmitters` names devices, a listener-only round plays them with fresh clock errors (every device's, and
 * the listener's frozen map), analysed like the app does; then `mergeTuneRounds` → `solveTune({ timingRow })`.
 */
export function tuneRounds(o: RoundsOptions): RoundsRun {
  const room = o.room ?? ROOM;
  const ids = room.map((x) => x.id);
  // the rounds' own random stream, so round 0 is exactly tune({ seed })
  const rr = mulberry32(o.seed * 7919 + 1);
  const first = tune({ seed: o.seed, placeHead: true, room, noHeadLevels: true, ...o.perRound?.(0, rr) });
  const detached = room.filter((x) => x.speaker).map((x) => x.id);
  // a Bluetooth output's latency jitters: it confirms on three agreeing readings, as the app does
  const confirm = Object.fromEntries(detached.map((id) => [id, TUNE_CONFIRM_BLUETOOTH]));
  const rounds: TuneRound[] = [
    { round: 0, emitters: ids, rows: first.rows['L']!, valid: true, responses: first.listener.responses, broadbandSnrDb: first.listener.broadbandSnrDb },
  ];
  const L = room.find((x) => x.id === 'L')!;
  let elapsed = calibrationRecordingMs(first.plan.slots);
  for (let k = 1; ; k++) {
    const emitters = nextRoundEmitters(tuneProgress(rounds, { listenerId: 'L', deviceIds: ids, confirm }), k, elapsed);
    if (!emitters) break;
    const knobs = o.perRound?.(k, rr) ?? {};
    const slots = buildTuneSlots(emitters);
    const plan: CalibrationPlan = { id: first.plan.id, listenerId: 'L', startRoomTime: first.plan.startRoomTime + k * 30_000, slots, recorders: 'listener', round: k };
    const clock = Object.fromEntries(room.map((x) => [x.id, CLOCK_SIGMA_MS * gauss(rr)]));
    const listenerOffset = (o.listenerOffsetSigmaMs ?? CLOCK_SIGMA_MS) * gauss(rr);
    const recording = renderListenerRecording({
      plan,
      speakers: room.filter((x) => emitters.includes(x.id)).map((x) => simSpeaker(x, -clock[x.id]!, knobs)),
      listener: L.pos,
      selfId: 'L',
      sampleRate: SR,
      durationMs: calibrationRecordingMs(slots),
      inputLatencyMs: L.inMs + listenerOffset,
      noiseDb: -60,
      roomNoiseDb: -50,
      reflections: REFL,
      ppm: first.ppm['L']!,
      seed: o.seed * 31 + k * 101,
    });
    const rate = first.rate['L']!;
    const a = analyzeRecording({ plan, recording, sampleRate: SR, toRoomMs: (i) => plan.startRoomTime + (i / (SR * rate)) * 1000 });
    rounds.push({ round: k, emitters, rows: a.rows, valid: true, responses: a.responses, broadbandSnrDb: a.broadbandSnrDb });
    elapsed += calibrationRecordingMs(slots);
  }
  const progress = tuneProgress(rounds, { listenerId: 'L', deviceIds: ids, confirm });
  const merged = mergeTuneRounds(rounds, progress);
  const naiveRow = merged.row.map((c) => {
    const raw = rounds.flatMap((r) => r.rows.filter((x) => x.emitterId === c.emitterId && x.mMs !== null).map((x) => x.mMs!));
    const agree = agreeing(raw);
    return { ...c, mMs: raw.length ? medianOf(agree.length >= 2 ? agree : raw) : null };
  });
  const solve = (timingRow: typeof merged.row) =>
    solveTune({
      rows: first.rows,
      timingRow,
      listenerId: 'L',
      responses: merged.responses,
      broadbandSnrDb: merged.broadbandSnrDb,
      sampleRate: SR,
      scene: first.scene,
      deviceIds: ids,
      placeHead: true,
      detached,
    });
  return { report: solve(merged.row), single: first.report, naive: solve(naiveRow), rounds, progress, rnd: first.rnd };
}

export interface RoundsScore {
  run: RoundsRun;
  /** pairwise arrival differences at the true head among the devices each report timed, ms */
  pairs: { rounds: number[]; single: number[]; naive: number[] };
  /** every device was timed */
  allTimed: { rounds: boolean; single: boolean };
  /** every device ended confirmed (in sync) or measured as varying */
  settled: boolean;
}

/** run `tuneRounds` per seed and play every report at the same later instant (same fresh clock errors) */
export function scoreRounds(seeds: number[], o: Omit<RoundsOptions, 'seed'>): RoundsScore[] {
  const ids = (o.room ?? ROOM).map((x) => x.id);
  return seeds.map((seed) => {
    const run = tuneRounds({ seed, ...o });
    const play = Object.fromEntries(ids.map((id) => [id, CLOCK_SIGMA_MS * gauss(run.rnd)]));
    const timed = (r: TuneReport) => r.devices.filter((d) => d.heard).map((d) => d.deviceId);
    const pairsOf = (r: TuneReport) => {
      const at = arrivalsAtHead(r, run.rnd, play);
      const h = timed(r);
      return pairwise(at.filter((_, i) => h.includes(ids[i]!)));
    };
    return {
      run,
      pairs: { rounds: pairsOf(run.report), single: pairsOf(run.single), naive: pairsOf(run.naive) },
      allTimed: { rounds: timed(run.report).length === ids.length, single: timed(run.single).length === ids.length },
      settled: run.progress.devices.every((d) => d.state === 'in-sync' || d.state === 'varies'),
    };
  });
}

export interface VerifyRun {
  verification: TuneVerification;
  /** pairwise arrival differences at the true head before and after applying the corrections, ms */
  before: number[];
  after: number[];
}

/**
 * The check after a tune, simulated: at a later instant every device clicks through its full compensation (the
 * report's timing, the engine's propagation delays, a fresh clock error) plus `stepMs` its output gained since the
 * tune (a step the tune couldn't see); the listener's mic records, `analyzeSyncMeasurement` → `verifyTune`. Both
 * the room as tuned and the room with the corrections applied are then scored at the true head.
 */
export function verifyRoom(report: TuneReport, rnd: () => number, o: { seed: number; stepMs?: Record<string, number>; room?: Laptop[] }): VerifyRun {
  const room = (o.room ?? ROOM).map((x) => (o.stepMs?.[x.id] ? { ...x, outMs: x.outMs + o.stepMs[x.id]! } : x));
  const ids = room.map((x) => x.id);
  const heard = report.devices.filter((d) => d.heard);
  const cal = Object.fromEntries(report.devices.map((d) => [d.deviceId, d.relativeLatencyMs]));
  const scene = { devices: report.positions, listener: report.listener };
  const delays = propagationDelays(scene as never, ids);
  const play = Object.fromEntries(ids.map((id) => [id, CLOCK_SIGMA_MS * gauss(rnd)]));
  const durationSec = (VERIFY_CLICKS * Math.max(1000, ids.length * SYNC_STAGGER_MS)) / 1000;
  const slots = buildSyncMeasurementSlots(ids, { durationSec });
  const plan: CalibrationPlan = { id: `v${o.seed}`, listenerId: 'L', startRoomTime: 9_000_000, slots, purpose: 'measure' };
  const L = room.find((x) => x.id === 'L')!;
  const recording = renderListenerRecording({
    plan,
    // full compensation: the device starts cal earlier and waits its propagation delay
    speakers: room.map((x) => simSpeaker(x, -play[x.id]! - (cal[x.id] ?? 0) + (delays[x.id] ?? 0) * 1000, {})),
    listener: L.pos,
    selfId: 'L',
    sampleRate: SR,
    durationMs: calibrationRecordingMs(slots, SYNC_SEARCH_LATE_MS),
    inputLatencyMs: L.inMs,
    noiseDb: -60,
    roomNoiseDb: -50,
    reflections: REFL,
    clickJitterMs: () => 0.05 * gauss(rnd),
    seed: o.seed * 53 + 3,
  });
  const sync = analyzeSyncMeasurement({
    plan,
    recording,
    sampleRate: SR,
    toRoomMs: (i) => plan.startRoomTime + (i / SR) * 1000,
    expectedMs: expectedArrivalMs({ ...scene, propagationComp: true }, report.positions['L'] ?? report.listener, 'L', ids),
  });
  const arrivals = Object.fromEntries(heard.map((d) => [d.deviceId, d.arrivalMs!]));
  const verification = verifyTune(sync.devices, arrivals);
  const score = (c: Record<string, number | null>) => pairwise(arrivalsAtHeadWith({ scene, cal: c, playErrorMs: play, room }).filter((_, i) => heard.some((h) => h.deviceId === ids[i])));
  const fixed = verification.corrected
    ? Object.fromEntries(Object.entries(cal).map(([id, c]) => [id, c === null ? null : c + (verification.corrected![id]! - arrivals[id]!)]))
    : cal;
  return { verification, before: score(cal), after: score(fixed) };
}
