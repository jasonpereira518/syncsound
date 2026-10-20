import { describe, expect, it } from 'vitest';
import { deriveServerUrl, toWsUrl } from './config';

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
