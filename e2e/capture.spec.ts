import { expect, test, type Page } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

type Cap = { active: boolean; receiving: boolean; silent: boolean; error: string | null; peers: number; pipelineDelayMs: number | null };
const cap = (p: Page) =>
  p.evaluate(() => (window as unknown as { __syncsound: { getState(): { capture: Cap } } }).__syncsound.getState().capture);

async function startCapture(page: Page) {
  await page.getByRole('tab', { name: /capture tab/i }).click();
  await page.getByRole('button', { name: /start capture/i }).click();
}

// Video mode 1 (tab capture → WebRTC mesh → every device). `?fakeCapture=tone` stands in for getDisplayMedia.
test('capture mode: host streams to a guest over WebRTC', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?fakeCapture=tone`);
  await joinRoom(host.page, code, 'Host');
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);
  await startCapture(host.page);
  await expect.poll(async () => (await cap(host.page)).active).toBe(true);
  await expect.poll(async () => (await cap(host.page)).peers, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await cap(guest.page)).receiving, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await cap(guest.page)).pipelineDelayMs, { timeout: 20_000 }).not.toBeNull();
  await host.page.waitForTimeout(4000);
  expect((await cap(host.page)).silent).toBe(false);
  console.log('capture: guest pipeline delay estimate (ms) =', (await cap(guest.page)).pipelineDelayMs);
  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});

// DRM tabs capture as digital silence: detect it and explain instead of failing quietly.
test('capture mode: a silent (DRM-like) capture is detected and explained', async ({ browser }) => {
  test.setTimeout(60_000);
  const host = await newPage(browser);
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?fakeCapture=silent`);
  await joinRoom(host.page, code, 'Host');
  await startCapture(host.page);
  await expect.poll(async () => (await cap(host.page)).silent, { timeout: 10_000 }).toBe(true);
  await expect(host.page.getByText(/This tab is silent/)).toBeVisible();
  await expect(host.page.getByText(/DRM-protected sites/)).toBeVisible();
  await host.ctx.close();
});
