/**
 * Spotify Class B adapter: Authorization Code + PKCE in the browser (popup, falls back to a redirect),
 * Web Playback SDK for the in-browser device, Web API for play/seek. Each device plays under its own Premium
 * account (one stream per account; relaying one stream to many devices is not allowed). Sign-in is kept per
 * device in localStorage and refreshed (spotifyAuth.ts); tokens are never logged. Browser-only.
 */
import type { RemoteServiceStatus } from '@syncsound/protocol';
import { spotifyClientId, spotifyConfigured, spotifyRedirectUri } from '../config';
import { randomId } from '../device';
import { loadScript } from './loadScript';
import { BROWSE_SCOPES, PLAYBACK_SCOPES, SpotifyAuthError, classify403, spotifyAuth } from './spotifyAuth';
import type { RemotePlayerAdapter, RemotePosition } from './types';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const PKCE_KEY = 'syncsound:spotify:pkce';
const MSG_TYPE = 'syncsound:spotify';

/** this browser's Spotify sign-in */
export const auth = () => spotifyAuth(() => spotifyClientId);
export const hasSpotifyAuth = () => spotifyConfigured && auth().has();
export const spotifyCanBrowse = () => auth().scopeCovers(BROWSE_SCOPES);

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * Sign in. MUST be called synchronously from a click (opens the popup before any await). `browse` also asks to
 * read playlists and Liked Songs (the controller browses; speakers only play). Resolves once signed in; with
 * popups blocked it redirects (the page unloads).
 */
export function loginSpotify(opts: { browse?: boolean } = {}): Promise<void> {
  const popup = window.open('', 'syncsound-spotify', 'width=480,height=720');
  return (async () => {
    if (!crypto.subtle) {
      popup?.close();
      throw new Error('Spotify sign-in needs a secure (https) page.');
    }
    const verifier = randomId(64);
    const state = randomId(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, returnTo: location.pathname + location.search + location.hash }));
    const scope = [...PLAYBACK_SCOPES, ...(opts.browse ? BROWSE_SCOPES : [])].join(' ');
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: spotifyClientId,
      response_type: 'code',
      redirect_uri: spotifyRedirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope,
      state,
      ...(opts.browse && auth().has() ? { show_dialog: 'true' } : {}),
    })}`;
    if (!popup) {
      location.assign(url);
      return new Promise<void>(() => {}); // page is navigating away
    }
    popup.location.href = url;
    const before = auth().read()?.accessToken ?? null;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('message', onMsg);
        clearInterval(iv);
      };
      // the popup stores the tokens itself (same origin); the message only says how it went
      const onMsg = (e: MessageEvent<{ type?: string; ok?: boolean; error?: string }>) => {
        if (e.origin !== location.origin || e.data?.type !== MSG_TYPE) return;
        cleanup();
        auth().notify();
        if (e.data.ok) resolve();
        else reject(new Error(e.data.error ?? 'Spotify sign-in failed.'));
      };
      const iv = setInterval(() => {
        if (!popup.closed) return;
        cleanup();
        const now = auth().read()?.accessToken ?? null;
        if (now && now !== before) resolve();
        else if (auth().has() && !opts.browse) resolve();
        else reject(new Error('Spotify sign-in was closed before finishing.'));
      }, 500);
      window.addEventListener('message', onMsg);
    });
  })();
}

/**
 * For the /spotify-callback page: exchange the code and store the sign-in on this device. In a popup it tells the
 * opener and closes the window (returns { returnTo: null }); after a full redirect it returns where to go back to.
 */
export async function handleSpotifyCallback(): Promise<{ returnTo: string | null }> {
  const q = new URLSearchParams(location.search);
  let pkce: { verifier: string; state: string; returnTo: string } | null = null;
  try {
    pkce = JSON.parse(localStorage.getItem(PKCE_KEY) ?? 'null');
    localStorage.removeItem(PKCE_KEY);
  } catch {
    pkce = null;
  }
  const opener = window.opener as Window | null;
  const finish = (error?: string) => {
    if (opener && opener !== window) {
      opener.postMessage({ type: MSG_TYPE, ok: !error, ...(error && { error }) }, location.origin);
      window.close();
      return { returnTo: null };
    }
    if (error) throw new Error(error);
    return { returnTo: pkce?.returnTo ?? '/' };
  };
  try {
    const err = q.get('error');
    if (err) throw new Error(err === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed (${err}).`);
    const code = q.get('code');
    if (!code || !pkce || q.get('state') !== pkce.state) throw new Error('Spotify sign-in expired. Try connecting again.');
    await auth().exchangeCode(code, pkce.verifier, spotifyRedirectUri());
    return finish();
  } catch (e) {
    return finish(e instanceof Error ? e.message : String(e));
  }
}

/** a Web API call failed with a status the caller should show */
export class SpotifyHttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
    readonly kind?: 'needs-premium' | 'not-allowlisted' | 'signed-out',
  ) {
    super(msg);
  }
}

/**
 * Authorized Web API request: refreshes the token before it expires and once more after a 401.
 * 403s are classified (Premium required / account not on the dev-mode allow-list).
 */
export async function spotifyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string | null;
    try {
      token = await auth().getAccessToken(attempt > 0);
    } catch (e) {
      throw new SpotifyHttpError(0, e instanceof SpotifyAuthError ? e.message : String(e));
    }
    if (!token) throw new SpotifyHttpError(401, 'Spotify session expired. Connect again.', 'signed-out');
    const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined && { 'content-type': 'application/json' }), ...init.headers },
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) throw new SpotifyHttpError(401, 'Spotify session expired. Connect again.', 'signed-out');
    if (res.status === 403) {
      const c = classify403(await res.json().catch(() => null));
      throw new SpotifyHttpError(403, c.message, c.kind === 'forbidden' ? undefined : c.kind);
    }
    return res;
  }
  throw new SpotifyHttpError(401, 'Spotify session expired. Connect again.', 'signed-out');
}

interface SdkState {
  position: number;
  duration: number;
  paused: boolean;
  timestamp: number;
  track_window?: { current_track?: { uri?: string } | null };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (d: { device_id?: string; message?: string } & Partial<SdkState>) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  activateElement?(): Promise<void>;
}
type SdkWindow = Window & {
  Spotify?: { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
  onSpotifyWebPlaybackSDKReady?: () => void;
};

let sdkPromise: Promise<NonNullable<SdkWindow['Spotify']>> | null = null;
function loadSdk(): Promise<NonNullable<SdkWindow['Spotify']>> {
  const w = window as SdkWindow;
  if (w.Spotify) return Promise.resolve(w.Spotify);
  sdkPromise ??= new Promise((resolve, reject) => {
    w.onSpotifyWebPlaybackSDKReady = () => (w.Spotify ? resolve(w.Spotify) : reject(new Error('Spotify SDK failed to start.')));
    loadScript(SDK_URL).catch((e: unknown) => {
      sdkPromise = null;
      reject(e);
    });
  });
  return sdkPromise;
}

export class SpotifyAdapter implements RemotePlayerAdapter {
  readonly name = 'spotify' as const;
  status: RemoteServiceStatus = spotifyConfigured ? 'signed-out' : 'unconfigured';
  message: string | null = null;
  needsTap = false;
  elsewhere = false;
  onChange: (() => void) | null = null;
  private player: SdkPlayer | null = null;
  private connected = false;
  private deviceId: string | null = null;
  private uri: string | null = null;
  private next: string | null = null;

  constructor(private readonly deviceName: () => string = () => 'SyncSound') {}

  /** load the SDK and create the (not yet connected) player, so a later tap can unlock its audio synchronously */
  async prepare(): Promise<void> {
    if (!spotifyConfigured || this.player) return;
    const Spotify = await loadSdk();
    if (this.player) return;
    const player = new Spotify.Player({
      name: `SyncSound · ${this.deviceName()}`.slice(0, 60),
      getOAuthToken: (cb) => void auth().getAccessToken().then((t) => cb(t ?? ''), () => cb('')),
      volume: 0.8,
    });
    this.player = player;
    player.addListener('ready', ({ device_id }) => {
      this.deviceId = device_id ?? null;
      this.emit();
    });
    player.addListener('not_ready', () => {
      this.deviceId = null;
      this.emit();
    });
    player.addListener('account_error', () => this.fail('needs-premium', 'Spotify Premium is required to play in the browser.'));
    player.addListener('authentication_error', () => {
      // the token was refreshed already if possible: this account can't use the player
      this.fail('signed-out', 'Spotify session expired. Connect again.');
    });
    player.addListener('initialization_error', ({ message }) => this.fail('error', `Spotify can't play in this browser: ${message ?? 'unsupported'}.`));
    player.addListener('playback_error', ({ message }) => {
      this.message = `Spotify playback error: ${message ?? 'unknown'}`;
      this.emit();
    });
    // iOS/Safari: the first play after a transfer needs a tap
    player.addListener('autoplay_failed', () => {
      this.needsTap = true;
      this.emit();
    });
    // null = this device is no longer the account's active player (it was started on another device)
    player.addListener('player_state_changed', (state) => {
      const lost = state === null || state === undefined || state.timestamp === undefined;
      if (lost !== this.elsewhere) {
        this.elsewhere = lost && this.uri !== null;
        this.emit();
      }
    });
  }

  /** synchronous: MUST run inside the user's tap (unlocks the SDK's audio element on iOS/Safari) */
  activate(): void {
    void this.player?.activateElement?.().catch(() => {});
    this.needsTap = false;
  }

  private emit() {
    this.onChange?.();
  }

  private fail(status: RemoteServiceStatus, message: string) {
    this.status = status;
    this.message = message;
    this.emit();
  }

  async connect(): Promise<RemoteServiceStatus> {
    if (!spotifyConfigured) return (this.status = 'unconfigured');
    if (!auth().has()) return (this.status = 'signed-out');
    if (this.connected && this.deviceId && this.status === 'ready') return this.status;
    await this.prepare();
    const player = this.player!;
    const status = await new Promise<RemoteServiceStatus>((resolve) => {
      if (this.deviceId) return resolve('ready');
      const t = setTimeout(() => {
        off();
        this.message = 'Spotify player did not become ready.';
        resolve('error');
      }, 15_000);
      const prev = this.onChange;
      const off = () => (this.onChange = prev);
      // resolve on the first decisive event (ready, or a failure listener setting the status)
      this.onChange = () => {
        prev?.();
        if (this.deviceId) {
          clearTimeout(t);
          off();
          resolve('ready');
        } else if (this.status === 'needs-premium' || this.status === 'error' || (this.status === 'signed-out' && this.message)) {
          clearTimeout(t);
          off();
          resolve(this.status);
        }
      };
      this.status = 'signed-out';
      this.message = null;
      player.connect().then(
        (ok) => {
          if (ok) return;
          clearTimeout(t);
          off();
          resolve('error');
        },
        () => {
          clearTimeout(t);
          off();
          resolve('error');
        },
      );
    });
    this.connected = status === 'ready';
    this.status = status;
    if (status === 'ready') this.message = null;
    return status;
  }

  private async api(method: string, path: string, body?: unknown) {
    try {
      const res = await spotifyFetch(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
      if (res.ok || res.status === 204) return;
      if (res.status === 404) {
        this.deviceId = null; // the SDK device went away (e.g. after a long sleep): reconnect
        this.connected = false;
        this.status = 'error';
        throw new Error('Spotify lost this player. Connect again.');
      }
      throw new Error(`Spotify request failed (HTTP ${res.status}).`);
    } catch (e) {
      if (e instanceof SpotifyHttpError && e.kind) {
        this.status = e.kind === 'not-allowlisted' ? 'error' : e.kind;
        this.message = e.message;
        this.emit();
      }
      throw e;
    }
  }

  async load(remoteId: string, opts: { next?: string | null } = {}) {
    this.uri = remoteId;
    this.next = opts.next ?? null;
  }

  async play(positionMs: number) {
    if (!this.deviceId || !this.uri) throw new Error('Spotify player is not ready.');
    // the next track rides along so the SDK has it buffered; SyncSound still starts it on the room timeline
    await this.api('PUT', `/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, {
      uris: this.next && this.next !== this.uri ? [this.uri, this.next] : [this.uri],
      position_ms: Math.max(0, Math.round(positionMs)),
    });
    this.elsewhere = false;
  }

  async pause() {
    await this.player?.pause();
  }

  async seek(positionMs: number) {
    if (!this.deviceId) return;
    await this.api('PUT', `/me/player/seek?position_ms=${Math.max(0, Math.round(positionMs))}&device_id=${encodeURIComponent(this.deviceId)}`);
  }

  async setVolume(v: number) {
    await this.player?.setVolume(Math.min(1, Math.max(0, v)));
  }

  async getPosition(): Promise<RemotePosition> {
    const now = performance.now();
    const s = await this.player?.getCurrentState();
    if (!s) return { positionMs: 0, atMs: now, playing: false, uri: null };
    const age = Date.now() - s.timestamp;
    return {
      positionMs: s.position,
      atMs: now - (age >= 0 && age < 5000 ? age : 0),
      playing: !s.paused,
      uri: s.track_window?.current_track?.uri ?? null,
      durationMs: s.duration || undefined,
    };
  }

  dispose() {
    this.player?.disconnect();
    this.player = null;
    this.connected = false;
    this.deviceId = null;
    this.uri = null;
  }
}
