import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  defaultScene,
  defaultSettings,
  type HomeGroupResponse,
} from '@syncsound/protocol';
import type { Home, HomeStore, StoredRoom } from './homes.ts';
import { Room, perfClock, type ControlCmd, type Outbound, type RoomDeps } from './room.ts';

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
      homes?: HomeStore;
      prepareDeadlineMs?: number;
    } = {},
  ) {
    this.ttlMs = (opts.ttlMinutes ?? Number(process.env.ROOM_TTL_MINUTES ?? 60)) * 60_000;
  }

  /** temporary and home rooms share one code space so JOIN-by-code reaches both */
  private newCode() {
    let code = randomRoomCode();
    while (this.rooms.has(code) || this.opts.homes?.findRoom(code)) code = randomRoomCode();
    return code;
  }

  create(password: string | undefined, now: number): { code: string; hostKey: string } {
    const code = this.newCode();
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
        ...(this.opts.prepareDeadlineMs !== undefined ? { prepareDeadlineMs: this.opts.prepareDeadlineMs } : {}),
      }),
    );
    return { code, hostKey };
  }

  /** live room, or a stored home room brought up on demand */
  get(code: string): Room | undefined {
    const live = this.rooms.get(code);
    if (live) return live;
    const found = this.opts.homes?.findRoom(code);
    return found && this.materialize(found.home, found.room);
  }

  private materialize(home: Home, stored: StoredRoom): Room {
    const homes = this.opts.homes!;
    const room = new Room({
      code: stored.id,
      isHostKey: (k) => homes.isOwner(home, k),
      createdAt: (this.opts.clock ?? perfClock)(),
      scene: stored.scene,
      settings: stored.settings,
      passwordHash: stored.passwordHash ?? null,
      onConfig: (cfg) => homes.updateRoom(stored.id, cfg),
      passwords,
      profiles: this.opts.profiles,
      clock: this.opts.clock ?? perfClock,
      ...(this.opts.prepareDeadlineMs !== undefined ? { prepareDeadlineMs: this.opts.prepareDeadlineMs } : {}),
    });
    this.rooms.set(stored.id, room);
    return room;
  }

  addHomeRoom(home: Home, name: string): StoredRoom {
    const room: StoredRoom = { id: this.newCode(), name, scene: defaultScene(), settings: defaultSettings() };
    this.opts.homes!.addRoom(home, room);
    return room;
  }

  /** forget a home room; returns the live instance (if any) so the transport can disconnect its devices */
  removeHomeRoom(home: Home, code: string): { removed: boolean; live?: Room } {
    if (!this.opts.homes!.removeRoom(home, code)) return { removed: false };
    const live = this.rooms.get(code);
    this.rooms.delete(code);
    return { removed: true, live };
  }

  /**
   * One transport command to several rooms at one shared start time T = now + the largest room lead,
   * so every room's SCHEDULE carries the same startRoomTime.
   */
  groupControl(
    codes: string[],
    cmd: ControlCmd,
    now: number,
  ): HomeGroupResponse & { updates: Array<{ room: Room; out: Outbound[] }> } {
    const rooms = [...new Set(codes)].map((c) => this.get(c)).filter((r): r is Room => r !== undefined);
    const startRoomTime = now + Math.max(0, ...rooms.map((r) => r.lead()));
    const updates: Array<{ room: Room; out: Outbound[] }> = [];
    const errors: Record<string, string> = {};
    for (const room of rooms) {
      const r = room.controlAt(cmd, startRoomTime, now);
      if ('error' in r) errors[room.code] = r.error;
      else updates.push({ room, out: r.out });
    }
    return { startRoomTime, errors, updates };
  }

  /** time-driven room work (a prepared tune's deadline): what each room has to broadcast now */
  tick(now: number): { updates: Array<{ room: Room; out: Outbound[] }> } {
    const updates: Array<{ room: Room; out: Outbound[] }> = [];
    for (const room of this.rooms.values()) {
      const due = room.due();
      if (due === null || now < due) continue;
      const out = room.tick(now);
      if (out.length) updates.push({ room, out });
    }
    return { updates };
  }

  /** expire rooms empty for longer than the TTL (home rooms are only unloaded; their config is stored), prune long-disconnected devices; returns broadcasts to deliver */
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
