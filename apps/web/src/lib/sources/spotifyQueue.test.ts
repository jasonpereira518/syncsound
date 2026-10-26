import { describe, expect, it } from 'vitest';
import { MAX_QUEUE, QueueTrack, parseClientMessage } from '@syncsound/protocol';
import type { SpTrack } from './spotifyApi';
import { batches, planQueue, shuffled, toRoomTrack } from './spotifyQueue';

const song = (n: number, extra: Partial<SpTrack> = {}): SpTrack => {
  const id = `${'B'.repeat(18)}${String(n).padStart(4, '0')}`;
  return { id, uri: `spotify:track:${id}`, title: `Song ${n}`, artist: 'Band', album: 'LP', artworkUrl: 'https://i.scdn.co/image/abc', durationMs: 180_000 + n, ...extra };
};
const songs = (n: number) => Array.from({ length: n }, (_, i) => song(i));
let seq = 0;
const newId = () => `t_${seq++}`;

describe('toRoomTrack', () => {
  it('builds a valid queue track; drops artwork from other hosts', () => {
    const t = toRoomTrack(song(1), 't1', 'dev1');
    expect(QueueTrack.safeParse(t).success).toBe(true);
    expect(t).toMatchObject({ id: 't1', kind: 'spotify', sourceClass: 'remote', durationSec: 180.001, artist: 'Band', addedBy: 'dev1' });
    expect(toRoomTrack(song(2, { artworkUrl: 'https://evil.example/a.png' }), 't2')).not.toHaveProperty('artworkUrl');
    expect(toRoomTrack(song(3, { title: '' }), 't3').title).toBe('Untitled');
  });
});

describe('shuffled / batches', () => {
  it('shuffles a copy, keeping every item', () => {
    const a = [1, 2, 3, 4, 5];
    const s = shuffled(a, () => 0);
    expect(s).not.toEqual(a);
    expect([...s].sort()).toEqual(a);
    expect(a).toEqual([1, 2, 3, 4, 5]);
  });

  it('splits by count and by bytes, in order', () => {
    const ts = songs(250).map((s, i) => toRoomTrack(s, `t${i}`));
    const b = batches(ts);
    expect(b.map((x) => x.length)).toEqual([100, 100, 50]);
    expect(b.flat().map((t) => t.id)).toEqual(ts.map((t) => t.id));
    const small = batches(ts.slice(0, 10), 100, 1000);
    expect(small.every((x) => JSON.stringify(x).length <= 1000 + x.length)).toBe(true);
    expect(small.length).toBeGreaterThan(1);
  });
});

describe('planQueue', () => {
  it('play from a row: replaces the queue with that song onwards and starts it; every command validates', () => {
    const p = planQueue(songs(5), 'play', { startIndex: 2, queueLength: 40, newId });
    expect(p).toMatchObject({ queued: 3, dropped: 0 });
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toMatchObject({ mode: 'replace', playIndex: 0 });
    expect(p.commands[0]!.tracks.map((t) => t.title)).toEqual(['Song 2', 'Song 3', 'Song 4']);
    for (const c of p.commands) expect(parseClientMessage({ type: 'CONTROL', command: c }).success).toBe(true);
  });

  it('a long playlist fills the room queue in batches: the first starts it, the rest append', () => {
    const p = planQueue(songs(734), 'play', { queueLength: 0, newId });
    expect(p).toMatchObject({ queued: MAX_QUEUE, dropped: 534 });
    expect(p.commands.map((c) => [c.mode, c.tracks.length, c.playIndex])).toEqual([
      ['replace', 100, 0],
      ['append', 100, undefined],
    ]);
  });

  it('shuffle takes a random 200 of the whole list', () => {
    let x = 7;
    const random = () => (x = (x * 48271) % 2147483647) / 2147483647; // seeded
    const p = planQueue(songs(300), 'shuffle', { queueLength: 0, newId, random });
    expect(p.queued).toBe(200);
    const titles = p.commands.flatMap((c) => c.tracks.map((t) => t.title));
    expect(new Set(titles).size).toBe(200);
    expect(titles).not.toEqual(songs(200).map((s) => s.title));
    expect(titles.some((t) => Number(t.split(' ')[1]) >= 200)).toBe(true); // drawn from the whole list
  });

  it('play next chains batches after one another; append respects what is left', () => {
    const next = planQueue(songs(150), 'next', { queueLength: 10, newId });
    expect(next.commands[0]).toMatchObject({ mode: 'insert' });
    expect(next.commands[0]).not.toHaveProperty('afterTrackId');
    expect(next.commands[1]).toMatchObject({ mode: 'insert', afterTrackId: next.commands[0]!.tracks.at(-1)!.id });
    const add = planQueue(songs(30), 'append', { queueLength: 190, newId });
    expect(add).toMatchObject({ queued: 10, dropped: 20 });
    expect(planQueue(songs(3), 'append', { queueLength: 200, newId })).toMatchObject({ queued: 0, commands: [] });
  });
});
