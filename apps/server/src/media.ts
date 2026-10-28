/** ffprobe/ffmpeg helpers: learn a file's length/channels/rate, and (below) split long files into FLAC segments. */
import { spawn } from 'node:child_process';

export interface Probe {
  durationSec: number;
  channels: number;
  sampleRate: number;
}

/** what the HTTP layer needs from ffmpeg; tests inject a fake */
export interface Media {
  /** null when ffprobe is missing or can't read the file: callers carry on without a duration */
  probe(src: string): Promise<Probe | null>;
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

export const ffmpegMedia: Media = { probe };
