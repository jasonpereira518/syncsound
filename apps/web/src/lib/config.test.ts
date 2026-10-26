import { describe, expect, it } from 'vitest';
import { deriveServerUrl, serverMissing, toWsUrl } from './config';

describe('server URL derivation', () => {
  it('uses the env URL (trailing slash trimmed) when set', () => {
    expect(deriveServerUrl('https://api.example.com/', { protocol: 'http:', hostname: 'x' })).toBe('https://api.example.com');
  });
  it('falls back to the page host on port 8787', () => {
    expect(deriveServerUrl(undefined, { protocol: 'http:', hostname: '192.168.1.20' })).toBe('http://192.168.1.20:8787');
    expect(deriveServerUrl(undefined, { protocol: 'http:', hostname: '192.168.1.20' }, '8788')).toBe('http://192.168.1.20:8788');
  });
  it('maps http(s) to ws(s) + /ws', () => {
    expect(toWsUrl('https://a.b:8787')).toBe('wss://a.b:8787/ws');
    expect(toWsUrl('http://localhost:8787')).toBe('ws://localhost:8787/ws');
  });
});

describe('a public site with no server configured', () => {
  it('is flagged on a public host without NEXT_PUBLIC_SERVER_URL', () => {
    expect(serverMissing(undefined, { hostname: 'sync-sound.vercel.app' })).toBe(true);
    expect(serverMissing(undefined, { hostname: 'syncsound.example.com' })).toBe(true);
  });
  it('is fine once the env URL is set, and on this machine or the local network', () => {
    expect(serverMissing('https://syncsound-server.onrender.com', { hostname: 'sync-sound.vercel.app' })).toBe(false);
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '192.168.1.20', '10.23.209.122', '172.20.0.5', 'my-laptop', 'my-laptop.local', 'app.localhost'])
      expect(serverMissing(undefined, { hostname }), hostname).toBe(false);
    expect(serverMissing(undefined, null)).toBe(false); // server-side render: nothing to say yet
  });
});
