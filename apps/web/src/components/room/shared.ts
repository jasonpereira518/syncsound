import { create } from 'zustand';
import type { Device, DeviceClass, RoomState, Track } from '@syncsound/protocol';
import { roomNowMs as engineRoomNowMs, useRoomStore } from '@/store/roomStore';
import type { ClockStats } from '@/store/types';
import type { SyncStatus } from '../ui';

/** Host, or anyone when the host hasn't restricted control. */
export function useCanControl(): boolean {
  return useRoomStore((s) => s.isHost || !s.room?.settings.hostOnlyControl);
}

/** Where to put the tuning device: a phone is held at the head (its mic becomes the seat), anything else sits in front. */
export const placementHint = (deviceClass: DeviceClass | undefined) =>
  deviceClass === 'phone'
    ? 'Sit where you usually listen and hold this phone at your head, at ear height, with the screen facing you. Keep still.'
    : 'Sit where you usually listen with this device in front of you.';

/** Room time now (ms). ClockSync works on performance.now() values, so offset = room − performance.now(). */
export function roomNowMs(clock: ClockStats | null): number {
  return engineRoomNowMs() ?? performance.now() + (clock?.offsetMs ?? 0);
}

export function currentTrack(room: RoomState | null): Track | null {
  if (!room?.playback.trackId) return null;
  return room.queue.find((t) => t.id === room.playback.trackId) ?? null;
}

/**
 * green: |syncError| < 1 ms with a converged clock; yellow: < 5 ms; red otherwise / disconnected / no stats.
 * Only this device knows its own convergence (ClockStats); for peers, reported stats imply a running clock.
 */
export function syncStatusOf(d: Device, selfId: string, clock: ClockStats | null): SyncStatus {
  if (!d.connected || !d.stats) return 'bad';
  const e = Math.abs(d.stats.syncErrorMs);
  const converged = d.id === selfId ? !!clock?.converged : true;
  if (e < 1 && converged) return 'ok';
  if (e < 5) return 'warn';
  return 'bad';
}

/** Run an engine call that may throw synchronously or reject; report the message. */
export function attempt(fn: () => unknown, onError: (msg: string) => void): void {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((e: unknown) => onError(errMsg(e)));
  } catch (e) {
    onError(errMsg(e));
  }
}

/** Same as attempt(), reporting failures as a toast. */
export const act = (fn: () => unknown) => attempt(fn, toast);

// ---------- UI-local toasts (engine errors come from store.error; these are action failures) ----------

export const useToasts = create<{ items: { id: number; msg: string }[] }>(() => ({ items: [] }));
let toastSeq = 0;
export function dismissToast(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}
export function toast(msg: string) {
  const id = ++toastSeq;
  useToasts.setState((s) => ({ items: [...s.items.slice(-2), { id, msg }] }));
  setTimeout(() => dismissToast(id), 6000);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
