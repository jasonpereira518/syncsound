import { describe, expect, it } from 'vitest';
import { TUNE_MAX_ROUNDS, type CalibrationRow } from '@syncsound/protocol';
import {
  agreeing,
  mergeTuneRounds,
  nextRoundEmitters,
  TUNE_GIVE_UP_ROUNDS,
  TUNE_MAX_RUN_MS,
  tuneProgress,
  tuneRoundMs,
  verifyTune,
  type TuneRound,
} from './tuneRounds';
import type { Response } from './measure';

const row = (emitterId: string, mMs: number | null, o: Partial<CalibrationRow> = {}): CalibrationRow => ({
  emitterId,
  mMs,
  levelDb: mMs === null ? null : -20,
  directDb: mMs === null ? null : -22,
  snrDb: mMs === null ? 8 : 40,
  clipped: false,
  ...o,
});
/** a round: arrivals per emitter (null = not heard), all shifted by this round's listener clock offset */
const round = (k: number, arrivals: Record<string, number | null>, offsetMs = 0, extra: Partial<TuneRound> = {}): TuneRound => ({
  round: k,
  emitters: Object.keys(arrivals),
  rows: Object.entries(arrivals).map(([id, m]) => row(id, m === null ? null : m + offsetMs)),
  valid: true,
  ...extra,
});
const ids = ['L', 'A', 'B'];
const prog = (rounds: TuneRound[], connected?: string[]) => tuneProgress(rounds, { listenerId: 'L', deviceIds: ids, ...(connected ? { connected } : {}) });
const dev = (p: ReturnType<typeof prog>, id: string) => p.devices.find((d) => d.deviceId === id)!;

describe('agreeing', () => {
  it('finds the largest cluster within the tolerance, preferring the tighter one', () => {
    expect(agreeing([40, 42, 40.1], 0.25)).toEqual([40, 40.1]);
    expect(agreeing([1, 5, 9], 0.25)).toHaveLength(1);
    expect(agreeing([10, 10.2, 10.3, 10.6], 0.25)).toEqual([10.2, 10.3]);
    expect(agreeing([], 0.25)).toEqual([]);
  });
});

describe('tuneProgress', () => {
  it('confirms every device after two agreeing rounds, whatever each round’s clock offset', () => {
    const p = prog([round(0, { L: 30, A: 40, B: 50 }), round(1, { L: 30, A: 40.1, B: 49.95 }, 7.3)]);
    expect(p.anchorId).toBe('L');
    expect(p.devices.map((d) => d.state)).toEqual(['in-sync', 'in-sync', 'in-sync']);
    // in round 0's terms: the anchor's offset cancels
    expect(dev(p, 'A').valueMs).toBeCloseTo(40.05, 9);
    expect(dev(p, 'B').valueMs).toBeCloseTo(49.975, 9);
    expect(nextRoundEmitters(p, 2, 20_000)).toBeNull();
  });

  it('after one round everyone is checking; the next round plays them all, anchor first', () => {
    const p = prog([round(0, { A: 40, L: 30, B: 50 })]);
    expect(p.devices.map((d) => d.state)).toEqual(['checking', 'checking', 'checking']);
    expect(nextRoundEmitters(p, 1, 9000)).toEqual(['L', 'A', 'B']);
  });

  it('rejects an outlier: a third round settles a disagreement on the agreeing pair', () => {
    const r = [round(0, { L: 30, A: 40, B: 50 }), round(1, { L: 30, A: 42, B: 50 }, -3)];
    expect(dev(prog(r), 'A').state).toBe('checking');
    expect(nextRoundEmitters(prog(r), 2, 20_000)).toEqual(['L', 'A']);
    const p = prog([...r, round(2, { L: 30, A: 40.1 }, 11)]);
    expect(dev(p, 'A').state).toBe('in-sync');
    expect(dev(p, 'A').valueMs).toBeCloseTo(40.05, 9);
  });

  it('a known Bluetooth output needs three agreeing readings; two lucky ones only make it checking', () => {
    const r = [round(0, { L: 30, A: 40, B: 50 }), round(1, { L: 30, A: 40.2, B: 50 })];
    const p = tuneProgress(r, { listenerId: 'L', deviceIds: ids, confirm: { A: 3 } });
    expect(dev(p, 'A').state).toBe('checking');
    expect(dev(p, 'B').state).toBe('in-sync');
    const p3 = tuneProgress([...r, round(2, { L: 30, A: 44 }), round(3, { L: 30, A: 36 })], { listenerId: 'L', deviceIds: ids, confirm: { A: 3 } });
    expect(dev(p3, 'A').state).toBe('varies');
  });

  it('a device whose timing jitters varies after three readings: median, spread, no more rounds', () => {
    const p = prog([round(0, { L: 30, A: 40, B: 50 }), round(1, { L: 30, A: 43, B: 50 }), round(2, { L: 30, A: 37 })]);
    const a = dev(p, 'A');
    expect(a.state).toBe('varies');
    expect(a.valueMs).toBe(40);
    expect(a.spreadMs).toBeCloseTo(3, 9);
    expect(nextRoundEmitters(p, 3, 30_000)).toBeNull();
  });

  it('not heard → not-heard (turn it up), played again, skipped after missing the give-up count in a row', () => {
    const rounds = [round(0, { L: 30, A: 40, B: null })];
    expect(dev(prog(rounds), 'B')).toMatchObject({ state: 'not-heard', hint: 'volume', missed: 1 });
    for (let k = 1; k < TUNE_GIVE_UP_ROUNDS; k++) rounds.push(round(k, { L: 30, B: null, ...(k === 1 ? { A: 40 } : {}) }));
    const p = prog(rounds);
    expect(dev(p, 'B')).toMatchObject({ state: 'skipped', hint: 'volume' });
    expect(nextRoundEmitters(p, rounds.length, 30_000)).toBeNull();
  });

  it('a device turned up mid-run is picked up by the next rounds', () => {
    const p = prog([round(0, { L: 30, A: 40, B: null }), round(1, { L: 30, A: 40, B: 50 }), round(2, { L: 30, B: 50.1 })]);
    expect(dev(p, 'B')).toMatchObject({ state: 'in-sync', missed: 0 });
  });

  it('clipping: too loud while unconfirmed; its level and response come from an unclipped round', () => {
    const r0 = round(0, { L: 30, A: 40, B: 50 });
    r0.rows[1]!.clipped = true;
    expect(dev(prog([r0]), 'A')).toMatchObject({ state: 'too-loud', hint: 'loud' });
    const p = prog([r0, round(1, { L: 30, A: 40.05, B: 50 })]);
    expect(dev(p, 'A')).toMatchObject({ state: 'in-sync', hint: null, bestRound: 1 });
  });

  it('a round whose listener clocks moved is discarded for everyone', () => {
    const p = prog([round(0, { L: 30, A: 40, B: 50 }), round(1, { L: 30, A: 99, B: 99 }, 0, { valid: false })]);
    expect(p.devices.map((d) => d.state)).toEqual(['checking', 'checking', 'checking']);
    expect(p.discardedInARow).toBe(1);
    expect(p.usable).toEqual([0]);
  });

  it("without its own speaker the anchor is the device heard best; a round where the anchor isn't heard is discarded", () => {
    const r0 = round(0, { L: null, A: 40, B: 50 });
    r0.rows[2]!.snrDb = 55;
    const p0 = prog([r0]);
    expect(p0.anchorId).toBe('B');
    expect(nextRoundEmitters(p0, 1, 9000)).toEqual(['B', 'L', 'A']);
    const p = prog([r0, round(1, { B: null, L: 30, A: 40 })]);
    expect(p.discardedInARow).toBe(1);
    expect(dev(p, 'A').measurementsMs).toEqual([40]);
  });

  it('a round that heard nothing is a miss for everyone in it', () => {
    const rounds = Array.from({ length: TUNE_GIVE_UP_ROUNDS }, (_, k) => round(k, { L: null, A: null, B: null }));
    const p = prog(rounds);
    expect(p.anchorId).toBeNull();
    expect(p.devices.every((d) => d.state === 'skipped')).toBe(true);
    expect(nextRoundEmitters(p, rounds.length, 30_000)).toBeNull();
  });

  it("a device whose clock moved while it played isn't counted (hint: clock)", () => {
    const p = prog([round(0, { L: 30, A: 40, B: 50 }, 0, { faults: { A: 'its clock moved' } })]);
    expect(dev(p, 'A')).toMatchObject({ state: 'not-heard', hint: 'clock', measurementsMs: [] });
  });

  it('a device that left is skipped, unless it was already confirmed', () => {
    const p = prog([round(0, { L: 30, A: 40, B: 50 }), round(1, { L: 30, A: 40, B: 50.8 })], ['L']);
    expect(dev(p, 'A').state).toBe('in-sync');
    expect(dev(p, 'B')).toMatchObject({ state: 'skipped', hint: 'left' });
  });
});

describe('nextRoundEmitters', () => {
  const p = prog([round(0, { L: 30, A: 40, B: null })]);
  it('stops at the round cap and at the chime budget', () => {
    expect(nextRoundEmitters(p, TUNE_MAX_ROUNDS, 0)).toBeNull();
    expect(nextRoundEmitters(p, 1, TUNE_MAX_RUN_MS - tuneRoundMs(3) + 1)).toBeNull();
    expect(nextRoundEmitters(p, 1, TUNE_MAX_RUN_MS - tuneRoundMs(3))).toEqual(['L', 'A', 'B']);
  });
  it('a round plays its slots one TUNE_PERIOD after another', () => {
    expect(tuneRoundMs(6) - tuneRoundMs(5)).toBe(1550);
  });
});

describe('mergeTuneRounds', () => {
  const resp = (v: number): Response => ({ freqs: [100, 1000], db: [v, v] });
  it("builds the listener row solveTune times by: confirmed arrivals, the best round's levels and responses", () => {
    const r0 = round(0, { L: 30, A: 40, B: null }, 0, { responses: { L: resp(1), A: resp(2) }, broadbandSnrDb: { L: 30, A: 20 } });
    r0.rows[1]!.clipped = true;
    const r1 = round(1, { L: 30, A: 40.1, B: null }, 5, { responses: { L: resp(3), A: resp(4) }, broadbandSnrDb: { L: 31, A: 25 } });
    r1.rows[1]!.levelDb = -18;
    const rounds = [r0, r1];
    const p = prog(rounds);
    const m = mergeTuneRounds(rounds, p);
    const a = m.row.find((r) => r.emitterId === 'A')!;
    expect(a.mMs).toBeCloseTo(40.05, 9);
    expect(a).toMatchObject({ levelDb: -18, clipped: false });
    expect(m.responses['A']!.db).toEqual([4, 4]);
    expect(m.broadbandSnrDb['A']).toBe(25);
    // never heard: no arrival, its latest SNR kept for diagnostics
    expect(m.row.find((r) => r.emitterId === 'B')).toMatchObject({ mMs: null, levelDb: null, snrDb: 8 });
    expect(m.responses['B']).toBeUndefined();
  });
});

describe('verifyTune', () => {
  const clicks = (base: number, jitter = [0, 0.05, -0.05, 0.02]) => jitter.map((j) => base + j);
  it('a correct room needs nothing: every steady device lands with the others', () => {
    const v = verifyTune(
      [
        { deviceId: 'L', rawMs: clicks(10) },
        { deviceId: 'A', rawMs: clicks(10.2) },
        { deviceId: 'B', rawMs: clicks(9.9) },
      ],
      { L: 0, A: 12, B: 30 },
    );
    expect(v.corrected).toBeNull();
    expect(Object.keys(v.offsetMs).sort()).toEqual(['A', 'B', 'L']);
  });

  it('a device landing 3 ms late starts 3 ms earlier: its arrival grows, the rest stay, re-zeroed', () => {
    const v = verifyTune(
      [
        { deviceId: 'L', rawMs: clicks(10) },
        { deviceId: 'A', rawMs: clicks(13) },
        { deviceId: 'B', rawMs: clicks(10) },
      ],
      { L: 0, A: 12, B: 30 },
    );
    expect(v.offsetMs['A']).toBeCloseTo(3, 9);
    expect(v.corrected).toEqual({ L: 0, A: 15, B: 30 });
  });

  it('one landing early can push the minimum below zero: everything is re-zeroed', () => {
    const v = verifyTune(
      [
        { deviceId: 'L', rawMs: clicks(10) },
        { deviceId: 'A', rawMs: clicks(8) },
        { deviceId: 'B', rawMs: clicks(10) },
      ],
      { L: 0, A: 1, B: 30 },
    );
    expect(v.corrected).toEqual({ L: 1, A: 0, B: 31 });
  });

  it('a jittering device is reported, not corrected, and not used as the reference; missing clicks → unverified', () => {
    const v = verifyTune(
      [
        { deviceId: 'L', rawMs: clicks(10) },
        { deviceId: 'A', rawMs: clicks(10.1) },
        { deviceId: 'bt', rawMs: [5, 15, 9, 13] },
        { deviceId: 'C', rawMs: [10, NaN, NaN, NaN] },
      ],
      { L: 0, A: 12, bt: 200, C: 40 },
    );
    expect(v.wobble['bt']).toBeGreaterThan(3);
    expect(v.unverified).toEqual(['C']);
    expect(v.corrected).toBeNull();
  });

  it('with fewer than two steady devices there is nothing to compare', () => {
    expect(verifyTune([{ deviceId: 'L', rawMs: clicks(10) }], { L: 0 })).toMatchObject({ corrected: null, offsetMs: {} });
  });
});
