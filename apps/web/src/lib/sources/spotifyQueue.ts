/**
 * Turning catalog songs into room queue commands: room tracks with metadata, a shuffle, and batches that fit the
 * server's limits (≤ MAX_QUEUE_BATCH tracks and well under the 64 KB message cap). Pure.
 */
import { MAX_QUEUE, MAX_QUEUE_BATCH, isSpotifyImageUrl, type ControlCommand, type Track } from '@syncsound/protocol';
import type { SpTrack } from './spotifyApi';

/** keep each queueMany message well under the server's 64 KB limit */
export const MAX_BATCH_BYTES = 48_000;

export type QueueMode = 'play' | 'shuffle' | 'next' | 'append';
type QueueMany = Extract<ControlCommand, { type: 'queueMany' }>;

/** a catalog song as a room track (a fresh id each time: the same song may be queued twice) */
export function toRoomTrack(t: SpTrack, id: string, addedBy?: string): Track {
  return {
    id,
    title: t.title.slice(0, 200) || 'Untitled',
    kind: 'spotify',
    sourceClass: 'remote',
    remoteId: t.uri,
    durationSec: t.durationMs / 1000,
    ...(t.artist && { artist: t.artist.slice(0, 200) }),
    ...(t.album && { album: t.album.slice(0, 200) }),
    ...(t.artworkUrl && isSpotifyImageUrl(t.artworkUrl) && { artworkUrl: t.artworkUrl }),
    ...(addedBy && { addedBy }),
  };
}

/** Fisher–Yates */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** split into batches of at most `maxCount` tracks and about `maxBytes` of JSON each, keeping order */
export function batches(tracks: readonly Track[], maxCount = MAX_QUEUE_BATCH, maxBytes = MAX_BATCH_BYTES): Track[][] {
  const out: Track[][] = [];
  let cur: Track[] = [];
  let bytes = 0;
  for (const t of tracks) {
    const size = JSON.stringify(t).length + 1;
    if (cur.length && (cur.length >= maxCount || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(t);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The queueMany commands for picking `songs` in `mode`:
 *  - play: replace the queue with songs[startIndex…] and start the first; shuffle: the same, shuffled
 *  - next: right after the current track (batches chained after one another); append: at the end
 * Capped by what the queue can hold; `dropped` says how many didn't fit.
 */
export function planQueue(
  songs: readonly SpTrack[],
  mode: QueueMode,
  opts: { startIndex?: number; queueLength: number; newId: () => string; addedBy?: string; random?: () => number },
): { commands: QueueMany[]; queued: number; dropped: number } {
  const replace = mode === 'play' || mode === 'shuffle';
  const picked = mode === 'shuffle' ? shuffled(songs, opts.random) : mode === 'play' ? songs.slice(opts.startIndex ?? 0) : [...songs];
  const room = replace ? MAX_QUEUE : Math.max(0, MAX_QUEUE - opts.queueLength);
  const tracks = picked.slice(0, room).map((s) => toRoomTrack(s, opts.newId(), opts.addedBy));
  const parts = batches(tracks);
  const commands = parts.map((part, i): QueueMany => {
    if (replace) return i === 0 ? { type: 'queueMany', tracks: part, mode: 'replace', playIndex: 0 } : { type: 'queueMany', tracks: part, mode: 'append' };
    if (mode === 'next')
      return i === 0 ? { type: 'queueMany', tracks: part, mode: 'insert' } : { type: 'queueMany', tracks: part, mode: 'insert', afterTrackId: parts[i - 1]!.at(-1)!.id };
    return { type: 'queueMany', tracks: part, mode: 'append' };
  });
  return { commands, queued: tracks.length, dropped: picked.length - tracks.length };
}
