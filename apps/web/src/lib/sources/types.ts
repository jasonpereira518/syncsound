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
}

export interface RemotePlayerAdapter {
  readonly name: 'spotify' | 'apple' | 'mock';
  status: RemoteServiceStatus;
  /** human-readable detail for the current status (errors, etc.) */
  message: string | null;
  connect(): Promise<RemoteServiceStatus>;
  load(remoteId: string): Promise<void>;
  play(positionMs: number): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  getPosition(): Promise<RemotePosition>;
  dispose(): void;
}

/** reported position extrapolated to `nowMs` */
export const extrapolate = (p: RemotePosition, nowMs: number) => p.positionMs + (p.playing ? nowMs - p.atMs : 0);

/** spotify:track:ID from a URI or open.spotify.com link; Apple catalog song id from an id or music.apple.com link */
export function normalizeRemoteId(kind: 'spotify' | 'apple', input: string): string | null {
  const s = input.trim();
  if (kind === 'spotify') {
    if (/^spotify:track:[A-Za-z0-9]{22}$/.test(s)) return s;
    const m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/.exec(s);
    return m ? `spotify:track:${m[1]}` : /^[A-Za-z0-9]{22}$/.test(s) ? `spotify:track:${s}` : null;
  }
  if (/^\d{5,15}$/.test(s)) return s;
  const m = /[?&]i=(\d{5,15})/.exec(s) ?? /music\.apple\.com\/.*\/song\/(?:[^/]+\/)?(\d{5,15})/.exec(s);
  return m?.[1] ?? null;
}
