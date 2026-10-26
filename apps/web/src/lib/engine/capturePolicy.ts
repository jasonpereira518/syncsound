/**
 * Tab/system-audio capture policy: which share options to ask for and whether the capturing device may play the
 * stream itself. Pure decisions (no DOM calls), unit-tested in Node.
 *
 * The one rule: the host's own AudioContext output must never end up inside the capture. Sharing the app's own tab
 * would feed the delayed monitor back into the stream (an echo loop held up by the limiter), so the app tab is
 * excluded from the picker, surface switching onto it is disabled, and the host only monitors a shared *browser
 * tab* (whose local sound is suppressed). A window or the whole screen is heard directly from the OS already:
 * monitoring would double it and, with system audio, re-enter the capture.
 */

/** not yet in lib.dom */
export interface CaptureAudioConstraints extends MediaTrackConstraints {
  suppressLocalAudioPlayback?: boolean;
}
export interface CaptureOptions extends DisplayMediaStreamOptions {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
}

/** `MediaTrackSettings.displaySurface` of the share's video track */
export type DisplaySurface = 'browser' | 'window' | 'monitor' | 'application' | undefined;

export function captureOptions(): CaptureOptions {
  const audio: CaptureAudioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // a shared tab's own sound stays off this device: the delayed monitor plays instead, in time with the others
    suppressLocalAudioPlayback: true,
  };
  return {
    video: true, // Chrome offers tab audio only with a video surface; the track is disabled right after
    audio,
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: 'include',
  };
}

/** May the capturing device play the stream through its own output chain? */
export function shouldMonitor(p: { surface: DisplaySurface; capturedSelf: boolean }): boolean {
  return p.surface === 'browser' && !p.capturedSelf;
}

/** Capture Handle (Chrome): did we just capture a SyncSound tab in this browser? */
export function isOwnCapture(
  handle: { origin?: string; handle?: string } | null | undefined,
  own: { origin: string; handle: string } | null,
): boolean {
  return !!handle && !!own && handle.origin === own.origin && handle.handle === own.handle;
}

/** What the capturing device hears, for the UI */
export type HostPlayback = 'monitor' | 'original' | 'none';
export function hostPlayback(p: { surface: DisplaySurface; monitoring: boolean }): HostPlayback {
  if (p.monitoring) return 'monitor';
  return p.surface === 'window' || p.surface === 'monitor' ? 'original' : 'none';
}
