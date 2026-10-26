import { expect, test, type Page } from '@playwright/test';
import { createRoom, joinRoom, newPage, openSource, pageErrors, waitConverged } from './helpers';

type Remote = { spotify: string; apple: string; errorMs: number | null; meanAbsErrorMs: number | null; seeks: number };
type St = { remote: Remote; engine: { bufferState: string }; room: { devices: Array<{ name: string; stats: { remoteErrorMs: number | null } | null }> } };
const st = (p: Page) => p.evaluate(() => (window as unknown as { __syncsound: { getState(): St } }).__syncsound.getState());

// Class B (Spotify/Apple) sync-only path against the mock SDK adapter (?mockRemote=1): seek latency + jitter,
// seek-based sync with hysteresis, honest labeling, measured error reported in the UI and to the room.
test('sync-only remote source: mock players converge and report measured error', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?mockRemote=1`);
  await joinRoom(host.page, code, 'Host');
  await guest.page.goto(`/room/${code}?mockRemote=1`);
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);

  for (const p of [host.page, guest.page]) {
    await openSource(p, /^spotify/i);
    await p.getByRole('button', { name: /connect spotify/i }).click();
    await expect.poll(async () => (await st(p)).remote.spotify).toBe('ready');
  }
  await host.page.getByLabel('Spotify track').fill('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  await host.page.getByRole('button', { name: /^queue$/i }).click();
  await expect(host.page.getByText('Sync-only mode (no spatial/EQ)').first()).toBeVisible();
  await host.page.getByTestId('queue-item').first().click().catch(() => {});
  await host.page.getByTestId('play-pause').click();

  await host.page.waitForTimeout(9000);
  for (const p of [host.page, guest.page]) {
    const s = await st(p);
    console.log('remote sync (mock):', JSON.stringify(s.remote));
    expect(s.engine.bufferState).not.toBe('playing'); // Class B: the SDK owns the audio path
    expect(s.remote.meanAbsErrorMs).not.toBeNull();
    expect(Math.abs(s.remote.errorMs!)).toBeLessThan(150);
  }
  await expect(host.page.getByTestId('remote-sync-stats')).toContainText(/mean \|error\|/);
  // measured error reaches the room (device stats)
  await expect
    .poll(async () => (await st(host.page)).room.devices.every((d) => d.stats?.remoteErrorMs != null), { timeout: 10_000 })
    .toBe(true);
  expect(pageErrors(host.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
