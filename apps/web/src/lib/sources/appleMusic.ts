/** Apple Music Class B adapter via MusicKit JS v3. Browser-only. */
import type { RemoteServiceStatus } from '@syncsound/protocol';
import { appleConfigured, appleDeveloperToken } from '../config';
import { loadScript } from './loadScript';
import type { RemotePlayerAdapter, RemotePosition } from './types';

const MUSICKIT_URL = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

interface MusicKitInstance {
  authorize(): Promise<string>;
  isAuthorized: boolean;
  setQueue(o: { song: string; startPlaying?: boolean }): Promise<unknown>;
  play(): Promise<void>;
  pause(): void | Promise<void>;
  stop?(): void | Promise<void>;
  seekToTime(t: number): Promise<void>;
  volume: number;
  currentPlaybackTime: number;
  isPlaying: boolean;
}
type MkWindow = Window & {
  MusicKit?: { configure(o: { developerToken: string; app: { name: string; build: string } }): Promise<MusicKitInstance> };
};

async function loadMusicKit() {
  const w = window as MkWindow;
  if (!w.MusicKit) {
    const loaded = new Promise<void>((r) => document.addEventListener('musickitloaded', () => r(), { once: true }));
    await loadScript(MUSICKIT_URL);
    if (!w.MusicKit) await loaded;
  }
  return w.MusicKit!;
}

export class AppleMusicAdapter implements RemotePlayerAdapter {
  readonly name = 'apple' as const;
  status: RemoteServiceStatus = appleConfigured ? 'signed-out' : 'unconfigured';
  message: string | null = null;
  private music: MusicKitInstance | null = null;

  async connect(): Promise<RemoteServiceStatus> {
    if (!appleConfigured) return (this.status = 'unconfigured');
    const MusicKit = await loadMusicKit();
    this.music ??= await MusicKit.configure({ developerToken: appleDeveloperToken, app: { name: 'SyncSound', build: '1.0.0' } });
    if (!this.music.isAuthorized) {
      try {
        await this.music.authorize();
      } catch {
        this.message = 'Apple Music sign-in was cancelled or blocked (allow pop-ups and try again).';
        return (this.status = 'signed-out');
      }
    }
    this.message = null;
    return (this.status = 'ready');
  }

  private get mk() {
    if (!this.music) throw new Error('Apple Music is not connected.');
    return this.music;
  }

  async load(remoteId: string) {
    await this.mk.setQueue({ song: remoteId, startPlaying: false });
  }

  async play(positionMs: number) {
    try {
      await this.mk.seekToTime(Math.max(0, positionMs / 1000)).catch(() => {});
      await this.mk.play();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/subscri/i.test(msg)) {
        this.status = 'needs-premium';
        this.message = 'An Apple Music subscription is required for full playback.';
      }
      throw new Error(`Apple Music playback failed: ${msg}`);
    }
  }

  async pause() {
    await this.music?.pause();
  }

  async seek(positionMs: number) {
    await this.mk.seekToTime(Math.max(0, positionMs / 1000));
  }

  async setVolume(v: number) {
    if (this.music) this.music.volume = Math.min(1, Math.max(0, v));
  }

  async getPosition(): Promise<RemotePosition> {
    const m = this.music;
    return { positionMs: (m?.currentPlaybackTime ?? 0) * 1000, atMs: performance.now(), playing: !!m?.isPlaying };
  }

  dispose() {
    void this.music?.stop?.();
  }
}
