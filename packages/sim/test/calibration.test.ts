import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import {
  analyzeCalibration,
  buildCalibrationSlots,
  CALIBRATION_FREQS,
  calibrationRecordingMs,
  cascadeMagnitudeDb,
  eqToBiquads,
  estimateRolloffHz,
  smoothFractionalOctave,
  diagnoseCalibration,
  mulberry32,
  SILENT_MIC_PEAK_DB,
  type CalibrationReport,
  type Response,
} from '@syncsound/audio-core';
import { referenceSpeakers, renderListenerRecording, SIM_SR, type SimSpeaker } from '../src/acoustics';

const LISTENER: Vec2 = { x: 0, y: 1 };
const INPUT_LATENCY_MS = 12;

function run(
  speakers: SimSpeaker[],
  extra: { roomNoiseDb?: number; quick?: boolean; mic?: (rec: Float32Array) => Float32Array } = {},
) {
  const { quick, mic, ...render } = extra;
  const slots = buildCalibrationSlots(speakers.map((s) => s.id), quick ? { include: ['chirp'] } : {});
  const plan: CalibrationPlan = { id: 'cal1', listenerId: 'listener', startRoomTime: 1_000_000, slots };
  const recording = renderListenerRecording({
    plan,
    speakers,
    listener: LISTENER,
    sampleRate: SIM_SR,
    durationMs: calibrationRecordingMs(slots),
    inputLatencyMs: INPUT_LATENCY_MS,
    noiseDb: -50,
    ...render,
  });
  return analyzeCalibration({
    plan,
    recording: mic ? mic(recording) : recording,
    sampleRate: SIM_SR,
    recordingStartRoomTime: plan.startRoomTime,
    devicePositions: Object.fromEntries(speakers.map((s) => [s.id, s.position])),
    listener: LISTENER,
  });
}

const trueResponse = (s: SimSpeaker): Response =>
  smoothFractionalOctave(
    { freqs: CALIBRATION_FREQS, db: CALIBRATION_FREQS.map((f) => cascadeMagnitudeDb(s.filters, f, SIM_SR)) },
    6,
  );

/** RMS of a − b over [f1, f2] after removing the mean difference (shape only; levels are handled by trims). */
function shapeRms(freqs: number[], a: number[], b: number[], f1: number, f2: number): number {
  const d = freqs.flatMap((f, i) => (f >= f1 && f <= f2 ? [a[i]! - b[i]!] : []));
  const m = d.reduce((s, x) => s + x, 0) / d.length;
  return Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / d.length);
}
function maxAbsShapeErr(freqs: number[], a: number[], b: number[], f1: number, f2: number): number {
  const idx = freqs.flatMap((f, i) => (f >= f1 && f <= f2 ? [i] : []));
  const m = idx.reduce((s, i) => s + a[i]! - b[i]!, 0) / idx.length;
  return Math.max(...idx.map((i) => Math.abs(a[i]! - b[i]! - m)));
}
function meanPairwise(curves: number[][], f1: number, f2: number): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < curves.length; i++)
    for (let j = i + 1; j < curves.length; j++) {
      s += shapeRms(CALIBRATION_FREQS, curves[i]!, curves[j]!, f1, f2);
      n++;
    }
  return s / n;
}
const r2 = (x: number) => Math.round(x * 100) / 100;

const results: Record<string, unknown> = {};

describe('acoustic calibration (end to end, synthetic room)', () => {
  const speakers = referenceSpeakers();
  let report: CalibrationReport;

  it('recovers relative latency within 1 ms for every device (incl. 210 ms Bluetooth)', () => {
    report = run(speakers);
    const minLat = Math.min(...speakers.map((s) => s.latencyMs));
    const rows = speakers.map((s) => {
      const d = report.devices.find((x) => x.deviceId === s.id)!;
      expect(d.heard).toBe(true);
      const truth = s.latencyMs - minLat;
      return {
        id: s.id,
        truthMs: truth,
        measuredMs: r2(d.relativeLatencyMs!),
        errorMs: r2(Math.abs(d.relativeLatencyMs! - truth)),
        snrDb: r2(d.snrDb!),
      };
    });
    results.latency = rows;
    for (const r of rows) expect(r.errorMs).toBeLessThan(1);
    expect(report.warnings).toEqual([]);
  });

  it('quick re-sync (chirps only) recovers the same latencies and leaves level/EQ alone', () => {
    const quick = run(speakers, { quick: true });
    const minLat = Math.min(...speakers.map((s) => s.latencyMs));
    for (const s of speakers) {
      const d = quick.devices.find((x) => x.deviceId === s.id)!;
      expect(d.heard).toBe(true);
      expect(Math.abs(d.relativeLatencyMs! - (s.latencyMs - minLat))).toBeLessThan(1);
    }
    expect(quick.trims).toEqual({});
    expect(quick.volumeUp).toEqual({});
    expect(Object.keys(quick.eq)).toEqual([]);
  });

  it('recovers each smoothed response within ±1.5 dB in the passband', () => {
    const rows = speakers.map((s) => {
      const d = report.devices.find((x) => x.deviceId === s.id)!;
      const truth = trueResponse(s);
      const f1 = Math.max(estimateRolloffHz(truth), 50);
      const err = maxAbsShapeErr(CALIBRATION_FREQS, d.response!.db, truth.db, f1, 12000);
      return {
        id: s.id,
        passbandHz: [r2(f1), 12000],
        maxErrDb: r2(err),
        rolloffTrueHz: r2(estimateRolloffHz(truth)),
        rolloffMeasuredHz: r2(d.rolloffHz!),
        bassCapable: d.bassCapable,
      };
    });
    results.response = rows;
    for (const r of rows) expect(r.maxErrDb).toBeLessThanOrEqual(1.5);
  });

  it('EQ toward the common target brings devices measurably closer (pairwise RMS, mean-removed)', () => {
    const before = speakers.map((s) => trueResponse(s).db);
    const after = speakers.map((s, k) => {
      const fit = report.eq[s.id]!;
      const cs = eqToBiquads(fit.eq, SIM_SR);
      return CALIBRATION_FREQS.map(
        (f, i) => before[k]![i]! + cascadeMagnitudeDb(cs, f, SIM_SR) + fit.eq.preampDb,
      );
    });
    // band where EVERY device's EQ may act: above max(fit floor = 1.2 × rolloff). Below it EQ is forbidden to boost
    // (rails) and bass management (computeDeviceMix) high-passes the small devices instead.
    const eqFloor = Math.max(...report.devices.map((d) => Math.max(60, 1.2 * d.rolloffHz!)));
    const band = (f1: number, f2: number) => {
      const b = meanPairwise(before, f1, f2);
      const a = meanPairwise(after, f1, f2);
      return {
        band: [r2(f1), f2],
        beforeDb: r2(b),
        afterDb: r2(a),
        reductionPct: r2((1 - a / b) * 100),
        a,
        b,
      };
    };
    const common = band(eqFloor, 8000);
    const wide = band(200, 8000);
    results.convergence = {
      note: 'mean pairwise RMS difference of the TRUE responses before vs after applying each fitted EQ; level removed',
      commonEqBand: { ...common, a: undefined, b: undefined },
      band200to8k: { ...wide, a: undefined, b: undefined },
    };
    results.eq = Object.fromEntries(
      speakers.map((s) => {
        const f = report.eq[s.id]!;
        return [
          s.id,
          { ...f.eq, rmsErrorBeforeDb: r2(f.rmsErrorBeforeDb), rmsErrorAfterDb: r2(f.rmsErrorAfterDb) },
        ];
      }),
    );
    results.trims = report.trims;
    expect(common.a).toBeLessThanOrEqual(common.b * 0.6);
    // 200 Hz–8 kHz includes the phone's 200–280 Hz rolloff, which EQ may not boost: it still improves, but its
    // floor is set by that rolloff (real number recorded in results/calibration.json)
    expect(wide.a).toBeLessThan(wide.b);
  });

  it('EQ safety rails: band boost ≤ 6 dB, no boost below rolloff, overall gain ≤ 0 dB', () => {
    const dense = Array.from({ length: 961 }, (_, k) => 20 * Math.pow(1000, k / 960));
    const rows = speakers.map((s) => {
      const d = report.devices.find((x) => x.deviceId === s.id)!;
      const { eq } = report.eq[s.id]!;
      const cs = eqToBiquads(eq, SIM_SR);
      const tot = dense.map((f) => cascadeMagnitudeDb(cs, f, SIM_SR));
      const belowRolloff = Math.max(-99, ...dense.flatMap((f, i) => (f < d.rolloffHz! ? [tot[i]!] : [])));
      return {
        id: s.id,
        maxBandBoostDb: Math.max(0, ...eq.bands.map((b) => b.gainDb)),
        maxEqBelowRolloffDb: r2(belowRolloff),
        maxOverallGainDb: r2(Math.max(...tot.map((t) => t + eq.preampDb))),
        preampDb: eq.preampDb,
      };
    });
    results.safety = rows;
    for (const r of rows) {
      expect(r.maxBandBoostDb).toBeLessThanOrEqual(6);
      expect(r.maxEqBelowRolloffDb).toBeLessThanOrEqual(0.05);
      expect(r.maxOverallGainDb).toBeLessThanOrEqual(0.05);
      expect(r.preampDb).toBeGreaterThanOrEqual(-12);
    }
    // trims: quietest device gets 0, everyone else is cut (never boosted)
    const trims = Object.values(report.trims);
    expect(Math.max(...trims)).toBeCloseTo(0, 6);
    expect(Math.min(...trims)).toBeLessThan(0);
  });

  it('flags a noisy room', () => {
    const noisy = run(speakers, { roomNoiseDb: -30 });
    results.noisyRoom = {
      warnings: noisy.warnings,
      latencyErrorsMs: speakers.map((s) => {
        const d = noisy.devices.find((x) => x.deviceId === s.id)!;
        return d.heard ? r2(Math.abs(d.relativeLatencyMs! - (s.latencyMs - 15))) : null;
      }),
    };
    expect(noisy.warnings.some((w) => /noisy/i.test(w))).toBe(true);
  });

  it('diagnoses a dead / wrong microphone (silence) separately from unheard speakers', () => {
    const dead = run(speakers, { mic: (r) => new Float32Array(r.length) });
    expect(dead.devices.every((d) => !d.heard)).toBe(true);
    expect(dead.recordingPeakDb).toBeLessThan(SILENT_MIC_PEAK_DB);
    expect(diagnoseCalibration(dead, 'phone')).toMatchObject({ kind: 'silent-mic' });
  });

  it('a mic that records only faint sound: none heard, with the best candidate reported', () => {
    const rnd = mulberry32(5);
    // speakers 66 dB down, under -55 dBFS of mic hiss: sound is recorded, chirps don't clear the thresholds
    const faint = run(speakers, { mic: (r) => r.map((x) => x * 5e-4 + (rnd() - 0.5) * 0.006) });
    expect(faint.devices.every((d) => !d.heard)).toBe(true);
    expect(faint.recordingPeakDb).toBeGreaterThan(SILENT_MIC_PEAK_DB);
    for (const d of faint.devices) expect(d.bestSnrDb).not.toBeNull();
    const dx = diagnoseCalibration(faint, 'phone');
    expect(dx.kind).toBe('none-heard');
    results.faintMic = { recordingPeakDb: r2(faint.recordingPeakDb), diagnosis: dx, bestSnrDb: faint.devices.map((d) => r2(d.bestSnrDb!)) };
  });

  it('only the listening device heard: diagnosed as only-self with the missing speakers named', () => {
    const self = speakers[0]!.id;
    const rep = run(speakers.map((s) => (s.id === self ? s : { ...s, audible: false })));
    expect(diagnoseCalibration(rep, self)).toEqual({ kind: 'only-self', missing: speakers.slice(1).map((s) => s.id) });
    expect(diagnoseCalibration(run(speakers), self)).toEqual({ kind: 'ok' });
  });

  it('reports an unplugged device as unheard', () => {
    const rep = run(speakers.map((s) => (s.id === 'laptop' ? { ...s, audible: false } : s)));
    const laptop = rep.devices.find((d) => d.deviceId === 'laptop')!;
    results.unplugged = { heard: laptop.heard, warnings: rep.warnings };
    expect(laptop.heard).toBe(false);
    expect(laptop.relativeLatencyMs).toBeNull();
    expect(rep.warnings).toContain("Couldn't hear laptop — is its volume up?");
    expect(rep.devices.filter((d) => d.heard)).toHaveLength(3);
    expect(rep.eq.laptop).toBeUndefined();
  });

  it('writes metrics', () => {
    const dir = new URL('../results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      new URL('calibration.json', dir),
      JSON.stringify({ sampleRate: SIM_SR, inputLatencyMs: INPUT_LATENCY_MS, ...results }, null, 2) + '\n',
    );
  });
});
