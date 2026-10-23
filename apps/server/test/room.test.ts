import { describe, expect, it } from 'vitest';
import {
  MIN_SCHEDULE_LEAD_MS,
  SCHEDULE_SAFETY_MARGIN_MS,
  type ClientMessage,
  type DeviceCaps,
  type DeviceStats,
  type ServerMessage,
  type Track,
} from '@syncsound/protocol';
import { AUTO_PLACE_RADIUS_M, Room, type Outbound, type Profile } from '../src/room.ts';
import { passwords } from '../src/roomManager.ts';

const CODE = 'ABCDEF';
const caps = (deviceClass: DeviceCaps['deviceClass'] = 'phone'): DeviceCaps => ({
  userAgent: 'test',
  platform: 'test',
  deviceClass,
  sampleRate: 48000,
  baseLatencyMs: null,
  outputLatencyMs: null,
  hasOutputTimestamp: true,
  hasMic: true,
});
const stats = (rttMs: number): DeviceStats => ({
  offsetMs: 0,
  rttMs,
  jitterMs: 1,
  driftPpm: 0,
  syncErrorMs: 0,
  bufferState: 'ready',
  loadedTrackId: null,
  remoteErrorMs: null,
  autoLatencyMs: null,
  battery: null,
});
const track = (id: string, durationSec = 300): Track => ({
  id,
  title: id,
  kind: 'file',
  sourceClass: 'rendered',
  url: `http://localhost/assets/${id}`,
  durationSec,
});

function mkRoom(extra: Partial<ConstructorParameters<typeof Room>[0]> = {}) {
  return new Room({ code: CODE, hostKey: 'HOSTKEY', createdAt: 0, passwords, clock: () => 99999, ...extra });
}
function join(
  room: Room,
  conn: string,
  deviceId: string,
  extra: Partial<Extract<ClientMessage, { type: 'JOIN' }>> = {},
  now = 1000,
) {
  return room.join(
    conn,
    { type: 'JOIN', roomCode: CODE, deviceId, name: deviceId, caps: caps(), ...extra },
    now,
  );
}
const of = <T extends ServerMessage['type']>(outs: Outbound[], type: T) =>
  outs.filter((o) => o.msg.type === type) as Array<{
    to: Outbound['to'];
    msg: Extract<ServerMessage, { type: T }>;
  }>;
const one = <T extends ServerMessage['type']>(outs: Outbound[], type: T) => {
  const found = of(outs, type);
  expect(found, `expected one ${type} in ${outs.map((o) => o.msg.type).join(',')}`).toHaveLength(1);
  return found[0]!;
};
const ctl = (command: Extract<ClientMessage, { type: 'CONTROL' }>['command']): ClientMessage => ({
  type: 'CONTROL',
  command,
});

/** host h (conn ch) + guests g1/g2 */
function setup() {
  const room = mkRoom();
  join(room, 'ch', 'h', { hostKey: 'HOSTKEY' });
  join(room, 'c1', 'g1');
  join(room, 'c2', 'g2');
  return room;
}

describe('Room join', () => {
  it('welcomes the joiner, notifies others, marks the host and auto-places on a circle', () => {
    const room = mkRoom();
    const h = join(room, 'ch', 'h', { hostKey: 'HOSTKEY' });
    expect(h.ok).toBe(true);
    const w = one(h.out, 'WELCOME');
    expect(w.to).toEqual(['ch']);
    expect(w.msg.isHost).toBe(true);
    expect(w.msg.roomState.hostId).toBe('h');

    const g = join(room, 'c1', 'g1', { caps: caps('laptop') });
    expect(one(g.out, 'WELCOME').msg.isHost).toBe(false);
    expect(one(g.out, 'DEVICE_LIST').to).toBe('others');
    expect(one(g.out, 'SCENE').to).toBe('others');
    expect(room.resolve('others', 'c1')).toEqual(['ch']);

    const dev = room.device('g1')!;
    expect(dev).toMatchObject({
      role: 'Full',
      volume: 1,
      trimDb: 0,
      latencyMs: 0,
      calibratedLatencyMs: null,
      bassCapable: true,
    });
    expect(room.device('h')!.bassCapable).toBe(false); // phone
    const { listener, devices } = room.state.scene;
    for (const id of ['h', 'g1']) {
      const p = devices[id]!;
      expect(Math.hypot(p.x - listener.x, p.y - listener.y)).toBeCloseTo(AUTO_PLACE_RADIUS_M, 2);
    }
    expect(devices.h).not.toEqual(devices.g1);
  });

  it('auto-places inside the room even when the listener sits at a wall', () => {
    const room = mkRoom();
    join(room, 'ch', 'h', { hostKey: 'HOSTKEY' });
    room.handle('ch', { type: 'SCENE_UPDATE', listener: { x: -4, y: 3 } }, 1000);
    for (let i = 0; i < 6; i++) join(room, `c${i}`, `g${i}`);
    const { room: r, devices } = room.state.scene;
    for (const p of Object.values(devices)) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(r.width / 2);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(r.depth / 2);
    }
  });

  it('enforces the password unless the hostKey matches', () => {
    const room = mkRoom({ passwordHash: passwords.hash('s3cret') });
    expect(room.state.settings.hasPassword).toBe(true);
    expect(one(join(room, 'c1', 'g1').out, 'ERROR').msg.code).toBe('bad_password');
    expect(one(join(room, 'c1', 'g1', { password: 'nope' }).out, 'ERROR').msg.code).toBe('bad_password');
    expect(room.connectedCount).toBe(0);
    expect(join(room, 'c1', 'g1', { password: 's3cret' }).ok).toBe(true);
    expect(join(room, 'ch', 'h', { hostKey: 'HOSTKEY' }).ok).toBe(true);
    expect(join(room, 'cx', 'x', { hostKey: 'WRONG' }).ok).toBe(false);
  });

  it('duplicate JOIN from the same deviceId replaces the old connection without duplicating the device', () => {
    const room = mkRoom();
    join(room, 'c1', 'g1');
    const again = join(room, 'c2', 'g1', {}, 2000);
    expect(again.ok).toBe(true);
    expect(again.replacedConnId).toBe('c1');
    expect(room.state.devices).toHaveLength(1);
    expect(room.connIds()).toEqual(['c2']);
    expect(room.leave('c1', 3000)).toEqual([]); // stale socket closing must not disconnect the device
    expect(room.device('g1')!.connected).toBe(true);
    expect(join(room, 'c2', 'g1').replacedConnId).toBeUndefined(); // same conn re-JOIN is a no-op replace
    expect(one(join(room, 'c2', 'other').out, 'ERROR').msg.code).toBe('already_joined');
  });

  it('restores persisted profiles for a known deviceId', () => {
    const store = new Map<string, Profile>();
    const profiles = {
      get: (id: string) => store.get(id),
      set: (id: string, p: Profile) => void store.set(id, p),
    };
    const a = mkRoom({ profiles });
    join(a, 'c1', 'g1');
    a.handle('c1', { type: 'DEVICE_UPDATE', patch: { role: 'L', latencyMs: 42, name: 'Kitchen', volume: 0.6 } }, 1100);
    expect(store.get('g1')).toMatchObject({ role: 'L', latencyMs: 42, name: 'Kitchen', volume: 0.6 });

    const b = mkRoom({ profiles });
    join(b, 'c9', 'g1');
    expect(b.device('g1')).toMatchObject({ role: 'L', latencyMs: 42, name: 'Kitchen', volume: 0.6, connected: true });
  });

  it('rejects messages from connections that never joined', () => {
    const room = setup();
    expect(one(room.handle('ghost', { type: 'PING', t0: 1 }, 1000), 'ERROR').msg.code).toBe('not_joined');
  });
});

describe('Room seq + ping', () => {
  it('assigns a strictly increasing seq to every outgoing message', () => {
    const room = mkRoom();
    const outs = [
      ...join(room, 'ch', 'h', { hostKey: 'HOSTKEY' }).out,
      ...join(room, 'c1', 'g1').out,
      ...room.handle('c1', { type: 'PING', t0: 5 }, 1100),
      ...room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1200),
      ...room.handle('ch', ctl({ type: 'play' }), 1300),
      ...room.handle('c1', { type: 'RTC_SIGNAL', to: 'zzz', data: { kind: 'hangup' } }, 1400),
      ...room.leave('c1', 1500),
    ];
    const seqs = outs.map((o) => o.msg.seq);
    expect(seqs.length).toBeGreaterThan(8);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('PONG echoes t0, uses the arrival time as ts_recv and the clock as ts_send, sender only', () => {
    const room = setup();
    const pong = one(room.handle('c1', { type: 'PING', t0: 123.5 }, 5000), 'PONG');
    expect(pong.to).toEqual(['c1']);
    expect(pong.msg).toMatchObject({ t0: 123.5, ts_recv: 5000, ts_send: 99999 });
  });
});

describe('Room playback control', () => {
  it('schedule lead is ≥ max connected RTT + safety margin, and ≥ the minimum', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1000);
    let s = one(room.handle('ch', ctl({ type: 'play' }), 2000), 'SCHEDULE');
    expect(s.msg.startRoomTime - 2000).toBe(MIN_SCHEDULE_LEAD_MS);

    room.handle('c1', { type: 'STATS', stats: stats(400) }, 3000);
    room.handle('c2', { type: 'STATS', stats: stats(50) }, 3000);
    s = one(room.handle('ch', ctl({ type: 'seek', position: 10 }), 4000), 'SCHEDULE');
    expect(s.msg.startRoomTime - 4000).toBeGreaterThanOrEqual(400 + SCHEDULE_SAFETY_MARGIN_MS);

    room.leave('c1', 5000); // disconnected device RTT no longer counts
    s = one(room.handle('ch', ctl({ type: 'seek', position: 10 }), 6000), 'SCHEDULE');
    expect(s.msg.startRoomTime - 6000).toBe(MIN_SCHEDULE_LEAD_MS);
  });

  it('play → pause → seek → resume position math', () => {
    const room = setup();
    const q = room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1000);
    expect(one(q, 'STATE').msg.roomState.playback).toMatchObject({ status: 'stopped', trackId: 'a' });

    const play = room.handle('ch', ctl({ type: 'play' }), 1000);
    const s1 = one(play, 'SCHEDULE');
    expect(s1.to).toBe('all');
    expect(s1.msg).toMatchObject({ action: 'play', startRoomTime: 1250, trackOffset: 0, trackId: 'a' });
    expect(one(play, 'STATE').to).toBe('all');

    // pause decided at now=11250 takes effect at T=11500: position = (11500-1250)/1000
    const s2 = one(room.handle('ch', ctl({ type: 'pause' }), 11250), 'SCHEDULE');
    expect(s2.msg).toMatchObject({ action: 'pause', startRoomTime: 11500 });
    expect(s2.msg.trackOffset).toBeCloseTo(10.25, 9);
    expect(room.state.playback.status).toBe('paused');

    // repeated pause must not move the position
    const again = room.handle('ch', ctl({ type: 'pause' }), 20000);
    expect(of(again, 'SCHEDULE')).toHaveLength(0);
    expect(room.state.playback.trackOffset).toBeCloseTo(10.25, 9);

    // seek while paused keeps paused
    const s3 = one(room.handle('ch', ctl({ type: 'seek', position: 42 }), 21000), 'SCHEDULE');
    expect(s3.msg).toMatchObject({ action: 'seek', trackOffset: 42 });
    expect(room.state.playback.status).toBe('paused');

    // resume continues from the paused offset
    const s4 = one(room.handle('ch', ctl({ type: 'play' }), 30000), 'SCHEDULE');
    expect(s4.msg).toMatchObject({ action: 'play', startRoomTime: 30250, trackOffset: 42 });
    expect(room.positionAt(32250)).toBeCloseTo(44, 9);

    // repeated play keeps the running timeline
    const s5 = one(room.handle('ch', ctl({ type: 'play' }), 31000), 'SCHEDULE');
    expect(s5.msg).toMatchObject({ startRoomTime: 30250, trackOffset: 42 });

    // seek while playing reschedules at T
    const s6 = one(room.handle('ch', ctl({ type: 'seek', position: 100 }), 40000), 'SCHEDULE');
    expect(s6.msg).toMatchObject({ action: 'seek', startRoomTime: 40250, trackOffset: 100 });
    expect(room.state.playback.status).toBe('playing');

    const s7 = one(room.handle('ch', ctl({ type: 'stop' }), 50000), 'SCHEDULE');
    expect(s7.msg).toMatchObject({ action: 'stop', trackOffset: 0 });
    expect(room.state.playback.status).toBe('stopped');
  });

  it('next/previous move through the queue keeping the playing state', () => {
    const room = setup();
    for (const id of ['a', 'b', 'c']) room.handle('ch', ctl({ type: 'queue', track: track(id) }), 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1000); // duplicate queue is ignored
    expect(room.state.queue.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    room.handle('ch', ctl({ type: 'play', position: 30 }), 1000);

    let s = one(room.handle('ch', ctl({ type: 'next' }), 2000), 'SCHEDULE');
    expect(s.msg).toMatchObject({ action: 'play', trackId: 'b', trackOffset: 0, startRoomTime: 2250 });
    s = one(room.handle('ch', ctl({ type: 'previous' }), 3000), 'SCHEDULE');
    expect(s.msg).toMatchObject({ action: 'play', trackId: 'a', trackOffset: 0 });

    room.handle('ch', ctl({ type: 'pause' }), 4000);
    const n = room.handle('ch', ctl({ type: 'next' }), 5000);
    expect(of(n, 'SCHEDULE')).toHaveLength(0);
    expect(room.state.playback).toMatchObject({ status: 'paused', trackId: 'b', trackOffset: 0 });

    room.handle('ch', ctl({ type: 'play' }), 6000);
    room.handle('ch', ctl({ type: 'next' }), 7000);
    s = one(room.handle('ch', ctl({ type: 'next' }), 8000), 'SCHEDULE'); // past the end → stop
    expect(s.msg.action).toBe('stop');
    expect(room.state.playback.status).toBe('stopped');
  });

  it('remove of the current track stops and selects the neighbour; volume sets master', () => {
    const room = setup();
    for (const id of ['a', 'b']) room.handle('ch', ctl({ type: 'queue', track: track(id) }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 1000);
    expect(one(room.handle('ch', ctl({ type: 'remove', trackId: 'a' }), 2000), 'SCHEDULE').msg.action).toBe(
      'stop',
    );
    expect(room.state.playback).toMatchObject({ status: 'stopped', trackId: 'b' });
    room.handle('ch', ctl({ type: 'volume', volume: 0.3 }), 3000);
    expect(room.state.volume).toBe(0.3);
    expect(one(room.handle('ch', ctl({ type: 'play', trackId: 'nope' }), 3000), 'ERROR').msg.code).toBe(
      'unknown_track',
    );
  });

  it('hostOnlyControl restricts CONTROL to the host; SETTINGS_UPDATE is host-only', () => {
    const room = setup();
    room.handle('c1', ctl({ type: 'queue', track: track('a') }), 1000);
    expect(room.state.queue).toHaveLength(1); // open control by default

    expect(
      one(room.handle('c1', { type: 'SETTINGS_UPDATE', hostOnlyControl: true }, 1000), 'ERROR').msg.code,
    ).toBe('forbidden');
    const st = one(
      room.handle('ch', { type: 'SETTINGS_UPDATE', hostOnlyControl: true, password: 'pw' }, 1000),
      'STATE',
    );
    expect(st.msg.roomState.settings).toMatchObject({ hostOnlyControl: true, hasPassword: true });

    expect(one(room.handle('c1', ctl({ type: 'play' }), 2000), 'ERROR').msg.code).toBe('forbidden');
    expect(room.state.playback.status).toBe('stopped');
    expect(one(room.handle('ch', ctl({ type: 'play' }), 2000), 'SCHEDULE').msg.action).toBe('play');

    room.handle('ch', { type: 'SETTINGS_UPDATE', password: null }, 3000);
    expect(room.state.settings.hasPassword).toBe(false);
  });
});

describe('Room devices + scene', () => {
  it('DEVICE_UPDATE: self always; others only when host or control is open', () => {
    const room = setup();
    one(room.handle('c1', { type: 'DEVICE_UPDATE', patch: { volume: 0.5 } }, 1000), 'DEVICE_LIST');
    expect(room.device('g1')!.volume).toBe(0.5);

    room.handle('c1', { type: 'DEVICE_UPDATE', targetDeviceId: 'g2', patch: { muted: true } }, 1000);
    expect(room.device('g2')!.muted).toBe(true); // open control

    room.handle('ch', { type: 'SETTINGS_UPDATE', hostOnlyControl: true }, 1000);
    const denied = room.handle(
      'c1',
      { type: 'DEVICE_UPDATE', targetDeviceId: 'g2', patch: { muted: false } },
      1000,
    );
    expect(one(denied, 'ERROR').msg.code).toBe('forbidden');
    expect(room.device('g2')!.muted).toBe(true);
    room.handle('c1', { type: 'DEVICE_UPDATE', patch: { role: 'R' } }, 1000);
    expect(room.device('g1')!.role).toBe('R');

    one(
      room.handle('ch', { type: 'DEVICE_UPDATE', targetDeviceId: 'g2', patch: { muted: false } }, 1000),
      'DEVICE_LIST',
    );
    expect(room.device('g2')!.muted).toBe(false);
    expect(
      one(room.handle('ch', { type: 'DEVICE_UPDATE', targetDeviceId: 'nobody', patch: {} }, 1000), 'ERROR')
        .msg.code,
    ).toBe('unknown_target');
  });

  it('SCENE_UPDATE merges, ignores unknown device ids and goes to others', () => {
    const room = setup();
    const out = one(
      room.handle(
        'c1',
        { type: 'SCENE_UPDATE', rolloff: 2, devices: { g1: { x: 1, y: 1 }, ghost: { x: 3, y: 3 } } },
        1000,
      ),
      'SCENE',
    );
    expect(out.to).toBe('others');
    expect(out.msg.scene.rolloff).toBe(2);
    expect(out.msg.scene.devices.g1).toEqual({ x: 1, y: 1 });
    expect(out.msg.scene.devices.ghost).toBeUndefined();
    expect(out.msg.scene.devices.h).toBeDefined();
  });

  it('calibration: plan broadcast to all, results applied to devices', () => {
    const room = setup();
    room.handle('c2', { type: 'STATS', stats: stats(100) }, 900);
    const slots = [
      { deviceId: 'g1', deviceIndex: 0, signal: 'chirp' as const, offsetMs: 0, durationMs: 500 },
      { deviceId: 'h', deviceIndex: 1, signal: 'chirp' as const, offsetMs: 600, durationMs: 500 },
    ];
    const plan = one(room.handle('c2', { type: 'CALIBRATION_START', slots }, 1000), 'CALIBRATION_PLAN');
    expect(plan.to).toBe('all');
    expect(plan.msg.plan).toMatchObject({ listenerId: 'g2', slots, startRoomTime: 2500 });

    const eq = {
      enabled: true,
      bands: [{ type: 'peaking' as const, freq: 1000, gainDb: -3, q: 1 }],
      highpassHz: 120,
      preampDb: -1,
      source: 'measured' as const,
    };
    const res = room.handle(
      'c2',
      {
        type: 'CALIBRATION_RESULT',
        planId: plan.msg.plan.id,
        results: [
          {
            deviceId: 'g1',
            heard: true,
            calibratedLatencyMs: 87,
            eq,
            rolloffHz: 150,
            bassCapable: false,
            trimDb: -2,
            volumeUpDb: 7.5,
          },
          { deviceId: 'h', heard: true, volumeUpDb: null },
          { deviceId: 'ghost', heard: true, calibratedLatencyMs: 1 },
        ],
      },
      5000,
    );
    one(res, 'DEVICE_LIST');
    expect(room.device('g1')).toMatchObject({
      calibratedLatencyMs: 87,
      eq,
      rolloffHz: 150,
      bassCapable: false,
      trimDb: -2,
      volumeUpDb: 7.5,
    });
    expect(room.device('h')!.calibratedLatencyMs).toBeNull();
    expect(room.device('h')!.volumeUpDb).toBeNull();

    const bad = room.handle('c2', { type: 'CALIBRATION_RESULT', planId: 'nope', results: [] }, 5000);
    expect(one(bad, 'ERROR').msg.code).toBe('unknown_plan');
  });

  it('IDENTIFY broadcasts with a lead; RTC_SIGNAL relays to the target only', () => {
    const room = setup();
    const id = one(room.handle('c1', { type: 'IDENTIFY', targetDeviceId: 'g2' }, 1000), 'IDENTIFY');
    expect(id.msg).toMatchObject({ targetDeviceId: 'g2', startRoomTime: 1250 });

    const data = { kind: 'offer' as const, sdp: 'v=0' };
    const rtc = one(room.handle('c1', { type: 'RTC_SIGNAL', to: 'g2', data }, 1000), 'RTC_SIGNAL');
    expect(rtc.to).toEqual(['c2']);
    expect(rtc.msg).toMatchObject({ from: 'g1', data });
    expect(rtc.msg).not.toHaveProperty('ch');
    const clk = one(room.handle('c1', { type: 'RTC_SIGNAL', to: 'g2', data, ch: 'clock' }, 1000), 'RTC_SIGNAL');
    expect(clk.msg).toMatchObject({ from: 'g1', data, ch: 'clock' });

    const err = one(room.handle('c1', { type: 'RTC_SIGNAL', to: 'nobody', data }, 1000), 'ERROR');
    expect(err).toMatchObject({ to: ['c1'], msg: { code: 'unknown_target' } });
  });

  it('only one capture host at a time; leaving clears it', () => {
    const room = setup();
    expect(
      one(room.handle('c1', { type: 'CAPTURE', active: true }, 1000), 'STATE').msg.roomState.captureHostId,
    ).toBe('g1');
    expect(one(room.handle('c2', { type: 'CAPTURE', active: true }, 1000), 'ERROR').msg.code).toBe(
      'capture_busy',
    );
    room.handle('c2', { type: 'CAPTURE', active: false }, 1000); // non-owner stop is a no-op
    expect(room.state.captureHostId).toBe('g1');

    const left = room.leave('c1', 2000);
    expect(one(left, 'DEVICE_LIST').msg.devices.find((d) => d.id === 'g1')!.connected).toBe(false);
    expect(one(left, 'STATE').msg.roomState.captureHostId).toBeNull();
    room.handle('c2', { type: 'CAPTURE', active: true }, 3000);
    expect(room.state.captureHostId).toBe('g2');
  });

  it('STATS stores and throttles DEVICE_LIST to 1/s per room', () => {
    const room = setup();
    expect(of(room.handle('c1', { type: 'STATS', stats: stats(10) }, 1000), 'DEVICE_LIST')).toHaveLength(1);
    expect(room.handle('c2', { type: 'STATS', stats: stats(20) }, 1500)).toEqual([]);
    expect(room.device('g2')!.stats!.rttMs).toBe(20);
    const later = one(room.handle('c1', { type: 'STATS', stats: stats(30) }, 2001), 'DEVICE_LIST');
    expect(later.msg.devices.find((d) => d.id === 'g2')!.stats!.rttMs).toBe(20);
    expect(later.msg.devices.find((d) => d.id === 'g1')!.stats!.rttMs).toBe(30);
  });
});
