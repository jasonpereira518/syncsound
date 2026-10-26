'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { isValidRoomCode } from '@syncsound/protocol';
import { roomActions, useRoomStore } from '@/store/roomStore';
import { getRoomInfo, hostKeyName } from '@/lib/roomClient';
import { BrandLink } from '../Brand';
import { Button, Icon, inputClass, type IconName } from '../ui';
import { errMsg } from './shared';

type Info = { state: 'loading' } | { state: 'ok'; hasPassword: boolean; name?: string } | { state: 'missing' } | { state: 'unreachable' };
const NAME_KEY = 'syncsound:name';

const TIPS: { icon: IconName; text: string }[] = [
  { icon: 'volume', text: 'Tapping the button turns on audio. Your screen stays awake while you\u2019re in the room.' },
  { icon: 'phone', text: 'Keep this tab open and in the foreground. iPhones pause audio from background tabs and locked screens.' },
  { icon: 'bluetooth', text: 'Bluetooth speakers add delay. Tuning the room fixes it once everyone has joined.' },
];

/** a friendly default speaker name from the user agent, so joining is one tap */
export function suggestName(ua: string): string {
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android.*Mobile/i.test(ua)) return 'Android phone';
  if (/Android/i.test(ua)) return 'Android tablet';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  return 'Speaker';
}

export function JoinGate({ code }: { code: string }) {
  const conn = useRoomStore((s) => s.conn);
  const validCode = isValidRoomCode(code);
  const [info, setInfo] = useState<Info>(validCode ? { state: 'loading' } : { state: 'missing' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState(false);

  useEffect(() => {
    try {
      setName(localStorage.getItem(NAME_KEY) ?? suggestName(navigator.userAgent));
      setMine(!!localStorage.getItem(hostKeyName(code)));
    } catch {
      setName(suggestName(navigator.userAgent));
    }
  }, [code]);

  useEffect(() => {
    if (!validCode) return;
    let live = true;
    getRoomInfo(code)
      .then((r) => live && setInfo(r.exists ? { state: 'ok', hasPassword: r.hasPassword, name: r.name } : { state: 'missing' }))
      .catch(() => live && setInfo({ state: 'unreachable' }));
    return () => {
      live = false;
    };
  }, [code, validCode]);

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim().slice(0, 40);
    if (!n) {
      setError('Give this speaker a name so the host can find it.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      /* storage blocked */
    }
    // Called synchronously inside the click/submit gesture: the engine unlocks the AudioContext here.
    let p: Promise<void>;
    try {
      p = roomActions.join({ code, name: n, password: password || undefined });
    } catch (err) {
      p = Promise.reject(err);
    }
    p.catch((err: unknown) => setError(errMsg(err))).finally(() => setBusy(false));
  };

  if (info.state === 'missing') {
    return (
      <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-5 py-10">
        <BrandLink className="mb-4" />
        <p className="font-mono text-sm tracking-[0.3em] text-ink-400">{code || '------'}</p>
        <h1 className="font-display text-4xl font-semibold tracking-[-0.03em]">Room not found</h1>
        <p className="text-ink-200">
          This room doesn&rsquo;t exist or has closed. Quick rooms disappear when everyone leaves; rooms saved in a home stay.
          Double-check the code, or start again from the home screen.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 font-semibold text-accent-ink transition hover:bg-accent-bright"
        >
          <Icon name="home" className="size-4" /> Back to SyncSound
        </Link>
      </main>
    );
  }

  const needsPassword = info.state === 'ok' && info.hasPassword;
  const connecting = busy || conn === 'connecting';

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <BrandLink className="mb-8" />
      <p className="text-sm text-ink-300">{info.state === 'ok' && info.name ? info.name : 'Room'}</p>
      <p className="mt-1 font-mono text-4xl font-semibold tracking-[0.18em] text-ink-100">{code}</p>
      <h1 className="mt-6 font-display text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">{mine ? 'Your room' : 'Use this device as a speaker'}</h1>

      <form onSubmit={onJoin} className="mt-8 flex flex-col gap-4">
        <div>
          <label htmlFor="join-name" className="mb-1.5 block text-sm text-ink-200">
            Name this speaker
          </label>
          <input
            id="join-name"
            data-testid="join-name"
            autoComplete="nickname"
            maxLength={40}
            placeholder="e.g. Maya's phone"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        {needsPassword && (
          <div>
            <label htmlFor="join-pw" className="mb-1.5 block text-sm text-ink-200">
              Room password
            </label>
            <input
              id="join-pw"
              type="password"
              autoComplete="current-password"
              maxLength={100}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>
        )}
        {info.state === 'unreachable' && (
          <p className="flex items-start gap-2 text-sm text-warn">
            <Icon name="warning" className="mt-0.5 size-4 shrink-0" />
            Couldn&rsquo;t reach the room server to check this room. You can still try to join.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" data-testid="join-button" disabled={connecting} className="mt-2 w-full">
          <Icon name="volume" className="size-5" />
          {connecting ? 'Joining…' : mine ? 'Open my room' : 'Use this device as a speaker'}
        </Button>
      </form>

      <ul className="mt-10 space-y-4 text-sm text-ink-300">
        {TIPS.map((t) => (
          <li key={t.icon} className="flex items-start gap-3">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-850 text-ink-200">
              <Icon name={t.icon} className="size-4" />
            </span>
            <span className="pt-1.5">{t.text}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
