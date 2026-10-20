import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CalibrationPlan, Vec2 } from '@syncsound/protocol';
import {
  analyzeSyncMeasurement,
  buildSyncMeasurementSlots,
  calibrationRecordingMs,
  mulberry32,
} from '@syncsound/audio-core';
import { referenceSpeakers, renderListenerRecording, SIM_SR } from '../src/acoustics';

const LISTENER: Vec2 = { x: 0, y: 1 };

// Sync-measurement tool (spec §11.1), simulated: four devices playing compensated clicks simultaneously in
// distinct chirp bands. Each has a known residual sync error (what calibration left over) and per-click jitter.
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
      durationMs: calibrationRecordingMs(slots, 300),
      inputLatencyMs: 12,
      noiseDb: -50,
      clickJitterMs: (id, k) => jitter[id]![k]!,
    });
    const report = analyzeSyncMeasurement({
      plan,
      recording,
      sampleRate: SIM_SR,
      recordingStartRoomTime: plan.startRoomTime,
      devicePositions: Object.fromEntries(speakers.map((s) => [s.id, s.position])),
      listener: LISTENER,
      maxLatencyMs: 300,
    });

    // truth per click: (residual + jitter) − mean over devices
    let maxErr = 0;
    for (let k = 0; k < 60; k++) {
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
});
