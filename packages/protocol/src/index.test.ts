import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultScene, isValidRoomCode, parseClientMessage, parseServerMessage, ServerMessage, withLegacyDefaults } from './index';

describe('protocol', () => {
  it('validates room codes', () => {
    expect(isValidRoomCode('ABC234')).toBe(true);
    expect(isValidRoomCode('ABC10O')).toBe(false); // ambiguous chars excluded
    expect(isValidRoomCode('ABC23')).toBe(false);
  });
  it('accepts a PING and rejects junk', () => {
    expect(parseClientMessage({ type: 'PING', t0: 12.5 }).success).toBe(true);
    expect(parseClientMessage({ type: 'PING', t0: 'x' }).success).toBe(false);
    expect(parseClientMessage({ type: 'NOPE' }).success).toBe(false);
  });
  it('default scene is valid in SCENE_UPDATE', () => {
    const s = defaultScene();
    expect(parseClientMessage({ type: 'SCENE_UPDATE', objects: s.objects, listener: s.listener }).success).toBe(true);
  });
});

describe('protocol validation (trust boundary)', () => {
  const caps = {
    userAgent: 'x',
    platform: 'mac',
    deviceClass: 'laptop',
    sampleRate: 48000,
    baseLatencyMs: 5,
    outputLatencyMs: null,
    hasOutputTimestamp: true,
    hasMic: true,
  };
  const join = { type: 'JOIN', roomCode: 'ABC234', deviceId: 'dev_1', name: 'Phone', caps };

  it('accepts a valid JOIN and rejects bad ids, codes, names and caps', () => {
    expect(parseClientMessage(join).success).toBe(true);
    expect(parseClientMessage({ ...join, deviceId: '../etc' }).success).toBe(false);
    expect(parseClientMessage({ ...join, roomCode: 'abc234' }).success).toBe(false);
    expect(parseClientMessage({ ...join, name: 'x'.repeat(41) }).success).toBe(false);
    expect(parseClientMessage({ ...join, name: '   ' }).success).toBe(false);
    expect(parseClientMessage({ ...join, caps: { ...caps, deviceClass: 'toaster' } }).success).toBe(false);
  });

  it('rejects non-finite numbers and out-of-range scene/device values', () => {
    expect(parseClientMessage({ type: 'PING', t0: Infinity }).success).toBe(false);
    expect(parseClientMessage({ type: 'SCENE_UPDATE', listener: { x: 999, y: 0 } }).success).toBe(false);
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { latencyMs: 1001 } }).success).toBe(false);
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { latencyMs: -1001 } }).success).toBe(false);
    // slow Bluetooth speakers need more than the old ±500 ms
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { latencyMs: 750 } }).success).toBe(true);
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { latencyMs: -1000, trimDb: 12 } }).success).toBe(true);
    expect(parseClientMessage({ type: 'CONTROL', command: { type: 'seek', position: -1 } }).success).toBe(false);
    expect(parseClientMessage({ type: 'CONTROL', command: { type: 'volume', volume: 1.5 } }).success).toBe(false);
  });

  it('bounds calibration plans and repeats', () => {
    const slot = { deviceId: 'd1', deviceIndex: 0, signal: 'chirp', offsetMs: 500, durationMs: 400 };
    expect(parseClientMessage({ type: 'CALIBRATION_START', slots: [slot] }).success).toBe(true);
    expect(parseClientMessage({ type: 'CALIBRATION_START', slots: [] }).success).toBe(false);
    expect(
      parseClientMessage({ type: 'CALIBRATION_START', slots: [{ ...slot, repeat: 60, periodMs: 1000 }], purpose: 'measure' }).success,
    ).toBe(true);
    expect(parseClientMessage({ type: 'CALIBRATION_START', slots: [{ ...slot, repeat: 601 }] }).success).toBe(false);
    // the tune's swoosh → chime, and the plain sweep of older tunes
    for (const signal of ['tune', 'sweep'])
      expect(parseClientMessage({ type: 'CALIBRATION_START', slots: [{ ...slot, signal, durationMs: 1100 }], recorders: 'all' }).success).toBe(true);
    expect(parseClientMessage({ type: 'CALIBRATION_START', slots: [{ ...slot, signal: 'chime' }] }).success).toBe(false);
  });

  it('device patches carry the tune invariant, never the derived compensation', () => {
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { tuneArrivalMs: 12.5, tuneId: 'p1', tuneStale: null } }).success).toBe(true);
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { tuneStale: 'route' } }).success).toBe(true);
    expect(parseClientMessage({ type: 'DEVICE_UPDATE', patch: { tuneArrivalMs: -1 } }).success).toBe(false);
    const p = parseClientMessage({ type: 'DEVICE_UPDATE', patch: { calibratedLatencyMs: 50 } });
    expect(p.success && p.data.type === 'DEVICE_UPDATE' && 'calibratedLatencyMs' in p.data.patch).toBe(false); // unknown keys are stripped
    const result = { type: 'CALIBRATION_RESULT', planId: 'p1', results: [{ deviceId: 'd1', heard: true, tuneArrivalMs: 3 }], tune: { mic: { x: 0, y: 1 }, quick: false, ranged: ['d1'], positions: { d1: { x: 1, y: 2 } } } };
    expect(parseClientMessage(result).success).toBe(true);
    expect(parseClientMessage({ ...result, tune: undefined }).success).toBe(false);
  });

  it('a prepared run: caps carry the mic permission, recorders answer READY, the server announces PREPARE', () => {
    expect(parseClientMessage({ ...join, caps: { ...caps, micPermission: 'granted' } }).success).toBe(true);
    expect(parseClientMessage({ ...join, caps: { ...caps, micPermission: 'maybe' } }).success).toBe(false);
    expect(parseClientMessage({ type: 'CAPS_UPDATE', caps: { ...caps, micPermission: 'denied' } }).success).toBe(true);
    const slot = { deviceId: 'd1', deviceIndex: 0, signal: 'tune', offsetMs: 500, durationMs: 1100 };
    expect(parseClientMessage({ type: 'CALIBRATION_START', slots: [slot], recorders: 'all', prepare: true }).success).toBe(true);
    expect(parseClientMessage({ type: 'CALIBRATION_READY', planId: 'p1', ok: false, reason: 'no mic' }).success).toBe(true);
    expect(parseClientMessage({ type: 'CALIBRATION_READY', planId: 'p1', ok: 'yes' }).success).toBe(false);
    expect(parseServerMessage({ type: 'CALIBRATION_PREPARE', planId: 'p1', listenerId: 'd1', recorderIds: ['d2'], deadlineRoomTime: 5, seq: 1 }).success).toBe(true);
    expect(parseServerMessage({ type: 'CALIBRATION_READY', planId: 'p1', recorderId: 'd2', ok: true, seq: 2 }).success).toBe(true);
  });

  it('calibration rows may flag invalid emissions; a run can be cancelled', () => {
    const rows = { type: 'CALIBRATION_ROWS', planId: 'p1', rows: [], valid: false, emissionValid: false, reason: 'clock moved' };
    expect(parseClientMessage(rows).success).toBe(true);
    expect(parseClientMessage({ ...rows, emissionValid: 'no' }).success).toBe(false);
    expect(parseClientMessage({ type: 'CALIBRATION_CANCEL', planId: 'p1' }).success).toBe(true);
    expect(parseServerMessage({ type: 'CALIBRATION_CANCELLED', planId: 'p1', seq: 3 }).success).toBe(true);
  });

  it('server messages require a seq and a known type', () => {
    const pong = { type: 'PONG', t0: 1, ts_recv: 2, ts_send: 3 };
    expect(parseServerMessage({ ...pong, seq: 4 }).success).toBe(true);
    expect(parseServerMessage(pong).success).toBe(false);
    expect(parseServerMessage({ type: 'SCHEDULE', action: 'play', startRoomTime: 1, trackOffset: 0, trackId: 't', seq: 1 }).success).toBe(true);
    expect(parseServerMessage({ type: 'SCHEDULE', action: 'rewind', startRoomTime: 1, trackOffset: 0, trackId: 't', seq: 1 }).success).toBe(false);
  });

  it('RTC signaling payloads are bounded', () => {
    expect(parseClientMessage({ type: 'RTC_SIGNAL', to: 'd2', data: { kind: 'offer', sdp: 'v=0' } }).success).toBe(true);
    expect(parseClientMessage({ type: 'RTC_SIGNAL', to: 'd2', data: { kind: 'offer', sdp: 'x'.repeat(20001) } }).success).toBe(false);
    expect(parseClientMessage({ type: 'RTC_SIGNAL', to: 'd2', ch: 'clock', data: { kind: 'hangup' } }).success).toBe(true);
    expect(parseClientMessage({ type: 'RTC_SIGNAL', to: 'd2', ch: 'video', data: { kind: 'hangup' } }).success).toBe(false);
  });
});

describe('older servers', () => {
  // a real WELCOME from a server deployed before crossfade and tune identity (captured from Cloud Run)
  const welcome = JSON.parse(readFileSync(new URL('./fixtures/welcome-before-tune-identity.json', import.meta.url), 'utf8'));

  it('accepts a message that only lacks newer fields, with the safe defaults', () => {
    expect(ServerMessage.safeParse(welcome).success).toBe(false); // the strict schema alone rejects it
    const r = parseServerMessage(welcome);
    expect(r.success).toBe(true);
    if (!r.success || r.data.type !== 'WELCOME') throw new Error('expected a WELCOME');
    expect(r.data.roomState.settings.crossfadeSec).toBe(0);
    expect(r.data.roomState.devices[0]).toMatchObject({ tuneArrivalMs: null, tuneId: null, tuneStale: null, syncState: 'untuned' });
  });

  it('never overrides a value the server sent, and still rejects a real mismatch', () => {
    const tuned = structuredClone(welcome);
    tuned.roomState.settings.crossfadeSec = 4;
    tuned.roomState.devices[0].syncState = 'tuned';
    const r = parseServerMessage(tuned);
    expect(r.success && r.data.type === 'WELCOME' && r.data.roomState.settings.crossfadeSec).toBe(4);
    expect(r.success && r.data.type === 'WELCOME' && r.data.roomState.devices[0]!.syncState).toBe('tuned');
    const broken = structuredClone(welcome);
    broken.roomState.devices[0].caps = 'not caps';
    expect(parseServerMessage(broken).success).toBe(false);
    expect(withLegacyDefaults({ type: 'PONG', t0: 1 })).toEqual({ type: 'PONG', t0: 1 });
  });
});
