/**
 * Spotify Class B adapter: Authorization Code + PKCE in the browser (popup, falls back to a redirect),
 * Web Playback SDK for the in-browser device, Web API for play/seek. Token lives in memory + sessionStorage
 * only and is never logged. Browser-only.
 */
import type { RemoteServiceStatus } from '@syncsound/protocol';
import { spotifyClientId, spotifyConfigured, spotifyRedirectUri } from '../config';
import { randomId } from '../device';
import { loadScript } from './loadScript';
import type { RemotePlayerAdapter, RemotePosition } from './types';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
const PKCE_KEY = 'syncsound:spotify:pkce';
const TOKEN_KEY = 'syncsound:spotify:token';
const MSG_TYPE = 'syncsound:spotify';

interface Token {
  accessToken: string;
  expiresAt: number;
}
let memToken: Token | null = null;

export function getSpotifyToken(): string | null {
  if (!memToken) {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      memToken = raw ? (JSON.parse(raw) as Token) : null;
    } catch {
      memToken = null;
    }
  }
  return memToken && memToken.expiresAt > Date.now() + 30_000 ? memToken.accessToken : null;
}

function saveToken(t: Token | null) {
  memToken = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* memory only */
  }
}

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * Sign in. MUST be called synchronously from a click (opens the popup before any await).
 * Resolves once a token is available; with popups blocked it redirects (the page unloads).
 */
export function loginSpotify(): Promise<void> {
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
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: spotifyClientId,
      response_type: 'code',
      redirect_uri: spotifyRedirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    })}`;
    if (!popup) {
      location.assign(url);
      return new Promise<void>(() => {}); // page is navigating away
    }
    popup.location.href = url;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('message', onMsg);
        clearInterval(iv);
      };
      const onMsg = (e: MessageEvent<{ type?: string; token?: Token; error?: string }>) => {
        if (e.origin !== location.origin || e.data?.type !== MSG_TYPE) return;
        cleanup();
        if (e.data.token) {
          saveToken(e.data.token);
          resolve();
        } else reject(new Error(e.data.error ?? 'Spotify sign-in failed.'));
      };
      const iv = setInterval(() => {
        if (!popup.closed) return;
        cleanup();
        if (getSpotifyToken()) resolve();
        else reject(new Error('Spotify sign-in was closed before finishing.'));
      }, 500);
      window.addEventListener('message', onMsg);
    });
  })();
}

/**
 * For the /spotify-callback page. In a popup it hands the token to the opener and closes the window
 * (returns { returnTo: null }); after a full redirect it stores the token and returns where to go back to.
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
  const finish = (payload: { token?: Token; error?: string }) => {
    if (opener && opener !== window) {
      opener.postMessage({ type: MSG_TYPE, ...payload }, location.origin);
      window.close();
      return { returnTo: null };
    }
    if (payload.error) throw new Error(payload.error);
    saveToken(payload.token!);
    return { returnTo: pkce?.returnTo ?? '/' };
  };
  try {
    const err = q.get('error');
    if (err) throw new Error(err === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed (${err}).`);
    const code = q.get('code');
    if (!code || !pkce || q.get('state') !== pkce.state) throw new Error('Spotify sign-in expired. Try connecting again.');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: spotifyRedirectUri(),
        client_id: spotifyClientId,
        code_verifier: pkce.verifier,
      }),
    });
    if (!res.ok) throw new Error("Spotify rejected the sign-in. Check the app's redirect URI settings.");
    const j = (await res.json()) as { access_token: string; expires_in: number };
    return finish({ token: { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 } });
  } catch (e) {
    return finish({ error: e instanceof Error ? e.message : String(e) });
  }
}

interface SdkState {
  position: number;
  paused: boolean;
  timestamp: number;
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (d: { device_id?: string; message?: string }) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  setVolume(v: number): Promise<void>;
  pause(): Promise<void>;
  activateElement?(): Promise<void>;
}
type SdkWindow = Window & {
  Spotify?: { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
  onSpotifyWebPlaybackSDKReady?: () => void;
};

function loadSdk(): Promise<NonNullable<SdkWindow['Spotify']>> {
  const w = window as SdkWindow;
  if (w.Spotify) return Promise.resolve(w.Spotify);
  return new Promise((resolve, reject) => {
    w.onSpotifyWebPlaybackSDKReady = () => (w.Spotify ? resolve(w.Spotify) : reject(new Error('Spotify SDK failed to start.')));
    loadScript(SDK_URL).catch(reject);
  });
}

export class SpotifyAdapter implements RemotePlayerAdapter {
  readonly name = 'spotify' as const;
  status: RemoteServiceStatus = spotifyConfigured ? 'signed-out' : 'unconfigured';
  message: string | null = null;
  private player: SdkPlayer | null = null;
  private deviceId: string | null = null;
  private uri: string | null = null;

  async connect(): Promise<RemoteServiceStatus> {
    if (!spotifyConfigured) return (this.status = 'unconfigured');
    if (!getSpotifyToken()) return (this.status = 'signed-out');
    if (this.player && this.deviceId && this.status === 'ready') return this.status;
    const Spotify = await loadSdk();
    this.player?.disconnect();
    const player = new Spotify.Player({ name: 'SyncSound', getOAuthToken: (cb) => cb(getSpotifyToken() ?? ''), volume: 0.8 });
    this.player = player;
    const status = await new Promise<RemoteServiceStatus>((resolve) => {
      const t = setTimeout(() => {
        this.message = 'Spotify player did not become ready.';
        resolve('error');
      }, 15_000);
      const done = (s: RemoteServiceStatus) => {
        clearTimeout(t);
        resolve(s);
      };
      player.addListener('ready', ({ device_id }) => {
        this.deviceId = device_id ?? null;
        done('ready');
      });
      player.addListener('not_ready', () => (this.deviceId = null));
      player.addListener('account_error', () => {
        this.message = 'Spotify Premium is required to play in the browser.';
        this.status = 'needs-premium';
        done('needs-premium');
      });
      player.addListener('authentication_error', () => {
        saveToken(null);
        this.message = 'Spotify session expired. Connect again.';
        this.status = 'signed-out';
        done('signed-out');
      });
      player.addListener('initialization_error', ({ message }) => {
        this.message = `Spotify can't play in this browser: ${message ?? 'unsupported'}.`;
        done('error');
      });
      player.addListener('playback_error', ({ message }) => (this.message = `Spotify playback error: ${message ?? 'unknown'}`));
      void player.activateElement?.().catch(() => {});
      player.connect().then(
        (ok) => !ok && done('error'),
        () => done('error'),
      );
    });
    this.status = status;
    if (status === 'ready') this.message = null;
    return status;
  }

  private async api(method: string, path: string, body?: unknown) {
    const token = getSpotifyToken();
    if (!token) {
      this.status = 'signed-out';
      throw new Error('Spotify session expired. Connect again.');
    }
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return;
    if (res.status === 401) {
      saveToken(null);
      this.status = 'signed-out';
      throw new Error('Spotify session expired. Connect again.');
    }
    if (res.status === 403) {
      this.status = 'needs-premium';
      throw new Error('Spotify Premium is required to play in the browser.');
    }
    throw new Error(`Spotify request failed (HTTP ${res.status}).`);
  }

  async load(remoteId: string) {
    this.uri = remoteId;
  }

  async play(positionMs: number) {
    if (!this.deviceId || !this.uri) throw new Error('Spotify player is not ready.');
    await this.api('PUT', `/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, {
      uris: [this.uri],
      position_ms: Math.max(0, Math.round(positionMs)),
    });
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
    if (!s) return { positionMs: 0, atMs: now, playing: false };
    const age = Date.now() - s.timestamp;
    return { positionMs: s.position, atMs: now - (age >= 0 && age < 5000 ? age : 0), playing: !s.paused };
  }

  dispose() {
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
  }
}
