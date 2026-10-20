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
}

export class MockRemoteAdapter implements RemotePlayerAdapter {
  readonly name = 'mock' as const;
  status: RemoteServiceStatus = 'signed-out';
  message: string | null = null;
  volume = 1;
  loaded: string | null = null;
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
      ...opts,
    };
  }

  private pos(now = this.o.now()) {
    return this.basePos + (this.playing ? (now - this.baseAt) * (1 + this.o.rateError) : 0);
  }

  private latency() {
    return Math.max(0, this.o.seekLatencyMs + (this.o.random() * 2 - 1) * this.o.jitterMs);
  }

  async connect() {
    this.status = 'ready';
    return this.status;
  }

  async load(remoteId: string) {
    this.loaded = remoteId;
    this.basePos = 0;
    this.playing = false;
  }

  /** takes effect after the simulated latency, at the requested position (so it ends up behind) */
  async play(positionMs: number) {
    await this.o.sleep(this.latency());
    this.basePos = positionMs;
    this.baseAt = this.o.now();
    this.playing = true;
  }

  async pause() {
    this.basePos = this.pos();
    this.playing = false;
  }

  async seek(positionMs: number) {
    await this.o.sleep(this.latency());
    this.basePos = positionMs;
    this.baseAt = this.o.now();
  }

  async setVolume(v: number) {
    this.volume = v;
  }

  async getPosition(): Promise<RemotePosition> {
    const now = this.o.now();
    return { positionMs: this.pos(now), atMs: now, playing: this.playing };
  }

  dispose() {
    this.playing = false;
  }
}
