/** Simulated Class B player with seek latency + jitter (`?mockRemote=1`, tests). */
import type { RemoteServiceStatus } from '@syncsound/protocol';
import type { RemotePlayerAdapter, RemotePosition } from './types';

export interface MockOptions {
  /** delay before play/seek takes effect, ms (default 120) */
  seekLatencyMs?: number;
  /** ± uniform jitter on that delay, ms (default 30) */
  jitterMs?: number;
  /** playback clock error, e.g. 0.001 = runs 0.1 % fast (default 0) */
  rateError?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** a track's length, ms (default: none, plays forever) */
  durationMs?: (uri: string) => number | null;
}

export class MockRemoteAdapter implements RemotePlayerAdapter {
  readonly name = 'mock' as const;
  status: RemoteServiceStatus = 'signed-out';
  message: string | null = null;
  volume = 1;
  loaded: string | null = null;
  /** the play request's track list: the loaded track, then the next one riding along */
  private list: string[] = [];
  private idx = 0;
  private basePos = 0;
  private baseAt = 0;
  private playing = false;
  private readonly o: Required<MockOptions>;

  constructor(opts: MockOptions = {}) {
    this.o = {
      seekLatencyMs: 120,
      jitterMs: 30,
      rateError: 0,
      now: () => performance.now(),
      random: Math.random,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      durationMs: () => null,
      ...opts,
    };
  }

  private pos(now = this.o.now()) {
    return this.basePos + (this.playing ? (now - this.baseAt) * (1 + this.o.rateError) : 0);
  }

  /** like the SDK: at a track's end it moves on to the next one in the request, or stops at position 0 */
  private advance(now = this.o.now()) {
    for (;;) {
      const uri = this.list[this.idx];
      const dur = uri ? this.o.durationMs(uri) : null;
      if (!this.playing || dur === null) return;
      const p = this.pos(now);
      if (p < dur) return;
      const overMs = (p - dur) / (1 + this.o.rateError);
      if (this.idx + 1 < this.list.length) {
        this.idx++;
        this.basePos = 0;
        this.baseAt = now - overMs;
      } else {
        this.playing = false;
        this.basePos = 0;
        return;
      }
    }
  }

  private latency() {
    return Math.max(0, this.o.seekLatencyMs + (this.o.random() * 2 - 1) * this.o.jitterMs);
  }

  async connect() {
    this.status = 'ready';
    return this.status;
  }

  async load(remoteId: string, opts: { next?: string | null } = {}) {
    this.loaded = remoteId;
    this.next = opts.next ?? null;
  }

  private next: string | null = null;

  /** takes effect after the simulated latency, at the requested position (so it ends up behind) */
  async play(positionMs: number) {
    await this.o.sleep(this.latency());
    this.list = this.loaded ? [this.loaded, ...(this.next && this.next !== this.loaded ? [this.next] : [])] : [];
    this.idx = 0;
    this.basePos = positionMs;
    this.baseAt = this.o.now();
    this.playing = true;
  }

  async pause() {
    this.advance();
    this.basePos = this.pos();
    this.playing = false;
  }

  async seek(positionMs: number) {
    await this.o.sleep(this.latency());
    this.advance();
    this.basePos = positionMs;
    this.baseAt = this.o.now();
  }

  async setVolume(v: number) {
    this.volume = v;
  }

  async getPosition(): Promise<RemotePosition> {
    const now = this.o.now();
    this.advance(now);
    const uri = this.list[this.idx] ?? null;
    const dur = uri ? this.o.durationMs(uri) : null;
    return { positionMs: this.pos(now), atMs: now, playing: this.playing, uri, ...(dur !== null && { durationMs: dur }) };
  }

  dispose() {
    this.playing = false;
  }
}
