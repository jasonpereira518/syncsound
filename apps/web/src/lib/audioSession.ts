/**
 * Safari's Audio Session API (iOS/iPadOS 16.4+): 'playback' plays through the loudspeaker and ignores the ringer
 * switch; while a microphone is open the session must be 'play-and-record'. WebKit doesn't always switch back when
 * the mic closes, which leaves music quiet or on the earpiece after a tune, so every mic close restores 'playback'.
 * Other browsers have no `navigator.audioSession`: these are no-ops there.
 */
type SessionType = 'auto' | 'playback' | 'play-and-record' | 'ambient' | 'transient' | 'transient-solo';

const session = () => (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { audioSession?: { type: SessionType } }).audioSession);

export function setAudioSession(type: SessionType): void {
  const s = session();
  if (!s) return;
  try {
    s.type = type;
  } catch {
    /* unsupported value on this version: keep the current one */
  }
}

export const audioSessionType = (): SessionType | null => session()?.type ?? null;
