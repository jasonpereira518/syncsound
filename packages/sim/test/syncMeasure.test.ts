import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import {
  analyzeSyncMeasurement,
  buildSyncMeasurementSlots,
  calibrationRecordingMs,
  expectedArrivalMs,
  mulberry32,
  SYNC_SEARCH_LATE_MS,
} from '@syncsound/audio-core';
import { referenceSpeakers, renderListenerRecording, SIM_SR } from '../src/acoustics';

const LISTENER: Vec2 = { x: 0, y: 1 };

// Sync check (spec §11.1), simulated: four devices playing compensated wideband clicks, time-staggered by
// SYNC_STAGGER_MS. Each has a known residual sync error (what calibration left over) and per-click jitter.
// Emission-aligned (propagation alignment off): the expected arrival at the mic is just the distance.
const expect0 = (speakers: Array<{ id: string; position: Vec2 }>) =>
  expectedArrivalMs(
    { devices: Object.fromEntries(speakers.map((s) => [s.id, s.position])), listener: LISTENER, propagationComp: false },
    LISTENER,
    'l',
    speakers.map((s) => s.id),
  );
describe('sync measurement tool (simulated)', () => {
  it('recovers per-device inter-device sync error from one mixed recording', () => {
    const residual: Record<string, number> = { phone: 2.0, laptop: -1.5, bt: 4.0, desktop: 0 };
    const speakers = referenceSpeakers().map((s) => ({ ...s, latencyMs: residual[s.id]! }));
    const rnd = mulberry32(11);
    const jitter: Record<string, number[]> = {};
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    for (const s of speakers) jitter[s.id] = Array.from({ length: 60 }, () => 0.4 * gauss());
    const slots = buildSyncMeasurementSlots(speakers.map((s) => s.id), { durationSec: 60 });
    expect(slots).toHaveLength(4);
    const plan: CalibrationPlan = { id: 'm1', listenerId: 'l', startRoomTime: 5_000_000, slots, purpose: 'measure' };
    const recording = renderListenerRecording({
      plan,
      speakers,
      listener: LISTENER,
      sampleRate: SIM_SR,
      durationMs: calibrationRecordingMs(slots, SYNC_SEARCH_LATE_MS),
      inputLatencyMs: 12,
      noiseDb: -50,
      clickJitterMs: (id, k) => jitter[id]![k]!,
    });
    const report = analyzeSyncMeasurement({
      plan,
      recording,
      sampleRate: SIM_SR,
      toRoomMs: (i) => plan.startRoomTime + (i / SIM_SR) * 1000,
      expectedMs: expect0(speakers),
    });

    // truth per click: (residual + jitter) − mean over devices
    let maxErr = 0;
    const clicks = slots[0]!.repeat!;
    expect(clicks).toBe(60); // 4 devices × 250 ms stagger still fit one click per second
    for (let k = 0; k < clicks; k++) {
      const vals = speakers.map((s) => residual[s.id]! + jitter[s.id]![k]!);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      speakers.forEach((s, i) => {
        const got = report.devices.find((d) => d.deviceId === s.id)!.errorsMs[k]!;
        maxErr = Math.max(maxErr, Math.abs(got - (vals[i]! - mean)));
      });
    }
    for (const d of report.devices) expect(d.detected).toBe(60);
    expect(maxErr).toBeLessThan(0.2);
    expect(report.histogram.counts.reduce((a, b) => a + b, 0)).toBe(240);
    const bt = report.devices.find((d) => d.deviceId === 'bt')!;
    expect(bt.meanMs).toBeGreaterThan(2.5); // bt really is ~2.9 ms late vs the group mean
    mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
    writeFileSync(
      new URL('../results/syncMeasure.json', import.meta.url),
      JSON.stringify(
        {
          description: 'Simulated sync-measurement run: 4 devices, 60 clicks, residual + 0.4 ms rms jitter',
          maxRecoveryErrorMs: maxErr,
          overall: report.overall,
          devices: report.devices.map((d) => ({ id: d.deviceId, detected: d.detected, meanMs: d.meanMs, stdMs: d.stdMs, p95AbsMs: d.p95AbsMs })),
        },
        null,
        2,
      ),
    );
  }, 60_000);

  it('Bluetooth wobble readout: a speaker with ±3 ms jitter stands out, the steady ones stay under 1 ms', () => {
    const speakers = referenceSpeakers().map((s) => ({ ...s, latencyMs: 0 }));
    const rnd = mulberry32(23);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const sigma: Record<string, number> = { phone: 0.2, laptop: 0.2, bt: 3, desktop: 0.2 };
    const jitter = Object.fromEntries(speakers.map((s) => [s.id, Array.from({ length: 10 }, () => sigma[s.id]! * gauss())]));
    // the 10 s run the tuning flow does when a Bluetooth speaker is present
    const slots = buildSyncMeasurementSlots(speakers.map((s) => s.id), { durationSec: 10 });
    const plan: CalibrationPlan = { id: 'm2', listenerId: 'l', startRoomTime: 5_000_000, slots, purpose: 'measure' };
    const recording = renderListenerRecording({
      plan,
      speakers,
      listener: LISTENER,
      sampleRate: SIM_SR,
      durationMs: calibrationRecordingMs(slots, SYNC_SEARCH_LATE_MS),
      inputLatencyMs: 12,
      noiseDb: -50,
      clickJitterMs: (id, k) => jitter[id]![k]!,
    });
    const report = analyzeSyncMeasurement({
      plan,
      recording,
      sampleRate: SIM_SR,
      toRoomMs: (i) => plan.startRoomTime + (i / SIM_SR) * 1000,
      expectedMs: expect0(speakers),
    });
    const std = Object.fromEntries(report.devices.map((d) => [d.deviceId, d.stdMs]));
    // errors are relative to the group mean, so the readout is ~(n−1)/n of the true σ for the wobbly one
    expect(std.bt).toBeGreaterThan(1.5);
    expect(std.bt).toBeLessThan(4);
    for (const id of ['phone', 'laptop', 'desktop']) expect(std[id]).toBeLessThan(1);
  }, 60_000);
});
