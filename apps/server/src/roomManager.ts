import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@syncsound/protocol';
import { Room, perfClock, type Outbound, type RoomDeps } from './room.ts';

export const DEVICE_PRUNE_MS = 10 * 60_000;

export const passwords = {
  hash(pw: string): string {
    const salt = randomBytes(16);
    return `${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`;
  },
  verify(pw: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const want = Buffer.from(hash, 'hex');
    const got = scryptSync(pw, Buffer.from(salt, 'hex'), want.length);
    return timingSafeEqual(got, want);
  },
};

export function randomRoomCode(): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return s;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly ttlMs: number;

  constructor(
    private readonly opts: {
      ttlMinutes?: number;
      profiles?: RoomDeps['profiles'];
      clock?: () => number;
    } = {},
  ) {
    this.ttlMs = (opts.ttlMinutes ?? Number(process.env.ROOM_TTL_MINUTES ?? 60)) * 60_000;
  }

  create(password: string | undefined, now: number): { code: string; hostKey: string } {
    let code = randomRoomCode();
    while (this.rooms.has(code)) code = randomRoomCode();
    const hostKey = randomBytes(16).toString('base64url');
    this.rooms.set(
      code,
      new Room({
        code,
        hostKey,
        createdAt: now,
        passwordHash: password ? passwords.hash(password) : null,
        passwords,
        profiles: this.opts.profiles,
        clock: this.opts.clock ?? perfClock,
      }),
    );
    return { code, hostKey };
  }

  get(code: string) {
    return this.rooms.get(code);
  }

  /** expire rooms empty for longer than the TTL, prune long-disconnected devices; returns broadcasts to deliver */
  sweep(now: number): { expired: string[]; updates: Array<{ room: Room; out: Outbound[] }> } {
    const expired: string[] = [];
    const updates: Array<{ room: Room; out: Outbound[] }> = [];
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince > this.ttlMs) {
        this.rooms.delete(code);
        expired.push(code);
        continue;
      }
      const out = room.prune(now, DEVICE_PRUNE_MS);
      if (out.length) updates.push({ room, out });
    }
    return { expired, updates };
  }
}
