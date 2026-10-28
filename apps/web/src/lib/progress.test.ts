import { describe, expect, it } from 'vitest';
import type { Device } from '@syncsound/protocol';
import type { EngineLoad } from '../store/types';
import { bufferedSpan, devicesReady, fmtClock, fmtEta, fmtSize, playerStatus, uploadLine } from './progress';

const load: EngineLoad = { trackId: 't', bufferedThroughSec: 360, playheadSec: 10, totalSec: 10_800, ready: 3, loading: 0, count: 90 };

describe('fmtClock', () => {
  it('is m:ss under an hour and h:mm:ss from an hour up', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(59.9)).toBe('0:59');
    expect(fmtClock(754)).toBe('12:34');
    expect(fmtClock(3600)).toBe('1:00:00');
    expect(fmtClock(10_800)).toBe('3:00:00');
    expect(fmtClock(9_015)).toBe('2:30:15');
  });
  it('treats unknown and negative as 0:00', () => {
    expect(fmtClock(null)).toBe('0:00');
    expect(fmtClock(Number.NaN)).toBe('0:00');
    expect(fmtClock(-3)).toBe('0:00');
  });
});

describe('fmtSize / fmtEta', () => {
  it('formats sizes', () => {
    expect(fmtSize(3.2 * 1024 * 1024)).toBe('3.2 MB');
    expect(fmtSize(170 * 1024 * 1024)).toBe('170 MB');
    expect(fmtSize(2.5 * 1024 ** 3)).toBe('2.5 GB');
  });
  it('rounds the time left to something readable', () => {
    expect(fmtEta(2)).toBe('a few seconds left');
    expect(fmtEta(42)).toBe('about 40 s left');
    expect(fmtEta(300)).toBe('about 5 min left');
  });
});

describe('uploadLine', () => {
  it('shows bytes, percent and time left while uploading', () => {
    const l = uploadLine('mix.mp3', { phase: 'uploading', loaded: 60 * 1024 * 1024, total: 170 * 1024 * 1024 }, 20_000);
    expect(l.text).toBe('Uploading mix.mp3 · 35% · 60 MB of 170 MB · about 35 s left');
    expect(l.frac).toBeCloseTo(60 / 170, 6);
  });
  it('holds off the estimate until it has something to go on', () => {
    const l = uploadLine('mix.mp3', { phase: 'uploading', loaded: 1024, total: 100 * 1024 * 1024 }, 500);
    expect(l.text).not.toMatch(/left/);
  });
  it('shows the part count while the server splits a long file', () => {
    expect(uploadLine('mix.mp3', { phase: 'preparing', done: 12, total: 90 }, 0)).toEqual({ text: 'Preparing for playback · part 12 of 90', frac: 12 / 90 });
  });
  it('is indeterminate before there is anything to count', () => {
    expect(uploadLine('mix.mp3', { phase: 'preparing' }, 0).frac).toBeNull();
    expect(uploadLine('mix.mp3', undefined, 0)).toEqual({ text: 'Uploading mix.mp3…', frac: null });
  });
});

describe('playerStatus', () => {
  const base = { kind: 'file', status: 'playing' as const, load: null, devices: null };
  it('is the plain status for an ordinary loaded track', () => {
    expect(playerStatus({ ...base, bufferState: 'playing' })).toBe('file · playing');
  });
  it('says what it is waiting on', () => {
    expect(playerStatus({ ...base, bufferState: 'loading' })).toBe('file · downloading…');
    expect(playerStatus({ ...base, bufferState: 'loading', load: { ...load, bufferedThroughSec: 10 } })).toBe('file · buffering · 0:00 ready');
    expect(playerStatus({ ...base, bufferState: 'error' })).toBe("file · couldn't load");
  });
  it('shows how far ahead a long track is buffered', () => {
    expect(playerStatus({ ...base, bufferState: 'playing', load })).toBe('file · playing · 5:50 buffered ahead');
    // at the end of the track there is nothing more to buffer
    expect(playerStatus({ ...base, bufferState: 'playing', load: { ...load, bufferedThroughSec: 10_800, playheadSec: 10_700 } })).toBe('file · playing');
  });
  it('shows how many devices are ready until they all are', () => {
    expect(playerStatus({ ...base, bufferState: 'ready', status: 'stopped', devices: { ready: 2, total: 3 } })).toBe('file · stopped · 2 of 3 devices ready');
    expect(playerStatus({ ...base, bufferState: 'ready', devices: { ready: 3, total: 3 } })).toBe('file · playing');
    expect(playerStatus({ ...base, bufferState: 'ready', devices: { ready: 0, total: 1 } })).toBe('file · playing');
  });
});

describe('devicesReady', () => {
  const dev = (id: string, connected: boolean, loadedTrackId: string | null, bufferState: 'ready' | 'loading' | 'playing') =>
    ({ id, connected, stats: { loadedTrackId, bufferState } }) as unknown as Device;
  it('counts connected devices that hold the track', () => {
    const r = devicesReady([dev('a', true, 't', 'ready'), dev('b', true, 't', 'playing'), dev('c', true, 't', 'loading'), dev('d', true, 'other', 'ready'), dev('e', false, 't', 'ready')], 't');
    expect(r).toEqual({ ready: 2, total: 4 });
  });
  it('is null with nobody connected', () => {
    expect(devicesReady([dev('a', false, 't', 'ready')], 't')).toBeNull();
  });
});

describe('bufferedSpan', () => {
  it('is nothing for an unknown length or a track that has not loaded', () => {
    expect(bufferedSpan(0, 0, 'ready', null)).toBeNull();
    expect(bufferedSpan(200, 0, 'loading', null)).toBeNull();
  });
  it('is the whole bar for an ordinary track that is ready', () => {
    expect(bufferedSpan(200, 50, 'ready', null)).toEqual({ from: 0, to: 1 });
    expect(bufferedSpan(200, 50, 'playing', null)).toEqual({ from: 0, to: 1 });
  });
  it('runs from the playhead to the end of the decoded window for a long track', () => {
    expect(bufferedSpan(10_800, 1080, 'playing', { ...load, bufferedThroughSec: 1440 })).toEqual({ from: 0.1, to: 0.13333333333333333 });
    expect(bufferedSpan(10_800, 1080, 'playing', { ...load, bufferedThroughSec: 1000 })).toBeNull();
  });
});
