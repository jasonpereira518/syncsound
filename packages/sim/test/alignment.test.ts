import { describe, expect, it } from 'vitest';
import { AudioClockMap, computeStart } from '@syncsound/audio-core';
import { AudioClockModel, SimClient, writeResult } from '../src/clockSim';
import { makeRng, ROOM_T0, type NetParams } from '../src/network';
import { renderDevice, toRoomTimeline, xcorrLag } from '../src/render';

const FS = 48_000;
const S = ROOM_T0 + 40_000; // common startRoomTime
const TRACK_SEC = 12;
const LOSSY = { spikeProb: 0.01, spikeMaxMs: 200, lossProb: 0.01 };
const CAL_ERR_MS = 0.5; // calibration measured output latency to ±0.5 ms

interface DeviceSpec {
  name: string;
  latencyMs: number;
  offsetMs: number;
  driftPpm: number;
  audioPpm: number;
  net: NetParams;
  joinT: number;
}

/** device clocks/latencies; `jitter` = per-leg queueing σ in ms for each device */
const mkDevices = (jitter: number[]): DeviceSpec[] => [
  { name: 'phone', latencyMs: 10, offsetMs: 3200, driftPpm: 35, audioPpm: 20, net: { baseRttMs: 30, jitterMs: jitter[0]!, ...LOSSY }, joinT: ROOM_T0 },
  { name: 'laptop', latencyMs: 40, offsetMs: -7900, driftPpm: -80, audioPpm: -45, net: { baseRttMs: 60, jitterMs: jitter[1]!, ...LOSSY }, joinT: ROOM_T0 },
  { name: 'bt-speaker', latencyMs: 180, offsetMs: 9500, driftPpm: 100, audioPpm: 80, net: { baseRttMs: 25, jitterMs: jitter[2]!, ...LOSSY }, joinT: ROOM_T0 },
  { name: 'tablet', latencyMs: 25, offsetMs: -1100, driftPpm: -20, audioPpm: 10, net: { baseRttMs: 80, jitterMs: jitter[3]!, ...LOSSY }, joinT: ROOM_T0 },
];
/** same-room Wi-Fi: σ drawn U(3, 6) ms per device (seeded), plus the 1 % spikes ≤ 200 ms and 1 % loss */
const WIFI_JITTER = (() => {
  const r = makeRng(7);
  return [0, 1, 2, 3].map(() => +r.uniform(3, 6).toFixed(2));
})();
/** harsh: the clock sim's "realistic" σ range 5–30 ms */
const HARSH_JITTER = [8, 15, 5, 30];
const DEVICES = mkDevices(WIFI_JITTER);
const LATE: DeviceSpec = { name: 'late-joiner', latencyMs: 120, offsetMs: 6100, driftPpm: -60, audioPpm: 55, net: { baseRttMs: 45, jitterMs: 5, ...LOSSY }, joinT: S + 7300 };

const track = (() => {
  const rng = makeRng(99);
  return Float32Array.from({ length: TRACK_SEC * FS }, () => rng.uniform(-0.5, 0.5)); // white noise: one sharp xcorr peak
})();

/** Run one device: ClockSync over the network, AudioClockMap from ctx creation, computeStart, offline render. */
async function runDevice(d: DeviceSpec, seed: number, compensate: boolean, gridStarts: number[]) {
  const rng = makeRng(seed);
  const client = new SimClient({ clock: { offsetMs: d.offsetMs, driftPpm: d.driftPpm }, net: d.net, seed, joinT: d.joinT });
  // the AudioContext is created at join for the late joiner, ~20 s before the start for everyone else
  const ctxCreated = d.joinT >= S ? d.joinT : S - 20_000;
  const decisionT = d.joinT >= S ? d.joinT + 1500 : S - 1000;
  const audio = new AudioClockModel(client.clock, d.audioPpm, ctxCreated);
  const acm = new AudioClockMap();
  for (let T = d.joinT; T <= decisionT; T += 50) {
    client.advanceTo(T);
    if (T >= ctxCreated && (T - ctxCreated) % 250 === 0) {
      const o = audio.observe(T, rng);
      acm.addObservation(o.perfMs, o.ctxSec);
    }
  }
  const calibratedMs = d.latencyMs + rng.uniform(-CAL_ERR_MS, CAL_ERR_MS);
  const dec = computeStart({
    startRoomTime: S,
    trackOffset: 0,
    roomToCtx: (r) => acm.perfToCtx(client.sync.toLocalTime(r)),
    nowCtx: audio.currentTime(decisionT),
    compensationSec: compensate ? calibratedMs / 1000 : 0,
    durationSec: TRACK_SEC,
  });
  if (!dec) throw new Error(`${d.name}: no start`);
  // render from an integer-sample base shortly before `when` (time-invariant, keeps buffers short)
  const base = Math.floor((dec.when - 0.5) * FS) / FS;
  const endCtx = audio.ctx(S + 11_500);
  const rendered = await renderDevice({ track, sampleRate: FS, when: dec.when - base, offset: dec.offset, lengthSec: endCtx - base });
  const windows = gridStarts.map((g) => toRoomTimeline(rendered, FS, (T) => audio.ctx(T) - base, d.latencyMs, g, FS));
  // per-device truth check: how far was the clock estimate off at the decision instant
  return { dec, windows, clockErrMs: client.roomError(decisionT), calErrMs: calibratedMs - d.latencyMs, acmRatePpm: acm.ratePpm() };
}

const ms = (samples: number) => (samples / FS) * 1000;
/** the track exactly on the room timeline (trackOffset 0 heard at S) for a window starting at true time g */
const ideal = (g: number) => toRoomTimeline(track, FS, (T) => (T - S) / 1000, 0, g, FS);
/** device error vs the ideal timeline, ms (+ve = device late) */
const absErrMs = (w: Float64Array, g: number) => +ms(xcorrLag(ideal(g), w, MAX_LAG)).toFixed(4);
const MAX_LAG = Math.round(0.25 * FS);
const results: Record<string, unknown> = {};

async function alignment(compensate: boolean, devices = DEVICES) {
  const grid = [S + 500];
  const runs = await Promise.all(devices.map((d, i) => runDevice(d, 100 + i, compensate, grid)));
  const pairs: { a: string; b: string; lagMs: number }[] = [];
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++)
      pairs.push({ a: devices[i]!.name, b: devices[j]!.name, lagMs: +ms(xcorrLag(runs[i]!.windows[0]!, runs[j]!.windows[0]!, MAX_LAG)).toFixed(4) });
  const maxPairMs = Math.max(...pairs.map((p) => Math.abs(p.lagMs)));
  return {
    maxPairwiseMisalignmentMs: +maxPairMs.toFixed(4),
    pairs,
    devices: runs.map((r, i) => ({
      ...devices[i]!,
      when: +r.dec.when.toFixed(6),
      errorVsIdealMs: absErrMs(r.windows[0]!, grid[0]!),
      clockErrMsAtDecision: +r.clockErrMs.toFixed(3),
      calibrationErrMs: +r.calErrMs.toFixed(3),
      acmRatePpm: +r.acmRatePpm.toFixed(1),
    })),
  };
}

describe('offline-render alignment (node-web-audio-api OfflineAudioContext)', () => {
  it('self-check: xcorrLag recovers a known fractional delay', () => {
    const a = track.subarray(0, 4800);
    const b = toRoomTimeline(track, FS, (T) => T / 1000, 1000 * (37.3 / FS), 0, 4800);
    expect(xcorrLag(a, b, 200)).toBeCloseTo(37.3, 0);
  });

  // Threshold from the error budget (per device, independent): clock error (clock sim, σ 5 ms Wi-Fi:
  // rms 0.35, p95 0.69, max 1.13 ms) + calibration U(±0.5) (rms 0.29) + AudioClockMap extrapolation (~0.2–0.4)
  // + start quantisation (< 1 sample = 0.02 ms) → per-device rms ≈ 0.5 ms, pairwise rms ≈ 0.7 ms; 2 ms ≈ 2.8σ.
  it('same-room Wi-Fi: 4 devices (10/40/180/25 ms output latency) align < 2 ms with compensation', { timeout: 30_000 }, async () => {
    const r = await alignment(true);
    results.compensated = { jitterMs: WIFI_JITTER, ...r };
    expect(r.maxPairwiseMisalignmentMs).toBeLessThan(2);
  });

  // With σ up to 30 ms the clock error is the limit (~0.1·σ rms at 1 Hz pings / 64-sample window; realistic clock
  // sim p95 2.6 ms). Budget bound: 2 × (2.6 clock p95 + 0.5 calibration + 0.4 AudioClockMap) = 7 ms.
  it('harsh jitter (σ 8/15/5/30 ms): misalignment stays inside the clock error budget (< 7 ms)', { timeout: 30_000 }, async () => {
    const r = await alignment(true, mkDevices(HARSH_JITTER));
    results.compensatedHarsh = { jitterMs: HARSH_JITTER, budgetBoundMs: 7, ...r };
    expect(r.maxPairwiseMisalignmentMs).toBeLessThan(7);
  });

  it('without latency compensation the misalignment is ~170 ms (the test can fail)', { timeout: 30_000 }, async () => {
    const r = await alignment(false);
    results.uncompensated = r;
    expect(r.maxPairwiseMisalignmentMs).toBeGreaterThan(150);
  });

  it('late joiner (joins 7.3 s after start) lands on the same timeline < 2 ms', { timeout: 30_000 }, async () => {
    const grid = [S + 9500];
    const ref = await runDevice(DEVICES[0]!, 100, true, grid);
    const late = await runDevice(LATE, 200, true, grid);
    const lagMs = ms(xcorrLag(ref.windows[0]!, late.windows[0]!, MAX_LAG));
    results.lateJoiner = {
      joinedAfterStartSec: (LATE.joinT - S) / 1000,
      decidedAfterJoinMs: 1500,
      late: late.dec.late,
      latenessSec: +late.dec.latenessSec.toFixed(4),
      startOffsetSec: +late.dec.offset.toFixed(4),
      misalignmentVsPhoneMs: +lagMs.toFixed(4),
      phoneErrorVsIdealMs: absErrMs(ref.windows[0]!, grid[0]!),
      lateErrorVsIdealMs: absErrMs(late.windows[0]!, grid[0]!),
      lateAcmRatePpm: +late.acmRatePpm.toFixed(1),
      clockErrMsAtDecision: +late.clockErrMs.toFixed(3),
      calibrationErrMs: +late.calErrMs.toFixed(3),
      spec: LATE,
    };
    expect(late.dec.late).toBe(true);
    expect(Math.abs(lagMs)).toBeLessThan(2);
  });

  it('writes results', () => {
    writeResult('alignment', { sampleRate: FS, calibrationErrorMs: `±${CAL_ERR_MS}`, signal: 'seeded white noise track, 1 s correlation windows', ...results });
  });
});
