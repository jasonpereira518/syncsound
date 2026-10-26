/**
 * What a Class B (Spotify/Apple) player should do on each sync tick, beyond seek corrections: the cases where the
 * player isn't simply ahead or behind on the right track. Pure, so the rules are unit-tested.
 */

/** no corrective seeks this close to the end: the room hands over to the next track there */
export const REMOTE_END_GUARD_MS = 1500;
/** after a play request, wait this long before judging the player (it is still loading) */
export const REMOTE_START_GRACE_MS = 1200;
/** after this many restarts in a row that didn't take, stop fighting (the account is playing elsewhere) */
export const REMOTE_MAX_REPLAYS = 2;

export interface RemoteTickInput {
  /** the room is playing this track right now */
  roomPlaying: boolean;
  /** where this device should be in the track (room time, output compensation included), ms */
  expectedMs: number;
  /** the track's length, ms (null = unknown) */
  durationMs: number | null;
  /** what the player reports */
  player: { playing: boolean; uri?: string | null };
  /** the URI this device should be playing */
  wantUri: string;
  /** ms since this device last asked the player to start */
  sinceStartMs: number;
  /** restarts since the player was last seen playing the right track */
  replays: number;
  /** the service says this account's playback moved to another device */
  elsewhere: boolean;
}

export type RemoteTickAction =
  /** compare positions and let the seek controller decide */
  | { kind: 'sync' }
  /** start the wanted track again at the expected position */
  | { kind: 'replay' }
  /** the player plays although the room doesn't: nothing plays unless the room starts it */
  | { kind: 'pause' }
  | { kind: 'hold'; reason: 'idle' | 'starting' | 'end' | 'elsewhere' };

export function decideRemoteTick(i: RemoteTickInput): RemoteTickAction {
  if (!i.roomPlaying) return i.player.playing ? { kind: 'pause' } : { kind: 'hold', reason: 'idle' };
  if (i.durationMs !== null && i.expectedMs > i.durationMs - REMOTE_END_GUARD_MS) return { kind: 'hold', reason: 'end' };
  if (i.sinceStartMs < REMOTE_START_GRACE_MS) return { kind: 'hold', reason: 'starting' };
  const onTrack = i.player.uri === undefined || i.player.uri === i.wantUri; // undefined = the player doesn't say
  if (i.player.playing && onTrack) return { kind: 'sync' };
  // stopped, ended early, or playing something else (Spotify autoplay, another app on this account)
  if (i.elsewhere || i.replays >= REMOTE_MAX_REPLAYS) return { kind: 'hold', reason: 'elsewhere' };
  return { kind: 'replay' };
}

/** clamp a seek target so a correction never lands in the end guard (or past the end) */
export function clampRemoteSeek(targetMs: number, durationMs: number | null): number {
  const t = Math.max(0, targetMs);
  return durationMs === null ? t : Math.min(t, Math.max(0, durationMs - REMOTE_END_GUARD_MS));
}
