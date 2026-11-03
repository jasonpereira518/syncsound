'use client';
import { useEffect, useState } from 'react';
import { selfTuneLine } from '@/lib/tuneStatus';
import { useRoomStore } from '@/store/roomStore';
import { Icon } from '../ui';

/** how long a finished tune's line for this speaker stays up */
const LINGER_MS = 20_000;

/**
 * On every speaker while another device tunes the room: its own line from the listener's status after each round,
 * so whoever stands next to it can turn it up (or down) before the next round plays it again.
 */
export function TuneSelfBanner() {
  const st = useRoomStore((s) => s.calibration.selfStatus);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!st?.done) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, st.at + LINGER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [st]);
  if (!st || (st.done && Date.now() > st.at + LINGER_MS)) return null;
  const line = selfTuneLine(st);
  if (!line) return null;
  return (
    <div
      role="alert"
      data-testid="tune-self"
      data-state={st.state}
      className="mx-3 mb-3 flex items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-2 text-sm"
    >
      <Icon name="warning" className="size-5 shrink-0 text-warn" />
      <p className="min-w-0 flex-1">{line}</p>
    </div>
  );
}
