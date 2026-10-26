'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BrandLink } from '@/components/Brand';
import { Icon } from '@/components/ui';
import { handleSpotifyCallback } from '@/lib/sources/spotify';

/** Spotify OAuth (PKCE) redirect target: finish the token exchange, then go back to the room. */
export default function SpotifyCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let returnTo = '/';
    try {
      returnTo = sessionStorage.getItem('syncsound:returnTo') ?? '/';
      sessionStorage.removeItem('syncsound:returnTo');
    } catch {
      /* storage blocked */
    }
    const safe = (p: string) => (p.startsWith('/') && !p.startsWith('//') ? p : '/');
    Promise.resolve()
      .then(() => handleSpotifyCallback())
      .then((r) => {
        // returnTo null = popup flow: the handler already closed this window
        if (r.returnTo !== null) window.location.replace(safe(r.returnTo !== '/' ? r.returnTo : returnTo));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-5">
      <BrandLink className="mb-4" />
      <h1 className="font-display text-3xl font-semibold tracking-[-0.03em]">{error ? 'Spotify sign-in failed' : 'Connecting Spotify…'}</h1>
      {error ? (
        <>
          <p role="alert" className="text-bad">
            {error}
          </p>
          <Link href="/" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 font-semibold text-accent-ink transition hover:bg-accent-bright"
          >
            <Icon name="home" className="size-4" /> Back to SyncSound
          </Link>
        </>
      ) : (
        <p className="flex items-center gap-2 text-ink-200">
          <Icon name="spinner" className="size-4 shrink-0 animate-spin text-ink-300" /> Finishing sign-in and taking you back to your room.
        </p>
      )}
    </main>
  );
}
