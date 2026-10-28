import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetProgress, UploadResponse } from '@syncsound/protocol';
import { startServer } from '../src/index.ts';
import { Windower, probe, segmentAudio, type Media } from '../src/media.ts';

/** stereo s16 frame i encodes its own index: left = low 16 bits, right = high 16 bits */
function ramp(frames: number): Buffer {
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    b.writeUInt16LE(i & 0xffff, i * 4);
    b.writeUInt16LE(i >>> 16, i * 4 + 2);
  }
  return b;
}
const frameIndex = (b: Buffer, f: number) => b.readUInt16LE(f * 4) + b.readUInt16LE(f * 4 + 2) * 65536;

describe('Windower', () => {
  // [total frames, segment, overlap]: exact multiples, remainders inside / past the overlap, and a stream shorter than one segment
  it.each([
    [1000, 100, 7],
    [1003, 100, 7],
    [205, 100, 7],
    [207, 100, 7],
    [100, 100, 7],
    [99, 100, 7],
    [1, 100, 7],
    [500, 50, 0],
  ])('tiles %i frames (segment %i, overlap %i) exactly, however the stream is chunked', (total, seg, overlap) => {
    const pcm = ramp(total);
    const w = new Windower(4, seg, overlap);
    const wins: Buffer[] = [];
    // ragged chunk sizes, deliberately not frame-aligned
    for (let at = 0, n = 1; at < pcm.length; n = ((n * 7 + 3) % 61) + 1) {
      wins.push(...w.push(pcm.subarray(at, at + n)));
      at += n;
    }
    wins.push(...w.flush());

    expect(w.frames).toBe(total);
    expect(wins).toHaveLength(Math.ceil(total / seg));
    wins.forEach((win, i) => {
      const start = i * seg;
      const end = Math.min(total, start + seg + overlap);
      expect(win.length / 4, `segment ${i} length`).toBe(end - start);
      expect(frameIndex(win, 0)).toBe(start);
      expect(frameIndex(win, win.length / 4 - 1)).toBe(end - 1);
    });
  });
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const decode = (file: string) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-'], { maxBuffer: 1 << 28 }).stdout;

describe.skipIf(!haveFfmpeg)('segmentAudio (real ffmpeg)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'syncsound-seg-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('splits a track into FLAC segments that reproduce the source samples exactly', async () => {
    const src = join(dir, 'tone.wav');
    // a chirp, not a constant tone, so any misplaced sample shows up
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*(200+60*t)*t)|0.5*sin(2*PI*(300+40*t)*t):d=25:s=44100', src]);
    const p = (await probe(src))!;
    const out = join(dir, 'out');
    mkdirSync(out);
    const seen: number[] = [];
    const r = await segmentAudio(
      src,
      p,
      { put: async (i, file) => void copyFileSync(file, join(out, `seg-${i}.flac`)) },
      { segmentSec: 10, overlapSec: 0.05, onProgress: (done) => seen.push(done) },
    );

    expect(r).toMatchObject({ count: 3, totalSamples: 25 * 44100, segmentSamples: 441_000, overlapSamples: 2205, sampleRate: 44100, channels: 2 });
    expect(readdirSync(out).sort()).toEqual(['seg-0.flac', 'seg-1.flac', 'seg-2.flac']);
    expect(seen).toEqual([1, 2, 3]);

    const whole = decode(src);
    const segs = [0, 1, 2].map((i) => decode(join(out, `seg-${i}.flac`)));
    const S = r.segmentSamples * 4;
    const O = r.overlapSamples * 4;
    expect(segs.map((s) => s.length / 4)).toEqual([441_000 + 2205, 441_000 + 2205, 25 * 44100 - 2 * 441_000]);
    // the heads of the segments, laid end to end, are the source
    const joined = Buffer.concat(segs.map((s, i) => s.subarray(0, i === 2 ? s.length : S)));
    expect(joined.equals(whole)).toBe(true);
    // each segment's tail repeats the start of the next (that's what the player crossfades)
    expect(segs[0]!.subarray(S, S + O).equals(segs[1]!.subarray(0, O))).toBe(true);
    expect(segs[1]!.subarray(S, S + O).equals(segs[2]!.subarray(0, O))).toBe(true);
  }, 60_000);

  it('rejects a file ffmpeg cannot decode', async () => {
    const junk = join(dir, 'junk.mp3');
    writeFileSync(junk, 'not audio');
    await expect(segmentAudio(junk, { durationSec: 10, channels: 2, sampleRate: 44100 }, { put: async () => {} })).rejects.toThrow();
  });
});

describe('long uploads over HTTP (local storage, fake media)', () => {
  let dataDir: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  const media: Media = {
    probe: async () => ({ durationSec: 1500, channels: 2, sampleRate: 44100 }),
    segment: async (_src, p, sink) => {
      for (let i = 0; i < 3; i++) {
        const f = join(dataDir, `fake-${i}.flac`);
        writeFileSync(f, `segment ${i}`);
        await sink.put(i, f);
      }
      return { count: 3, totalSamples: 1500 * 44100, segmentSamples: 5_292_000, overlapSamples: 2205, sampleRate: p.sampleRate, channels: p.channels };
    },
  };
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'syncsound-long-'));
    srv = await startServer({ port: 0, dataDir, allowedOrigins: [], media });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns a segment plan, serves the segments, and reports progress as done', async () => {
    const up = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'content-type': 'audio/mpeg', 'x-filename': 'mix.mp3' }, body: Buffer.alloc(100) });
    expect(up.status).toBe(201);
    const info = (await up.json()) as UploadResponse;
    expect(info).toMatchObject({ durationSec: 1500, channels: 2 });
    expect(info.segments).toEqual({
      baseUrl: `${base}/assets/${info.id}/segments`,
      count: 3,
      segmentSamples: 5_292_000,
      overlapSamples: 2205,
      sampleRate: 44100,
      totalSamples: 1500 * 44100,
    });

    const seg = await fetch(`${info.segments!.baseUrl}/seg-0001.flac`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get('content-type')).toBe('audio/flac');
    expect(await seg.text()).toBe('segment 1');
    expect((await fetch(`${info.segments!.baseUrl}/seg-0009.flac`)).status).toBe(404);
    expect((await fetch(`${info.segments!.baseUrl}/..%2Fsecret`)).status).toBe(404);

    const prog = (await (await fetch(`${base}/api/assets/${info.id}/progress`)).json()) as AssetProgress;
    expect(prog.phase).toBe('done');
  });

  it('short tracks get a duration but no segments', async () => {
    const short: Media = { ...media, probe: async () => ({ durationSec: 200, channels: 1, sampleRate: 48000 }) };
    const s = await startServer({ port: 0, dataDir, allowedOrigins: [], media: short });
    try {
      const up = await fetch(`http://127.0.0.1:${s.port}/api/assets`, { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: Buffer.alloc(100) });
      const info = (await up.json()) as UploadResponse;
      expect(info).toMatchObject({ durationSec: 200, channels: 1 });
      expect(info.segments).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
