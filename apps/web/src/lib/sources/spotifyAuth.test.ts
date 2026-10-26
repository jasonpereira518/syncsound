import { describe, expect, it } from 'vitest';
import { BROWSE_SCOPES, SpotifyAuthStore, classify403, type SpotifyAuth } from './spotifyAuth';

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(opts: { now?: number; responses?: Array<() => Response | Promise<Response>> } = {}) {
  const store = memStore();
  const legacy = memStore();
  let now = opts.now ?? 1_000_000;
  const calls: Array<Record<string, string>> = [];
  const responses = [...(opts.responses ?? [])];
  const a = new SpotifyAuthStore({
    store: () => store,
    legacy: () => legacy,
    now: () => now,
    clientId: () => 'client-1',
    fetch: async (_url, init) => {
      calls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      const r = responses.shift();
      if (!r) throw new Error('no response queued');
      return r();
    },
  });
  return { a, store, legacy, calls, advance: (ms: number) => (now += ms), now: () => now };
}

const rec = (o: Partial<SpotifyAuth> & { expiresAt: number }): SpotifyAuth => ({
  accessToken: 'AT1',
  refreshToken: 'RT1',
  scope: 'streaming',
  ...o,
});

describe('SpotifyAuthStore', () => {
  it('stores the code exchange with its refresh token and scopes', async () => {
    const t = setup({ responses: [() => json(200, { access_token: 'AT1', expires_in: 3600, refresh_token: 'RT1', scope: 'streaming playlist-read-private' })] });
    await t.a.exchangeCode('CODE', 'VERIFIER', 'http://127.0.0.1:3000/spotify-callback');
    expect(t.calls[0]).toMatchObject({ grant_type: 'authorization_code', code: 'CODE', code_verifier: 'VERIFIER', client_id: 'client-1' });
    expect(t.a.read()).toEqual({ accessToken: 'AT1', expiresAt: t.now() + 3_600_000, refreshToken: 'RT1', scope: 'streaming playlist-read-private' });
    expect(t.a.has()).toBe(true);
    expect(t.a.scopeCovers(['playlist-read-private'])).toBe(true);
    expect(t.a.scopeCovers(BROWSE_SCOPES)).toBe(false);
  });

  it('returns a fresh token without a request, and refreshes one about to expire (rotated token kept)', async () => {
    const t = setup({ responses: [() => json(200, { access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2' })] });
    t.a.write(rec({ expiresAt: t.now() + 10 * 60_000 }));
    expect(await t.a.getAccessToken()).toBe('AT1');
    expect(t.calls).toHaveLength(0);
    t.advance(9.5 * 60_000); // within the 60 s refresh margin
    expect(await t.a.getAccessToken()).toBe('AT2');
    expect(t.calls[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT1', client_id: 'client-1' });
    expect(t.a.read()).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2', scope: 'streaming' });
  });

  it('keeps the old refresh token when Spotify does not rotate it, and forces a refresh after a 401', async () => {
    const t = setup({ responses: [() => json(200, { access_token: 'AT2', expires_in: 3600 })] });
    t.a.write(rec({ expiresAt: t.now() + 30 * 60_000 }));
    expect(await t.a.getAccessToken(true)).toBe('AT2');
    expect(t.a.read()?.refreshToken).toBe('RT1');
  });

  it('shares one refresh between concurrent callers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({
      responses: [
        async () => {
          await gate;
          return json(200, { access_token: 'AT2', expires_in: 3600 });
        },
      ],
    });
    t.a.write(rec({ expiresAt: t.now() - 1 }));
    const p1 = t.a.getAccessToken();
    const p2 = t.a.getAccessToken();
    release();
    expect(await Promise.all([p1, p2])).toEqual(['AT2', 'AT2']);
    expect(t.calls).toHaveLength(1);
  });

  it('signs out when the refresh token is rejected (invalid_grant)', async () => {
    const t = setup({ responses: [() => json(400, { error: 'invalid_grant' })] });
    t.a.write(rec({ expiresAt: t.now() - 1 }));
    expect(await t.a.getAccessToken()).toBeNull();
    expect(t.a.read()).toBeNull();
    expect(t.a.has()).toBe(false);
  });

  it('keeps the sign-in when the network fails during a refresh', async () => {
    const t = setup({ responses: [() => Promise.reject(new TypeError('offline'))] });
    t.a.write(rec({ expiresAt: t.now() - 1 }));
    await expect(t.a.getAccessToken()).rejects.toMatchObject({ code: 'network' });
    expect(t.a.read()?.refreshToken).toBe('RT1');
  });

  it('migrates the old per-tab token while it is valid, without a refresh token', () => {
    const t = setup();
    t.legacy.setItem('syncsound:spotify:token', JSON.stringify({ accessToken: 'OLD', expiresAt: t.now() + 30 * 60_000 }));
    expect(t.a.read()).toMatchObject({ accessToken: 'OLD', refreshToken: null });
    expect(t.legacy.m.size).toBe(0);
    expect(t.store.m.size).toBe(1);
  });

  it('notifies subscribers on every change', () => {
    const t = setup();
    let n = 0;
    const off = t.a.subscribe(() => n++);
    t.a.write(rec({ expiresAt: t.now() + 1 }));
    t.a.clear();
    off();
    t.a.clear();
    expect(n).toBe(2);
  });
});

describe('classify403', () => {
  it('tells Premium-required apart from an account missing from the dev-mode allow-list', () => {
    expect(classify403({ error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }).kind).toBe('needs-premium');
    expect(classify403({ error: { status: 403, message: 'User not registered in the Developer Dashboard' } }).kind).toBe('not-allowlisted');
    expect(classify403({ error: { status: 403, message: 'Restriction violated' } })).toMatchObject({ kind: 'forbidden', message: 'Spotify refused the request: Restriction violated' });
    expect(classify403(null).kind).toBe('forbidden');
  });
});
