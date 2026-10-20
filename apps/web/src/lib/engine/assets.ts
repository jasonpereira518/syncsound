/** Fetch + decode ahead of time, cached by track id (small LRU; current/next are never evicted). */
import type { BufferState, Track } from '@syncsound/protocol';

interface Entry {
  state: Exclude<BufferState, 'idle' | 'playing'>;
  buffer: AudioBuffer | null;
  error: string | null;
}

export class AssetCache {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
    private readonly onChange: (trackId: string) => void,
    private readonly capacity = 3,
  ) {}

  get(trackId: string): Entry | undefined {
    return this.entries.get(trackId);
  }

  buffer(trackId: string): AudioBuffer | null {
    return this.entries.get(trackId)?.buffer ?? null;
  }

  prime(trackId: string, buffer: AudioBuffer) {
    this.entries.set(trackId, { state: 'ready', buffer, error: null });
  }

  /** make sure `wanted` tracks are loading/loaded; evict the rest beyond capacity */
  ensure(wanted: Track[]) {
    for (const t of wanted) {
      const e = this.entries.get(t.id);
      if (e) {
        // refresh LRU position
        this.entries.delete(t.id);
        this.entries.set(t.id, e);
        continue;
      }
      if (!t.url) continue;
      this.entries.set(t.id, { state: 'loading', buffer: null, error: null });
      void this.load(t);
    }
    const keep = new Set(wanted.map((t) => t.id));
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      if (!keep.has(id)) this.entries.delete(id);
    }
  }

  private async load(t: Track) {
    let entry: Entry;
    try {
      let res: Response;
      try {
        res = await fetch(t.url!);
      } catch {
        throw new Error(`Couldn't download "${t.title}" (network or CORS error).`);
      }
      if (!res.ok) throw new Error(`Couldn't download "${t.title}" (HTTP ${res.status}).`);
      const data = await res.arrayBuffer();
      try {
        entry = { state: 'ready', buffer: await this.decode(data), error: null };
      } catch {
        throw new Error(
          t.kind === 'video'
            ? `This browser can't decode the audio track of "${t.title}".`
            : `This browser can't decode "${t.title}" (unsupported audio format).`,
        );
      }
    } catch (e) {
      entry = { state: 'error', buffer: null, error: e instanceof Error ? e.message : String(e) };
    }
    if (!this.entries.has(t.id)) return; // evicted meanwhile
    this.entries.set(t.id, entry);
    this.onChange(t.id);
  }

  clear() {
    this.entries.clear();
  }
}
