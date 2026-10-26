/**
 * Drives the Class B (Spotify/Apple) player for the room's current remote track: load, start at the room
 * time, then every 500 ms compare the reported position with the room timeline and re-seek via
 * RemoteSyncController. The engine renders nothing for remote tracks. Browser-only.
 *
 * Each device plays under its own account; this only keeps the players on the room timeline. The timeline is
 * shifted by the device's output compensation (manual + calibrated, e.g. a Bluetooth speaker's delay), the start
 * and seek delays the player shows are learned and kept across tracks and sessions, and the hand-over at a track
 * boundary lets the current song finish before the next one starts on the room timeline.
 */
import { RemoteSyncController, clampRemoteSeek, decideRemoteTick, type RemoteLeads } from '@syncsound/audio-core';
import type { ClientMessage, Playback, RemoteServiceStatus, RoomState, Track } from '@syncsound/protocol';
import { errMsg, patch, useRoomStore } from '../../store/state';
import { appleConfigured, spotifyConfigured } from '../config';
import { storage } from '../device';
import { roomPosition } from '../engine/timing';
import { AppleMusicAdapter } from './appleMusic';
import { MockRemoteAdapter } from './mock';
import { isMockRemote } from './mockMode';
import { SpotifyAdapter, auth, hasSpotifyAuth } from './spotify';
import { mockDurationMs } from './spotifyMock';
import { extrapolate, type RemotePlayerAdapter } from './types';

type Kind = 'spotify' | 'apple';
const playbackKey = (pb: Playback) => `${pb.trackId}|${pb.startRoomTime}|${pb.trackOffset}`;
/** the next remote song rides along in the play request so the player has it buffered at the boundary */
const PRELOAD_NEXT = true;
const leadsKey = (adapter: RemotePlayerAdapter) => `syncsound:remote:leads:${adapter.name}`;

function loadLeads(adapter: RemotePlayerAdapter): Partial<RemoteLeads> {
  try {
    return JSON.parse(storage()?.getItem(leadsKey(adapter)) ?? '{}') as Partial<RemoteLeads>;
  } catch {
    return {};
  }
}

function saveLeads(adapter: RemotePlayerAdapter, leads: RemoteLeads) {
  try {
    storage()?.setItem(leadsKey(adapter), JSON.stringify({ seekMs: Math.round(leads.seekMs), startMs: Math.round(leads.startMs) }));
  } catch {
    /* storage blocked: learned again next session */
  }
}

/** the remote track after `track` in the queue, if the same service plays it */
function nextRemoteUri(room: RoomState, track: Track): string | null {
  const i = room.queue.findIndex((t) => t.id === track.id);
  const n = room.queue[i + 1];
  return n && n.kind === track.kind && n.sourceClass === 'remote' && n.remoteId ? n.remoteId : null;
}

interface Active {
  kind: Kind;
  adapter: RemotePlayerAdapter;
  trackId: string;
  uri: string;
  durationMs: number | null;
  /** the room playback this player was started for (null = not started / paused) */
  playingKey: string | null;
  /** performance.now() of the last play request */
  startedAt: number;
  /** the next sync reading measures how late the last start landed */
  startPending: boolean;
  /** restarts since the player was last seen playing the right song */
  replays: number;
}

export interface RemoteSyncDeps {
  nowRoom: () => number | null;
  send: (m: ClientMessage) => boolean;
  outputGain: () => number;
  /** how much earlier than the room timeline this device must sound, ms (manual + calibrated − propagation) */
  compensationMs?: () => number;
}

export class RemoteSyncManager {
  private adapters: Partial<Record<Kind, RemotePlayerAdapter>> = {};
  private active: Active | null = null;
  private readonly ctrl = new RemoteSyncController();
  private readonly mock: boolean;
  private timer: ReturnType<typeof setInterval>;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private seekPending = false;
  private ticking = false;
  private busy = false;
  private dirty = false;
  private lastVolume = -1;
  private sentRemote = '';
  private unsubAuth: (() => void) | null = null;

  constructor(private readonly deps: RemoteSyncDeps) {
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

  private deviceName = () => {
    const st = useRoomStore.getState();
    return st.room?.devices.find((d) => d.id === st.deviceId)?.name ?? 'speaker';
  };

  private comp(): number {
    try {
      const c = this.deps.compensationMs?.() ?? 0;
      return Number.isFinite(c) ? c : 0;
    } catch {
      return 0;
    }
  }

  private adapterFor(kind: Kind): RemotePlayerAdapter {
    let a = this.adapters[kind];
    if (!a) {
      a = this.mock
        ? new MockRemoteAdapter({ durationMs: mockDurationMs })
        : kind === 'spotify'
          ? new SpotifyAdapter(this.deviceName)
          : new AppleMusicAdapter();
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
    const a = this.active;
    if (a) {
      a.playingKey = null;
      a.replays = 0;
      if (a.adapter.elsewhere) a.adapter.elsewhere = false;
    }
    patch('remote', { elsewhere: false });
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
    patch('remote', { ...remote, needsTap: !!flags?.needsTap, ...(flags?.elsewhere && { elsewhere: true }), ...(msg ? { message: msg } : {}) });
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
    this.clearStop();
    if (a?.playingKey) await a.adapter.pause().catch(() => {});
  }

  /**
   * The room moves on to a track this player doesn't play: let the current song run until the room's hand-over
   * (the new track's start, shifted by this device's compensation), then pause. Immediate when not playing.
   */
  private handOverAway(pb: Playback) {
    const act = this.active;
    const now = this.deps.nowRoom();
    if (!act?.playingKey || pb.status !== 'playing' || now === null || pb.startRoomTime - this.comp() <= now) {
      void this.deactivate();
      return;
    }
    if (this.stopTimer) return;
    this.clearStart();
    this.stopTimer = setTimeout(
      () => {
        this.stopTimer = null;
        if (this.active === act) void this.deactivate();
      },
      pb.startRoomTime - this.comp() - now,
    );
  }

  private async reconcile() {
    const room = useRoomStore.getState().room;
    const track = room?.queue.find((t) => t.id === room.playback.trackId);
    const kind = track?.kind === 'spotify' || track?.kind === 'apple' ? track.kind : null;
    if (!room || !track || track.sourceClass !== 'remote' || !kind || !track.remoteId) {
      if (room) this.handOverAway(room.playback);
      else await this.deactivate();
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
    this.clearStop();
    const next = PRELOAD_NEXT ? nextRemoteUri(room, track) : null;
    const durationMs = track.durationSec ? track.durationSec * 1000 : null;
    const fresh = (): Active => ({ kind, adapter: a, trackId: track.id, uri: track.remoteId!, durationMs, playingKey: null, startedAt: 0, startPending: false, replays: 0 });
    if (!this.active || this.active.adapter !== a) {
      await this.deactivate();
      this.active = fresh();
      await a.load(track.remoteId, { next });
      this.ctrl.reset();
      this.ctrl.seedLeads(loadLeads(a));
      this.seekPending = false;
      patch('remote', { message: 'Sync-only mode (no spatial/EQ)', errorMs: null, meanAbsErrorMs: null, seeks: 0, elsewhere: false });
    } else if (this.active.trackId !== track.id) {
      // same player, next song: keep the current one sounding until the new one starts on the room timeline
      // (the advance arrives ahead of the boundary); the new start then replaces it
      this.clearStart();
      this.active = fresh();
      await a.load(track.remoteId, { next });
      this.ctrl.resetTrack();
      this.seekPending = false;
      patch('remote', { message: 'Sync-only mode (no spatial/EQ)', errorMs: null, meanAbsErrorMs: null, seeks: 0, elsewhere: false });
    } else {
      await a.load(track.remoteId, { next }); // the following song may have changed (queue edits)
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
        this.scheduleStart(act, pb);
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

  private clearStop() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  /** ask the player to start so the song is heard at the room time, ahead by compensation + the learned start delay */
  private scheduleStart(act: Active, pb: Playback) {
    this.clearStart();
    const now = this.deps.nowRoom();
    if (now === null) return; // tick() starts it once the clock is synced
    const a = act.adapter;
    const lead = this.ctrl.stats().startLatencyMs || 0;
    const fail = (e: unknown) => patch('remote', { message: errMsg(e) });
    const start = async (late: boolean) => {
      if (this.active !== act) return;
      if (!late) {
        // the player already moved into this song from the previous one (it rode along): keep it, ticks correct it
        const pos = await a.getPosition().catch(() => null);
        if (pos?.playing && pos.uri === act.uri) {
          act.startedAt = performance.now();
          act.startPending = false;
          return;
        }
      }
      const at = late ? roomPosition(pb, (this.deps.nowRoom() ?? now) + this.comp() + lead) * 1000 : pb.trackOffset * 1000;
      act.startedAt = performance.now();
      act.startPending = true;
      await a.play(at);
    };
    const wait = pb.startRoomTime - this.comp() - now - lead;
    if (wait > 0) this.startTimer = setTimeout(() => void start(false).catch(fail), wait);
    else void start(true).catch(fail);
  }

  private async tick() {
    const act = this.active;
    const pb = useRoomStore.getState().room?.playback;
    if (!act || !pb || this.ticking) return;
    const startNow = this.deps.nowRoom();
    if (startNow === null) return;
    const roomPlaying = pb.status === 'playing' && pb.trackId === act.trackId && act.playingKey !== null;
    // playing: only after the start (and the hand-over) has happened; not playing: watch for a stray player
    if (roomPlaying && startNow < pb.startRoomTime + 1000) return;
    if (!roomPlaying && (pb.status === 'playing' || this.stopTimer)) return;
    this.ticking = true; // never overlap: the first reading after a seek resolves feeds recordSeekResult
    try {
      const pos = await act.adapter.getPosition();
      const nowLocal = performance.now();
      const nowRoom = this.deps.nowRoom();
      if (nowRoom === null || this.active !== act) return;
      const comp = this.comp();
      const expected = roomPosition(pb, nowRoom + comp) * 1000;
      const d = decideRemoteTick({
        roomPlaying,
        expectedMs: expected,
        durationMs: act.durationMs,
        player: { playing: pos.playing, uri: pos.uri },
        wantUri: act.uri,
        sinceStartMs: nowLocal - act.startedAt,
        replays: act.replays,
        elsewhere: !!act.adapter.elsewhere,
      });
      if (d.kind === 'pause') {
        await act.adapter.pause(); // nothing plays unless the room starts it
        return;
      }
      if (d.kind === 'hold') {
        if (d.reason === 'elsewhere' && !useRoomStore.getState().remote.elsewhere) patch('remote', { elsewhere: true });
        return;
      }
      if (d.kind === 'replay') {
        act.replays++;
        act.startedAt = nowLocal;
        act.startPending = true;
        this.seekPending = false;
        const lead = this.ctrl.stats().startLatencyMs || 0;
        await act.adapter.play(clampRemoteSeek(roomPosition(pb, nowRoom + comp + lead) * 1000, act.durationMs));
        return;
      }
      act.replays = 0;
      if (useRoomStore.getState().remote.elsewhere) patch('remote', { elsewhere: false });
      const reported = extrapolate(pos, nowLocal);
      if (act.startPending) {
        this.ctrl.recordStartResult(expected - reported); // +ve = player behind
        act.startPending = false;
        saveLeads(act.adapter, this.ctrl.exportLeads());
      } else if (this.seekPending) {
        this.ctrl.recordSeekResult(expected - reported);
        saveLeads(act.adapter, this.ctrl.exportLeads());
      }
      this.seekPending = false;
      const dec = this.ctrl.update({ expectedPositionMs: expected, reportedPositionMs: reported, nowMs: nowLocal });
      if (dec.action === 'seek' && dec.seekToMs !== undefined) {
        await act.adapter.seek(clampRemoteSeek(dec.seekToMs, act.durationMs));
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
    this.clearStop();
    for (const a of Object.values(this.adapters)) a?.dispose();
    this.adapters = {};
    this.active = null;
  }
}
