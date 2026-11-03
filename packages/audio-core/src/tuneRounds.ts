/**
 * A tune in rounds (docs/CALIBRATION.md, "Rounds"): round 0 plays every device; each later round plays the anchor
 * and the devices that aren't settled yet, until every device is confirmed (two measurements agree), varies (heard
 * several times without agreeing: a Bluetooth speaker's jitter) or is given up on. Pure: the listener's controller
 * and the simulator run the same rules.
 *
 * Every round is timed on its own frozen clock map, so the listener's offset differs from round to round. Within a
 * round it is common to every slot, so each device is measured against the anchor (the listener's own speaker when
 * it hears it): rel_e(k) = M(L,e,k) − M(L,a,k), put back in the first usable round's terms. Values from different
 * rounds then line up, and the merged row drops straight into `solveTune` as the row it times by.
 */
import { TUNE_MAX_ROUNDS, type CalibrationRow, type TuneDeviceState, type TuneHint } from '@syncsound/protocol';
import { buildTuneSlots, calibrationRecordingMs } from './calibration';
import { medianOf } from './loudness';
import type { Response } from './measure';

/**
 * Two measurements of one device this close are the same arrival, ms. Honest repeats differ by the devices' clock
 * errors (σ ≈ 0.11 ms each at tune time, ≈ 0.22 ms between two rounds: sim p95 0.35 ms, max 0.46 ms), while a
 * blocked direct path, a reflection taken for the direct sound, reads 0.6–1.2 ms off (sim: tuneRounds.test.ts).
 */
export const TUNE_AGREE_MS = 0.5;
/** agreeing readings that confirm a device (a known Bluetooth output: TUNE_CONFIRM_BLUETOOTH, as its latency jitters) */
export const TUNE_CONFIRM = 2;
export const TUNE_CONFIRM_BLUETOOTH = 3;
/** a device missed this many rounds in a row is given up on */
export const TUNE_GIVE_UP_ROUNDS = 3;
/** no further round starts once the run's chimes would add up to more than this, ms */
export const TUNE_MAX_RUN_MS = 90_000;
/** states that need no more rounds */
const SETTLED: ReadonlySet<TuneDeviceState> = new Set(['in-sync', 'varies', 'skipped']);

export interface TuneRound {
  round: number;
  /** the devices this round's plan played */
  emitters: string[];
  /** the listener's rows for this round (one per slot) */
  rows: CalibrationRow[];
  /** the listener's clocks stayed put through the round (runValidity); false: nothing in it counts */
  valid: boolean;
  /** devices whose own clock moved while they played this round, id → reason: their rows don't count */
  faults?: Record<string, string>;
  /** the listener's analysis of this round: responses and broadband SNRs per heard device */
  responses?: Record<string, Response>;
  broadbandSnrDb?: Record<string, number>;
}

export interface TuneDeviceProgress {
  deviceId: string;
  state: TuneDeviceState;
  hint: TuneHint | null;
  /** its arrival per usable round it was heard in (anchor-referenced, first usable round's terms), ms */
  measurementsMs: number[];
  /** the arrival to use: median of the agreeing measurements (of all of them when none agree), ms; null = never heard */
  valueMs: number | null;
  /** standard deviation of its measurements, ms (null with fewer than 2) */
  spreadMs: number | null;
  /** the round whose listener cell gives its level and response: unclipped first, then the best SNR */
  bestRound: number | null;
  /** rounds in a row it played without being heard (or with its clock moving) */
  missed: number;
}

export interface TuneProgress {
  devices: TuneDeviceProgress[];
  /** what every round is measured against; null until a round heard something */
  anchorId: string | null;
  /** the rounds that counted */
  usable: number[];
  /** rounds in a row, at the end, that didn't count (the listener's clocks moved, or the anchor wasn't heard) */
  discardedInARow: number;
}

const heardCell = (rows: CalibrationRow[], id: string) => rows.find((r) => r.emitterId === id && r.mMs !== null) ?? null;

/** the largest set of measurements within `tolMs` of each other (ties: the tighter one) */
export function agreeing(values: number[], tolMs = TUNE_AGREE_MS): number[] {
  const s = [...values].sort((a, b) => a - b);
  let best: number[] = [];
  for (let i = 0, j = 0; i < s.length; i++) {
    while (s[i]! - s[j]! > tolMs) j++;
    const win = s.slice(j, i + 1);
    if (win.length > best.length || (win.length === best.length && win.at(-1)! - win[0]! < best.at(-1)! - best[0]!)) best = win;
  }
  return best;
}

function std(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Where every device stands after `rounds` (in order). `connected`: devices still in the room (one that left is
 * skipped unless already settled). `confirm`: agreeing readings a device needs (default TUNE_CONFIRM); one more
 * reading than that without them agreeing, and it varies.
 */
export function tuneProgress(
  rounds: TuneRound[],
  opts: { listenerId: string; deviceIds: string[]; connected?: string[]; confirm?: Record<string, number> },
): TuneProgress {
  // the anchor: the first round that heard anything picks the listener's own speaker if it heard it, else the
  // device it heard best
  let anchorId: string | null = null;
  const usable: number[] = [];
  /** per round: 'usable' | 'silent' (valid, nothing heard: a miss for everyone in it) | 'discarded' */
  const kind = new Map<number, 'usable' | 'silent' | 'discarded'>();
  let base = 0;
  for (const r of rounds) {
    if (!r.valid) {
      kind.set(r.round, 'discarded');
      continue;
    }
    const heard = r.rows.filter((c) => c.mMs !== null && !r.faults?.[c.emitterId]);
    if (anchorId === null) {
      if (!heard.length) {
        kind.set(r.round, 'silent');
        continue;
      }
      const own = heard.find((c) => c.emitterId === opts.listenerId);
      anchorId = (own ?? [...heard].sort((a, b) => (b.snrDb ?? -Infinity) - (a.snrDb ?? -Infinity))[0]!).emitterId;
      base = heardCell(r.rows, anchorId)!.mMs!;
    }
    const a = heardCell(r.rows, anchorId);
    kind.set(r.round, a && !r.faults?.[anchorId] ? 'usable' : 'discarded');
    if (kind.get(r.round) === 'usable') usable.push(r.round);
  }
  let discardedInARow = 0;
  for (let k = rounds.length - 1; k >= 0 && kind.get(rounds[k]!.round) === 'discarded'; k--) discardedInARow++;

  const devices = opts.deviceIds.map((id): TuneDeviceProgress => {
    const measurementsMs: number[] = [];
    let missed = 0;
    let missHint: TuneHint = 'volume';
    let lastMissed = false;
    let lastClipped = false;
    let allClipped = true;
    let bestRound: number | null = null;
    let best: { clipped: boolean; snr: number } | null = null;
    for (const r of rounds) {
      const k = kind.get(r.round);
      if (!r.emitters.includes(id) || k === 'discarded') continue;
      const c = heardCell(r.rows, id);
      if (k === 'silent' || r.faults?.[id] || !c) {
        missed++;
        missHint = r.faults?.[id] ? 'clock' : 'volume';
        lastMissed = true;
        continue;
      }
      missed = 0;
      lastMissed = false;
      lastClipped = c.clipped;
      allClipped &&= c.clipped;
      measurementsMs.push(base + c.mMs! - heardCell(r.rows, anchorId!)!.mMs!);
      const snr = c.snrDb ?? -Infinity;
      if (!best || (best.clipped && !c.clipped) || (best.clipped === c.clipped && snr > best.snr)) {
        best = { clipped: c.clipped, snr };
        bestRound = r.round;
      }
    }
    const need = opts.confirm?.[id] ?? TUNE_CONFIRM;
    const agree = agreeing(measurementsMs);
    const valueMs = measurementsMs.length ? medianOf(agree.length >= 2 ? agree : measurementsMs) : null;
    const left = opts.connected !== undefined && !opts.connected.includes(id);
    const p = { deviceId: id, measurementsMs, valueMs, spreadMs: std(measurementsMs), bestRound, missed };
    if (agree.length >= need) return { ...p, state: 'in-sync', hint: allClipped ? 'loud' : null };
    if (measurementsMs.length > need) return { ...p, state: 'varies', hint: null };
    if (left) return { ...p, state: 'skipped', hint: 'left' };
    if (missed >= TUNE_GIVE_UP_ROUNDS) return { ...p, state: 'skipped', hint: missHint };
    if (lastMissed) return { ...p, state: 'not-heard', hint: missHint };
    if (measurementsMs.length) return lastClipped ? { ...p, state: 'too-loud', hint: 'loud' } : { ...p, state: 'checking', hint: null };
    return { ...p, state: 'waiting', hint: null };
  });
  return { devices, anchorId, usable, discardedInARow };
}

/**
 * Who plays next round (the anchor first, then every device not yet settled), or null: everything settled, no rounds
 * left, or the round would take the run's chimes past `TUNE_MAX_RUN_MS` (`elapsedMs`: chimes so far).
 */
export function nextRoundEmitters(progress: TuneProgress, nextRound: number, elapsedMs: number): string[] | null {
  if (nextRound >= TUNE_MAX_ROUNDS) return null;
  const open = progress.devices.filter((d) => !SETTLED.has(d.state)).map((d) => d.deviceId);
  if (!open.length) return null;
  const a = progress.anchorId;
  const ids = a ? [a, ...open.filter((id) => id !== a)] : open;
  if (elapsedMs + tuneRoundMs(ids.length) > TUNE_MAX_RUN_MS) return null;
  return ids;
}

/** how long a round of `n` devices plays, ms */
export function tuneRoundMs(n: number): number {
  return calibrationRecordingMs(buildTuneSlots(Array.from({ length: n }, (_, i) => `d${i}`)));
}

/**
 * The listener's row for `solveTune({ timingRow })`: each device's arrival from `progress` (any device heard at least
 * once; null otherwise), its level / direct level / SNR / clipping from its best round, and the matching responses
 * and broadband SNRs for EQ and the noisy-room check.
 */
export function mergeTuneRounds(
  rounds: TuneRound[],
  progress: TuneProgress,
): { row: CalibrationRow[]; responses: Record<string, Response>; broadbandSnrDb: Record<string, number> } {
  const row: CalibrationRow[] = [];
  const responses: Record<string, Response> = {};
  const broadbandSnrDb: Record<string, number> = {};
  for (const d of progress.devices) {
    const id = d.deviceId;
    const best = d.bestRound === null ? undefined : rounds.find((r) => r.round === d.bestRound);
    // a device never heard keeps its latest row (its SNR says how close it came)
    const last = [...rounds].reverse().find((r) => r.emitters.includes(id));
    const c = (best ?? last)?.rows.find((r) => r.emitterId === id);
    row.push({
      emitterId: id,
      mMs: d.valueMs,
      levelDb: best ? (c?.levelDb ?? null) : null,
      directDb: best ? (c?.directDb ?? null) : null,
      snrDb: c?.snrDb ?? null,
      clipped: best ? (c?.clipped ?? false) : false,
    });
    const resp = best?.responses?.[id];
    if (resp) responses[id] = resp;
    const snr = best?.broadbandSnrDb?.[id];
    if (snr !== undefined) broadbandSnrDb[id] = snr;
  }
  return { row, responses, broadbandSnrDb };
}
