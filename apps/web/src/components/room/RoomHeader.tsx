'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { roomActions, useRoomStore } from '@/store/roomStore';
import type { ConnStatus } from '@/store/types';
import { Button, Icon, IconButton, StatusDot } from '../ui';
import { DebugDrawer } from './DebugDrawer';

const CONN: Record<ConnStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  idle: { label: 'Offline', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'warn' },
  open: { label: 'Connected', tone: 'ok' },
  reconnecting: { label: 'Reconnecting', tone: 'warn' },
  closed: { label: 'Disconnected', tone: 'bad' },
  error: { label: 'Connection error', tone: 'bad' },
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

/** debug: show the debug drawer toggle (Advanced only); extra: buttons placed before Leave */
export function RoomHeader({ name, debug = false, extra }: { name?: string; debug?: boolean; extra?: ReactNode }) {
  const router = useRouter();
  const conn = useRoomStore((s) => s.conn);
  const isHost = useRoomStore((s) => s.isHost);
  const deviceCount = useRoomStore((s) => s.room?.devices.filter((d) => d.connected).length ?? 0);
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
    <header className="flex shrink-0 items-center gap-3 px-3 py-2.5 sm:px-4">
      <button
        type="button"
        onClick={() => setBigQr(true)}
        aria-label="Show QR code to join"
        className="shrink-0 overflow-hidden rounded-xl bg-white p-0.5 transition hover:ring-2 hover:ring-accent"
      >
        {qr ? (
          <img src={qr} alt="" className="size-10" />
        ) : (
          <span className="grid size-10 place-items-center text-ink-950">
            <Icon name="qr" className="size-5" />
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-3 leading-tight">
          {name && <span className="truncate font-display text-lg font-semibold text-ink-100">{name}</span>}
          <span className="sr-only">Room code </span>
          <span
            data-testid="room-code"
            className={`shrink-0 font-mono font-semibold tracking-[0.16em] ${name ? 'text-sm text-ink-300' : 'text-lg text-ink-100'}`}
          >
            {code}
          </span>
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-300">
          <StatusDot status={c.tone} label="" testid="conn-status" />
          <span role="status">{c.label}</span>
          {/* phones: connection status only, so the header stays one row */}
          <span className="truncate max-sm:hidden">
            {isHost && ' · Host'} · {deviceCount} speaker{deviceCount === 1 ? '' : 's'}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {/* phones get the native share sheet instead of copy, to keep the header on one row */}
        <IconButton
          icon={copied ? 'check' : 'link'}
          label={copied ? 'Link copied' : 'Copy join link'}
          onClick={copy}
          variant="ghost"
          className={canShare ? 'max-sm:hidden' : ''}
        />
        {canShare && <IconButton icon="share" label="Share join link" onClick={share} variant="ghost" className="sm:hidden" />}
        {debug && <DebugDrawer />}
        {extra}
        <Button variant="ghost" onClick={leave} className="max-sm:!px-3" aria-label="Leave">
          <Icon name="leave" className="size-4" />
          <span className="max-sm:hidden">Leave</span>
        </Button>
      </div>
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
          <div className="flex w-full max-w-sm flex-col items-center gap-5" onClick={(e) => e.stopPropagation()}>
            {qr && <img src={qr} alt={`QR code linking to ${joinUrl}`} className="w-full rounded-panel bg-white p-4" />}
            <div className="text-center">
              <p className="font-mono text-4xl font-semibold tracking-[0.2em] text-ink-100">{code}</p>
              <p className="mt-1 max-w-full truncate text-sm text-ink-400">{joinUrl}</p>
            </div>
            <Button autoFocus onClick={() => setBigQr(false)}>
              <Icon name="x" className="size-4" /> Close
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
