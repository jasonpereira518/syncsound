import { describe, expect, it } from 'vitest';
import { ROOM_CODE_LENGTH, isValidRoomCode } from '@syncsound/protocol';
import { DEVICE_PRUNE_MS, RoomManager, passwords } from '../src/roomManager.ts';

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

describe('RoomManager', () => {
  it('creates unique valid codes and 128-bit base64url host keys', () => {
    const m = new RoomManager({ ttlMinutes: 60 });
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { code, hostKey } = m.create(undefined, 0);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      expect(hostKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });

  it('hashes passwords with a salt and verifies them', () => {
    const a = passwords.hash('pw');
    expect(a).not.toContain('pw');
    expect(a).not.toBe(passwords.hash('pw'));
    expect(passwords.verify('pw', a)).toBe(true);
    expect(passwords.verify('PW', a)).toBe(false);
    expect(passwords.verify('pw', 'garbage')).toBe(false);
  });

  it('expires rooms after the TTL with no connected devices', () => {
    const m = new RoomManager({ ttlMinutes: 60 });
    const empty = m.create(undefined, 0).code;
    const busy = m.create(undefined, 0).code;
    m.get(busy)!.join('c1', { type: 'JOIN', roomCode: busy, deviceId: 'd1', name: 'd1', caps }, 1000);

    expect(m.sweep(59 * MIN).expired).toEqual([]);
    expect(m.sweep(61 * MIN).expired).toEqual([empty]);
    expect(m.get(empty)).toBeUndefined();
    expect(m.get(busy)).toBeDefined();

    m.get(busy)!.leave('c1', 100 * MIN);
    expect(m.sweep(150 * MIN).expired).toEqual([]);
    expect(m.sweep(161 * MIN).expired).toEqual([busy]);
  });

  it('prunes devices disconnected for more than 10 minutes', () => {
    const m = new RoomManager({ ttlMinutes: 600 });
    const code = m.create(undefined, 0).code;
    const room = m.get(code)!;
    room.join('c1', { type: 'JOIN', roomCode: code, deviceId: 'stay', name: 'stay', caps }, 0);
    room.join('c2', { type: 'JOIN', roomCode: code, deviceId: 'gone', name: 'gone', caps }, 0);
    room.leave('c2', 1000);
    expect(m.sweep(1000 + DEVICE_PRUNE_MS - 1).updates).toEqual([]);
    const { updates } = m.sweep(1000 + DEVICE_PRUNE_MS + 1);
    expect(updates).toHaveLength(1);
    expect(room.state.devices.map((d) => d.id)).toEqual(['stay']);
    expect(room.state.scene.devices.gone).toBeUndefined();
  });
});

describe('HTTP fixed-window limiter', () => {
  it('allows max requests per window then blocks until the window rolls', async () => {
    const { overLimit } = await import('../src/http');
    const t = 1_000;
    for (let i = 0; i < 30; i++) expect(overLimit('k', 30, 60_000, t + i)).toBe(false);
    expect(overLimit('k', 30, 60_000, t + 100)).toBe(true);
    expect(overLimit('k', 30, 60_000, t + 60_001)).toBe(false);
    expect(overLimit('other', 30, 60_000, t + 100)).toBe(false);
  });
});
