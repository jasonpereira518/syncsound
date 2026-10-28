import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@syncsound/protocol';
import { AssetCache } from './assets';

// 100 Hz "audio": 120 s segments, 550 s total → 5 segments
const seg = {
  baseUrl: 'https://bucket.test/uploads/abc-seg',
  count: 5,
  segmentSamples: 12_000,
  overlapSamples: 5,
  sampleRate: 100,
  totalSamples: 55_000,
};
const long: Track = { id: 'long', title: 'Long mix', kind: 'file', sourceClass: 'rendered', url: 'https://bucket.test/uploads/abc', segments: seg, durationSec: 550, channels: 2 };
const url = (i: number) => `https://bucket.test/uploads/abc-seg/seg-000${i}.flac`;

const fetched: string[] = [];
let failing = new Set<string>();
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  fetched.length = 0;
  failing = new Set();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      fetched.push(u);
      if (failing.has(u)) throw new TypeError('network');
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const make = () => {
  const changes: string[] = [];
  const cache = new AssetCache(async () => ({ duration: 120 }) as AudioBuffer, (id) => changes.push(id));
  return { cache, changes };
};

describe('AssetCache: segmented tracks', () => {
  it('loads the playing segment and two ahead, and reports how far it is buffered', async () => {
    const { cache, changes } = make();
    cache.ensure([long], { id: 'long', pos: 10 });
    expect(cache.get('long')!.state).toBe('loading');
    await flush();
    expect(fetched).toEqual([url(0), url(1), url(2)]);
    expect(cache.get('long')!.state).toBe('ready');
    expect(changes.length).toBeGreaterThan(0);
    expect(cache.segmentBuffer('long', 1)).not.toBeNull();
    expect(cache.progress('long')).toMatchObject({ playheadSec: 10, bufferedThroughSec: 360, totalSec: 550, ready: 3, count: 5 });
  });

  it('slides the window with the playhead, dropping what is behind it', async () => {
    const { cache } = make();
    cache.ensure([long], { id: 'long', pos: 0 });
    await flush();
    fetched.length = 0;
    cache.ensureWindow(long, 250); // segment 2 → keep 2, 3, 4
    await flush();
    expect(fetched).toEqual([url(3), url(4)]); // 2 was already held
    expect(cache.segmentBuffer('long', 0)).toBeNull();
    expect(cache.segmentBuffer('long', 1)).toBeNull();
    expect(cache.segmentBuffer('long', 4)).not.toBeNull();
    expect(cache.progress('long')!.bufferedThroughSec).toBe(550); // the last one ends at the track's end, not a full segment later
  });

  it('only prefetches the first segments of a track that is not playing yet', async () => {
    const { cache } = make();
    cache.ensure([long]);
    await flush();
    expect(fetched).toEqual([url(0), url(1)]);
  });

  it('is not ready until the segment under the playhead is decoded', async () => {
    const { cache } = make();
    cache.ensure([long], { id: 'long', pos: 0 });
    await flush();
    cache.ensureWindow(long, 500); // far seek: segment 4 is not held
    expect(cache.get('long')!.state).toBe('loading');
    await flush();
    expect(cache.get('long')!.state).toBe('ready');
  });

  it('reports a failed segment as an error naming the part, then retries after a pause', async () => {
    vi.useFakeTimers();
    failing.add(url(0));
    const { cache } = make();
    cache.ensure([long], { id: 'long', pos: 0 });
    await flush();
    expect(cache.get('long')).toMatchObject({ state: 'error', error: expect.stringContaining('part 1 of "Long mix"') });

    cache.ensureWindow(long, 0); // too soon: not retried
    await flush();
    expect(fetched.filter((u) => u === url(0))).toHaveLength(1);

    failing.clear();
    vi.advanceTimersByTime(5001);
    cache.ensureWindow(long, 0);
    await flush();
    expect(cache.get('long')!.state).toBe('ready');
  });
});

describe('AssetCache: whole-file tracks', () => {
  it('refuses a track too long to decode in a tab instead of failing as an "unsupported format"', async () => {
    const { cache, changes } = make();
    const huge: Track = { id: 'huge', title: 'Three hours', kind: 'file', sourceClass: 'rendered', url: 'https://x.test/a.mp3', durationSec: 10_800, channels: 2 };
    cache.ensure([huge]);
    await flush();
    expect(fetched).toEqual([]);
    expect(cache.get('huge')).toMatchObject({ state: 'error', error: expect.stringContaining('too long to decode') });
    expect(changes).toContain('huge');
  });

  it('still loads an ordinary track whole', async () => {
    const { cache } = make();
    const song: Track = { id: 'song', title: 'Song', kind: 'file', sourceClass: 'rendered', url: 'https://x.test/a.mp3', durationSec: 200, channels: 2 };
    cache.ensure([song]);
    await flush();
    expect(fetched).toEqual(['https://x.test/a.mp3']);
    expect(cache.buffer('song')).not.toBeNull();
    expect(cache.progress('song')).toBeNull();
  });
});
