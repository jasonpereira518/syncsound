/** Device identity + capabilities. Browser-only at call time (every entry point guards `window`). */
import type { DeviceCaps, DeviceClass } from '@syncsound/protocol';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEVICE_KEY = 'syncsound:deviceId';
const NAME_KEY = 'syncsound:name';

export function randomId(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

export function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getDeviceId(): string {
  const s = storage();
  const existing = s?.getItem(DEVICE_KEY);
  if (existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) return existing;
  const id = randomId();
  s?.setItem(DEVICE_KEY, id);
  return id;
}

export const getRememberedName = () => storage()?.getItem(NAME_KEY) ?? '';
export const rememberName = (name: string) => storage()?.setItem(NAME_KEY, name);

interface UAData {
  mobile?: boolean;
  platform?: string;
}
const uaData = (): UAData | undefined => (navigator as Navigator & { userAgentData?: UAData }).userAgentData;

const BT_RE = /bluetooth|airpods|beats|bose|jbl|sony wh|sony wf|galaxy buds|headset|hands-free/i;
/** reported output latency above this is a Bluetooth link in practice (wired/built-in outputs report ≲ 60 ms) */
const BT_LATENCY_MS = 120;

export const isBluetoothLabel = (label: string | null | undefined): boolean => !!label && BT_RE.test(label);

export function detectDeviceClass(
  ua: string,
  opts: { mobile?: boolean; touchPoints?: number; outputLabel?: string; outputLatencyMs?: number | null } = {},
): DeviceClass {
  if (isBluetoothLabel(opts.outputLabel)) return 'bluetooth';
  if ((opts.outputLatencyMs ?? 0) > BT_LATENCY_MS) return 'bluetooth';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  // iPadOS reports a Mac UA; touch points give it away.
  if (/Macintosh/i.test(ua) && (opts.touchPoints ?? 0) > 1) return 'tablet';
  if (opts.mobile || /iPhone|iPod|Android.*Mobile|Mobi|Windows Phone/i.test(ua)) return 'phone';
  if (/Macintosh|Mac OS X|CrOS/i.test(ua)) return 'laptop';
  if (/Windows|Linux|X11/i.test(ua)) return 'desktop';
  return 'unknown';
}

type MediaDeviceLike = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>;

/** label of the output the page plays through; undefined when the browser hides labels (no mic permission, iOS) */
export function defaultOutputLabel(devices: readonly MediaDeviceLike[]): string | undefined {
  const out = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default') ?? devices.find((d) => d.kind === 'audiooutput');
  return out?.label ? out.label.slice(0, 120) : undefined;
}

export async function currentOutputLabel(): Promise<string | undefined> {
  try {
    return defaultOutputLabel((await navigator.mediaDevices?.enumerateDevices?.()) ?? []);
  } catch {
    return undefined;
  }
}

export type CalibrationInputChoice = { kind: 'keep' } | { kind: 'switch'; deviceId: string } | { kind: 'bluetooth-only' };

/**
 * Which mic a calibration listener should record with. A Bluetooth headset mic is the wrong one: it sits at the
 * speaker instead of the listening position, records in call quality, and holds the output in its hands-free
 * profile (different latency from music playback). Prefer any real non-Bluetooth input.
 */
export function chooseCalibrationInput(openedLabel: string, inputs: readonly MediaDeviceLike[]): CalibrationInputChoice {
  if (!isBluetoothLabel(openedLabel)) return { kind: 'keep' };
  const alt = inputs.find(
    (d) =>
      d.kind === 'audioinput' &&
      d.deviceId &&
      d.deviceId !== 'default' &&
      d.deviceId !== 'communications' &&
      d.label &&
      !isBluetoothLabel(d.label),
  );
  return alt ? { kind: 'switch', deviceId: alt.deviceId } : { kind: 'bluetooth-only' };
}

async function mediaInfo(): Promise<{ hasMic: boolean; outputLabel?: string }> {
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    return {
      hasMic: devices.some((d) => d.kind === 'audioinput') && !!navigator.mediaDevices?.getUserMedia,
      outputLabel: defaultOutputLabel(devices),
    };
  } catch {
    return { hasMic: false };
  }
}

export async function buildCaps(ctx: AudioContext | null): Promise<DeviceCaps> {
  const ua = navigator.userAgent;
  const { hasMic, outputLabel } = await mediaInfo();
  const ms = (s: number | undefined) => (typeof s === 'number' && Number.isFinite(s) ? s * 1000 : null);
  const outputLatencyMs = ms(ctx?.outputLatency);
  return {
    userAgent: ua.slice(0, 400),
    platform: (uaData()?.platform || navigator.platform || 'unknown').slice(0, 80),
    deviceClass: detectDeviceClass(ua, { mobile: uaData()?.mobile, touchPoints: navigator.maxTouchPoints, outputLabel, outputLatencyMs }),
    sampleRate: Math.min(192000, Math.max(8000, ctx?.sampleRate ?? 48000)),
    baseLatencyMs: ms(ctx?.baseLatency),
    outputLatencyMs,
    hasOutputTimestamp: typeof ctx?.getOutputTimestamp === 'function',
    hasMic,
    ...(outputLabel ? { outputLabel } : {}),
  };
}

interface BatteryLike {
  level: number;
}
let battery: BatteryLike | null = null;
let batteryRequested = false;

/** Battery level 0..1, or null when unsupported. First call kicks off the async lookup. */
export function batteryLevel(): number | null {
  if (!batteryRequested && typeof navigator !== 'undefined') {
    batteryRequested = true;
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    nav
      .getBattery?.()
      .then((b) => (battery = b))
      .catch(() => {});
  }
  return battery ? Math.min(1, Math.max(0, battery.level)) : null;
}
