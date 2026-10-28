/**
 * Spotify sign-in state for this device: Authorization Code + PKCE tokens, kept in localStorage so a speaker
 * connects once and stays connected (the access token is refreshed with the refresh token; PKCE needs no client
 * secret). Tokens are never logged. Storage, fetch and the clock are injected so this is unit-testable.
 */

export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
/** every device: play in the browser through the Web Playback SDK */
export const PLAYBACK_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
] as const;
/** the controller additionally browses the library (playlists, Liked Songs, saved albums) */
export const BROWSE_SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read'] as const;

const AUTH_KEY = 'syncsound:spotify:auth';
/** the per-tab token kept by earlier versions (sessionStorage) */
const LEGACY_KEY = 'syncsound:spotify:token';
/** refresh this long before the access token expires */
const REFRESH_MARGIN_MS = 60_000;

export interface SpotifyAuth {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  refreshToken: string | null;
  /** space-separated granted scopes */
  scope: string;
}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SpotifyAuthDeps {
  store: () => KV | null;
  /** where the old per-tab token lived (migrated once, then removed) */
  legacy?: () => KV | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  clientId: () => string;
  /** cross-tab mutual exclusion for the refresh (refresh tokens rotate); default: none */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class SpotifyAuthError extends Error {
  constructor(
    readonly code: 'signed-out' | 'network' | 'rejected',
    msg: string,
  ) {
    super(msg);
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

function parseAuth(raw: string | null): SpotifyAuth | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<SpotifyAuth>;
    if (typeof j.accessToken !== 'string' || typeof j.expiresAt !== 'number') return null;
    return {
      accessToken: j.accessToken,
      expiresAt: j.expiresAt,
      refreshToken: typeof j.refreshToken === 'string' ? j.refreshToken : null,
      scope: typeof j.scope === 'string' ? j.scope : '',
    };
  } catch {
    return null;
  }
}

export class SpotifyAuthStore {
  private refreshing: Promise<string | null> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly d: SpotifyAuthDeps) {}

  read(): SpotifyAuth | null {
    const s = this.d.store();
    let a: SpotifyAuth | null = null;
    try {
      a = parseAuth(s?.getItem(AUTH_KEY) ?? null);
    } catch {
      a = null;
    }
    if (a) return a;
    // one-time migration of the old per-tab token (no refresh token: it lasts until it expires)
    const legacy = this.d.legacy?.();
    try {
      const old = parseAuth(legacy?.getItem(LEGACY_KEY) ?? null);
      legacy?.removeItem(LEGACY_KEY);
      if (old && old.expiresAt > this.d.now()) {
        this.write(old);
        return old;
      }
    } catch {
      /* storage blocked */
    }
    return null;
  }

  write(a: SpotifyAuth | null): void {
    try {
      const s = this.d.store();
      if (a) s?.setItem(AUTH_KEY, JSON.stringify(a));
      else s?.removeItem(AUTH_KEY);
    } catch {
      /* storage full/blocked: the session still works until reload */
    }
    this.notify();
  }

  /** tell subscribers the stored record changed (this tab wrote it, or another tab did) */
  notify(): void {
    for (const l of this.listeners) l();
  }

  /** called whenever the stored record changes in this tab */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** signed in: a refresh token, or an access token that is still valid */
  has(): boolean {
    const a = this.read();
    return !!a && (!!a.refreshToken || a.expiresAt > this.d.now() + REFRESH_MARGIN_MS);
  }

  /** every scope in `needed` was granted */
  scopeCovers(needed: readonly string[]): boolean {
    const granted = new Set((this.read()?.scope ?? '').split(/\s+/).filter(Boolean));
    return needed.every((s) => granted.has(s));
  }

  clear(): void {
    this.write(null);
  }

  /** exchange the authorization code from the callback; stores and returns the record */
  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<SpotifyAuth> {
    const j = await this.post({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.d.clientId(),
      code_verifier: verifier,
    });
    if (!j.access_token) throw new SpotifyAuthError('rejected', "Spotify rejected the sign-in. Check the app's redirect URI settings.");
    const a: SpotifyAuth = {
      accessToken: j.access_token,
      expiresAt: this.d.now() + (j.expires_in ?? 3600) * 1000,
      refreshToken: j.refresh_token ?? null,
      scope: j.scope ?? '',
    };
    this.write(a);
    return a;
  }

  /**
   * A valid access token, refreshing it first when it is about to expire (or when `force`, after a 401).
   * null = signed out. Concurrent callers share one refresh.
   */
  async getAccessToken(force = false): Promise<string | null> {
    const a = this.read();
    if (!a) return null;
    if (!force && a.expiresAt > this.d.now() + REFRESH_MARGIN_MS) return a.accessToken;
    if (!a.refreshToken) {
      if (a.expiresAt > this.d.now() && !force) return a.accessToken;
      this.clear();
      return null;
    }
    this.refreshing ??= this.refresh(a.accessToken).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(staleToken: string): Promise<string | null> {
    const run = async () => {
      // another tab may have refreshed while we waited for the lock: use its result
      const cur = this.read();
      if (!cur?.refreshToken) return null;
      if (cur.accessToken !== staleToken && cur.expiresAt > this.d.now() + REFRESH_MARGIN_MS) return cur.accessToken;
      let j: TokenResponse;
      try {
        j = await this.post({ grant_type: 'refresh_token', refresh_token: cur.refreshToken, client_id: this.d.clientId() });
      } catch (e) {
        if (e instanceof SpotifyAuthError && e.code === 'rejected') {
          this.clear(); // revoked or expired refresh token: sign in again
          return null;
        }
        throw e;
      }
      if (!j.access_token) {
        this.clear();
        return null;
      }
      this.write({
        accessToken: j.access_token,
        expiresAt: this.d.now() + (j.expires_in ?? 3600) * 1000,
        refreshToken: j.refresh_token ?? cur.refreshToken, // Spotify may rotate it
        scope: j.scope ?? cur.scope,
      });
      return j.access_token;
    };
    return this.d.lock ? this.d.lock(run) : run();
  }

  private async post(body: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.d.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
    } catch {
      throw new SpotifyAuthError('network', "Couldn't reach Spotify. Check the connection.");
    }
    let j: TokenResponse = {};
    try {
      j = (await res.json()) as TokenResponse;
    } catch {
      j = {};
    }
    if (res.ok) return j;
    if (res.status >= 500) throw new SpotifyAuthError('network', `Spotify sign-in is unavailable (HTTP ${res.status}).`);
    throw new SpotifyAuthError('rejected', j.error === 'invalid_grant' ? 'Spotify sign-in expired. Connect again.' : `Spotify rejected the sign-in (${j.error ?? res.status}).`);
  }
}

/** Spotify's error body, e.g. { error: { status: 403, message, reason: 'PREMIUM_REQUIRED' } } */
export type SpotifyApiFailure = 'needs-premium' | 'not-allowlisted' | 'forbidden';

/** what a 403 from the Web API means */
export function classify403(body: unknown): { kind: SpotifyApiFailure; message: string } {
  const err = (body as { error?: { message?: string; reason?: string } } | null)?.error;
  const msg = `${err?.reason ?? ''} ${err?.message ?? ''}`;
  if (/PREMIUM_REQUIRED|premium/i.test(msg))
    return { kind: 'needs-premium', message: 'Spotify Premium is required to play in the browser.' };
  if (/not registered|developer dashboard|user may not be registered/i.test(msg))
    return {
      kind: 'not-allowlisted',
      message:
        "This Spotify account isn't on this app's allow-list. The site owner must add it in the Spotify developer dashboard (development mode allows 5 accounts).",
    };
  return { kind: 'forbidden', message: `Spotify refused the request${err?.message ? `: ${err.message}` : '.'}` };
}

let browserStore: SpotifyAuthStore | null = null;

/** this browser's sign-in (localStorage, refresh serialized across tabs with the Web Locks API when present) */
export function spotifyAuth(clientId: () => string): SpotifyAuthStore {
  if (browserStore) return browserStore;
  const safe = <T,>(get: () => T): (() => T | null) => () => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  browserStore = new SpotifyAuthStore({
    store: safe(() => window.localStorage),
    legacy: safe(() => window.sessionStorage),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    clientId,
    ...(locks && { lock: <T,>(fn: () => Promise<T>) => locks.request('syncsound-spotify-refresh', fn) as Promise<T> }),
  });
  if (typeof window !== 'undefined')
    window.addEventListener('storage', (e) => {
      if (e.key === AUTH_KEY) browserStore?.notify();
    });
  return browserStore;
}
