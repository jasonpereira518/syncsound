import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultScene, defaultSettings, type ServerMessage, type Track } from '@syncsound/protocol';
import { HomeStore } from '../src/homes.ts';
import type { Outbound } from '../src/room.ts';
import { RoomManager } from '../src/roomManager.ts';

const MIN = 60_000;
const caps = {
  userAgent: 't',
  platform: 't',
  deviceClass: 'phone' as const,
  sampleRate: 48000,
  baseLatencyMs: null,
  outputLatencyMs: null,
  hasOutputTimestamp: false,
  hasMic: false,
};
const track: Track = { id: 't1', title: 't1', kind: 'file', sourceClass: 'rendered', url: 'http://x/a', durationSec: 60 };
const schedules = (out: Outbound[]) =>
  out.map((o) => o.msg).filter((m): m is Extract<ServerMessage, { type: 'SCHEDULE' }> => m.type === 'SCHEDULE');

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'syncsound-homes-'));
  file = join(dir, 'homes.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('HomeStore', () => {
  it('round-trips homes and rooms through the JSON file, storing only the owner-key hash', () => {
    const a = new HomeStore(file);
    const { home, ownerKey } = a.create();
    expect(ownerKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    a.addRoom(home, { id: 'ABCDEF', name: 'Living room', scene: defaultScene(), settings: defaultSettings() });
    a.updateRoom('ABCDEF', { name: 'Lounge', layout: { kind: 'opaque' } });
    a.flush();
    expect(readFileSync(file, 'utf8')).not.toContain(ownerKey);

    const b = new HomeStore(file);
    const loaded = b.get(home.id)!;
    expect(loaded.rooms).toEqual([
      { id: 'ABCDEF', name: 'Lounge', scene: defaultScene(), settings: defaultSettings(), layout: { kind: 'opaque' } },
    ]);
    expect(b.findRoom('ABCDEF')?.home.id).toBe(home.id);
    expect(b.isOwner(loaded, ownerKey)).toBe(true);
    expect(b.isOwner(loaded, ownerKey.slice(1))).toBe(false);
    expect(b.isOwner(loaded, undefined)).toBe(false);

    expect(b.removeRoom(loaded, 'ABCDEF')).toBe(true);
    expect(b.findRoom('ABCDEF')).toBeUndefined();
    b.updateRoom('ABCDEF', { name: 'ghost' }); // a live room writing back after removal is a no-op
    expect(loaded.rooms).toEqual([]);
  });
});

describe('home rooms', () => {
  it('materialize on demand, persist scene/settings, and survive unload', () => {
    const homes = new HomeStore(file);
    const now = { t: 0 };
    const m = new RoomManager({ ttlMinutes: 60, homes, clock: () => now.t });
    const { home, ownerKey } = homes.create();
    const { id: code } = m.addHomeRoom(home, 'Kitchen');
    expect(m.rooms.has(code)).toBe(false);

    const room = m.get(code)!;
    const owner = room.join('c1', { type: 'JOIN', roomCode: code, deviceId: 'd1', name: 'd1', caps, hostKey: ownerKey }, 0);
    expect(owner.ok && room.device('d1')!.isHost).toBe(true);
    room.join('c2', { type: 'JOIN', roomCode: code, deviceId: 'd2', name: 'd2', caps, hostKey: 'wrong' }, 0);
    expect(room.device('d2')!.isHost).toBe(false);

    room.handle('c1', { type: 'SCENE_UPDATE', listener: { x: 1, y: 2 }, devices: { d2: { x: 3, y: -1 } } }, 10);
    room.handle('c1', { type: 'SETTINGS_UPDATE', hostOnlyControl: true }, 10);
    const stored = homes.findRoom(code)!.room;
    expect(stored.scene.listener).toEqual({ x: 1, y: 2 });
    expect(stored.scene.devices.d2).toEqual({ x: 3, y: -1 });
    expect(stored.settings.hostOnlyControl).toBe(true);

    // everyone leaves; after the TTL the live room is unloaded but the stored room remains
    room.leave('c1', 1000);
    room.leave('c2', 1000);
    now.t = 1000 + 61 * MIN;
    expect(m.sweep(now.t).expired).toEqual([code]);
    expect(m.rooms.has(code)).toBe(false);

    homes.flush();
    const m2 = new RoomManager({ ttlMinutes: 60, homes: new HomeStore(file), clock: () => now.t });
    const again = m2.get(code)!;
    expect(again).toBeDefined();
    expect(again.state.scene.listener).toEqual({ x: 1, y: 2 });
    expect(again.state.settings.hostOnlyControl).toBe(true);
    again.join('c3', { type: 'JOIN', roomCode: code, deviceId: 'd2', name: 'd2', caps }, now.t);
    expect(again.state.scene.devices.d2).toEqual({ x: 3, y: -1 }); // returning speaker keeps its spot
  });

  it('share the code space with temporary rooms and can be removed', () => {
    const homes = new HomeStore(file);
    const m = new RoomManager({ homes, clock: () => 0 });
    const { home } = homes.create();
    const { id } = m.addHomeRoom(home, 'Den');
    m.get(id);
    expect(m.removeHomeRoom(home, id).live).toBeDefined();
    expect(m.get(id)).toBeUndefined();
    expect(m.removeHomeRoom(home, id).removed).toBe(false);
  });
});

describe('group play', () => {
  it('schedules every room at the same startRoomTime, past the slowest room lead', () => {
    const homes = new HomeStore(file);
    const m = new RoomManager({ homes, clock: () => 0 });
    const { home } = homes.create();
    const codes = ['Kitchen', 'Lounge', 'Office'].map((n) => m.addHomeRoom(home, n).id);
    const [kitchen, lounge, office] = codes.map((c) => m.get(c)!);
    for (const [i, r] of [kitchen!, lounge!, office!].entries())
      r.join(`c${i}`, { type: 'JOIN', roomCode: r.code, deviceId: `d${i}`, name: `d${i}`, caps }, 0);
    // the lounge has a slow device → larger lead than the others
    lounge!.device('d1')!.stats = {
      offsetMs: 0, rttMs: 900, jitterMs: 0, driftPpm: 0, syncErrorMs: 0, bufferState: 'ready',
      loadedTrackId: null, remoteErrorMs: null, autoLatencyMs: null, battery: null,
    };
    expect(lounge!.lead()).toBeGreaterThan(kitchen!.lead());

    m.groupControl([kitchen!.code, lounge!.code], { type: 'queue', track }, 100);
    const r = m.groupControl(codes, { type: 'play', trackId: 't1' }, 100);
    expect(r.startRoomTime).toBe(100 + lounge!.lead());
    expect(r.errors).toEqual({ [office!.code]: 'unknown_track' }); // the office never queued t1
    const scheds = r.updates.flatMap((u) => schedules(u.out));
    expect(scheds).toHaveLength(2);
    for (const s of scheds) expect(s).toMatchObject({ action: 'play', trackId: 't1', startRoomTime: r.startRoomTime });
    expect(kitchen!.state.playback.status).toBe('playing');
    expect(kitchen!.state.queue[0]!.addedBy).toBeUndefined();
  });
});
