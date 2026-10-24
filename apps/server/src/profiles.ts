/** id → value maps kept in memory and flushed (debounced, atomic rename) to a JSON file under dataDir. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Profile } from './room.ts';

export class JsonStore<V> {
  protected readonly map = new Map<string, V>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 1000,
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, V>;
      for (const [id, v] of Object.entries(raw)) this.map.set(id, v);
    } catch {
      // missing or corrupt file → start empty
    }
  }

  get(id: string): V | undefined {
    return this.map.get(id);
  }

  set(id: string, v: V) {
    this.map.set(id, v);
    this.touch();
  }

  /** schedule a flush after mutating a stored value in place */
  touch() {
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

/** Device profiles keyed by deviceId (`${dataDir}/profiles.json`). */
export class ProfileStore extends JsonStore<Profile> {}
