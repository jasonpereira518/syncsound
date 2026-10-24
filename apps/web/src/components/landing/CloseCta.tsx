'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { addRoom, createHome, savedHome } from '@/lib/home';

/** The closing sentence is the form: the blank names the first room, the last words create the home. */
export function CloseCta() {
  const router = useRouter();
  const [home, setHome] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setHome(savedHome()?.homeId ?? null), []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (home) return router.push(`/h/${home}`);
    setBusy(true);
    setError(null);
    try {
      const id = await createHome();
      await addRoom(id, name.trim() || 'Living room');
      router.push(`/h/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up your home.');
      setBusy(false);
    }
  };

  return (
    <form className="close-form" onSubmit={onSubmit} aria-labelledby="close-h">
      <h2 id="close-h" className="close-h">
        {home ? (
          <>
            Your home is waiting.{' '}
            <button type="submit" className="close-btn">
              Open it
            </button>
          </>
        ) : (
          <>
            First room:{' '}
            <label htmlFor="close-room" className="sr-only">
              Name of your first room
            </label>
            <input
              id="close-room"
              className="close-input"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="Living room"
              autoComplete="off"
            />{' '}
            <button type="submit" className="close-btn" disabled={busy} data-testid="close-create-home">
              {busy ? 'Setting up…' : 'Set it up'}
            </button>
          </>
        )}
      </h2>
      <p className="close-note" role={error ? 'alert' : undefined}>
        {error ??
          (home
            ? 'Your rooms, layouts and tuning are saved on this device.'
            : 'This saves a home on this device with your first room in it. Add the kitchen and the bedroom whenever you like.')}
      </p>
    </form>
  );
}
