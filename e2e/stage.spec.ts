import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

type Win = { __syncsound: { getState(): { room: { scene: { devices: Record<string, { x: number; y: number }> } } } } };
const positions = (page: import('@playwright/test').Page) =>
  page.evaluate(() => JSON.stringify((window as unknown as Win).__syncsound.getState().room.scene.devices));

// Spatial stage: preset layouts reposition devices for everyone; undo/redo restore the scene.
test('stage presets propagate to every client and undo/redo restore them', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await host.page.getByRole('tab', { name: /stage/i }).click({ timeout: 1500 }).catch(() => {});
  const before = await positions(host.page);

  await host.page.getByTestId('preset-frontStage').click();
  await expect.poll(() => positions(host.page)).not.toBe(before);
  const front = await positions(host.page);
  await expect.poll(() => positions(guest.page), { timeout: 10_000 }).toBe(front);

  await host.page.getByRole('button', { name: /undo/i }).first().click();
  await expect.poll(() => positions(host.page)).toBe(before);
  await expect.poll(() => positions(guest.page), { timeout: 10_000 }).toBe(before);

  await host.page.getByRole('button', { name: /redo/i }).first().click();
  await expect.poll(() => positions(guest.page), { timeout: 10_000 }).toBe(front);
  expect(pageErrors(host.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
