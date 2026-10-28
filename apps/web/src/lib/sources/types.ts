import type { RemoteServiceStatus, Track } from '@syncsound/protocol';

export interface SourceCapabilities {
  /** per-device spatial mix available */
  spatial: boolean;
  eq: boolean;
  /** sample-accurate scheduling (vs. seek-based sync) */
  sampleAccurate: boolean;
}

export interface AudioSource {
  kind: Track['kind'];
  sourceClass: Track['sourceClass'];
  capabilities: SourceCapabilities;
}

/** What the engine can do with a track. Class B (remote) = "Sync-only mode (no spatial/EQ)". */
export function sourceFor(track: Pick<Track, 'kind' | 'sourceClass'>): AudioSource {
  const rendered = track.sourceClass === 'rendered';
  return {
    kind: track.kind,
    sourceClass: track.sourceClass,
    capabilities: { spatial: rendered, eq: rendered, sampleAccurate: rendered && track.kind !== 'capture' },
  };
}

export interface RemotePosition {
  positionMs: number;
  /** local performance.now() at which positionMs was valid */
  atMs: number;
  playing: boolean;
  /** what the player has loaded (Spotify: spotify:track:…); null = nothing / not this device's session */
  uri?: string | null;
  durationMs?: number;
}

export interface RemotePlayerAdapter {
  readonly name: 'spotify' | 'apple' | 'mock';
  status: RemoteServiceStatus;
  /** human-readable detail for the current status (errors, etc.) */
  message: string | null;
  connect(): Promise<RemoteServiceStatus>;
  /** `next`: the following remote track, so the player can buffer it before the room advances */
  load(remoteId: string, opts?: { next?: string | null }): Promise<void>;
  play(positionMs: number): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  getPosition(): Promise<RemotePosition>;
  dispose(): void;
  /** load the SDK ahead of time, so `activate` can run inside a later tap */
  prepare?(): Promise<void>;
  /** synchronous; MUST run inside a user tap (iOS/Safari unlock the player's audio only there) */
  activate?(): void;
  /** the browser blocked playback until the user taps (autoplay policy) */
  needsTap?: boolean;
  /** this account's playback moved to another device */
  elsewhere?: boolean;
  /** status / needsTap / elsewhere changed outside a call */
  onChange?: (() => void) | null;
}

/** reported position extrapolated to `nowMs` */
export const extrapolate = (p: RemotePosition, nowMs: number) => p.positionMs + (p.playing ? nowMs - p.atMs : 0);

export type SpotifyLink = { type: 'track' | 'album' | 'playlist'; id: string };

/** a Spotify track / album / playlist from a spotify: URI, an open.spotify.com link (any locale, ?si=…) or a bare track id */
export function parseSpotifyLink(input: string): SpotifyLink | null {
  const s = input.trim();
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(s);
  if (uri) return { type: uri[1] as SpotifyLink['type'], id: uri[2]! };
  const url = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})/.exec(s);
  if (url) return { type: url[1] as SpotifyLink['type'], id: url[2]! };
  return /^[A-Za-z0-9]{22}$/.test(s) ? { type: 'track', id: s } : null;
}

/** spotify:track:ID from a URI or open.spotify.com link; Apple catalog song id from an id or music.apple.com link */
export function normalizeRemoteId(kind: 'spotify' | 'apple', input: string): string | null {
  const s = input.trim();
  if (kind === 'spotify') {
    const l = parseSpotifyLink(s);
    return l?.type === 'track' ? `spotify:track:${l.id}` : null;
  }
  if (/^\d{5,15}$/.test(s)) return s;
  const m = /[?&]i=(\d{5,15})/.exec(s) ?? /music\.apple\.com\/.*\/song\/(?:[^/]+\/)?(\d{5,15})/.exec(s);
  return m?.[1] ?? null;
}
