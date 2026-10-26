import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import {
  analyzeRecording,
  buildTuneSlots,
  CALIBRATION_FREQS,
  calibrationRecordingMs,
  cascadeMagnitudeDb,
  eqToBiquads,
  estimateRolloffHz,
  loudnessDb,
  smoothFractionalOctave,
  solveTune,
  type Response,
  type TuneReport,
} from '@syncsound/audio-core';
import { referenceSpeakers, renderListenerRecording, SIM_SR, type SimSpeaker } from '../src/acoustics';

const LISTENER: Vec2 = { x: 0, y: 1 };
const INPUT_LATENCY_MS = 12;

/** listener-only tune: one recording at LISTENER (not a device), analyzed and solved like the listener's own row */
function run(speakers: SimSpeaker[], extra: { roomNoiseDb?: number; inputLatencyMs?: number; silence?: boolean } = {}) {
  const { silence, ...render } = extra;
  const slots = buildTuneSlots(speakers.map((s) => s.id));
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
  if (silence) recording.fill(0);
  const a = analyzeRecording({ plan, recording, sampleRate: SIM_SR, toRoomMs: (i) => plan.startRoomTime + (i / SIM_SR) * 1000 });
  const devices = { ...Object.fromEntries(speakers.map((s) => [s.id, s.position])), listener: LISTENER };
  const report = solveTune({
    rows: { listener: a.rows },
    listenerId: 'listener',
    responses: a.responses,
    broadbandSnrDb: a.broadbandSnrDb,
    sampleRate: SIM_SR,
    scene: { devices, listener: LISTENER },
    deviceIds: speakers.map((s) => s.id),
  });
  return { ...report, rows: a.rows, recordingPeakDb: a.recordingPeakDb };
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
  let report: TuneReport;

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
    // trims meet in the middle: loud devices cut, soft ones boosted, never past +6 dB
    const trims = Object.values(report.trims);
    expect(Math.max(...trims)).toBeGreaterThan(0);
    expect(Math.min(...trims)).toBeLessThan(0);
    expect(Math.max(...trims)).toBeLessThanOrEqual(6);
  });

  it('after EQ + trim every device is equally loud at the listener (true K-weighted loudness, ±1 dB)', () => {
    // truth: 1/r spreading of each speaker's gain, its true response, its fitted EQ and its trim
    const rows = speakers.map((s) => {
      const fit = report.eq[s.id]!;
      const cs = eqToBiquads(fit.eq, SIM_SR);
      const db = trueResponse(s).db.map((d, i) => d + cascadeMagnitudeDb(cs, CALIBRATION_FREQS[i]!, SIM_SR) + fit.eq.preampDb);
      const dist = Math.hypot(s.position.x - LISTENER.x, s.position.y - LISTENER.y);
      const trim = report.trims[s.id]!;
      const level = 20 * Math.log10(s.gain / dist) + loudnessDb({ freqs: CALIBRATION_FREQS, db }) + trim;
      return { id: s.id, trimDb: r2(trim), levelDb: r2(level), capped: trim >= 6 || trim <= -24 };
    });
    const free = rows.filter((r) => !r.capped);
    const spread = Math.max(...free.map((r) => r.levelDb)) - Math.min(...free.map((r) => r.levelDb));
    results.loudness = { rows, spreadDb: r2(spread) };
    expect(free.length).toBeGreaterThanOrEqual(3);
    expect(spread).toBeLessThanOrEqual(2);
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

describe('calibration failure diagnostics', () => {
  const one = [referenceSpeakers().find((s) => s.id === 'desktop')!];

  it.each([-300, 900])('still hears a sweep arriving %i ms from nominal (window −400…+1000 ms)', (offset) => {
    // desktop: 15 ms output latency + ~10 ms propagation = ~25 ms nominal; shift the rest via the listener's input latency
    const r = run(one, { inputLatencyMs: offset - 25 });
    const d = r.devices[0]!;
    expect(d.heard).toBe(true);
    expect(r.rows[0]!.mMs!).toBeGreaterThan(offset - 10);
    expect(r.rows[0]!.mMs!).toBeLessThan(offset + 10);
    expect(r.warnings.some((w) => /unusual timing/.test(w))).toBe(true);
  });

  it('digital silence from the mic is reported as such (recordingPeakDb ≈ −200) and nobody is heard', () => {
    const r = run(one, { silence: true });
    expect(r.devices.some((d) => d.heard)).toBe(false);
    expect(r.recordingPeakDb).toBeLessThan(-80);
  });

  it('a too-weak speaker still exposes its best match for diagnostics', () => {
    const quiet = [{ ...one[0]!, gain: 0.00002 }];
    const r = run(quiet, { roomNoiseDb: -45 });
    const d = r.devices[0]!;
    expect(d.heard).toBe(false);
    expect(r.rows[0]!.snrDb).not.toBeNull();
    expect(r.recordingPeakDb).toBeGreaterThan(-80);
  });
});
