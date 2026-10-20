/** Server URLs + feature flags. Safe to import anywhere (guards `window`). */
import { SERVER_PORT_DEFAULT } from '@syncsound/protocol';

export function deriveServerUrl(
  envUrl: string | undefined,
  loc: { protocol: string; hostname: string } | null,
  port: string | number = SERVER_PORT_DEFAULT,
): string {
  if (envUrl) return envUrl.replace(/\/+$/, '');
  if (!loc) return `http://localhost:${port}`;
  return `${loc.protocol}//${loc.hostname}:${port}`;
}

export const toWsUrl = (httpBase: string) => `${httpBase.replace(/^http/, 'ws')}/ws`;

export function serverUrl(): string {
  return deriveServerUrl(
    process.env.NEXT_PUBLIC_SERVER_URL,
    typeof window === 'undefined' ? null : window.location,
    process.env.NEXT_PUBLIC_SERVER_PORT || SERVER_PORT_DEFAULT,
  );
}

export const wsUrl = () => toWsUrl(serverUrl());

export const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';
export const appleDeveloperToken = process.env.NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN ?? '';
export const spotifyConfigured = !!spotifyClientId;
export const appleConfigured = !!appleDeveloperToken;
export const spotifyRedirectUri = () =>
  process.env.NEXT_PUBLIC_SPOTIFY_REDIRECT_URI ||
  (typeof window === 'undefined' ? '' : `${window.location.origin}/spotify-callback`);
