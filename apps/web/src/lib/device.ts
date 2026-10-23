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

function storage(): Storage | null {
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

export function detectDeviceClass(
  ua: string,
  opts: { mobile?: boolean; touchPoints?: number; outputLabel?: string; outputLatencyMs?: number | null } = {},
): DeviceClass {
  if (opts.outputLabel && BT_RE.test(opts.outputLabel)) return 'bluetooth';
  if ((opts.outputLatencyMs ?? 0) > BT_LATENCY_MS) return 'bluetooth';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  // iPadOS reports a Mac UA; touch points give it away.
  if (/Macintosh/i.test(ua) && (opts.touchPoints ?? 0) > 1) return 'tablet';
  if (opts.mobile || /iPhone|iPod|Android.*Mobile|Mobi|Windows Phone/i.test(ua)) return 'phone';
  if (/Macintosh|Mac OS X|CrOS/i.test(ua)) return 'laptop';
  if (/Windows|Linux|X11/i.test(ua)) return 'desktop';
  return 'unknown';
}

async function mediaInfo(): Promise<{ hasMic: boolean; outputLabel?: string }> {
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    const out = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default') ?? devices.find((d) => d.kind === 'audiooutput');
    return {
      hasMic: devices.some((d) => d.kind === 'audioinput') && !!navigator.mediaDevices?.getUserMedia,
      outputLabel: out?.label ? out.label.slice(0, 120) : undefined,
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
