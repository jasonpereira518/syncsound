/**
 * Fetch + decode ahead of time, cached by track id (small LRU; current/next are never evicted).
 * A long (segmented) track never exists as one buffer: only a sliding window of its decoded segments is kept.
 */
import { segmentIndexAt, segmentStartSec, segmentTotalSec, segmentWindow } from '@syncsound/audio-core';
import { segmentUrl, type BufferState, type SegmentPlan, type Track } from '@syncsound/protocol';

/** the playing segment plus this many more stay decoded (~45 MB each for 2 minutes of stereo) */
const SEGMENTS_AHEAD = 2;
/** a segment that failed to download is retried after this long */
const RETRY_MS = 5000;
/** decoded PCM is float32: a track that would need more than this can't be decoded whole in a browser tab */
const MAX_DECODED_BYTES = 1.1e9;

interface SegState {
  plan: SegmentPlan;
  /** track position (s) the window follows */
  pos: number;
  ahead: number;
  chunks: Map<number, AudioBuffer>;
  loading: Set<number>;
  failed: Map<number, { msg: string; at: number }>;
}

export interface Entry {
  state: Exclude<BufferState, 'idle' | 'playing'>;
  buffer: AudioBuffer | null;
  error: string | null;
  /** set for segmented tracks: `state` then means "the segment under the playhead is decoded" */
  seg?: SegState;
}

/** how much of a segmented track this device has ready, for the player bar and the device stats */
export interface SegmentProgress {
  /** decoded audio is available from the playhead up to here, track s */
  bufferedThroughSec: number;
  playheadSec: number;
  totalSec: number;
  /** segments decoded / being fetched / total */
  ready: number;
  loading: number;
  count: number;
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

  /** the decoded segment `idx` of a segmented track, if it is currently held */
  segmentBuffer(trackId: string, idx: number): AudioBuffer | null {
    return this.entries.get(trackId)?.seg?.chunks.get(idx) ?? null;
  }

  prime(trackId: string, buffer: AudioBuffer) {
    this.entries.set(trackId, { state: 'ready', buffer, error: null });
  }

  /**
   * make sure `wanted` tracks are loading/loaded; evict the rest beyond capacity.
   * `current` is the track being played and where: its segment window follows that position.
   */
  ensure(wanted: Track[], current?: { id: string; pos: number }) {
    for (const t of wanted) {
      if (t.segments) {
        const isCurrent = t.id === current?.id;
        this.ensureSegments(t, isCurrent ? current.pos : 0, isCurrent ? SEGMENTS_AHEAD : 1);
        continue;
      }
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

  /** (re)aim a segmented track's window at track position `pos`: fetches what is missing, drops what is behind */
  ensureWindow(t: Track, pos: number) {
    if (t.segments) this.ensureSegments(t, pos, SEGMENTS_AHEAD);
  }

  progress(trackId: string): SegmentProgress | null {
    const s = this.entries.get(trackId)?.seg;
    if (!s) return null;
    const total = segmentTotalSec(s.plan);
    let through = s.pos;
    for (let i = segmentIndexAt(s.plan, s.pos); s.chunks.has(i); i++) through = Math.min(total, segmentStartSec(s.plan, i + 1));
    return { bufferedThroughSec: through, playheadSec: s.pos, totalSec: total, ready: s.chunks.size, loading: s.loading.size, count: s.plan.count };
  }

  private ensureSegments(t: Track, pos: number, ahead: number) {
    const plan = t.segments!;
    let e = this.entries.get(t.id);
    if (e) {
      this.entries.delete(t.id); // refresh LRU position
      this.entries.set(t.id, e);
    } else {
      e = { state: 'loading', buffer: null, error: null, seg: { plan, pos, ahead, chunks: new Map(), loading: new Set(), failed: new Map() } };
      this.entries.set(t.id, e);
    }
    const s = e.seg;
    if (!s) return;
    s.pos = pos;
    s.ahead = ahead;
    const want = segmentWindow(plan, pos, ahead);
    for (const i of [...s.chunks.keys()]) if (!want.includes(i)) s.chunks.delete(i); // a source still playing one keeps it alive
    for (const i of want) {
      if (s.chunks.has(i) || s.loading.has(i)) continue;
      const f = s.failed.get(i);
      if (f && Date.now() - f.at < RETRY_MS) continue;
      void this.loadSegment(t, e, i);
    }
    this.refresh(e);
  }

  private async loadSegment(t: Track, e: Entry, idx: number) {
    const s = e.seg!;
    s.loading.add(idx);
    s.failed.delete(idx);
    let buf: AudioBuffer | null = null;
    let msg = '';
    try {
      let res: Response;
      try {
        res = await fetch(segmentUrl(s.plan, idx));
      } catch {
        throw new Error(`Couldn't download part ${idx + 1} of "${t.title}" (network or CORS error).`);
      }
      if (!res.ok) throw new Error(`Couldn't download part ${idx + 1} of "${t.title}" (HTTP ${res.status}).`);
      try {
        buf = await this.decode(await res.arrayBuffer());
      } catch {
        throw new Error(`This browser can't decode part ${idx + 1} of "${t.title}".`);
      }
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    if (this.entries.get(t.id) !== e) return; // evicted meanwhile
    s.loading.delete(idx);
    if (!buf) s.failed.set(idx, { msg, at: Date.now() });
    // the playhead may have moved on while this was in flight
    else if (segmentWindow(s.plan, s.pos, s.ahead).includes(idx)) s.chunks.set(idx, buf);
    this.refresh(e);
    this.onChange(t.id);
  }

  /** ready = the segment under the playhead is decoded */
  private refresh(e: Entry) {
    const s = e.seg!;
    const i = segmentIndexAt(s.plan, s.pos);
    const failed = s.failed.get(i);
    if (s.chunks.has(i)) {
      e.state = 'ready';
      e.error = null;
    } else if (failed) {
      e.state = 'error';
      e.error = failed.msg;
    } else {
      e.state = 'loading';
      e.error = null;
    }
  }

  private async load(t: Track) {
    let entry: Entry;
    try {
      const needBytes = (t.durationSec ?? 0) * 48_000 * (t.channels ?? 2) * 4;
      if (needBytes > MAX_DECODED_BYTES)
        throw new Error(
          `"${t.title}" is about ${Math.round((t.durationSec ?? 0) / 60)} minutes: too long to decode in a browser tab. ` +
            'Upload it again so the server can split it (needs the server to have ffmpeg), or use a shorter file.',
        );
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
