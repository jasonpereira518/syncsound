import type { CalibrationPlan, CalibrationRow, Scene, Vec2 } from '@syncsound/protocol';
import { commonTarget, fitEq, type EqFitResult } from './eq';
import { loudnessTrims, medianOf, volumeHints } from './loudness';
import {
  crossCorrelate,
  deconvolve,
  estimateRolloffHz,
  firstArrival,
  logFreqs,
  loudnessDb,
  magnitudeResponse,
  rmsDb,
  smoothFractionalOctave,
  type Response,
} from './measure';
import { CALIBRATION_SIGNAL_MS, calibrationArrivalRef, calibrationInverse, calibrationSignal } from './signals';
import { polar, procrustes2d, smacof2d, SPEED_OF_SOUND } from './spatial';

/** Silence before the first slot (noise-floor reference + clock-error slack), ms. */
export const CALIBRATION_LEAD_MS = 500;
/**
 * Arrival search window around a slot's scheduled start: unreported output latency (Bluetooth: 100–300 ms, some
 * speakers more) + mic input latency + clock-map error. Every device plays the SAME signal, so a window must never
 * reach the next slot's earliest possible arrival: TUNE_PERIOD_MS > EARLY + LATE (+ margin for the next swoosh's
 * harmonic-distortion images, ≤ 124 ms before it).
 */
export const SEARCH_EARLY_MS = 400;
export const SEARCH_LATE_MS = 1000;
/**
 * One device's slot in a tune run, ms. The response segment of a late device may reach into the next slot's start:
 * that is the same signal, so it deconvolves into an impulse a whole slot (minus the latency difference) later, far
 * past the IR window. Kept short: the recorders' ±20 ppm rate error accumulates between slots and costs ranging.
 */
export const TUNE_PERIOD_MS = SEARCH_EARLY_MS + SEARCH_LATE_MS + 150;
/** IR window used for response measurement, samples at 48 kHz (scaled with sample rate). */
const IR_SEC = 16384 / 48000;
/** A device whose measured rolloff is at or below this is treated as bass-capable. */
export const BASS_CAPABLE_ROLLOFF_HZ = 80;
/**
 * "Heard" gate on the arrival's envelope peak/median, dB. The sweep's matched filter has ~45 dB of processing gain;
 * noise alone tops out near 12 dB over a 1.4 s window, so 20 dB rejects noise but keeps a device far below it.
 */
const MIN_SNR_DB = 20;
/**
 * …and the normalized correlation at the arrival (|y| / √(E_ref·E_segment)) must reach this: an absolute gate, so a
 * near-silent window (digital silence: the envelope median is FFT round-off) can't pass on peak/median alone.
 */
const MIN_PEAK = 0.1;
/** Broadband signal-to-noise (sweep RMS vs the lead-in silence) below this calls the room noisy, dB. */
export const NOISY_ROOM_SNR_DB = 15;
/** a sample at or above this is treated as clipped */
const CLIP = 0.98;
/**
 * Speaker-to-own-mic offset of a laptop/phone (both built in), m.
 * ponytail: one prior for every class; a per-model table if hardware tests show it matters.
 */
export const SELF_OFFSET_M = 0.1;
/**
 * BeepBeep only holds when a device's speaker sits at its own mic. Gain-free test per pair i,j on DIRECT-path levels
 * (reverb would inflate the far ones): (D_ii − D_ji) + (D_jj − D_ij) = 20·log10(d²/(s_i·s_j)) when both are
 * co-located; a speaker away from its own mic falls short by roughly 20·log10(its distance to that mic / s).
 * Allowed shortfall (speaker/mic directivity, desk bounce), dB.
 */
const COLOCATED_TOLERANCE_DB = 10;
/** A listener-row arrival outside [−100 ms, +500 ms] of its slot still counts, but is flagged (likely a mismatch). */
const NOMINAL_MS = { early: -100, late: 500 } as const;
/** Default distance from the tuning laptop's mic to the listener's head (head sits behind the laptop), m. */
export const HEAD_OFFSET_M = 0.4;

/** Tune plan slots: one swoosh → chime per device, each in its own TUNE_PERIOD_MS slot. */
export function buildTuneSlots(deviceIds: string[]): CalibrationPlan['slots'] {
  return deviceIds.map((deviceId, i) => ({
    deviceId,
    deviceIndex: i % 64,
    signal: 'tune' as const,
    offsetMs: CALIBRATION_LEAD_MS + i * TUNE_PERIOD_MS,
    durationMs: CALIBRATION_SIGNAL_MS.tune,
  }));
}

/** How long a recorder must record from plan.startRoomTime to capture every slot, ms. */
export function calibrationRecordingMs(slots: CalibrationPlan['slots'], lateMs = SEARCH_LATE_MS): number {
  return (
    Math.max(0, ...slots.map((s) => s.offsetMs + ((s.repeat ?? 1) - 1) * (s.periodMs ?? 0) + s.durationMs)) +
    lateMs +
    200
  );
}

export interface RecordingInput {
  plan: CalibrationPlan;
  /** mono microphone recording */
  recording: Float32Array;
  sampleRate: number;
  /**
   * room ms of recording[idx], as this recorder's clocks say (linear over a run). Map through the audio clock
   * (`ctxToRoom(startCtx + idx/sr)`), not the nominal rate: 50 ppm is 0.3 ms over a 6 s run. The recorder's own
   * input latency and mapping error are common to everything it hears, and cancel.
   */
  toRoomMs: (idx: number) => number;
}

/** linear inverse of toRoomMs (room ms → recording index) */
export function indexMap(toRoomMs: (idx: number) => number, length: number): (roomMs: number) => number {
  const n = Math.max(1, length);
  const t0 = toRoomMs(0);
  const perIdx = (toRoomMs(n) - t0) / n;
  return (roomMs) => (roomMs - t0) / perIdx;
}

export interface RecordingAnalysis {
  /** one row per slot of the plan */
  rows: CalibrationRow[];
  /** 1/6-octave smoothed response per heard emitter (absolute dB: includes distance + mic gain) */
  responses: Record<string, Response>;
  /** whole-recording level, dBFS: ≈ −200 means the microphone delivered digital silence */
  recordingPeakDb: number;
  recordingRmsDb: number;
  /** per heard emitter: sweep RMS over the lead-in silence before the first slot, dB (levels/EQ degrade when low) */
  broadbandSnrDb: Record<string, number>;
}

/**
 * Response grid: 1/24 octave, 20 Hz–16 kHz — the sweep's band below 16 kHz (EQ stops there; the top octave only
 * sharpens timing). Starting at 20 Hz keeps the EQ rails (no boost below rolloff) checked wherever a band can reach.
 */
export const CALIBRATION_FREQS = logFreqs(20, 16000, 24);

/**
 * One recorder's analysis of a tune run: per slot, the matched filter's direct-path arrival (`firstArrival`) → mMs,
 * then the impulse response around it → response and level. Pure; runs on every recorder.
 */
export function analyzeRecording(input: RecordingInput): RecordingAnalysis {
  const { plan, recording: rec, sampleRate: sr } = input;
  const toIdx = indexMap(input.toRoomMs, rec.length);
  const ms = (x: number) => Math.round((x / 1000) * sr);
  const irLength = Math.round(IR_SEC * sr);
  const rows: CalibrationRow[] = [];
  const responses: Record<string, Response> = {};
  const broadbandSnrDb: Record<string, number> = {};
  const lead = Math.round(toIdx(plan.startRoomTime));
  const floorDb = rmsDb(rec, lead + ms(50), lead + ms(CALIBRATION_LEAD_MS - 100));
  for (const slot of plan.slots) {
    const row: CalibrationRow = { emitterId: slot.deviceId, mMs: null, levelDb: null, directDb: null, snrDb: null, clipped: false };
    rows.push(row);
    const full = calibrationSignal(slot.signal, slot.deviceIndex, sr);
    const ref = calibrationArrivalRef(slot.signal, slot.deviceIndex, sr);
    const schedRoom = plan.startRoomTime + slot.offsetMs;
    const sched = Math.round(toIdx(schedRoom));
    const w0 = Math.max(0, sched - ms(SEARCH_EARLY_MS));
    const w1 = Math.min(rec.length - ref.length, sched + ms(SEARCH_LATE_MS));
    if (w1 <= w0) continue;
    const y = crossCorrelate(rec.subarray(w0, w1 + ref.length), ref);
    const fa = firstArrival(y, sr, { start: 0, end: w1 - w0 + 1 });
    if (!fa) continue;
    row.snrDb = fa.snrDb;
    if (fa.snrDb < MIN_SNR_DB || normalizedPeak(rec, y, w0, fa.index, ref) < MIN_PEAK) continue;
    const at = w0 + fa.index;
    row.mMs = input.toRoomMs(at) - schedRoom;
    row.directDb = fa.directDb;
    for (let i = Math.floor(at); i < Math.min(rec.length, at + full.length); i++)
      if (Math.abs(rec[i]!) >= CLIP) {
        row.clipped = true;
        break;
      }
    broadbandSnrDb[slot.deviceId] = rmsDb(rec, at, at + ref.length) - floorDb;
    if (slot.signal !== 'sweep' && slot.signal !== 'tune') continue;
    const inverse = calibrationInverse(slot.signal, sr);
    const s0 = Math.max(0, Math.floor(at) - ms(50));
    const s1 = Math.min(rec.length, Math.floor(at) + full.length + irLength + ms(50));
    if (s1 - s0 <= full.length) continue;
    const ir = deconvolve(rec.subarray(s0, s1), inverse, irLength);
    const r = smoothFractionalOctave(magnitudeResponse(ir, sr, CALIBRATION_FREQS), 6);
    responses[slot.deviceId] = r;
    row.levelDb = loudnessDb(r);
  }
  let peak = 0;
  for (const v of rec) peak = Math.max(peak, Math.abs(v));
  return { rows, responses, recordingPeakDb: 20 * Math.log10(peak + 1e-10), recordingRmsDb: rmsDb(rec), broadbandSnrDb };
}

/**
 * Normalized correlation of `ref` against rec[w0 + k …] at matched-filter index k (sub-sample): the sharp wideband
 * peak's max |y| within ±3 samples over √(E_ref·E_segment). 1 = a clean copy; reflections, filtering and noise lower it.
 */
export function normalizedPeak(rec: Float32Array, y: Float64Array, w0: number, k: number, ref: Float32Array): number {
  const k0 = Math.round(k);
  let pk = 0;
  for (let i = Math.max(0, k0 - 3); i <= Math.min(y.length - 1, k0 + 3); i++) pk = Math.max(pk, Math.abs(y[i]!));
  let refE = 0;
  for (const v of ref) refE += v * v;
  let segE = 0;
  for (let i = w0 + k0; i < Math.min(rec.length, w0 + k0 + ref.length); i++) segE += rec[i]! * rec[i]!;
  return pk / Math.sqrt(refE * segE + 1e-30);
}

/** rows by recorder id */
export type RowsByRecorder = Record<string, CalibrationRow[]>;
/** recorder's heard row for emitter, or null */
const cell = (rows: RowsByRecorder, recorder: string, emitter: string) =>
  rows[recorder]?.find((r) => r.emitterId === emitter && r.mMs !== null) ?? null;

/**
 * Pairwise distances by two-way ranging (BeepBeep, Peng et al. 2007). M(r,e) = ε_e + λ_r + d(e,r)/c, so
 * d_ij = c/2·(M(i,j) + M(j,i) − M(i,i) − M(j,j)) + (s_i + s_j)/2: every clock offset, output latency and input
 * latency cancels. Only pairs that heard each other and themselves and pass the co-location test; `detached`
 * (known external output, e.g. Bluetooth) never takes part.
 */
export function beepBeep(
  rows: RowsByRecorder,
  detached: string[] = [],
  selfOffsetM = SELF_OFFSET_M,
): Record<string, Record<string, number>> {
  const ids = Object.keys(rows).filter((id) => !detached.includes(id));
  const d: Record<string, Record<string, number>> = {};
  for (let a = 0; a < ids.length; a++)
    for (let b = a + 1; b < ids.length; b++) {
      const i = ids[a]!;
      const j = ids[b]!;
      const ii = cell(rows, i, i);
      const jj = cell(rows, j, j);
      const ij = cell(rows, i, j); // recorder i hears emitter j
      const ji = cell(rows, j, i);
      if (!ii || !jj || !ij || !ji) continue;
      const dist = (SPEED_OF_SOUND / 2) * ((ij.mMs! + ji.mMs! - ii.mMs! - jj.mMs!) / 1000) + selfOffsetM;
      if (!(dist > 0 && dist < 100)) continue;
      if ([ii, jj, ij, ji].some((c) => c.directDb === null)) continue;
      const sum = ii.directDb! - ji.directDb! + (jj.directDb! - ij.directDb!);
      if (sum < 20 * Math.log10((dist * dist) / (selfOffsetM * selfOffsetM)) - COLOCATED_TOLERANCE_DB) continue;
      (d[i] ??= {})[j] = dist;
      (d[j] ??= {})[i] = dist;
    }
  return d;
}

export interface TuneInput {
  /** every valid recorder's rows (the listener's must be present) */
  rows: RowsByRecorder;
  /** the tuning device: its mic is the timing reference */
  listenerId: string;
  /** the listener's responses (EQ) and broadband SNRs (noisy-room warning), from its `analyzeRecording` */
  responses: Record<string, Response>;
  broadbandSnrDb?: Record<string, number>;
  sampleRate: number;
  scene: Pick<Scene, 'devices' | 'listener'>;
  /** emitters in the plan */
  deviceIds: string[];
  /** re-place the listener's head behind the tuning device (full tune); false keeps scene.listener (quick tune) */
  placeHead?: boolean;
  /** devices known to play through an external output (Bluetooth): never ranged */
  detached?: string[];
  headOffsetM?: number;
}

export interface TuneDevice {
  deviceId: string;
  /** the listener heard it */
  heard: boolean;
  /** arrival at the listener mic − propagation − min over heard devices, ms → calibratedLatencyMs */
  relativeLatencyMs: number | null;
  snrDb: number | null;
  /** level at the listener's head (mic level corrected by 1/r from mic to head), dB */
  levelDb: number | null;
  /** distance to the listener mic used for timing, m (null = no position) */
  distanceM: number | null;
  /** position measured by ranging this run (false = the user's placement) */
  ranged: boolean;
  clipped: boolean;
  response: Response | null;
  rolloffHz: number | null;
  bassCapable: boolean | null;
}

export interface TuneReport {
  devices: TuneDevice[];
  /** positions after ranging (measured + unchanged manual ones) */
  positions: Record<string, Vec2>;
  /** listener head position after this run */
  listener: Vec2;
  /** measured pairwise distances, m */
  distancesM: Record<string, Record<string, number>>;
  /** layout fit (normalized stress), null with < 3 ranged devices */
  stress: number | null;
  targetDb: number[] | null;
  eq: Record<string, EqFitResult>;
  trims: Record<string, number>;
  /** dB to raise on the device itself (only devices the +6 dB boost leaves short of the median; see volumeHints) */
  volumeUp: Record<string, number>;
  warnings: string[];
}

/** biggest set of ids connected by measured distances (ties: the one containing `prefer`) */
function largestComponent(d: Record<string, Record<string, number>>, prefer: string): string[] {
  const seen = new Set<string>();
  let best: string[] = [];
  for (const start of Object.keys(d)) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const j of Object.keys(d[id] ?? {}))
        if (!seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
    }
    if (comp.length > best.length || (comp.length === best.length && comp.includes(prefer))) best = comp;
  }
  return best;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Solve a tune: distances (BeepBeep) → positions (stress majorization, rigidly fitted onto the user's layout) →
 * timing from the LISTENER ROW: cal_i = M(L,i) − |p_i − mic|/c − min. propagationDelays() adds those same
 * distances back (to the head), so every device arrives at the mic together whatever the distance error; only the
 * short mic→head step depends on geometry. Levels and EQ also come from the listener's recording.
 */
export function solveTune(input: TuneInput): TuneReport {
  const { rows, listenerId: L } = input;
  const warnings: string[] = [];

  const distancesM = beepBeep(rows, input.detached);
  const positions: Record<string, Vec2> = { ...input.scene.devices };
  const ranged = largestComponent(distancesM, L);
  let stress: number | null = null;
  if (ranged.length >= 2) {
    const init: Record<string, Vec2> = {};
    ranged.forEach((id, k) => {
      const a = (2 * Math.PI * k) / ranged.length;
      init[id] = positions[id] ?? polar(input.scene.listener, (a * 180) / Math.PI, 1.5);
    });
    const fit = smacof2d(init, Object.fromEntries(ranged.map((id) => [id, distancesM[id]!])));
    const manual = Object.fromEntries(ranged.flatMap((id) => (input.scene.devices[id] ? [[id, input.scene.devices[id]!]] : [])));
    Object.assign(positions, procrustes2d(fit.positions, Object.keys(manual).length ? manual : init));
    if (ranged.length >= 3) {
      stress = fit.stress;
      if (stress > 0.1) warnings.push("The measured distances don't fit a flat layout well — re-run with the room quiet.");
    }
  }
  const unranged = input.deviceIds.filter((id) => id !== L && !ranged.includes(id) && cell(rows, L, id));
  if (Object.keys(rows).length > 1 && unranged.length)
    warnings.push(`Placed by hand (not measured): ${unranged.join(', ')} — drag them to where they really are.`);

  const mic = positions[L] ?? input.scene.listener;
  const head = input.placeHead && positions[L] ? polar(mic, 180, input.headOffsetM ?? HEAD_OFFSET_M) : input.scene.listener;

  const devices: TuneDevice[] = input.deviceIds.map((id) => {
    const c = cell(rows, L, id);
    const raw = rows[L]?.find((r) => r.emitterId === id);
    const p = positions[id];
    const dMic = id === L ? SELF_OFFSET_M : p ? dist(p, mic) : null;
    const dHead = p ? Math.max(0.1, dist(p, head)) : null;
    const response = c ? (input.responses[id] ?? null) : null;
    const rolloffHz = response ? estimateRolloffHz(response) : null;
    return {
      deviceId: id,
      heard: !!c,
      relativeLatencyMs: c ? c.mMs! - ((dMic ?? 0) / SPEED_OF_SOUND) * 1000 : null,
      snrDb: raw?.snrDb ?? null,
      levelDb:
        c && c.levelDb !== null ? c.levelDb + (dMic !== null && dHead !== null ? 20 * Math.log10(dMic / dHead) : 0) : null,
      distanceM: dMic,
      ranged: ranged.includes(id),
      clipped: raw?.clipped ?? false,
      response,
      rolloffHz,
      bassCapable: rolloffHz === null ? null : rolloffHz <= BASS_CAPABLE_ROLLOFF_HZ,
    };
  });

  const heard = devices.filter((d) => d.heard);
  const min = Math.min(...heard.map((d) => d.relativeLatencyMs!));
  for (const d of heard) d.relativeLatencyMs = d.relativeLatencyMs! - min;
  for (const d of devices) {
    if (!d.heard) warnings.push(`Couldn't hear ${d.deviceId} — is its volume up?`);
    else if (d.clipped) warnings.push(`${d.deviceId} was too loud for the microphone — turn it down a little and re-run.`);
    if (d.heard && d.distanceM === null) warnings.push(`${d.deviceId} has no position, so its distance wasn't subtracted.`);
    const m = cell(rows, L, d.deviceId)?.mMs;
    if (m != null && (m < NOMINAL_MS.early || m > NOMINAL_MS.late))
      warnings.push(`${d.deviceId} arrived ${Math.round(m)} ms from its slot — unusual timing, results may be off.`);
  }

  const noisy = heard.flatMap((d) => {
    const snr = input.broadbandSnrDb?.[d.deviceId];
    return snr !== undefined && snr < NOISY_ROOM_SNR_DB ? [`${d.deviceId} ${snr.toFixed(0)} dB`] : [];
  });
  if (noisy.length)
    warnings.push(`The room is noisy (signal-to-noise: ${noisy.join(', ')}) — results may be less accurate; try a quieter moment.`);

  const measured = heard.filter((d) => d.response);
  const targetDb = measured.length ? commonTarget(measured.map((d) => d.response!)) : null;
  const eq: Record<string, EqFitResult> = {};
  const postLevels: Record<string, number> = {};
  for (const d of measured) {
    const fit = fitEq(d.response!, targetDb!, { sampleRate: input.sampleRate, rolloffHz: d.rolloffHz });
    eq[d.deviceId] = fit;
    if (d.levelDb !== null) {
      // trims act on the post-EQ loudness (EQ + preamp change each device's level differently)
      const eqShift = loudnessDb({ freqs: d.response!.freqs, db: fit.predictedDb }) - loudnessDb(d.response!);
      postLevels[d.deviceId] = d.levelDb + eqShift;
    }
  }
  for (const d of heard)
    if (d.levelDb !== null && postLevels[d.deviceId] === undefined) postLevels[d.deviceId] = d.levelDb;
  // The listener's own level is the least certain one (near field: its speaker→mic path is a prior, not measured), so
  // with two or more others the target is THEIR median: a misread listener can never move everyone else's trim.
  const others = Object.entries(postLevels).filter(([id]) => id !== L);
  const refDb = others.length >= 2 ? medianOf(others.map(([, l]) => l)) : undefined;
  return {
    devices,
    positions,
    listener: head,
    distancesM,
    stress,
    targetDb,
    eq,
    trims: loudnessTrims(postLevels, { refDb }),
    volumeUp: volumeHints(postLevels, { refDb }),
    warnings,
  };
}
