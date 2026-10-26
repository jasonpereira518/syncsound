import { describe, expect, it } from 'vitest';
import {
  AUTO_ADVANCE_MARGIN_MS,
  MIN_SCHEDULE_LEAD_MS,
  QUEUE_END_STOP_MS,
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
      tuneArrivalMs: null,
      tuneId: null,
      syncState: 'untuned',
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

  it('schedule lead covers each device’s output compensation (Bluetooth starts its source early)', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1000);
    room.handle('c1', { type: 'STATS', stats: { ...stats(30), autoLatencyMs: 40 } }, 1500);
    room.handle('c2', { type: 'STATS', stats: stats(100) }, 1500);
    // a tune by g2 heard g1's chime 220 ms late (its Bluetooth residual) and its own at the near-field prior:
    // derived compensation 220 ms, + manual 10 ms + browser 40 ms = 270 ms on a 30 ms RTT
    const slots = [{ deviceId: 'g1', deviceIndex: 0, signal: 'tune' as const, offsetMs: 500, durationMs: 1100 }];
    const plan = one(room.handle('c2', { type: 'CALIBRATION_START', slots }, 1500), 'CALIBRATION_PLAN').msg.plan;
    room.handle(
      'c2',
      {
        type: 'CALIBRATION_RESULT',
        planId: plan.id,
        results: [
          { deviceId: 'g1', heard: true, tuneArrivalMs: 220 },
          { deviceId: 'g2', heard: true, tuneArrivalMs: (0.1 / 343) * 1000 }, // its own speaker, 0.1 m away
        ],
        tune: { mic: room.state.scene.devices.g1!, quick: false, ranged: [], positions: {} },
      },
      1600,
    );
    room.handle('c1', { type: 'DEVICE_UPDATE', patch: { latencyMs: 10 } }, 1700);
    expect(room.device('g1')!.calibratedLatencyMs).toBeCloseTo(220, 6);
    const s = one(room.handle('ch', ctl({ type: 'play' }), 2000), 'SCHEDULE');
    expect(s.msg.startRoomTime - 2000).toBeCloseTo(30 + 270 + SCHEDULE_SAFETY_MARGIN_MS, 6);

    // a device compensating negatively (plays later) doesn't shorten anything below the RTT rule
    room.handle('c1', { type: 'DEVICE_UPDATE', patch: { tuneId: null, latencyMs: -300 } }, 2500);
    expect(room.device('g1')!.calibratedLatencyMs).toBeNull();
    const s2 = one(room.handle('ch', ctl({ type: 'seek', position: 5 }), 3000), 'SCHEDULE');
    expect(s2.msg.startRoomTime - 3000).toBe(100 + SCHEDULE_SAFETY_MARGIN_MS);
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
    const tune = { mic: { x: 0, y: 0 }, quick: false, ranged: ['g1', 'ghost'], positions: { g1: { x: 1, y: 0 } } };
    const res = room.handle(
      'c2',
      {
        type: 'CALIBRATION_RESULT',
        planId: plan.msg.plan.id,
        results: [
          {
            deviceId: 'g1',
            heard: true,
            tuneArrivalMs: 87,
            eq,
            rolloffHz: 150,
            bassCapable: false,
            trimDb: -2,
            volumeUpDb: 7.5,
          },
          { deviceId: 'h', heard: true, volumeUpDb: null },
          { deviceId: 'ghost', heard: true, tuneArrivalMs: 1 },
        ],
        tune,
      },
      5000,
    );
    one(res, 'DEVICE_LIST');
    expect(one(res, 'SCENE').to).toBe('all');
    expect(room.device('g1')).toMatchObject({
      tuneArrivalMs: 87,
      tuneId: plan.msg.plan.id,
      tuneStale: null,
      syncState: 'tuned',
      calibratedLatencyMs: 0, // the only device in the tune: it is the reference
      eq,
      rolloffHz: 150,
      bassCapable: false,
      trimDb: -2,
      volumeUpDb: 7.5,
    });
    expect(room.device('h')).toMatchObject({ calibratedLatencyMs: null, tuneArrivalMs: null, syncState: 'untuned', volumeUpDb: null });
    expect(room.state.scene.tune).toMatchObject({ id: plan.msg.plan.id, listenerId: 'g2', mic: tune.mic, quick: false, ranged: ['g1'], at: 5000 });

    const bad = room.handle('c2', { type: 'CALIBRATION_RESULT', planId: 'nope', results: [], tune }, 5000);
    expect(one(bad, 'ERROR').msg.code).toBe('unknown_plan');
  });

  it('tune: compensation is derived from the arrivals and the current positions, re-derived when a speaker is moved, and reset by the next run', () => {
    const room = setup();
    const msPerM = 1000 / 343;
    room.handle('ch', { type: 'SCENE_UPDATE', devices: { g1: { x: 0, y: 1 }, h: { x: 0, y: 0 }, g2: { x: 1, y: 0 } } }, 900);
    const slots = [{ deviceId: 'g1', deviceIndex: 0, signal: 'tune' as const, offsetMs: 500, durationMs: 1100 }];
    const plan = one(room.handle('c2', { type: 'CALIBRATION_START', slots }, 1000), 'CALIBRATION_PLAN').msg.plan;
    room.handle(
      'c2',
      {
        type: 'CALIBRATION_RESULT',
        planId: plan.id,
        results: [
          { deviceId: 'g1', heard: true, tuneArrivalMs: 87 },
          { deviceId: 'h', heard: true, tuneArrivalMs: 20 },
        ],
        tune: { mic: { x: 0, y: 0 }, quick: false, ranged: ['g1', 'h'], positions: { g1: { x: 0, y: 1 }, h: { x: 0, y: 0 } } },
      },
      2000,
    );
    // g1 is 1 m from the mic (2.9 ms of air), h at the mic: raw 84.1 / 20 → re-zeroed on h
    expect(room.device('g1')!.calibratedLatencyMs).toBeCloseTo(87 - msPerM - 20, 6);
    expect(room.device('h')!.calibratedLatencyMs).toBeCloseTo(0, 6);
    expect(room.device('g2')!.syncState).toBe('untuned');
    // moving the listener icon changes no derived value while nobody has been dragged (the engine follows the head)
    expect(of(room.handle('ch', { type: 'SCENE_UPDATE', listener: { x: 0, y: 0 } }, 2900), 'DEVICE_LIST')).toHaveLength(0);
    room.handle('ch', { type: 'SCENE_UPDATE', listener: { x: 0, y: 1 } }, 2950);
    // the host drags g1 sideways to (1, 1): 1 m farther from the listener at (0, 1) → the engine delays it 2.9 ms less, so
    // its compensation drops by the same (the sound still reaches the head when it did); everyone is told
    const moved = room.handle('ch', { type: 'SCENE_UPDATE', devices: { g1: { x: 1, y: 1 } } }, 3000);
    one(moved, 'DEVICE_LIST');
    expect(room.device('g1')!.calibratedLatencyMs).toBeCloseTo(87 - 2 * msPerM - 20, 6);
    // a layout change that moves nothing sends no device list
    expect(of(room.handle('ch', { type: 'SCENE_UPDATE', layout: 'stereo' }, 3100), 'DEVICE_LIST')).toHaveLength(0);
    // a device reporting a stale tune is flagged; its value stays in use
    room.handle('c1', { type: 'DEVICE_UPDATE', patch: { tuneStale: 'output' } }, 3200);
    expect(room.device('g1')).toMatchObject({ syncState: 'stale', calibratedLatencyMs: expect.any(Number) });
    // the next run hears only h: g1 drops out of the tune (its old value had a reference that is gone)
    const plan2 = one(room.handle('c2', { type: 'CALIBRATION_START', slots }, 4000), 'CALIBRATION_PLAN').msg.plan;
    room.handle('c2', { type: 'CALIBRATION_RESULT', planId: plan2.id, results: [{ deviceId: 'h', heard: true, tuneArrivalMs: 5 }], tune: { mic: { x: 0, y: 0 }, quick: true, ranged: [], positions: {} } }, 5000);
    expect(room.device('g1')).toMatchObject({ syncState: 'untuned', calibratedLatencyMs: null, tuneId: plan.id });
    expect(room.device('h')).toMatchObject({ syncState: 'tuned', calibratedLatencyMs: 0, tuneId: plan2.id });
    expect(room.state.scene.tune!.ranged).toEqual(['g1', 'h']); // a timing-only run keeps the previous ranging
  });

  it('a late joiner in a laid-out room takes a free slot and its spot; the others stay where they are', () => {
    const room = setup();
    room.handle('ch', { type: 'SCENE_UPDATE', layout: 'stereo', devices: { h: { x: -1.3, y: -1.9 }, g1: { x: 1.2, y: -2.0 } } }, 900);
    room.handle('ch', { type: 'DEVICE_UPDATE', patch: { role: 'L' } }, 901);
    room.handle('ch', { type: 'DEVICE_UPDATE', targetDeviceId: 'g1', patch: { role: 'R' } }, 902);
    room.handle('ch', { type: 'DEVICE_UPDATE', targetDeviceId: 'g2', patch: { role: 'Sub' } }, 903);
    const before = structuredClone(room.state.scene.devices);
    join(room, 'c3', 'g3', {}, 1000);
    const g3 = room.device('g3')!;
    expect(['L', 'R']).toContain(g3.role);
    expect(room.state.scene.devices.g3).toBeDefined();
    for (const id of ['h', 'g1', 'g2']) expect(room.state.scene.devices[id]).toEqual(before[id]);
    // in a room without a layout the joiner is auto-placed as before
    const plain = setup();
    join(plain, 'c3', 'g3', {}, 1000);
    expect(plain.device('g3')!.role).toBe('Full');
  });

  it('profiles carry the tune fields; a legacy calibratedLatencyMs is not used for timing', () => {
    const store = new Map<string, Profile>();
    const profiles = { get: (id: string) => store.get(id), set: (id: string, p: Profile) => void store.set(id, p) };
    const room = mkRoom({ profiles });
    join(room, 'ch', 'h', { hostKey: 'HOSTKEY' });
    join(room, 'c1', 'g1');
    const slots = [{ deviceId: 'g1', deviceIndex: 0, signal: 'tune' as const, offsetMs: 500, durationMs: 1100 }];
    const plan = one(room.handle('ch', { type: 'CALIBRATION_START', slots }, 1000), 'CALIBRATION_PLAN').msg.plan;
    room.handle('ch', { type: 'CALIBRATION_RESULT', planId: plan.id, results: [{ deviceId: 'g1', heard: true, tuneArrivalMs: 42 }], tune: { mic: { x: 0, y: 0 }, quick: false, ranged: [], positions: {} } }, 2000);
    expect(store.get('g1')).toMatchObject({ tuneArrivalMs: 42, tuneId: plan.id, tuneStale: null });
    expect('calibratedLatencyMs' in store.get('g1')!).toBe(false);
    // the same device in a new room instance (same stored scene.tune → still tuned); and a legacy profile
    store.set('old', { ...store.get('g1')!, tuneArrivalMs: null, tuneId: null, calibratedLatencyMs: 50 } as Profile);
    const again = mkRoom({ profiles, scene: structuredClone(room.state.scene) });
    join(again, 'c1', 'g1');
    join(again, 'c9', 'old');
    expect(again.device('g1')).toMatchObject({ tuneArrivalMs: 42, tuneId: plan.id, syncState: 'tuned' });
    expect(again.device('old')).toMatchObject({ calibratedLatencyMs: null, syncState: 'untuned' });
  });

  it("calibration: recorders' rows go to the listener only; only the listener may submit results", () => {
    const room = setup();
    const slots = [{ deviceId: 'g1', deviceIndex: 0, signal: 'sweep' as const, offsetMs: 500, durationMs: 700 }];
    const plan = one(room.handle('c2', { type: 'CALIBRATION_START', slots, recorders: 'all' }, 1000), 'CALIBRATION_PLAN');
    expect(plan.msg.plan.recorders).toBe('all');
    expect(plan.msg.plan.startRoomTime).toBe(4500); // remote mics open on arrival: longer lead
    const id = plan.msg.plan.id;
    const row = { emitterId: 'g1', mMs: 12.5, levelDb: -30, directDb: -20, snrDb: 50, clipped: false };
    const fwd = one(room.handle('c1', { type: 'CALIBRATION_ROWS', planId: id, rows: [row], valid: true }, 2000), 'CALIBRATION_ROWS');
    expect(fwd.to).toEqual(['c2']);
    expect(fwd.msg).toMatchObject({ recorderId: 'g1', planId: id, rows: [row], valid: true });
    const forged = room.handle(
      'c1',
      { type: 'CALIBRATION_RESULT', planId: id, results: [{ deviceId: 'h', heard: true, tuneArrivalMs: 999, volumeUpDb: null }], tune: { mic: { x: 0, y: 0 }, quick: false, ranged: [], positions: {} } },
      3000,
    );
    expect(one(forged, 'ERROR').msg.code).toBe('forbidden');
    expect(room.device('h')!.tuneArrivalMs).toBeNull();
  });

  it('calibration: an all-recorders plan must be one short slot per known device', () => {
    const room = setup();
    const ok = { deviceId: 'g1', deviceIndex: 0, signal: 'sweep' as const, offsetMs: 500, durationMs: 700 };
    for (const slots of [
      [{ ...ok, offsetMs: 600000 }],
      [{ ...ok, repeat: 600, periodMs: 10000 }],
      [ok, { ...ok, offsetMs: 2000 }],
      [{ ...ok, deviceId: 'ghost' }],
    ])
      expect(one(room.handle('c1', { type: 'CALIBRATION_START', slots, recorders: 'all' }, 1000), 'ERROR').msg.code).toBe('bad_plan');
    one(room.handle('c1', { type: 'CALIBRATION_START', slots: [ok], recorders: 'all' }, 1000), 'CALIBRATION_PLAN');
  });

  it('calibration: one run at a time — busy until the result, a cancel, the listener leaving, or the run has long ended', () => {
    const slots = [{ deviceId: 'g1', deviceIndex: 0, signal: 'tune' as const, offsetMs: 500, durationMs: 1100 }];
    const start = (room: Room, conn: string, now: number) => room.handle(conn, { type: 'CALIBRATION_START', slots }, now);
    // released by the result
    let room = setup();
    let plan = one(start(room, 'c2', 1000), 'CALIBRATION_PLAN').msg.plan;
    expect(one(start(room, 'c1', 1100), 'ERROR').msg.code).toBe('calibration_busy');
    expect(one(start(room, 'c2', 1100), 'ERROR').msg.code).toBe('calibration_busy'); // the listener itself too
    room.handle('c2', { type: 'CALIBRATION_RESULT', planId: plan.id, results: [], tune: { mic: { x: 0, y: 0 }, quick: false, ranged: [], positions: {} } }, 1200);
    one(start(room, 'c1', 1300), 'CALIBRATION_PLAN');
    // released by a cancel, which every device hears; only the listener may cancel
    room = setup();
    plan = one(start(room, 'c2', 1000), 'CALIBRATION_PLAN').msg.plan;
    expect(one(room.handle('c1', { type: 'CALIBRATION_CANCEL', planId: plan.id }, 1100), 'ERROR').msg.code).toBe('forbidden');
    expect(one(room.handle('c2', { type: 'CALIBRATION_CANCEL', planId: 'nope' }, 1100), 'ERROR').msg.code).toBe('unknown_plan');
    const cancelled = one(room.handle('c2', { type: 'CALIBRATION_CANCEL', planId: plan.id }, 1100), 'CALIBRATION_CANCELLED');
    expect(cancelled.to).toBe('all');
    expect(cancelled.msg.planId).toBe(plan.id);
    one(start(room, 'c1', 1200), 'CALIBRATION_PLAN');
    // released when the listener leaves (everyone is told), and by time
    room = setup();
    plan = one(start(room, 'c2', 1000), 'CALIBRATION_PLAN').msg.plan;
    expect(one(room.leave('c2', 1100), 'CALIBRATION_CANCELLED').msg.planId).toBe(plan.id);
    one(start(room, 'c1', 1200), 'CALIBRATION_PLAN');
    room = setup();
    plan = one(start(room, 'c2', 1000), 'CALIBRATION_PLAN').msg.plan;
    const endsAt = plan.startRoomTime + 500 + 1100 + 1000 + 200 + 5000; // recording + tail
    expect(one(start(room, 'c1', endsAt - 1), 'ERROR').msg.code).toBe('calibration_busy');
    one(start(room, 'c1', endsAt), 'CALIBRATION_PLAN');
  });

  it('a prepared tune: PREPARE names the recorders that can answer, the plan follows the last READY with a short lead', () => {
    const room = setup();
    // g1: a laptop with its mic granted; g2: a phone that never answered the prompt yet (still asked); extras:
    // a device without a mic, one that denied it, a Bluetooth output (never ranged → not waited for), an old tab
    room.handle('c1', { type: 'CAPS_UPDATE', caps: { ...caps('laptop'), micPermission: 'granted' } }, 900);
    room.handle('c2', { type: 'CAPS_UPDATE', caps: { ...caps(), micPermission: 'prompt' } }, 901);
    join(room, 'c3', 'nomic', { caps: { ...caps(), hasMic: false, micPermission: 'granted' } }, 902);
    join(room, 'c4', 'denied', { caps: { ...caps(), micPermission: 'denied' } }, 903);
    join(room, 'c5', 'bt', { caps: { ...caps('bluetooth'), micPermission: 'granted' } }, 904);
    const slots = ['h', 'g1', 'g2', 'nomic', 'denied', 'bt'].map((id, i) => ({ deviceId: id, deviceIndex: i, signal: 'tune' as const, offsetMs: 500 + i * 1550, durationMs: 1100 }));
    const out = room.handle('ch', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 1000);
    expect(of(out, 'CALIBRATION_PLAN')).toHaveLength(0);
    const prep = one(out, 'CALIBRATION_PREPARE');
    expect(prep.to).toBe('all');
    expect(prep.msg.listenerId).toBe('h');
    expect([...prep.msg.recorderIds].sort()).toEqual(['g1', 'g2']);
    expect(prep.msg.deadlineRoomTime).toBe(1000 + 8000);
    expect(room.calibrationDue()).toBe(9000);
    // busy meanwhile
    expect(one(room.handle('c1', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 1100), 'ERROR').msg.code).toBe('calibration_busy');
    // an answer from a device that was not asked is ignored; each expected answer reaches the listener only
    expect(room.handle('c5', { type: 'CALIBRATION_READY', planId: prep.msg.planId, ok: true }, 1200)).toEqual([]);
    const r1 = room.handle('c2', { type: 'CALIBRATION_READY', planId: prep.msg.planId, ok: false, reason: 'no mic permission' }, 1300);
    expect(one(r1, 'CALIBRATION_READY').to).toEqual(['ch']);
    expect(one(r1, 'CALIBRATION_READY').msg).toMatchObject({ recorderId: 'g2', ok: false, reason: 'no mic permission' });
    expect(of(r1, 'CALIBRATION_PLAN')).toHaveLength(0);
    const r2 = room.handle('c1', { type: 'CALIBRATION_READY', planId: prep.msg.planId, ok: true }, 2000);
    one(r2, 'CALIBRATION_READY');
    const plan = one(r2, 'CALIBRATION_PLAN');
    expect(plan.to).toBe('all');
    expect(plan.msg.plan.id).toBe(prep.msg.planId);
    expect(plan.msg.plan.recorders).toBe('all');
    // nobody opens a mic when the plan arrives: the lead is the short one (≥ 1.5 s, not the 3.5 s of a cold start)
    expect(plan.msg.plan.startRoomTime - 2000).toBe(1500);
    expect(room.calibrationDue()).toBeNull();
    expect(room.calibrationTick(99_999)).toEqual([]);
    // still busy until the run ends; a late READY is ignored
    expect(one(room.handle('c1', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 2100), 'ERROR').msg.code).toBe('calibration_busy');
    expect(room.handle('c1', { type: 'CALIBRATION_READY', planId: prep.msg.planId, ok: true }, 2200)).toEqual([]);
  });

  it('a prepared tune: the deadline plans without the stragglers (tick), an older tab keeps the long lead, no recorders → plan at once', () => {
    const room = setup();
    room.handle('c1', { type: 'CAPS_UPDATE', caps: { ...caps('laptop'), micPermission: 'granted' } }, 900);
    room.handle('c2', { type: 'CAPS_UPDATE', caps: { ...caps(), micPermission: 'granted' } }, 901);
    const slots = ['h', 'g1', 'g2'].map((id, i) => ({ deviceId: id, deviceIndex: i, signal: 'tune' as const, offsetMs: 500 + i * 1550, durationMs: 1100 }));
    const prep = one(room.handle('ch', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 1000), 'CALIBRATION_PREPARE');
    room.handle('c1', { type: 'CALIBRATION_READY', planId: prep.msg.planId, ok: true }, 1500);
    expect(room.calibrationTick(8999)).toEqual([]);
    const plan = one(room.calibrationTick(9000), 'CALIBRATION_PLAN');
    expect(plan.msg.plan.startRoomTime - 9000).toBe(1500);
    expect(room.calibrationDue()).toBeNull();
    // a cancel during the prepare phase frees the room and tells everyone (recorders close their mics)
    const again = setup();
    again.handle('c1', { type: 'CAPS_UPDATE', caps: { ...caps('laptop'), micPermission: 'granted' } }, 900);
    const p2 = one(again.handle('ch', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 1000), 'CALIBRATION_PREPARE');
    one(again.handle('ch', { type: 'CALIBRATION_CANCEL', planId: p2.msg.planId }, 1100), 'CALIBRATION_CANCELLED');
    expect(again.calibrationDue()).toBeNull();
    one(again.handle('ch', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 1200), 'CALIBRATION_PREPARE');
    // a recorder on older code (no micPermission in its caps) will open its mic when the plan arrives: long lead
    const old = setup();
    old.handle('c1', { type: 'CAPS_UPDATE', caps: { ...caps('laptop'), micPermission: 'granted' } }, 900);
    const p3 = one(old.handle('ch', { type: 'CALIBRATION_START', slots, recorders: 'all', prepare: true }, 1000), 'CALIBRATION_PREPARE');
    expect(p3.msg.recorderIds).toEqual(['g1']);
    const plan3 = one(old.handle('c1', { type: 'CALIBRATION_READY', planId: p3.msg.planId, ok: true }, 2000), 'CALIBRATION_PLAN');
    expect(plan3.msg.plan.startRoomTime - 2000).toBe(3500);
    // nobody to wait for: the plan comes with the start
    const alone = mkRoom();
    join(alone, 'ch', 'h', { hostKey: 'HOSTKEY', caps: { ...caps('laptop'), micPermission: 'granted' } });
    const solo = [{ deviceId: 'h', deviceIndex: 0, signal: 'tune' as const, offsetMs: 500, durationMs: 1100 }];
    one(alone.handle('ch', { type: 'CALIBRATION_START', slots: solo, recorders: 'all', prepare: true }, 1000), 'CALIBRATION_PLAN');
    // a start without `prepare` is the one-shot run of older tabs: long lead, no PREPARE
    const legacy = one(setup().handle('ch', { type: 'CALIBRATION_START', slots, recorders: 'all' }, 1000), 'CALIBRATION_PLAN');
    expect(legacy.msg.plan.startRoomTime - 1000).toBe(3500);
  });

  it('CAPS_UPDATE replaces the sender’s capabilities and tells everyone', () => {
    const room = setup();
    const out = room.handle('c1', { type: 'CAPS_UPDATE', caps: { ...caps('laptop'), micPermission: 'granted', outputLabel: 'Speakers' } }, 900);
    expect(one(out, 'DEVICE_LIST').to).toBe('all');
    expect(room.device('g1')!.caps).toMatchObject({ deviceClass: 'laptop', micPermission: 'granted', outputLabel: 'Speakers' });
  });

  it('calibration: a guest in a host-only room may not start a run', () => {
    const room = setup();
    room.handle('ch', { type: 'SETTINGS_UPDATE', hostOnlyControl: true }, 900);
    const slots = [{ deviceId: 'g1', deviceIndex: 0, signal: 'sweep' as const, offsetMs: 500, durationMs: 700 }];
    expect(one(room.handle('c1', { type: 'CALIBRATION_START', slots }, 1000), 'ERROR').msg.code).toBe('forbidden');
    one(room.handle('ch', { type: 'CALIBRATION_START', slots }, 1000), 'CALIBRATION_PLAN');
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

describe('Room capture (live share)', () => {
  it('starting a share pauses the running track at now+lead and refuses play until the share ends', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 1000); // plays from T = 1250

    // share decided at 11250 pauses at T = 11500: position = (11500 − 1250) / 1000
    const outs = room.handle('ch', { type: 'CAPTURE', active: true }, 11250);
    const s = one(outs, 'SCHEDULE');
    expect(s.msg).toMatchObject({ action: 'pause', startRoomTime: 11500, trackId: 'a' });
    expect(s.msg.trackOffset).toBeCloseTo(10.25, 9);
    const st = one(outs, 'STATE');
    expect(st.to).toBe('all');
    expect(st.msg.roomState.captureHostId).toBe('h');
    expect(st.msg.roomState.playback.status).toBe('paused');

    // sharing again while paused only re-announces the state and never moves the position
    const again = room.handle('ch', { type: 'CAPTURE', active: true }, 12000);
    expect(of(again, 'SCHEDULE')).toHaveLength(0);
    expect(one(again, 'STATE').msg.roomState.captureHostId).toBe('h');
    expect(room.state.playback.trackOffset).toBeCloseTo(10.25, 9);

    // a file track can't play through the alignment delay while the live stream runs
    expect(one(room.handle('ch', ctl({ type: 'play' }), 13000), 'ERROR').msg.code).toBe('capture_active');
    expect(room.state.playback.status).toBe('paused');

    room.handle('ch', { type: 'CAPTURE', active: false }, 14000);
    const resume = one(room.handle('ch', ctl({ type: 'play' }), 14000), 'SCHEDULE');
    expect(resume.msg).toMatchObject({ action: 'play', startRoomTime: 14250 });
    expect(resume.msg.trackOffset).toBeCloseTo(10.25, 9);
  });

  it('a capturer that disconnects no longer blocks play', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('a') }), 1000);
    room.handle('c1', { type: 'CAPTURE', active: true }, 1000);
    expect(one(room.handle('ch', ctl({ type: 'play' }), 2000), 'ERROR').msg.code).toBe('capture_active');
    room.leave('c1', 3000);
    expect(of(room.handle('ch', ctl({ type: 'play' }), 4000), 'SCHEDULE')).toHaveLength(1);
  });

  it('under host-only control only the host may start a share', () => {
    const room = setup();
    room.handle('ch', { type: 'SETTINGS_UPDATE', hostOnlyControl: true }, 1000);
    expect(one(room.handle('c1', { type: 'CAPTURE', active: true }, 1000), 'ERROR').msg.code).toBe('forbidden');
    expect(room.state.captureHostId).toBeNull();
    expect(one(room.handle('ch', { type: 'CAPTURE', active: true }, 1000), 'STATE').msg.roomState.captureHostId).toBe(
      'h',
    );
  });
});

describe('Room auto-advance', () => {
  const LEAD = MIN_SCHEDULE_LEAD_MS;
  const remote = (id: string): Track => ({ id, title: id, kind: 'spotify', sourceClass: 'remote', remoteId: `spotify:track:${id}` });

  it('schedules the next track to start exactly when the current one ends, then a stop after the last', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('a', 10) }), 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('b', 5) }), 1000);
    expect(room.nextDueAt()).toBeNull(); // nothing playing
    expect(one(room.handle('ch', ctl({ type: 'play' }), 2000), 'SCHEDULE').msg.startRoomTime).toBe(2000 + LEAD);
    expect(room.endRoomTime()).toBe(12_000 + LEAD);

    const due = room.nextDueAt()!;
    expect(due).toBe(12_000 + LEAD - LEAD - AUTO_ADVANCE_MARGIN_MS);
    expect(room.tick(due - 1)).toEqual([]); // not yet
    const adv = room.tick(due);
    expect(one(adv, 'SCHEDULE').msg).toEqual({
      type: 'SCHEDULE',
      seq: expect.any(Number),
      action: 'play',
      trackId: 'b',
      trackOffset: 0,
      startRoomTime: 12_000 + LEAD,
      crossfadeSec: 0,
    });
    expect(one(adv, 'STATE').msg.roomState.playback).toEqual({
      status: 'playing',
      trackId: 'b',
      trackOffset: 0,
      startRoomTime: 12_000 + LEAD,
      crossfadeSec: 0,
    });
    expect(room.tick(due + 1)).toEqual([]); // idempotent: the transition happened

    // end of the queue: stop on the last track just past its end
    const due2 = room.nextDueAt()!;
    const bEnd = 12_000 + LEAD + 5000;
    expect(due2).toBe(bEnd + QUEUE_END_STOP_MS - LEAD - AUTO_ADVANCE_MARGIN_MS);
    const stop = one(room.tick(due2), 'SCHEDULE').msg;
    expect(stop).toMatchObject({ action: 'stop', trackId: 'b', trackOffset: 0, startRoomTime: bEnd + QUEUE_END_STOP_MS });
    expect(stop).not.toHaveProperty('crossfadeSec');
    expect(room.state.playback).toMatchObject({ status: 'stopped', trackId: 'b' });
    expect(room.state.playback).not.toHaveProperty('crossfadeSec');
    expect(room.nextDueAt()).toBeNull();
  });

  it('a user action clears the pending transition and the crossfade marker', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('a', 10) }), 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('b', 10) }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 2000);
    room.tick(room.nextDueAt()!); // now on b, crossfadeSec 0
    expect(room.state.playback.crossfadeSec).toBe(0);
    room.handle('ch', ctl({ type: 'pause' }), 13_000); // b started at 12 250 → paused 1 s in (at 13 250)
    expect(room.state.playback).toMatchObject({ status: 'paused', trackId: 'b', trackOffset: 1 });
    expect(room.state.playback).not.toHaveProperty('crossfadeSec');
    expect(room.nextDueAt()).toBeNull();
    expect(one(room.handle('ch', ctl({ type: 'play' }), 14_000), 'SCHEDULE').msg).not.toHaveProperty('crossfadeSec');
  });

  it('crossfade setting: the next track starts early by the fade, clamped to half of either track; never into a sync-only track', () => {
    const room = setup();
    expect(room.state.settings.crossfadeSec).toBe(0);
    room.handle('ch', { type: 'SETTINGS_UPDATE', crossfadeSec: 3 }, 1000);
    expect(room.state.settings.crossfadeSec).toBe(3);
    for (const t of [track('a', 10), track('b', 2), track('c', 10), remote('s')]) room.handle('ch', ctl({ type: 'queue', track: t }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 2000); // a: 2250 → 12250
    const aEnd = 12_000 + LEAD;

    // a → b: b is only 2 s long, so the fade is limited to 1 s (half of b)
    let s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 'b', startRoomTime: aEnd - 1000, crossfadeSec: 1 });
    // b → c: half of b's remaining 2 s
    const bEnd = aEnd - 1000 + 2000;
    s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 'c', startRoomTime: bEnd - 1000, crossfadeSec: 1 });
    // c → s (Spotify): no overlap possible, plain hand-over at c's end
    const cEnd = bEnd - 1000 + 10_000;
    s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 's', startRoomTime: cEnd, crossfadeSec: 0 });
    expect(room.nextDueAt()).toBeNull(); // no duration known: the room can't tell when it ends
  });

  it('a Spotify track with its duration auto-advances, with no fade into or out of it', () => {
    const room = setup();
    room.handle('ch', { type: 'SETTINGS_UPDATE', crossfadeSec: 6 }, 1000);
    const sp = (id: string, sec: number): Track => ({ ...remote(id), durationSec: sec });
    for (const t of [sp('s1', 20), sp('s2', 30), track('r', 40), sp('s3', 30)]) room.handle('ch', ctl({ type: 'queue', track: t }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 2000); // s1: 2250 → 22250
    const s1End = 22_000 + LEAD;
    expect(room.endRoomTime()).toBe(s1End);
    let s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 's2', startRoomTime: s1End, crossfadeSec: 0 }); // remote → remote
    s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 'r', startRoomTime: s1End + 30_000, crossfadeSec: 0 }); // remote → rendered
    s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 's3', startRoomTime: s1End + 70_000, crossfadeSec: 0 }); // rendered → remote
  });

  it('a late tick never starts earlier than now + lead; the crossfade shrinks to what is left', () => {
    const room = setup();
    room.handle('ch', { type: 'SETTINGS_UPDATE', crossfadeSec: 3 }, 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('a', 10) }), 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('b', 10) }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 2000);
    const aEnd = 12_000 + LEAD;
    expect(room.nextDueAt()).toBe(aEnd - 3000 - LEAD - AUTO_ADVANCE_MARGIN_MS);
    const s = one(room.tick(aEnd - 1500), 'SCHEDULE').msg; // 1.5 s before the end: fade over what is left
    expect(s).toMatchObject({ trackId: 'b', startRoomTime: aEnd - 1500 + LEAD, crossfadeSec: 1.25 });

    const room2 = setup();
    room2.handle('ch', ctl({ type: 'queue', track: track('a', 10) }), 1000);
    room2.handle('ch', ctl({ type: 'queue', track: track('b', 10) }), 1000);
    room2.handle('ch', ctl({ type: 'play' }), 2000);
    const s2 = one(room2.tick(aEnd + 5000), 'SCHEDULE').msg; // long past the end (gap, no overlap)
    expect(s2).toMatchObject({ trackId: 'b', startRoomTime: aEnd + 5000 + LEAD, crossfadeSec: 0 });
  });

  it('a seek near the end transitions from the new position; the lead follows the devices', () => {
    const room = setup();
    room.handle('ch', { type: 'SETTINGS_UPDATE', crossfadeSec: 3 }, 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('a', 10) }), 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('b', 10) }), 1000);
    room.handle('c1', { type: 'STATS', stats: stats(400) }, 1500);
    room.handle('ch', ctl({ type: 'play' }), 2000);
    const lead = 400 + SCHEDULE_SAFETY_MARGIN_MS;
    room.handle('ch', ctl({ type: 'seek', position: 9.5 }), 3000); // 0.5 s left
    const end = 3000 + lead + 500;
    expect(room.endRoomTime()).toBe(end);
    expect(room.nextDueAt()).toBe(end - 250 - lead - AUTO_ADVANCE_MARGIN_MS); // fade = half of the 0.5 s left
    const s = one(room.tick(room.nextDueAt()!), 'SCHEDULE').msg;
    expect(s).toMatchObject({ trackId: 'b', startRoomTime: end - 250, crossfadeSec: 0.25 });
  });

  it('tracks without a known duration are learned from a re-queue (duration/channels only) and then advance', () => {
    const room = setup();
    const link: Track = { id: 'u', title: 'Link', kind: 'url', sourceClass: 'rendered', url: 'https://x.test/a.mp3' };
    room.handle('ch', ctl({ type: 'queue', track: link }), 1000);
    room.handle('ch', ctl({ type: 'queue', track: track('b', 10) }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 2000);
    expect(room.endRoomTime()).toBeNull();
    expect(room.nextDueAt()).toBeNull();
    // a guest's decode fills in what was unknown; title/url stay as queued
    room.handle('c1', ctl({ type: 'queue', track: { ...link, title: 'renamed', durationSec: 30, channels: 2 } }), 3000);
    expect(room.state.queue[0]).toMatchObject({ title: 'Link', durationSec: 30, channels: 2, addedBy: 'h' });
    // a later re-queue never overwrites a known value
    room.handle('c2', ctl({ type: 'queue', track: { ...link, durationSec: 99, channels: 6 } }), 3100);
    expect(room.state.queue[0]).toMatchObject({ durationSec: 30, channels: 2 });
    expect(room.endRoomTime()).toBe(2000 + LEAD + 30_000);
    expect(room.state.queue).toHaveLength(2);
  });

  it('a stored home room keeps the crossfade setting', () => {
    const cfgs: Array<{ settings: { crossfadeSec: number } }> = [];
    const room = mkRoom({ onConfig: (cfg) => cfgs.push(cfg) });
    join(room, 'ch', 'h', { hostKey: 'HOSTKEY' });
    room.handle('ch', { type: 'SETTINGS_UPDATE', crossfadeSec: 6 }, 1000);
    expect(cfgs.at(-1)?.settings.crossfadeSec).toBe(6);
    const again = mkRoom({ settings: cfgs.at(-1)!.settings as never });
    expect(again.state.settings.crossfadeSec).toBe(6);
  });
});

describe('Room queueMany', () => {
  const sp = (id: string, sec = 30): Track => ({ id, title: id, kind: 'spotify', sourceClass: 'remote', remoteId: `spotify:track:${id}`, durationSec: sec });
  const many = (tracks: Track[], mode: 'append' | 'insert' | 'replace', extra: { afterTrackId?: string; playIndex?: number } = {}) =>
    ctl({ type: 'queueMany', tracks, mode, ...extra });
  const ids = (room: Room) => room.state.queue.map((t) => t.id);

  it('appends in one STATE and selects the first track of an empty room', () => {
    const room = setup();
    const out = room.handle('c1', many([sp('a'), sp('b'), sp('c')], 'append'), 1000);
    expect(of(out, 'SCHEDULE')).toHaveLength(0);
    expect(one(out, 'STATE').to).toBe('all');
    expect(ids(room)).toEqual(['a', 'b', 'c']);
    expect(room.state.queue.every((t) => t.addedBy === 'g1')).toBe(true);
    expect(room.state.playback).toMatchObject({ trackId: 'a', status: 'stopped' });
    // already-queued ids are skipped, not duplicated
    room.handle('c1', many([sp('c'), sp('d')], 'append'), 1000);
    expect(ids(room)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('inserts after the current track (Play next) or after a given track', () => {
    const room = setup();
    room.handle('ch', many([sp('a'), sp('b'), sp('c')], 'append'), 1000);
    room.handle('ch', ctl({ type: 'play', trackId: 'b' }), 1000);
    room.handle('ch', many([sp('n1'), sp('n2')], 'insert'), 1000);
    expect(ids(room)).toEqual(['a', 'b', 'n1', 'n2', 'c']);
    room.handle('ch', many([sp('x')], 'insert', { afterTrackId: 'a' }), 1000);
    expect(ids(room)).toEqual(['a', 'x', 'b', 'n1', 'n2', 'c']);
    room.handle('ch', many([sp('y')], 'insert', { afterTrackId: 'gone' }), 1000);
    expect(ids(room).at(-1)).toBe('y');
  });

  it('replace + playIndex: swaps the queue and starts that track in one SCHEDULE', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('old', 100) }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 1000);
    const out = room.handle('ch', many([sp('p1'), sp('p2'), sp('p3')], 'replace', { playIndex: 1 }), 5000);
    expect(one(out, 'SCHEDULE').msg).toMatchObject({ action: 'play', trackId: 'p2', trackOffset: 0, startRoomTime: 5000 + MIN_SCHEDULE_LEAD_MS });
    expect(one(out, 'STATE').msg.roomState.queue.map((t) => t.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('replace without playIndex stops what was playing and selects the new first track', () => {
    const room = setup();
    room.handle('ch', ctl({ type: 'queue', track: track('old', 100) }), 1000);
    room.handle('ch', ctl({ type: 'play' }), 1000);
    const out = room.handle('ch', many([sp('p1')], 'replace'), 5000);
    expect(one(out, 'SCHEDULE').msg).toMatchObject({ action: 'stop', trackId: 'p1' });
    expect(room.state.playback).toMatchObject({ trackId: 'p1', status: 'stopped' });
  });

  it('is all or nothing when the queue would overflow, and obeys host-only control', () => {
    const room = setup();
    const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => sp(`t${from + i}`));
    room.handle('ch', many(batch(0, 100), 'append'), 1000);
    room.handle('ch', many(batch(100, 90), 'append'), 1000);
    expect(one(room.handle('ch', many(batch(190, 11), 'append'), 1000), 'ERROR').msg.code).toBe('queue_full');
    expect(room.state.queue).toHaveLength(190);
    room.handle('ch', many(batch(190, 10), 'append'), 1000);
    expect(room.state.queue).toHaveLength(200);
    // replace counts only the new tracks
    room.handle('ch', many(batch(500, 3), 'replace'), 1000);
    expect(room.state.queue).toHaveLength(3);

    room.handle('ch', { type: 'SETTINGS_UPDATE', hostOnlyControl: true }, 1000);
    expect(one(room.handle('c1', many([sp('z')], 'append'), 1000), 'ERROR').msg.code).toBe('forbidden');
  });
});
