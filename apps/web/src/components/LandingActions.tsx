'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from '@syncsound/protocol';
import Link from 'next/link';
import { isServerMissing, NO_SERVER_MESSAGE } from '@/lib/config';
import { addRoom, createHome, lastRoom, savedHome } from '@/lib/home';
import { createRoom } from '@/lib/roomClient';
import { Icon } from './ui';

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
  const [noServer, setNoServer] = useState(false);
  useEffect(() => {
    setHome(savedHome()?.homeId ?? null);
    setRejoin(lastRoom());
    setNoServer(isServerMissing()); // client-only: the server render can't see the page's host
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
    <div className="acts" id="start">
      {noServer && (
        <p role="alert" data-testid="no-server" className="acts-error">
          {NO_SERVER_MESSAGE}
        </p>
      )}
      <div className="acts-row">
        <button type="button" data-testid="create-home" onClick={onHome} disabled={creating} className="btn btn-primary">
          {creating ? 'Setting up…' : home ? 'Open my home' : 'Set up my home'}
        </button>
        {rejoin && (
          <Link href={`/room/${rejoin.code}`} data-testid="rejoin-room" className="btn btn-quiet">
            <Icon name="volume" className="size-5" />
            Rejoin {rejoin.name ?? `room ${rejoin.code}`}
          </Link>
        )}
      </div>
      {createError && (
        <p role="alert" className="acts-error">
          {createError}
        </p>
      )}

      <form onSubmit={onJoin} className="acts-join" noValidate>
        <label htmlFor="join-code" className="acts-label">
          Got a code from the host?
        </label>
        <div className="acts-join-row">
          <input
            id="join-code"
            data-testid="join-code-input"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="Room code"
            value={code}
            onChange={(e) => {
              setCode(strip(e.target.value));
              setJoinError(null);
            }}
            aria-invalid={joinError ? true : undefined}
            aria-describedby={joinError ? 'join-code-err' : undefined}
            className="acts-code tabular"
          />
          <button type="submit" data-testid="join-code-submit" aria-label="Join room" className="btn-round">
            <Icon name="next" className="size-5" />
          </button>
        </div>
        {joinError && (
          <p id="join-code-err" role="alert" className="acts-error">
            {joinError}
          </p>
        )}
      </form>

      <div className="acts-more">
        <button type="button" data-testid="create-room" onClick={onCreate} disabled={creating} className="link-btn">
          Or start a quick room that isn&rsquo;t saved
        </button>
        <details>
          <summary>Password for the quick room (optional)</summary>
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
            className="acts-code"
          />
        </details>
      </div>
    </div>
  );
}
