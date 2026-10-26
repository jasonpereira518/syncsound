'use client';
import type { ReactNode } from 'react';
import { useRoomStore, roomActions } from '@/store/roomStore';
import { Icon } from '../ui';
import { act, connectSpotifyHere, currentTrack } from './shared';

/**
 * Every speaker plays Spotify under its own Premium account. Shown on any view (also to guests in a host-only room)
 * while a Spotify track is current and this device can't play it yet: connect, tap to start, or take playback back.
 */
export function SpotifyBanner() {
  const track = useRoomStore((s) => currentTrack(s.room));
  const playing = useRoomStore((s) => s.room?.playback.status === 'playing');
  const remote = useRoomStore((s) => s.remote);
  if (track?.kind !== 'spotify' || remote.spotify === 'unconfigured') return null;

  let text: ReactNode = null;
  let action: { label: string; testid: string; onClick: () => void } | null = null;
  if (remote.spotify === 'needs-premium') {
    text = (
      <>
        <strong className="text-warn">This speaker&rsquo;s Spotify account can&rsquo;t play here.</strong> Spotify only plays in the
        browser with Premium. Sign in with a Premium account to hear this song.
      </>
    );
    action = { label: 'Use another account', testid: 'spotify-banner-connect', onClick: () => act(() => {
      roomActions.disconnectSpotify();
      connectSpotifyHere();
    }) };
  } else if (remote.spotify !== 'ready') {
    text = (
      <>
        <strong className="text-warn">This song plays from Spotify.</strong> Connect Spotify on this speaker (its own Premium
        account) to hear it. You only need to do this once.
        {remote.spotify === 'error' && remote.message ? <span className="mt-1 block text-ink-300">{remote.message}</span> : null}
      </>
    );
    action = { label: 'Connect Spotify', testid: 'spotify-banner-connect', onClick: connectSpotifyHere };
  } else if (remote.needsTap) {
    text = (
      <>
        <strong className="text-warn">Your browser is waiting for a tap</strong> before Spotify can play on this speaker.
      </>
    );
    action = { label: 'Start Spotify here', testid: 'spotify-banner-start', onClick: () => roomActions.startSpotifyHere() };
  } else if (remote.elsewhere && playing) {
    text = (
      <>
        <strong className="text-warn">This Spotify account is playing on another device.</strong> One account plays in one place;
        every speaker needs its own.
      </>
    );
    action = { label: 'Play here', testid: 'spotify-banner-start', onClick: () => roomActions.startSpotifyHere() };
  }
  if (!text) return null;
  return (
    <div
      role="status"
      data-testid="spotify-banner"
      className="mx-3 mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-4 py-2 text-sm"
    >
      <Icon name="music" className="size-5 shrink-0 text-warn" />
      <p className="min-w-0 flex-1">{text}</p>
      {action && (
        <button
          type="button"
          data-testid={action.testid}
          onClick={action.onClick}
          className="min-h-11 rounded-lg bg-warn/20 px-3 font-medium text-ink-100 hover:bg-warn/30"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
