import { describe, expect, it } from 'vitest';
import { QueueTrack, Track, defaultScene, isValidRoomCode, parseClientMessage, parseServerMessage } from './index';

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

describe('Spotify queue inputs', () => {
  const ID = 'A'.repeat(22);
  const sp = (extra: Record<string, unknown> = {}) => ({
    id: 't1',
    title: 'Song',
    kind: 'spotify',
    sourceClass: 'remote',
    remoteId: `spotify:track:${ID}`,
    durationSec: 200,
    artist: 'Band',
    album: 'LP',
    artworkUrl: 'https://i.scdn.co/image/ab67616d00001e02',
    ...extra,
  });
  const queue = (track: unknown) => parseClientMessage({ type: 'CONTROL', command: { type: 'queue', track } }).success;
  const many = (cmd: Record<string, unknown>) => parseClientMessage({ type: 'CONTROL', command: { type: 'queueMany', mode: 'append', ...cmd } }).success;

  it('needs one song and its duration; artwork only from Spotify image hosts', () => {
    expect(queue(sp())).toBe(true);
    expect(queue(sp({ durationSec: undefined }))).toBe(false); // the room can't advance past it
    expect(queue(sp({ remoteId: `spotify:playlist:${ID}` }))).toBe(false);
    expect(queue(sp({ sourceClass: 'rendered' }))).toBe(false);
    expect(queue(sp({ artworkUrl: 'https://evil.example/x.png' }))).toBe(false);
    expect(queue(sp({ artworkUrl: 'https://image-cdn-ak.spotifycdn.com/image/x' }))).toBe(true);
    expect(queue(sp({ artworkUrl: 'http://i.scdn.co/image/x' }))).toBe(false);
    // other remote sources keep their rules
    expect(queue({ id: 'a1', title: 'S', kind: 'apple', sourceClass: 'remote', remoteId: '1440833098' })).toBe(true);
  });

  it('queueMany: 1–100 unique tracks, playIndex within the batch', () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => sp({ id: `t${i}` }));
    expect(many({ tracks: batch(3), playIndex: 2, mode: 'replace' })).toBe(true);
    expect(many({ tracks: batch(3), playIndex: 3 })).toBe(false);
    expect(many({ tracks: [] })).toBe(false);
    expect(many({ tracks: batch(100) })).toBe(true);
    expect(many({ tracks: batch(101) })).toBe(false);
    expect(many({ tracks: [sp(), sp()] })).toBe(false); // duplicate ids
    expect(many({ tracks: batch(1), mode: 'shuffle' })).toBe(false);
    expect(many({ tracks: [sp({ durationSec: undefined })] })).toBe(false);
    expect(many({ tracks: batch(2), mode: 'insert', afterTrackId: 't9' })).toBe(true);
  });

  it('room state keeps accepting Spotify tracks without a duration (an older server may hold some)', () => {
    expect(Track.safeParse(sp({ durationSec: undefined })).success).toBe(true);
    expect(QueueTrack.safeParse(sp({ durationSec: undefined })).success).toBe(false);
  });
});
