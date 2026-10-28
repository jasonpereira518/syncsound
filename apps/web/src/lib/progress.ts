/** Text and numbers for "how far along is it": the upload line, the player's status line, the seek bar's buffered range. Pure. */
import type { BufferState, Device } from '@syncsound/protocol';
import type { EngineLoad, UploadProgress } from '../store/types';

/** m:ss, or h:mm:ss from an hour up (a 3 hour mix is not "180:00") */
export function fmtClock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '0:00';
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function fmtEta(sec: number): string {
  if (sec < 5) return 'a few seconds left';
  if (sec < 90) return `about ${Math.round(sec / 5) * 5} s left`;
  return `about ${Math.round(sec / 60)} min left`;
}

export interface ProgressLine {
  text: string;
  /** 0..1, or null when there is nothing to measure (show an indeterminate bar) */
  frac: number | null;
}

/** the upload card's line: bytes sent while uploading, then the server's part count while it prepares a long file */
export function uploadLine(name: string, p: UploadProgress | undefined, elapsedMs: number): ProgressLine {
  if (!p) return { text: `Uploading ${name}…`, frac: null };
  if (p.phase === 'uploading') {
    const frac = p.total > 0 ? Math.min(1, p.loaded / p.total) : null;
    const eta =
      elapsedMs > 4000 && p.loaded > 0 && p.total > p.loaded ? ` · ${fmtEta(((p.total - p.loaded) / p.loaded) * (elapsedMs / 1000))}` : '';
    const sent = frac === null ? '' : ` · ${Math.floor(frac * 100)}% · ${fmtSize(p.loaded)} of ${fmtSize(p.total)}`;
    return { text: `Uploading ${name}${sent}${eta}`, frac };
  }
  if (p.total && p.total > 0) {
    const done = Math.min(p.done ?? 0, p.total);
    return { text: `Preparing for playback · part ${done} of ${p.total}`, frac: done / p.total };
  }
  return { text: `Processing ${name} on the server…`, frac: null };
}

/** how many of the room's connected devices already hold the track, or null when there's nothing to compare */
export function devicesReady(devices: readonly Device[], trackId: string): { ready: number; total: number } | null {
  const online = devices.filter((d) => d.connected);
  if (online.length === 0) return null;
  const ready = online.filter((d) => d.stats?.loadedTrackId === trackId && (d.stats.bufferState === 'ready' || d.stats.bufferState === 'playing'));
  return { ready: ready.length, total: online.length };
}

export interface StatusInput {
  kind: string;
  status: 'stopped' | 'playing' | 'paused';
  bufferState: BufferState;
  /** this device's decode window for the current track, if it is a long one */
  load: EngineLoad | null;
  devices: { ready: number; total: number } | null;
}

/** the line under the track title in the player bar */
export function playerStatus(i: StatusInput): string {
  const parts: string[] = [i.kind];
  const ahead = i.load ? Math.max(0, i.load.bufferedThroughSec - i.load.playheadSec) : 0;
  if (i.bufferState === 'loading') parts.push(i.load ? `buffering · ${fmtClock(ahead)} ready` : 'downloading…');
  else if (i.bufferState === 'error') parts.push("couldn't load");
  else {
    parts.push(i.status);
    if (i.load && ahead > 0 && i.load.bufferedThroughSec < i.load.totalSec - 1) parts.push(`${fmtClock(ahead)} buffered ahead`);
  }
  if (i.devices && i.devices.total > 1 && i.devices.ready < i.devices.total) parts.push(`${i.devices.ready} of ${i.devices.total} devices ready`);
  return parts.join(' · ');
}

/**
 * The seek bar's buffered stretch as fractions of the track, behind the playhead: nothing while loading, the whole
 * bar for an ordinary track that is ready, and from the playhead to the end of the decoded window for a long one.
 */
export function bufferedSpan(duration: number, playheadSec: number, bufferState: BufferState, load: EngineLoad | null): { from: number; to: number } | null {
  if (!(duration > 0)) return null;
  if (load) {
    const from = Math.min(1, Math.max(0, playheadSec / duration));
    const to = Math.min(1, Math.max(from, load.bufferedThroughSec / duration));
    return to > from ? { from, to } : null;
  }
  return bufferState === 'ready' || bufferState === 'playing' ? { from: 0, to: 1 } : null;
}
