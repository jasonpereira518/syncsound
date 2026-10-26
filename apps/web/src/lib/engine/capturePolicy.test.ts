import { describe, expect, it } from 'vitest';
import { captureOptions, hostPlayback, isOwnCapture, shouldMonitor } from './capturePolicy';

describe('captureOptions', () => {
  it('keeps the app tab out of the picker and disables all audio processing', () => {
    const o = captureOptions();
    expect(o.preferCurrentTab).toBe(false);
    expect(o.selfBrowserSurface).toBe('exclude');
    expect(o.surfaceSwitching).toBe('exclude');
    expect(o.systemAudio).toBe('include');
    expect(o.video).toBe(true);
    expect(o.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: true,
    });
  });
  it('never combines preferCurrentTab with selfBrowserSurface=exclude (Chrome throws)', () => {
    const o = captureOptions();
    expect(o.preferCurrentTab && o.selfBrowserSurface === 'exclude').toBe(false);
  });
});

describe('shouldMonitor', () => {
  it.each([
    ['browser', false, true],
    ['browser', true, false],
    ['window', false, false],
    ['monitor', false, false],
    ['application', false, false],
    [undefined, false, false],
  ] as const)('surface %s, capturedSelf %s → %s', (surface, capturedSelf, expected) => {
    expect(shouldMonitor({ surface, capturedSelf })).toBe(expected);
  });
});

describe('isOwnCapture', () => {
  const own = { origin: 'https://sync.example', handle: 'abc' };
  it('matches only our origin and handle', () => {
    expect(isOwnCapture(null, own)).toBe(false);
    expect(isOwnCapture(undefined, own)).toBe(false);
    expect(isOwnCapture({ origin: 'https://other.example', handle: 'abc' }, own)).toBe(false);
    expect(isOwnCapture({ origin: own.origin, handle: 'zzz' }, own)).toBe(false);
    expect(isOwnCapture({ origin: own.origin, handle: 'abc' }, own)).toBe(true);
    expect(isOwnCapture({ origin: own.origin, handle: 'abc' }, null)).toBe(false);
  });
});

describe('hostPlayback', () => {
  it('describes what the sharing device hears', () => {
    expect(hostPlayback({ surface: 'browser', monitoring: true })).toBe('monitor');
    expect(hostPlayback({ surface: 'window', monitoring: false })).toBe('original');
    expect(hostPlayback({ surface: 'monitor', monitoring: false })).toBe('original');
    expect(hostPlayback({ surface: 'browser', monitoring: false })).toBe('none');
    expect(hostPlayback({ surface: undefined, monitoring: false })).toBe('none');
  });
});
