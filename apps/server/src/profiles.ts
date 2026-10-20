/** Device profiles keyed by deviceId, kept in memory and flushed (debounced) to `${dataDir}/profiles.json`. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Profile } from './room.ts';

export class ProfileStore {
  private readonly map = new Map<string, Profile>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 1000,
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Profile>;
      for (const [id, p] of Object.entries(raw)) this.map.set(id, p);
    } catch {
      // missing or corrupt file → start empty
    }
  }

  get(deviceId: string): Profile | undefined {
    return this.map.get(deviceId);
  }

  set(deviceId: string, p: Profile) {
    this.map.set(deviceId, p);
    this.timer ??= setTimeout(() => this.flush(), this.debounceMs).unref();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
    renameSync(tmp, this.file);
  }
}
