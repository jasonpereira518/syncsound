'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { roomActions, useRoomStore } from '@/store/roomStore';
import type { ConnStatus } from '@/store/types';
import { Badge, Icon, IconButton } from '../ui';
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
    QRCode.toDataURL(joinUrl, { margin: 1, width: 512, errorCorrectionLevel: 'M', color: { dark: '#06070a', light: '#ffffff' } })
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
    <header className="flex shrink-0 items-center gap-3 px-3 py-2">
      <button
        type="button"
        onClick={() => setBigQr(true)}
        aria-label="Show QR code to join"
        className="shrink-0 overflow-hidden rounded-lg border border-ink-600 bg-white p-0.5 transition hover:border-accent"
      >
        {qr ? (
          <img src={qr} alt="" className="size-10" />
        ) : (
          <span className="grid size-10 place-items-center text-ink-950">
            <Icon name="qr" className="size-5" />
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <p className="leading-none">
          {name && <span className="mr-3 font-display text-xl font-semibold text-ink-100">{name}</span>}
          <span className="sr-only">Room code </span>
          <span data-testid="room-code" className="font-mono text-2xl font-bold tracking-[0.16em] text-accent">
            {code}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={c.tone}>
            <span aria-hidden className={`size-1.5 rounded-full ${c.tone === 'ok' ? 'bg-ok' : c.tone === 'warn' ? 'bg-warn' : c.tone === 'bad' ? 'bg-bad' : 'bg-ink-400'}`} />
            <span role="status">{c.label}</span>
          </Badge>
          {/* phones: connection status only, so the header stays one row */}
          <span className="contents max-sm:hidden">
            {isHost && (
              <Badge tone="accent">
                <Icon name="crown" className="size-3.5" /> Host
              </Badge>
            )}
            <Badge>
              {deviceCount} speaker{deviceCount === 1 ? '' : 's'}
            </Badge>
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* phones get the native share sheet instead of copy, to keep the header on one row */}
        <IconButton
          icon={copied ? 'check' : 'link'}
          label={copied ? 'Link copied' : 'Copy join link'}
          onClick={copy}
          className={`border-transparent ${canShare ? 'max-sm:hidden' : ''}`}
        />
        {canShare && <IconButton icon="share" label="Share join link" onClick={share} className="border-transparent sm:hidden" />}
        {debug && <DebugDrawer />}
        {extra}
        <button type="button" onClick={leave} className="min-h-11 rounded-xl px-3 text-sm text-ink-400 hover:bg-ink-800 hover:text-ink-100">
          Leave
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied to clipboard' : ''}
      </span>

      {bigQr && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Join QR code"
          className="fixed inset-0 z-[60] grid place-items-center bg-ink-950/90 p-6 backdrop-blur"
          onClick={() => setBigQr(false)}
          onKeyDown={(e) => e.key === 'Escape' && setBigQr(false)}
        >
          <div className="flex w-full max-w-sm flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            {qr && (
              <img src={qr} alt={`QR code linking to ${joinUrl}`} className="w-full rounded-2xl bg-white p-3" />
            )}
            <p className="font-mono text-4xl font-bold tracking-[0.2em] text-accent">{code}</p>
            <p className="max-w-full truncate font-mono text-xs text-ink-400">{joinUrl}</p>
            <button
              type="button"
              autoFocus
              onClick={() => setBigQr(false)}
              className="min-h-12 rounded-xl border border-ink-600 px-6 text-ink-100 hover:border-ink-400"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
