/**
 * Persistent Homes (`${dataDir}/homes.json`): a capability link (home id) plus an owner key, no accounts.
 * Only a SHA-256 of the owner key is stored; the key is 128 random bits, so no salt/KDF is needed.
 * Stored room ids are room codes, so the existing JOIN-by-code flow reaches them.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RoomSettings, Scene } from '@syncsound/protocol';
import { JsonStore } from './profiles.ts';

export interface StoredRoom {
  id: string;
  name: string;
  scene: Scene;
  settings: RoomSettings;
  passwordHash?: string | null;
  /** opaque until R2 defines them */
  layout?: unknown;
  slots?: unknown;
  calibration?: unknown;
}

export interface Home {
  id: string;
  ownerKeyHash: string;
  rooms: StoredRoom[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export class HomeStore extends JsonStore<Home> {
  /** room code → owning home */
  private readonly roomHome = new Map<string, Home>();

  constructor(file: string, debounceMs?: number) {
    super(file, debounceMs);
    for (const h of this.map.values()) for (const r of h.rooms) this.roomHome.set(r.id, h);
  }

  create(): { home: Home; ownerKey: string } {
    let id = randomBytes(16).toString('base64url');
    while (this.map.has(id)) id = randomBytes(16).toString('base64url');
    const ownerKey = randomBytes(16).toString('base64url');
    const home: Home = { id, ownerKeyHash: sha256(ownerKey).toString('hex'), rooms: [] };
    this.set(id, home);
    return { home, ownerKey };
  }

  isOwner(home: Home, key: string | undefined): boolean {
    return key !== undefined && timingSafeEqual(sha256(key), Buffer.from(home.ownerKeyHash, 'hex'));
  }

  findRoom(code: string): { home: Home; room: StoredRoom } | undefined {
    const home = this.roomHome.get(code);
    const room = home?.rooms.find((r) => r.id === code);
    return home && room ? { home, room } : undefined;
  }

  addRoom(home: Home, room: StoredRoom) {
    home.rooms.push(room);
    this.roomHome.set(room.id, home);
    this.touch();
  }

  removeRoom(home: Home, code: string): boolean {
    const i = home.rooms.findIndex((r) => r.id === code);
    if (i < 0) return false;
    home.rooms.splice(i, 1);
    this.roomHome.delete(code);
    this.touch();
    return true;
  }

  /** merge live room config back into the stored room (no-op if the room was removed meanwhile) */
  updateRoom(code: string, patch: Partial<Omit<StoredRoom, 'id'>>) {
    const found = this.findRoom(code);
    if (!found) return;
    Object.assign(found.room, patch);
    this.touch();
  }
}
