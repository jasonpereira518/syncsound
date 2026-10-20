/**
 * Pure timing math shared by the audio engine, video driver and instrumentation. No DOM, no audio-core
 * runtime dependency, so it is unit-tested in Node.
 *
 * Conventions (keep them consistent everywhere):
 *  - roomToCtx(R) = ctx time whose sample *the clock mapping* says is heard at room time R. With
 *    getOutputTimestamp the mapping already includes browser output latency; otherwise it doesn't and the
 *    browser-reported auto latency must be compensated explicitly.
 *  - outputLatencyMs L = manual + calibrated + (fallback ? auto : 0): how much later than the mapping says
 *    a sample is actually heard.
 *  - delaySec D = intentional propagation alignment delay (nearer speakers play later).
 *  - compensation C = L/1000 − D (s, +ve = start earlier); source.start(when = roomToCtx(start) − C, offset).
 *  - A sample scheduled at ctx T is heard at room time ctxToRoom(T) + L, and should carry the track position
 *    of room time ctxToRoom(T) + L − D = ctxToRoom(T) + C·1000.
 */
import type { Playback } from '@syncsound/protocol';

export interface LatencyInput {
  /** manual fine-tune, ms */
  latencyMs: number;
  calibratedLatencyMs: number | null;
  /** browser-reported output latency, ms */
  autoLatencyMs: number | null;
  usingOutputTimestamp: boolean;
}

/** Output latency not already contained in the clock mapping, ms. */
export function outputLatencyMs(l: LatencyInput): number {
  return l.latencyMs + (l.calibratedLatencyMs ?? 0) + (l.usingOutputTimestamp ? 0 : (l.autoLatencyMs ?? 0));
}

/** Start compensation, s (+ve = start earlier). */
export function compensationSec(l: LatencyInput, delaySec: number): number {
  return outputLatencyMs(l) / 1000 - delaySec;
}

/** Calibration emission: only the browser-reported part, so the measurement captures the residual. */
export function autoOnlyCompensationSec(autoLatencyMs: number | null, usingOutputTimestamp: boolean): number {
  return usingOutputTimestamp ? 0 : (autoLatencyMs ?? 0) / 1000;
}

/** Track position (s) on the room timeline at roomMs (same semantics as audio-core positionAt). */
export function roomPosition(pb: Playback, roomMs: number): number {
  return pb.status === 'playing' ? pb.trackOffset + (roomMs - pb.startRoomTime) / 1000 : pb.trackOffset;
}

/** Track position the sample rendered at ctx time `ctxSec` should carry. */
export function expectedPositionAtCtx(
  pb: Playback,
  ctxSec: number,
  ctxToRoom: (ctxSec: number) => number,
  compSec: number,
): number {
  return roomPosition(pb, ctxToRoom(ctxSec) + compSec * 1000);
}

/** DriftController input: actual − expected, ms (+ve = ahead → slow down). */
export function driftErrorMs(actualPosSec: number, expectedPosSec: number): number {
  return (actualPosSec - expectedPosSec) * 1000;
}

/**
 * Epoch ms at which this device believes track position `trackOffset` is heard, for a source started at
 * (whenCtx, offset). Late starts begin at offset > trackOffset, so map back by the offset delta.
 */
export function expectedHeardEpochMs(p: {
  timeOrigin: number;
  ctxToPerf: (ctxSec: number) => number;
  whenCtx: number;
  offset: number;
  trackOffset: number;
  outputLatencyMs: number;
}): number {
  return p.timeOrigin + p.ctxToPerf(p.whenCtx) + p.outputLatencyMs - (p.offset - p.trackOffset) * 1000;
}

/** Capture-mode playout delay so every device plays ≈ captureTime + buffer. */
export function captureDelayMs(p: {
  videoBufferMs: number;
  lipSyncNudgeMs: number;
  pipelineDelayMs: number;
  compensationMs: number;
}): number {
  const d = p.videoBufferMs + p.lipSyncNudgeMs - p.pipelineDelayMs - p.compensationMs;
  return Math.min(1990, Math.max(0, d));
}

/** Mode-2 video correction: diff = element time − expected, s. */
export function videoCorrection(diffSec: number): { seek: boolean; rate: number } {
  const a = Math.abs(diffSec);
  if (a > 0.12) return { seek: true, rate: 1 };
  if (a > 0.02) return { seek: false, rate: diffSec > 0 ? 0.95 : 1.05 };
  return { seek: false, rate: 1 };
}
