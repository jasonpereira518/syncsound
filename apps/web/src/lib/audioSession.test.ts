import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioSessionType, setAudioSession } from './audioSession';

describe('audio session (Safari)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('switches the session type where the API exists', () => {
    const audioSession = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession });
    setAudioSession('play-and-record');
    expect(audioSessionType()).toBe('play-and-record');
    setAudioSession('playback');
    expect(audioSession.type).toBe('playback');
  });

  it('is a no-op without the API, and survives a browser that rejects a value', () => {
    vi.stubGlobal('navigator', {});
    expect(() => setAudioSession('playback')).not.toThrow();
    expect(audioSessionType()).toBeNull();
    const strict = {
      get type() {
        return 'playback';
      },
      set type(_v: string) {
        throw new TypeError('unsupported');
      },
    };
    vi.stubGlobal('navigator', { audioSession: strict });
    expect(() => setAudioSession('play-and-record')).not.toThrow();
    expect(audioSessionType()).toBe('playback');
  });
});
