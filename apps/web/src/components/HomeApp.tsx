'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { HomeView } from '@syncsound/protocol';
import { addRoom, claimRooms, getHome, ownerKeyFor, rememberHome, removeRoom, renameRoom } from '@/lib/home';
import { BrandLink } from './Brand';
import { Button, Icon, inputClass } from './ui';

/** A home: its rooms, how many speakers are in each right now, and (for the owner) adding/renaming rooms. */
export function HomeApp({ homeId }: { homeId: string }) {
  const [home, setHome] = useState<HomeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState(false);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const h = await getHome(homeId);
      setHome(h);
      setError(null);
      claimRooms(homeId, h.rooms.map((r) => r.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [homeId]);

  useEffect(() => {
    rememberHome(homeId);
    setOwner(!!ownerKeyFor(homeId));
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [homeId, load]);

  const run = (p: Promise<unknown>) => p.then(load).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setName('');
    run(addRoom(homeId, n));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this link', window.location.href);
    }
  };

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 py-8">
      <BrandLink className="mb-8" />
      <h1 className="font-display text-4xl font-bold tracking-tight">Your home</h1>
      <p className="mt-2 text-ink-300">
        Each room keeps its own speakers, layout and tuning. Open a room on the device you&rsquo;ll control it from, then add speakers to it.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm text-bad">
          {error}
        </p>
      )}

      <ul className="mt-6 divide-y divide-ink-800 border-y border-ink-800" data-testid="home-rooms">
        {home?.rooms.map((r) => (
          <RoomRow
            key={r.id}
            id={r.id}
            name={r.name}
            connected={r.connected}
            owner={owner}
            onRename={(n) => run(renameRoom(homeId, r.id, n))}
            onRemove={() => run(removeRoom(homeId, r.id))}
          />
        ))}
        {home && !home.rooms.length && <li className="py-6 text-ink-400">No rooms yet. Add the first one below.</li>}
        {!home && !error && <li className="py-6 text-ink-400">Loading your rooms…</li>}
      </ul>

      {owner && (
        <form onSubmit={onAdd} className="mt-6 flex gap-2">
          <label htmlFor="new-room" className="sr-only">
            New room name
          </label>
          <input
            id="new-room"
            data-testid="new-room-name"
            maxLength={40}
            placeholder="Kitchen, bedroom, patio…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
          <Button type="submit" data-testid="add-room" className="shrink-0 whitespace-nowrap" disabled={!name.trim()}>
            <Icon name="plus" className="size-4" /> Add room
          </Button>
        </form>
      )}

      <div className="mt-auto pt-10 text-sm text-ink-400">
        <button type="button" onClick={copy} className="inline-flex min-h-11 items-center gap-2 hover:text-ink-100">
          <Icon name={copied ? 'check' : 'link'} className="size-4" />
          {copied ? 'Link copied' : 'Copy the link to this home'}
        </button>
        <p className="mt-1">
          {owner
            ? 'Anyone with the link can see these rooms and join them. Only this browser can add, rename or remove rooms.'
            : 'You can join these rooms. Changes are made from the browser that set up this home.'}
        </p>
      </div>
    </main>
  );
}

function RoomRow({
  id,
  name,
  connected,
  owner,
  onRename,
  onRemove,
}: {
  id: string;
  name: string;
  connected: number;
  owner: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() && draft.trim() !== name) onRename(draft.trim());
    setEditing(false);
  };
  return (
    <li className="flex items-center gap-3 py-4">
      <span className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={save} className="flex gap-2">
            <label htmlFor={`rename-${id}`} className="sr-only">
              Room name
            </label>
            <input id={`rename-${id}`} autoFocus maxLength={40} value={draft} onChange={(e) => setDraft(e.target.value)} className={inputClass} />
            <Button type="submit">Save</Button>
          </form>
        ) : (
          <>
            <span className="block truncate font-display text-xl font-semibold">{name}</span>
            <span className="block text-sm text-ink-400">
              {connected ? `${connected} speaker${connected === 1 ? '' : 's'} connected now` : 'No speakers connected'}
            </span>
          </>
        )}
      </span>
      {!editing && owner && (
        <>
          <button type="button" aria-label={`Rename ${name}`} onClick={() => setEditing(true)} className="grid size-11 place-items-center rounded-lg text-ink-400 hover:text-ink-100">
            <Icon name="edit" className="size-4" />
          </button>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => window.confirm(`Remove ${name}? Its layout and tuning are deleted.`) && onRemove()}
            className="grid size-11 place-items-center rounded-lg text-ink-400 hover:text-bad"
          >
            <Icon name="trash" className="size-4" />
          </button>
        </>
      )}
      {!editing && (
        <Link
          href={`/room/${id}`}
          data-testid={`open-room-${id}`}
          className="inline-flex min-h-11 items-center rounded-xl bg-accent px-4 font-semibold text-accent-ink hover:brightness-110"
        >
          Open
        </Link>
      )}
    </li>
  );
}
