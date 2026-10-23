import { expect, test } from '@playwright/test';
import { joinRoom, newPage, pageErrors, waitConverged } from './helpers';

type Win = {
  __syncsound: {
    getState(): { room: { volume: number; scene: { layout?: string }; devices: Array<{ name: string; role: string }> }; mix: { outputGain: number } | null };
  };
};
const roles = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    Object.fromEntries((window as unknown as Win).__syncsound.getState().room.devices.map((d) => [d.name, d.role])),
  );

// The simple flow: set up a home, open its room, add a second speaker, pick a layout in the wizard, and come back
// later to the same (persisted) room.
test('home → room → setup wizard (with tuning) → speaker screen, master volume, and the room remembers its layout', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);

  await host.page.goto('/');
  await host.page.getByTestId('create-home').click();
  await host.page.waitForURL(/\/h\//);
  const open = host.page.locator('[data-testid^="open-room-"]').first();
  await expect(open).toBeVisible();
  await expect(host.page.getByTestId('home-rooms')).toContainText('Living room');
  const code = ((await open.getAttribute('data-testid')) ?? '').replace('open-room-', '');
  await open.click();
  await host.page.waitForURL(new RegExp(`/room/${code}`));
  // loopback "microphone": the host's own output is recorded, so tuning runs for real in a headless browser
  await host.page.goto(`/room/${code}?loopbackMic=120`);
  await joinRoom(host.page, code, 'Host laptop', { advanced: false });

  // first visit: the wizard, starting with the invite step
  await expect(host.page.getByTestId('wizard-title')).toHaveText('Add your speakers');
  await joinRoom(guest.page, code, 'Guest phone', { advanced: false });
  await expect(guest.page.getByTestId('speaker-screen')).toBeVisible();
  await expect(guest.page.getByTestId('volume-max-hint')).toBeVisible(); // never tuned yet
  await expect(host.page.getByTestId('wizard-speakers').locator('li')).toHaveCount(2);
  await waitConverged(host.page);

  // two speakers → stereo is suggested and applied; each gets a front slot
  await host.page.getByTestId('wizard-next').click();
  await expect(host.page.getByTestId('wizard-layout-stereo')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => roles(host.page)).toEqual({ 'Host laptop': 'L', 'Guest phone': 'R' });
  await expect(guest.page.getByTestId('speaker-screen').locator('h1')).toHaveText('Front right');

  // swap: tap the left slot and give it to the phone
  await host.page.getByTestId('slot-L').click();
  const guestId = await guest.page.evaluate(() => (window as unknown as { __syncsound: { getState(): { deviceId: string } } }).__syncsound.getState().deviceId);
  await host.page.getByTestId(`assign-${guestId}`).click();
  await expect(guest.page.getByTestId('speaker-screen').locator('h1')).toHaveText('Front left');

  await host.page.getByTestId('wizard-next').click();
  await expect(host.page.getByTestId('wizard-title')).toHaveText('Tune the room');
  await host.page.getByTestId('wizard-tune').click();
  const status = host.page.getByTestId('wizard-tune-status');
  await expect(status).toHaveAttribute('data-step', /done|error/, { timeout: 90_000 });
  await expect(status).toHaveAttribute('data-step', 'done');
  // the loopback only hears the host's own output; the phone is reported as not heard
  await expect(status).toContainText('Host laptop');
  await expect(status).toContainText('in sync, level matched');
  await expect(status).toContainText('not heard');
  await host.page.getByTestId('wizard-finish').click();
  await expect(host.page.getByTestId('room-health')).toBeVisible();

  // one master volume, set from the host, reaches the other speaker's mix
  const vol = host.page.getByLabel('Master volume').filter({ visible: true }).first();
  await vol.fill('0.4');
  await vol.blur();
  await expect.poll(() => guest.page.evaluate(() => (window as unknown as Win).__syncsound.getState().room.volume)).toBeCloseTo(0.4, 5);
  await expect
    .poll(() => guest.page.evaluate(() => (window as unknown as Win).__syncsound.getState().mix?.outputGain ?? -1))
    .toBeCloseTo(0.4, 2);

  // come back later: the room (and its layout) persisted, so the host lands on the controls, not the wizard
  await host.page.reload();
  await expect(host.page.getByText('Living room').first()).toBeVisible(); // the room's name, not just its code
  await joinRoom(host.page, code, 'Host laptop', { advanced: false });
  await expect(host.page.getByTestId('room-health')).toBeVisible();
  expect(await host.page.evaluate(() => (window as unknown as Win).__syncsound.getState().room.scene.layout)).toBe('stereo');

  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
