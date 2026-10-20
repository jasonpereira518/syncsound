import { describe, expect, it } from 'vitest';
import type { Playback } from '@syncsound/protocol';
import {
  snapToSampleGrid,
  captureDelayMs,
  compensationSec,
  driftErrorMs,
  expectedHeardEpochMs,
  expectedPositionAtCtx,
  outputLatencyMs,
  roomPosition,
  videoCorrection,
} from './timing';

// Synthetic device: room = local perf + 1234 ms; ctx seconds = (perf − 500) / 1000.
const ROOM_MINUS_LOCAL = 1234;
const toLocal = (room: number) => room - ROOM_MINUS_LOCAL;
const perfToCtx = (perf: number) => (perf - 500) / 1000;
const ctxToPerf = (ctx: number) => ctx * 1000 + 500;
const roomToCtx = (room: number) => perfToCtx(toLocal(room));
const ctxToRoom = (ctx: number) => ctxToPerf(ctx) + ROOM_MINUS_LOCAL;
const TIME_ORIGIN = 1_700_000_000_000;

const lat = { latencyMs: 20, calibratedLatencyMs: 35, autoLatencyMs: 40, usingOutputTimestamp: false };

describe('compensation', () => {
  it('sums manual + calibrated + auto (fallback) minus propagation delay', () => {
    expect(outputLatencyMs(lat)).toBe(95);
    expect(compensationSec(lat, 0.01)).toBeCloseTo(0.085, 9);
  });
  it('drops auto latency when the mapping uses getOutputTimestamp', () => {
    expect(outputLatencyMs({ ...lat, usingOutputTimestamp: true })).toBe(55);
  });
});

describe('expected heard time', () => {
  const delaySec = 0.004;
  const C = compensationSec(lat, delaySec);
  const L = outputLatencyMs(lat);
  const startRoomTime = 50_000;
  const trackOffset = 12;
  const idealHeardEpoch = TIME_ORIGIN + toLocal(startRoomTime) + delaySec * 1000;

  it('on-time start: heard at startRoomTime (+ alignment delay) in epoch ms', () => {
    const whenCtx = roomToCtx(startRoomTime) - C;
    const e = expectedHeardEpochMs({ timeOrigin: TIME_ORIGIN, ctxToPerf, whenCtx, offset: trackOffset, trackOffset, outputLatencyMs: L });
    expect(e).toBeCloseTo(idealHeardEpoch, 6);
  });

  it('late start (jumped ahead) maps back to the same origin', () => {
    const lateness = 0.37;
    const whenCtx = roomToCtx(startRoomTime) - C + lateness;
    const e = expectedHeardEpochMs({
      timeOrigin: TIME_ORIGIN,
      ctxToPerf,
      whenCtx,
      offset: trackOffset + lateness,
      trackOffset,
      outputLatencyMs: L,
    });
    expect(e).toBeCloseTo(idealHeardEpoch, 6);
  });

  it('two devices with different latencies agree on the heard time', () => {
    const other = { latencyMs: 0, calibratedLatencyMs: null, autoLatencyMs: 150, usingOutputTimestamp: false };
    const C2 = compensationSec(other, delaySec);
    const e2 = expectedHeardEpochMs({
      timeOrigin: TIME_ORIGIN,
      ctxToPerf,
      whenCtx: roomToCtx(startRoomTime) - C2,
      offset: trackOffset,
      trackOffset,
      outputLatencyMs: outputLatencyMs(other),
    });
    expect(e2).toBeCloseTo(idealHeardEpoch, 6);
  });
});

describe('drift sign conventions', () => {
  const pb: Playback = { status: 'playing', trackId: 't', startRoomTime: 10_000, trackOffset: 0 };
  const C = compensationSec(lat, 0);
  const idealWhen = roomToCtx(pb.startRoomTime) - C;

  it('a perfectly scheduled source has zero error', () => {
    const now = idealWhen + 3;
    const actual = 0 + (now - idealWhen); // tracker started at (idealWhen, 0)
    expect(driftErrorMs(actual, expectedPositionAtCtx(pb, now, ctxToRoom, C))).toBeCloseTo(0, 6);
  });

  it('a source started 10 ms late is behind (negative error → speed up)', () => {
    const now = idealWhen + 3;
    const actual = now - (idealWhen + 0.01);
    expect(driftErrorMs(actual, expectedPositionAtCtx(pb, now, ctxToRoom, C))).toBeCloseTo(-10, 6);
  });

  it('more compensation means the expected position is further ahead', () => {
    const now = idealWhen + 3;
    const a = expectedPositionAtCtx(pb, now, ctxToRoom, C);
    const b = expectedPositionAtCtx(pb, now, ctxToRoom, C + 0.05);
    expect(b - a).toBeCloseTo(0.05, 9);
  });

  it('paused playback has a fixed expected position', () => {
    const paused: Playback = { ...pb, status: 'paused', trackOffset: 42 };
    expect(expectedPositionAtCtx(paused, 99, ctxToRoom, C)).toBe(42);
  });
});

describe('capture delay', () => {
  it('fills the target buffer minus pipeline and compensation, clamped', () => {
    expect(captureDelayMs({ videoBufferMs: 150, lipSyncNudgeMs: 10, pipelineDelayMs: 60, compensationMs: 30 })).toBe(70);
    expect(captureDelayMs({ videoBufferMs: 40, lipSyncNudgeMs: -100, pipelineDelayMs: 60, compensationMs: 0 })).toBe(0);
  });
});

describe('video correction', () => {
  it('seeks on large error, nudges on medium, holds when close', () => {
    expect(videoCorrection(0.3)).toEqual({ seek: true, rate: 1 });
    expect(videoCorrection(0.05)).toEqual({ seek: false, rate: 0.95 });
    expect(videoCorrection(-0.05)).toEqual({ seek: false, rate: 1.05 });
    expect(videoCorrection(0.01)).toEqual({ seek: false, rate: 1 });
  });
});

describe('agreement with audio-core', async () => {
  const { computeStart, positionAt } = await import('@syncsound/audio-core');
  const pb: Playback = { status: 'playing', trackId: 't', startRoomTime: 20_000, trackOffset: 5 };
  const C = compensationSec(lat, 0.002);

  it('roomPosition matches positionAt', () => {
    for (const r of [19_000, 20_000, 23_456]) expect(roomPosition(pb, r)).toBeCloseTo(positionAt(pb, r), 9);
  });

  it('computeStart on-time and late decisions give the same heard epoch', () => {
    const heard = (nowCtx: number) => {
      const d = computeStart({ startRoomTime: pb.startRoomTime, trackOffset: pb.trackOffset, roomToCtx, nowCtx, compensationSec: C, durationSec: 300 })!;
      return expectedHeardEpochMs({ timeOrigin: TIME_ORIGIN, ctxToPerf, whenCtx: d.when, offset: d.offset, trackOffset: pb.trackOffset, outputLatencyMs: outputLatencyMs(lat) });
    };
    const onTime = heard(roomToCtx(pb.startRoomTime) - 1);
    expect(heard(roomToCtx(pb.startRoomTime) + 2.5)).toBeCloseTo(onTime, 3);
    expect(onTime).toBeCloseTo(TIME_ORIGIN + toLocal(pb.startRoomTime) + 2, 6);
  });
});

describe('snapToSampleGrid', () => {
  it('lands both on integer samples and keeps the timeline within half a sample', () => {
    const sr = 48000;
    for (const [when, offset] of [
      [1.2345678, 3.3333333],
      [10.00001, 0],
      [0.5, 12.25],
    ] as const) {
      const s = snapToSampleGrid(when, offset, sr);
      expect(Math.abs(s.when * sr - Math.round(s.when * sr))).toBeLessThan(1e-6);
      expect(Math.abs(s.offset * sr - Math.round(s.offset * sr))).toBeLessThan(1e-6);
      // timeline origin (when − offset) preserved
      expect(Math.abs(s.when - s.offset - (when - offset))).toBeLessThanOrEqual(0.5 / sr + 1e-9);
    }
  });
});
