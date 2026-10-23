/**
 * Which microphone tuning listens with. Remembered per browser; the default device otherwise. Processing is
 * off (echo cancellation, noise suppression and auto gain would distort the measurement).
 */
const KEY = 'syncsound:micId';
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as const;

export function savedMicId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setMicId(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the default mic is used */
  }
}

/** open the chosen mic; if it has gone away (unplugged, phone out of range), forget it and use the default */
export async function openMic(): Promise<MediaStream> {
  const id = savedMicId();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, deviceId: { exact: id } } });
    } catch (e) {
      if (!(e instanceof DOMException) || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
      setMicId(null);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: RAW });
}

/** mics that live on another device or in headphones hear the room badly (or not at all) */
export const REMOTE_MIC_RE = /iphone|ipad|airpods|bluetooth|headset|hands-free|buds|beats/i;
