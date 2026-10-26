import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

type Win = {
  __syncsound: {
    getState(): {
      deviceId: string;
      room: {
        scene: { layout?: string; devices: Record<string, { x: number; y: number }>; motion?: { periodSec: number } | null };
        devices: Array<{ id: string; name: string; role: string; connected: boolean }>;
      };
    };
  };
};
type Page = import('@playwright/test').Page;
const state = (page: Page) => page.evaluate(() => (window as unknown as Win).__syncsound.getState());
const roles = async (page: Page) =>
  Object.fromEntries((await state(page)).room.devices.filter((d) => d.connected).map((d) => [d.name, d.role]));

// Speaker spots that can't go silent, and 8D: a 5.1 room gives every speaker a slot (late joiners too), the Devices
// list moves speakers (swapping, re-placing), and 8D reaches every client and moves the sounds on the map.
test('every speaker gets a spot, the role picker swaps and re-places, 8D reaches everyone', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const a = await newPage(browser);
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await joinRoom(a.page, code, 'Phone A', { advanced: false });
  await waitConverged(host.page);
  await host.page.getByRole('tab', { name: /stage/i }).click({ timeout: 1500 }).catch(() => {});

  await host.page.getByTestId('layout-surround5').click();
  await expect.poll(async () => Object.values(await roles(host.page)).sort()).toEqual(['L', 'R']);

  // a speaker joining later is given a spot by itself (not left unplaced/silent)
  const b = await newPage(browser);
  await joinRoom(b.page, code, 'Phone B', { advanced: false });
  await expect.poll(async () => (await roles(host.page))['Phone B'], { timeout: 10_000 }).toBe('C');
  await expect(b.page.getByTestId('speaker-screen').locator('h1')).toHaveText('Centre');

  // the Devices list only offers this layout's spots, and moving into a taken spot swaps
  const bId = (await state(b.page)).deviceId;
  const select = host.page.locator(`[data-testid="device-row"][data-device-id="${bId}"]`).getByTestId('role-select');
  await host.page.getByRole('tab', { name: /devices/i }).click({ timeout: 1500 }).catch(() => {});
  await expect(select.locator('option')).toHaveText(['Front left', 'Front right', 'Centre', 'Surround left', 'Surround right', 'Subwoofer']);
  const before = (await state(host.page)).room.scene.devices[bId];
  const holderOfL = Object.entries(await roles(host.page)).find(([, r]) => r === 'L')![0];
  await select.selectOption('L');
  await expect.poll(async () => (await roles(host.page))['Phone B']).toBe('L');
  expect((await roles(host.page))[holderOfL]).toBe('C');
  await expect.poll(async () => JSON.stringify((await state(host.page)).room.scene.devices[bId])).not.toBe(JSON.stringify(before));
  await expect.poll(async () => (await roles(b.page))['Phone B']).toBe('L');

  // 8D: the motion reaches the others, and the map shows the sounds moving
  await host.page.getByRole('tab', { name: /stage/i }).click({ timeout: 1500 }).catch(() => {});
  await host.page.getByTestId('orbit-medium').click();
  await expect.poll(async () => (await state(a.page)).room.scene.motion?.periodSec ?? null).toBe(8);
  const obj = host.page.locator('[data-testid^="stage-object-"]').first();
  const t0 = await obj.getAttribute('transform');
  await expect.poll(() => obj.getAttribute('transform'), { timeout: 5_000 }).not.toBe(t0);
  await host.page.getByTestId('orbit-off').click();
  await expect.poll(async () => (await state(a.page)).room.scene.motion ?? null).toBeNull();

  for (const p of [host, a, b]) expect(pageErrors(p.page)).toEqual([]);
  for (const p of [host, a, b]) await p.ctx.close();
});
