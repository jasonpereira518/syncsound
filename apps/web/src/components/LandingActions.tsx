'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from '@syncsound/protocol';
import Link from 'next/link';
import { addRoom, createHome, lastRoom, savedHome } from '@/lib/home';
import { createRoom } from '@/lib/roomClient';
import { Icon, inputClass } from './ui';

const strip = (s: string) =>
  s
    .toUpperCase()
    .split('')
    .filter((c) => ROOM_CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);

export function LandingActions() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [rejoin, setRejoin] = useState<{ code: string; name?: string } | null>(null);
  useEffect(() => {
    setHome(savedHome()?.homeId ?? null);
    setRejoin(lastRoom());
  }, []);

  const onHome = async () => {
    if (home) return router.push(`/h/${home}`);
    setCreating(true);
    setCreateError(null);
    try {
      const id = await createHome();
      await addRoom(id, 'Living room');
      router.push(`/h/${id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not set up your home.');
      setCreating(false);
    }
  };

  const onCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const { code: newCode } = await createRoom(password.trim() || undefined);
      router.push(`/room/${newCode}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not create a room.');
      setCreating(false);
    }
  };

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidRoomCode(code)) {
      setJoinError(`Room codes are ${ROOM_CODE_LENGTH} characters (letters and digits, no O/0/I/1/L).`);
      return;
    }
    router.push(`/room/${code}`);
  };

  return (
    <div className="mt-8 grid max-w-xl gap-4 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <button
          type="button"
          data-testid="create-home"
          onClick={onHome}
          disabled={creating}
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-accent px-5 font-display text-lg font-semibold text-accent-ink shadow-[0_0_40px_-8px_var(--color-accent)] transition hover:brightness-110 disabled:opacity-60"
        >
          <Icon name={home ? 'stage' : 'plus'} className="size-5" />
          {creating ? 'Setting up…' : home ? 'Open my home' : 'Set up my home'}
        </button>
        {rejoin && (
          <Link
            href={`/room/${rejoin.code}`}
            data-testid="rejoin-room"
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-accent/60 px-5 font-semibold text-ink-100 hover:bg-accent/10"
          >
            <Icon name="volume" className="size-5 text-accent" />
            Rejoin {rejoin.name ?? `room ${rejoin.code}`}
          </Link>
        )}
        <button
          type="button"
          data-testid="create-room"
          onClick={onCreate}
          disabled={creating}
          className="min-h-11 rounded-xl px-1 text-left text-sm text-ink-300 hover:text-ink-100 disabled:opacity-60"
        >
          Or start a quick room that isn&rsquo;t saved
        </button>
        <details className="group rounded-xl text-sm text-ink-300">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-1 hover:text-ink-100">
            <Icon name="lock" className="size-4" /> Password for the quick room (optional)
          </summary>
          <label htmlFor="room-pw" className="sr-only">
            Room password
          </label>
          <input
            id="room-pw"
            type="password"
            autoComplete="new-password"
            maxLength={100}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Guests will need this to join"
            className={inputClass}
          />
        </details>
        {createError && (
          <p role="alert" className="text-sm text-bad">
            {createError}
          </p>
        )}
      </div>

      <form onSubmit={onJoin} className="flex min-w-0 flex-col gap-2" noValidate>
        <label htmlFor="join-code" className="sr-only">
          Room code
        </label>
        <div className="flex gap-2">
          <input
            id="join-code"
            data-testid="join-code-input"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ROOM CODE"
            value={code}
            onChange={(e) => {
              setCode(strip(e.target.value));
              setJoinError(null);
            }}
            aria-invalid={joinError ? true : undefined}
            aria-describedby={joinError ? 'join-code-err' : undefined}
            className={`${inputClass} h-14 rounded-2xl text-center font-mono text-xl tracking-[0.3em] uppercase sm:text-xl`}
          />
          <button
            type="submit"
            data-testid="join-code-submit"
            aria-label="Join room"
            className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl border border-ink-500 text-ink-100 transition hover:border-accent hover:text-accent"
          >
            <Icon name="next" className="size-5" />
          </button>
        </div>
        <p id="join-code-err" role={joinError ? 'alert' : undefined} className={`text-sm ${joinError ? 'text-bad' : 'text-ink-500'}`}>
          {joinError ?? 'Joining someone else’s room? Enter its code.'}
        </p>
      </form>
    </div>
  );
}
