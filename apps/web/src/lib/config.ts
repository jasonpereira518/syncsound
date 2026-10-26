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

/** this machine or the local network: the room server can run next to the page on :8787 */
const LOCAL_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+|.+\.(local|localhost|test|lan|home|internal))$/i;

/**
 * A public deployment (Vercel, …) built without NEXT_PUBLIC_SERVER_URL can't guess where its room server is: the
 * page's own host never runs one. True means "say so" instead of retrying a connection that can't succeed.
 */
export function serverMissing(envUrl: string | undefined, loc: { hostname: string } | null): boolean {
  return !envUrl && !!loc && !LOCAL_HOST.test(loc.hostname);
}

export const isServerMissing = () =>
  serverMissing(process.env.NEXT_PUBLIC_SERVER_URL, typeof window === 'undefined' ? null : window.location);

export const NO_SERVER_MESSAGE =
  "This SyncSound site isn't connected to its room server yet, so rooms can't open. " +
  'Site owner: deploy the server and set NEXT_PUBLIC_SERVER_URL (see docs/DEPLOY.md).';

/** Cloud Run scales an idle server to zero: the first connection after that waits for it to start */
export const SERVER_WAKING_HINT = 'If the server was idle, starting it can take a few seconds.';

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
