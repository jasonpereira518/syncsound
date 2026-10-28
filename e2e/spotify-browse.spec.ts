import { expect, test, type Page } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

type Track = { id: string; title: string; artist?: string; artworkUrl?: string; durationSec?: number };
type St = {
  remote: { spotify: string; errorMs: number | null };
  room: {
    queue: Track[];
    playback: { status: string; trackId: string | null; crossfadeSec?: number };
    settings: { hostOnlyControl: boolean; crossfadeSec: number };
  };
};
const st = (p: Page) => p.evaluate(() => (window as unknown as { __syncsound: { getState(): St } }).__syncsound.getState());

const t0 = Date.now();
const step = (name: string) => console.log(`[spotify-browse +${((Date.now() - t0) / 1000).toFixed(1)} s] ${name}`);
const ART = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7c5cff"/></svg>';

// Spotify through the fixture catalog and mock players (?mockRemote=1): a guest in a host-only room connects its own
// account from the banner, the host browses a playlist and plays it, and both speakers move through the songs on
// the room timeline: no crossfade into or out of Spotify, cover art shown, the players in step.
test('Spotify: browse a playlist, play it on every speaker, auto-advance in sync', async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  for (const p of [host, guest]) await p.ctx.route('https://i.scdn.co/**', (r) => r.fulfill({ contentType: 'image/svg+xml', body: ART }));
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?mockRemote=1`);
  await joinRoom(host.page, code, 'Host');
  await guest.page.goto(`/room/${code}?mockRemote=1`);
  await joinRoom(guest.page, code, 'Guest', { advanced: false }); // the guest stays on its speaker screen
  await waitConverged(host.page);
  await waitConverged(guest.page);
  step('joined');

  // host: only I can control, and a long crossfade (which Spotify songs must never get)
  await host.page.getByRole('button', { name: /only i can control/i }).click();
  const crossfade = host.page.getByLabel('Crossfade');
  await crossfade.focus();
  await crossfade.press('End');
  await expect.poll(async () => (await st(host.page)).room.settings).toMatchObject({ hostOnlyControl: true, crossfadeSec: 12 });
  step('settings');

  // host connects and browses: Library → Spotify → Your playlists → Mock Road Trip → Play
  await host.page.getByRole('tab', { name: /^spotify/i }).click();
  await host.page.getByTestId('spotify-connect').click();
  await expect.poll(async () => (await st(host.page)).remote.spotify).toBe('ready');
  await host.page.getByTestId('spotify-playlist').filter({ hasText: 'Mock Road Trip' }).click();
  await expect(host.page.getByTestId('spotify-detail')).toContainText('Mock Road Trip');
  await expect(host.page.getByTestId('spotify-song')).toHaveCount(3);
  await host.page.getByTestId('spotify-play-all').click();
  step('play');

  await expect(host.page.getByTestId('queue-item')).toHaveCount(3);
  await expect(host.page.getByTestId('queue-item').first()).toContainText('The Mock Band');
  const queue = (await st(host.page)).room.queue;
  expect(queue.map((t) => t.title)).toEqual(['Open Highway', 'Rest Stop', 'City Lights']);
  expect(queue.every((t) => t.durationSec === 15 && t.artworkUrl?.startsWith('https://i.scdn.co/'))).toBe(true);
  await expect(host.page.getByTestId('now-playing-art')).toBeVisible();
  await expect(host.page.getByTestId('seek-bar')).toBeEnabled(); // the song's length is known

  // guest: a host-only room still lets it connect its own account, from the banner on its speaker screen
  await expect(guest.page.getByTestId('spotify-banner')).toContainText(/plays from spotify/i);
  await guest.page.getByTestId('spotify-banner-connect').click();
  await expect.poll(async () => (await st(guest.page)).remote.spotify).toBe('ready');
  await expect(guest.page.getByTestId('spotify-banner')).toHaveCount(0);
  await expect(host.page.getByTestId('spotify-readiness')).toContainText('2 of 2 speakers connected');
  step('guest connected');

  // the room moves on to song 2 by itself, with no crossfade (Spotify audio never overlaps)
  for (const p of [host.page, guest.page])
    await expect
      .poll(async () => (await st(p)).room.playback.trackId, { timeout: 30_000, intervals: [250] })
      .toBe(queue[1]!.id);
  step('song 2');
  const pb = (await st(host.page)).room.playback;
  expect(pb.status).toBe('playing');
  expect(pb.crossfadeSec ?? 0).toBe(0);

  // both players are in step a few seconds into song 2 (15 s long)
  await host.page.waitForTimeout(4000);
  for (const p of [host.page, guest.page]) {
    const s = await st(p);
    console.log('spotify browse (mock):', JSON.stringify({ trackId: s.room.playback.trackId, remote: s.remote }));
    expect(s.room.playback.trackId).toBe(queue[1]!.id);
    expect(s.remote.errorMs).not.toBeNull();
    expect(Math.abs(s.remote.errorMs!)).toBeLessThan(150);
  }
  step('in step');
  await expect(guest.page.getByTestId('speaker-now-playing')).toContainText('Rest Stop');
  await expect(guest.page.getByTestId('speaker-now-playing').locator('img')).toBeVisible();

  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
