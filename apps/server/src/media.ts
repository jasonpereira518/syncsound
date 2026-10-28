/** ffprobe/ffmpeg helpers: learn a file's length/channels/rate, and (below) split long files into FLAC segments. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Probe {
  durationSec: number;
  channels: number;
  sampleRate: number;
}

/** what the HTTP layer needs from ffmpeg; tests inject a fake */
export interface Media {
  /** null when ffprobe is missing or can't read the file: callers carry on without a duration */
  probe(src: string): Promise<Probe | null>;
  /** split into FLAC windows and hand each to `sink`; rejects if ffmpeg can't decode it */
  segment(src: string, p: Probe, sink: SegmentSink, opts?: SegmentOpts): Promise<Segmented>;
}

/** run a command to completion; resolves with stdout, rejects on spawn failure, non-zero exit or timeout */
function exec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

/** `src` is a local path or an http(s) URL */
export async function probe(src: string): Promise<Probe | null> {
  try {
    const json = JSON.parse(
      await exec(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate,duration:format=duration', '-of', 'json', src],
        60_000,
      ),
    ) as { streams?: { channels?: number; sample_rate?: string; duration?: string }[]; format?: { duration?: string } };
    const s = json.streams?.[0];
    const durationSec = Number(s?.duration ?? json.format?.duration);
    const channels = Number(s?.channels);
    const sampleRate = Number(s?.sample_rate);
    if (!(durationSec > 0) || !Number.isFinite(durationSec) || !(channels >= 1) || !(sampleRate > 0)) return null;
    return { durationSec, channels: Math.min(8, Math.round(channels)), sampleRate: Math.round(sampleRate) };
  } catch {
    return null;
  }
}

// ---------- segmenting ----------

/** tracks longer than this are split; shorter ones decode whole in the browser as before */
export const SEGMENT_THRESHOLD_SEC = 10 * 60;
const SEGMENT_SEC = 120;
/** each segment also carries this much of the next one so the player can crossfade the seam */
const OVERLAP_SEC = 0.05;

/**
 * Cuts a stream of interleaved s16 PCM into windows: segment i = frames [i*seg, min(total, (i+1)*seg + overlap)).
 * Pure (no I/O) so the tiling is unit-tested on its own.
 */
export class Windower {
  private parts: Buffer[] = [];
  private bytes = 0;
  private total = 0;

  constructor(
    private readonly frameBytes: number,
    private readonly seg: number,
    private readonly overlap: number,
  ) {}

  /** whole frames received so far */
  get frames() {
    return Math.floor(this.total / this.frameBytes);
  }

  push(chunk: Buffer): Buffer[] {
    this.parts.push(chunk);
    this.bytes += chunk.length;
    this.total += chunk.length;
    const out: Buffer[] = [];
    const win = (this.seg + this.overlap) * this.frameBytes;
    if (this.bytes < win) return out;
    let all = Buffer.concat(this.parts);
    while (all.length >= win) {
      out.push(all.subarray(0, win));
      all = all.subarray(this.seg * this.frameBytes);
    }
    this.parts = [all];
    this.bytes = all.length;
    return out;
  }

  /** the remaining windows once the stream ends (a trailing partial frame is dropped) */
  flush(): Buffer[] {
    const all = Buffer.concat(this.parts);
    let data = all.subarray(0, Math.floor(all.length / this.frameBytes) * this.frameBytes);
    const out: Buffer[] = [];
    while (data.length > 0) {
      out.push(data);
      data = data.subarray(Math.min(this.seg * this.frameBytes, data.length));
    }
    this.parts = [];
    this.bytes = 0;
    return out;
  }
}

export interface SegmentSink {
  /** store segment `index` (a FLAC file); the caller deletes the file afterwards */
  put(index: number, file: string): Promise<void>;
}
export interface SegmentOpts {
  segmentSec?: number;
  overlapSec?: number;
  onProgress?: (done: number, total: number) => void;
}
export interface Segmented {
  count: number;
  totalSamples: number;
  segmentSamples: number;
  overlapSamples: number;
  sampleRate: number;
  channels: number;
}

const pad4 = (i: number) => String(i).padStart(4, '0');

/**
 * Decodes `src` once (ffmpeg → s16 PCM pipe), cuts exact windows and encodes each to FLAC (lossless, so every browser
 * decodes identical samples; MP3 slices would each carry their own decoder delay/padding). Memory stays at about one
 * window; the whole file is never held.
 */
export async function segmentAudio(src: string, p: Probe, sink: SegmentSink, opts: SegmentOpts = {}): Promise<Segmented> {
  const sr = String(p.sampleRate);
  const ch = String(p.channels);
  const segmentSamples = Math.round((opts.segmentSec ?? SEGMENT_SEC) * p.sampleRate);
  const overlapSamples = Math.round((opts.overlapSec ?? OVERLAP_SEC) * p.sampleRate);
  const windower = new Windower(p.channels * 2, segmentSamples, overlapSamples);
  const estimate = Math.max(1, Math.ceil((p.durationSec * p.sampleRate) / segmentSamples));
  const dir = await mkdtemp(join(tmpdir(), 'syncsound-seg-'));
  let index = 0;

  const emit = async (win: Buffer) => {
    const file = join(dir, `seg-${pad4(index)}.flac`);
    await new Promise<void>((resolve, reject) => {
      const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', sr, '-ac', ch, '-i', 'pipe:0', '-c:a', 'flac', '-compression_level', '5', file], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      enc.on('error', reject);
      enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`flac encode exited ${code}`))));
      enc.stdin.on('error', () => {}); // an early exit surfaces through 'close'
      enc.stdin.end(win);
    });
    try {
      await sink.put(index, file);
    } finally {
      await rm(file, { force: true });
    }
    opts.onProgress?.(++index, Math.max(estimate, index));
  };

  const dec = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', src, '-vn', '-map', '0:a:0', '-ac', ch, '-ar', sr, '-f', 's16le', 'pipe:1'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    dec.on('error', reject);
    dec.on('close', resolve);
  });
  exited.catch(() => {}); // surfaced below
  try {
    for await (const chunk of dec.stdout) for (const win of windower.push(chunk as Buffer)) await emit(win);
    if ((await exited) !== 0) throw new Error('ffmpeg could not decode the file');
    for (const win of windower.flush()) await emit(win);
  } finally {
    dec.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
  if (index === 0) throw new Error('no audio decoded');
  return { count: index, totalSamples: windower.frames, segmentSamples, overlapSamples, sampleRate: p.sampleRate, channels: p.channels };
}

export const ffmpegMedia: Media = { probe, segment: segmentAudio };
