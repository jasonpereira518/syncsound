'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { roomActions, useRoomStore } from '@/store/roomStore';
import type { ConnStatus } from '@/store/types';
import { Button, Icon, Menu, MenuItem } from '../ui';
import { DebugDrawer, toggleDebug } from './DebugDrawer';

const CONN: Record<ConnStatus, { label: string; dot: string }> = {
  idle: { label: 'Offline', dot: 'bg-ink-400' },
  connecting: { label: 'Connecting', dot: 'bg-warn' },
  open: { label: 'Connected', dot: 'bg-ok' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-warn' },
  closed: { label: 'Disconnected', dot: 'bg-bad' },
  error: { label: 'Connection error', dot: 'bg-bad' },
};

/** this room's join link and its QR code (data URL, null until rendered) */
export function useJoinLink(): { code: string; joinUrl: string; qr: string | null } {
  const code = useRoomStore((s) => s.room?.code ?? '');
  const [qr, setQr] = useState<string | null>(null);
  const joinUrl = typeof window === 'undefined' || !code ? '' : `${window.location.origin}/room/${code}`;
  useEffect(() => {
    if (!joinUrl) return;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 512, errorCorrectionLevel: 'M', color: { dark: '#0e0c0a', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [joinUrl]);
  return { code, joinUrl, qr };
}

/** debug: mount the debug drawer and offer it in the ⋯ menu (Advanced only); extra: buttons placed before the menu */
export function RoomHeader({ name, debug = false, extra }: { name?: string; debug?: boolean; extra?: ReactNode }) {
  const router = useRouter();
  const conn = useRoomStore((s) => s.conn);
  const { code, joinUrl, qr } = useJoinLink();
  const [bigQr, setBigQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this link', joinUrl);
    }
  };
  const share = () => navigator.share({ title: 'Join my SyncSound room', text: `Room ${code}`, url: joinUrl }).catch(() => {});
  const leave = () => {
    try {
      roomActions.leave();
    } catch {
      /* ignore */
    }
    router.push('/');
  };
  const c = CONN[conn];

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-ink-800 px-3 py-1 sm:px-4">
      <p className="flex min-w-0 flex-1 items-center gap-2.5">
        {name && <span className="truncate font-medium text-ink-100">{name}</span>}
        <span className="sr-only">Room code </span>
        <span data-testid="room-code" className="font-mono text-sm tracking-[0.14em] text-ink-300">
          {code}
        </span>
        <span title={c.label} className="flex items-center gap-1.5 text-xs text-ink-400">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${c.dot}`} />
          <span role="status" className={conn === 'open' ? 'sr-only' : undefined}>
            {c.label}
          </span>
        </span>
      </p>
      <Menu label="Invite speakers" icon="share" text="Share" panelClassName="w-72 p-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setBigQr(true)}
            aria-label="Show QR code full screen"
            className="shrink-0 rounded-md bg-white p-1"
          >
            {qr ? <img src={qr} alt="" className="size-20" /> : <span className="block size-20" />}
          </button>
          <div className="min-w-0">
            <p className="font-mono text-xl tracking-[0.16em] text-ink-100">{code}</p>
            <p className="truncate text-xs text-ink-400">{joinUrl.replace(/^https?:\/\//, '')}</p>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button className="flex-1" onClick={copy}>
            <Icon name={copied ? 'check' : 'link'} className="size-4" /> {copied ? 'Copied' : 'Copy link'}
          </Button>
          {canShare && (
            <Button className="flex-1" onClick={share}>
              <Icon name="share" className="size-4" /> Share
            </Button>
          )}
        </div>
      </Menu>
      {extra}
      <Menu label="More" icon="more" panelClassName="w-48">
        {debug && (
          <MenuItem testid="debug-toggle" onClick={toggleDebug}>
            <Icon name="bug" className="size-4" /> Debug info <kbd className="ml-auto font-mono text-xs text-ink-500">D</kbd>
          </MenuItem>
        )}
        <MenuItem onClick={leave}>
          <Icon name="leave" className="size-4" /> Leave room
        </MenuItem>
      </Menu>
      {debug && <DebugDrawer />}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied to clipboard' : ''}
      </span>

      {bigQr && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Join QR code"
          className="fixed inset-0 z-[60] grid place-items-center bg-ink-950/95 p-6"
          onClick={() => setBigQr(false)}
          onKeyDown={(e) => e.key === 'Escape' && setBigQr(false)}
        >
          <div className="flex w-full max-w-sm flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            {qr && <img src={qr} alt={`QR code linking to ${joinUrl}`} className="w-full rounded-xl bg-white p-3" />}
            <p className="font-mono text-4xl tracking-[0.2em] text-ink-100">{code}</p>
            <p className="max-w-full truncate font-mono text-xs text-ink-400">{joinUrl}</p>
            <Button autoFocus onClick={() => setBigQr(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
