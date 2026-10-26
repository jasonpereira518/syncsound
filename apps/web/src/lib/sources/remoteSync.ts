/**
 * Drives the Class B (Spotify/Apple) player for the room's current remote track: load, start at the room
 * time, then every 500 ms compare the reported position with the room timeline and re-seek via
 * RemoteSyncController. The engine renders nothing for remote tracks. Browser-only.
 */
import { RemoteSyncController } from '@syncsound/audio-core';
import type { ClientMessage, Playback, RemoteServiceStatus } from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
import { appleConfigured, spotifyConfigured } from '../config';
import { roomPosition } from '../engine/timing';
import { AppleMusicAdapter } from './appleMusic';
import { MockRemoteAdapter } from './mock';
import { isMockRemote } from './mockMode';
import { SpotifyAdapter, auth, hasSpotifyAuth } from './spotify';
import { extrapolate, type RemotePlayerAdapter } from './types';

type Kind = 'spotify' | 'apple';
const playbackKey = (pb: Playback) => `${pb.trackId}|${pb.startRoomTime}|${pb.trackOffset}`;

export class RemoteSyncManager {
  private adapters: Partial<Record<Kind, RemotePlayerAdapter>> = {};
  private active: { kind: Kind; adapter: RemotePlayerAdapter; trackId: string; playingKey: string | null } | null = null;
  private readonly ctrl = new RemoteSyncController();
  private readonly mock: boolean;
  private timer: ReturnType<typeof setInterval>;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private seekPending = false;
  private ticking = false;
  private busy = false;
  private dirty = false;
  private lastVolume = -1;
  private sentRemote = '';

  constructor(
    private readonly deps: { nowRoom: () => number | null; send: (m: ClientMessage) => boolean; outputGain: () => number },
  ) {
    this.mock = isMockRemote();
    this.timer = setInterval(() => void this.tick(), 500);
    patch('remote', {
      spotify: this.mock ? 'signed-out' : spotifyConfigured ? 'signed-out' : 'unconfigured',
      apple: this.mock ? 'signed-out' : appleConfigured ? 'signed-out' : 'unconfigured',
      needsTap: false,
      elsewhere: false,
    });
    if (!this.mock && spotifyConfigured) {
      // load the SDK now so a later tap can unlock its audio synchronously; a device that signed in before
      // reconnects on its own (connect once per device)
      const a = this.adapterFor('spotify');
      void a.prepare?.().catch(() => {});
      if (hasSpotifyAuth()) void this.connect('spotify');
      this.unsubAuth = auth().subscribe(() => {
        if (!hasSpotifyAuth() && this.adapters.spotify && this.adapters.spotify.status === 'ready') {
          this.adapters.spotify.status = 'signed-out';
          this.publish();
        }
      });
    }
  }

  private unsubAuth: (() => void) | null = null;

  private deviceName = () => {
    const st = useRoomStore.getState();
    return st.room?.devices.find((d) => d.id === st.deviceId)?.name ?? 'speaker';
  };

  private adapterFor(kind: Kind): RemotePlayerAdapter {
    let a = this.adapters[kind];
    if (!a) {
      a = this.mock ? new MockRemoteAdapter() : kind === 'spotify' ? new SpotifyAdapter(this.deviceName) : new AppleMusicAdapter();
      a.onChange = () => {
        this.publish();
        this.onRoomChanged();
      };
      this.adapters[kind] = a;
    }
    return a;
  }

  /** true when this device is signed in, so connect() won't need the sign-in popup */
  get spotifySignedIn() {
    return this.mock || hasSpotifyAuth();
  }

  /** synchronous, inside the user's tap: unlock the player's audio (iOS/Safari) */
  activate(kind: Kind): void {
    this.adapterFor(kind).activate?.();
    this.publish();
  }

  /** after "Tap to start" / "Play here": start the current track on this device again */
  restart(): void {
    if (this.active) this.active.playingKey = null;
    this.onRoomChanged();
  }

  /** sign this device out of the service */
  disconnect(kind: Kind): void {
    const a = this.adapters[kind];
    if (this.active?.kind === kind) void this.deactivate();
    a?.dispose();
    delete this.adapters[kind];
    if (kind === 'spotify' && !this.mock) auth().clear();
    patch('remote', { [kind]: this.mock || (kind === 'spotify' ? spotifyConfigured : appleConfigured) ? 'signed-out' : 'unconfigured', message: null });
    this.publish();
  }

  async connect(kind: Kind): Promise<void> {
    const a = this.adapterFor(kind);
    try {
      await a.connect();
    } catch (e) {
      a.status = 'error';
      a.message = errMsg(e);
    }
    this.publish();
    this.onRoomChanged();
  }

  /** push adapter statuses to the store + DEVICE_UPDATE remote (only when changed) */
  publish() {
    const status = (k: Kind): RemoteServiceStatus => this.adapters[k]?.status ?? useRoomStore.getState().remote[k];
    const remote = { spotify: status('spotify'), apple: status('apple') };
    const msg = this.active?.adapter.message ?? this.adapters.spotify?.message ?? this.adapters.apple?.message ?? null;
    const flags = this.active?.adapter ?? this.adapters.spotify;
    patch('remote', { ...remote, needsTap: !!flags?.needsTap, elsewhere: !!flags?.elsewhere, ...(msg ? { message: msg } : {}) });
    const key = JSON.stringify(remote);
    if (key !== this.sentRemote && this.deps.send({ type: 'DEVICE_UPDATE', patch: { remote } })) this.sentRemote = key;
  }

  onRoomChanged(): void {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    void this.reconcile()
      .catch((e) => patch('remote', { message: errMsg(e) }))
      .finally(() => {
        this.busy = false;
        this.publish();
        if (this.dirty) {
          this.dirty = false;
          this.onRoomChanged();
        }
      });
  }

  private async deactivate() {
    const a = this.active;
    this.active = null;
    this.clearStart();
    if (a?.playingKey) await a.adapter.pause().catch(() => {});
  }

  private async reconcile() {
    const room = useRoomStore.getState().room;
    const track = room?.queue.find((t) => t.id === room.playback.trackId);
    const kind = track?.kind === 'spotify' || track?.kind === 'apple' ? track.kind : null;
    if (!room || !track || track.sourceClass !== 'remote' || !kind || !track.remoteId) {
      await this.deactivate();
      return;
    }
    const a = this.adapterFor(kind);
    if (a.status !== 'ready') {
      await this.deactivate();
      patch('remote', {
        message: kind === 'spotify' ? 'Connect Spotify on this device to hear this track.' : 'Connect Apple Music on this device to hear this track.',
      });
      return;
    }
    if (!this.active || this.active.trackId !== track.id || this.active.adapter !== a) {
      await this.deactivate();
      this.active = { kind, adapter: a, trackId: track.id, playingKey: null };
      await a.load(track.remoteId);
      this.ctrl.reset();
      patch('remote', { message: 'Sync-only mode (no spatial/EQ)', errorMs: null, meanAbsErrorMs: null, seeks: 0 });
    }
    const vol = Math.min(1, Math.max(0, this.deps.outputGain()));
    if (Math.abs(vol - this.lastVolume) > 0.005) {
      this.lastVolume = vol;
      await a.setVolume(vol);
    }
    const pb = room.playback;
    const act = this.active;
    if (pb.status === 'playing') {
      const key = playbackKey(pb);
      if (act.playingKey !== key) {
        act.playingKey = key;
        this.scheduleStart(a, pb);
      }
    } else if (act.playingKey !== null) {
      act.playingKey = null;
      this.clearStart();
      await a.pause();
    }
  }

  private clearStart() {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private scheduleStart(a: RemotePlayerAdapter, pb: Playback) {
    this.clearStart();
    const now = this.deps.nowRoom();
    if (now === null) return; // tick() re-seeks once the clock is synced
    let lead = 0;
    try {
      lead = this.ctrl.stats().seekLatencyMs || 0;
    } catch {
      lead = 0;
    }
    const fail = (e: unknown) => patch('remote', { message: errMsg(e) });
    const wait = pb.startRoomTime - now - lead;
    if (wait > 0) this.startTimer = setTimeout(() => void a.play(pb.trackOffset * 1000).catch(fail), wait);
    else void a.play(roomPosition(pb, now + lead) * 1000).catch(fail);
  }

  private async tick() {
    const act = this.active;
    const pb = useRoomStore.getState().room?.playback;
    if (!act || !act.playingKey || !pb || pb.status !== 'playing') return;
    const startNow = this.deps.nowRoom();
    if (startNow === null || startNow < pb.startRoomTime + 1000 || this.ticking) return;
    this.ticking = true; // never overlap: the first reading after a seek resolves feeds recordSeekResult
    try {
      const pos = await act.adapter.getPosition();
      const nowLocal = performance.now();
      const nowRoom = this.deps.nowRoom();
      if (nowRoom === null || this.active !== act) return;
      const reported = extrapolate(pos, nowLocal);
      const expected = roomPosition(pb, nowRoom) * 1000;
      if (this.seekPending) {
        this.ctrl.recordSeekResult(expected - reported); // +ve = player behind
        this.seekPending = false;
      }
      const dec = this.ctrl.update({ expectedPositionMs: expected, reportedPositionMs: reported, nowMs: nowLocal });
      if (dec.action === 'seek' && dec.seekToMs !== undefined) {
        await act.adapter.seek(dec.seekToMs);
        this.seekPending = true;
      }
      const s = this.ctrl.stats();
      patch('remote', { errorMs: Math.round(dec.errorMs), meanAbsErrorMs: Math.round(s.meanAbsErrorMs), seeks: s.seeks });
    } catch (e) {
      patch('remote', { message: errMsg(e) });
    } finally {
      this.ticking = false;
    }
  }

  /** current remote error for STATS */
  errorMs(): number | null {
    return this.active?.playingKey ? useRoomStore.getState().remote.errorMs : null;
  }

  dispose() {
    this.unsubAuth?.();
    clearInterval(this.timer);
    this.clearStart();
    for (const a of Object.values(this.adapters)) a?.dispose();
    this.adapters = {};
    this.active = null;
  }
}

