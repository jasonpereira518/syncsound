import { expect, test, type Page } from '@playwright/test';
import { joinRoom, newPage, pageErrors, waitConverged } from './helpers';

type Win = {
  __syncsound: {
    getState(): {
      deviceId: string;
      room: {
        volume: number;
        scene: { layout?: string; tune?: { id: string } };
        devices: Array<{ id: string; name: string; role: string; syncState: string; caps: { micPermission?: string } }>;
      };
      mix: { outputGain: number } | null;
      calibration: { step: string; recorderStep: string; waitingFor: string[]; devices: Array<{ deviceId: string; heard: boolean }> };
    };
  };
};
const state = (page: Page) => page.evaluate(() => (window as unknown as Win).__syncsound.getState());
const roles = async (page: Page) => Object.fromEntries((await state(page)).room.devices.map((d) => [d.name, d.role]));

/** every click on the page, counted across navigations (sessionStorage): the setup experience is measured in taps */
async function countTaps(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    addEventListener('click', () => sessionStorage.setItem('__taps', String(Number(sessionStorage.getItem('__taps') ?? 0) + 1)), true);
  });
  return () => page.evaluate(() => Number(sessionStorage.getItem('__taps') ?? 0));
}

// The simple flow, measured in taps: a host sets up a home, lands in its room, tunes it from one screen (the layout
// is suggested and applied by the tune), plays something; a guest joins with one tap and grants the mic right there.
test('home → room → one-screen setup (tune first) → playing in 5 taps; a guest joins in 1', async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const guestLogs: string[] = [];
  guest.page.on('console', (m) => guestLogs.push(m.text()));
  const hostTaps = await countTaps(host.page);
  const guestTaps = await countTaps(guest.page);

  // 1: set up a home → straight into its room (no home page in between)
  await host.page.goto('/');
  await host.page.getByTestId('create-home').click();
  await host.page.waitForURL(/\/room\/[A-Z0-9]{6}/);
  const code = host.page.url().match(/\/room\/([A-Z0-9]{6})/)![1]!;
  // loopback "microphone": the host's own output is recorded, so tuning runs for real in a headless browser
  await host.page.goto(`/room/${code}?loopbackMic=120`);
  await host.page.getByTestId('join-name').fill('Host laptop');
  // 2: join (the mic is asked for in the same tap)
  await host.page.getByTestId('join-button').click();
  await expect(host.page.getByTestId('wizard-title')).toHaveText('Set up your speakers');

  // a guest: one tap, and its mic permission reaches the host's list without any banner on the guest
  await guest.page.goto(`/room/${code}`);
  await guest.page.getByTestId('join-name').fill('Guest phone');
  await guest.page.getByTestId('join-button').click();
  await expect(guest.page.getByTestId('speaker-screen')).toBeVisible();
  await expect(guest.page.getByTestId('volume-max-hint')).toBeVisible(); // never tuned yet
  await expect(guest.page.getByTestId('self-tune-state')).toHaveText('Not tuned yet');
  await expect(host.page.getByTestId('wizard-speakers').locator('li')).toHaveCount(2);
  await expect(host.page.getByTestId('wizard-speakers')).toContainText('Mic ready');
  await expect.poll(async () => (await state(host.page)).room.devices.find((d) => d.name === 'Guest phone')?.caps.micPermission).toBe('granted');
  await guest.page.waitForTimeout(3000);
  await expect(guest.page.getByTestId('route-restored')).toHaveCount(0);
  await expect(guest.page.getByTestId('banner-tune')).toHaveCount(0);
  expect(await guestTaps()).toBe(1);
  await waitConverged(host.page);

  // 3: tune — the layout is suggested (two speakers → stereo) and applied by the tune itself; the guest's mic is
  // opened ahead of the plan (prepare → ready), so the host waits for it, not the other way round
  await host.page.getByTestId('wizard-tune').click();
  // ("ready" lasts only until the plan arrives, milliseconds on one machine: the guest's log proves the path)
  await expect.poll(async () => (await state(guest.page)).calibration.recorderStep, { timeout: 30_000 }).toMatch(/ready|recording/);
  // when the tune is done the setup screen moves on to Now Playing by itself, where the result lingers
  await expect(host.page.getByTestId('room-health')).toBeVisible({ timeout: 90_000 });
  const status = host.page.getByTestId('tune-status');
  await expect(status).toHaveAttribute('data-step', 'done');
  expect(guestLogs.some((l) => l.includes('recording through the mic prepared for plan'))).toBe(true);
  expect(await hostTaps()).toBe(3);
  await expect.poll(() => roles(host.page)).toEqual({ 'Host laptop': 'L', 'Guest phone': 'R' });
  expect((await state(host.page)).room.scene.layout).toBe('stereo');
  await expect(guest.page.getByTestId('speaker-screen').locator('h1')).toHaveText('Front right');

  // the loopback heard only the host's own output
  await expect(status).toContainText('Host laptop');
  await expect(status).toContainText('not heard');
  await expect(host.page.getByTestId('tune-label')).toHaveText('1 of 2 speakers tuned');
  await expect(host.page.getByTestId('room-health')).toContainText('2 speakers, 1 needs tuning');
  await expect(guest.page.getByTestId('self-tune-state')).toHaveText('Not tuned yet');
  await expect(guest.page.getByTestId('volume-max-hint')).toBeVisible();

  // 4–5: something to play
  await host.page.getByTestId('demo-asset').filter({ hasText: /click/i }).first().click();
  await expect(host.page.getByTestId('queue-item').first()).toBeVisible();
  await host.page.getByTestId('play-pause').click();
  await expect.poll(async () => (await state(guest.page)).mix?.outputGain ?? -1).toBeGreaterThan(0);
  expect(await hostTaps()).toBe(5);

  // one master volume, set from the host, reaches the other speaker's mix
  const vol = host.page.getByLabel('Master volume').filter({ visible: true }).first();
  await vol.fill('0.4');
  await vol.blur();
  await expect.poll(async () => (await state(guest.page)).room.volume).toBeCloseTo(0.4, 5);
  await expect.poll(async () => (await state(guest.page)).mix?.outputGain ?? -1).toBeCloseTo(0.4, 2);

  // a tune from Now Playing shows its progress and result right there (it used to run blind)
  await host.page.getByTestId('tune-room').click();
  const again = host.page.getByTestId('tune-status');
  await expect(again).toBeVisible();
  await expect(again).toHaveAttribute('data-step', /done|error/, { timeout: 90_000 });
  await expect(again).toHaveAttribute('data-step', 'done');
  await expect(host.page.getByTestId('tune-label')).toHaveText('1 of 2 speakers tuned');

  // come back later: "Open my home" lands in the (only) room; the layout and the tune persisted, so the host gets
  // the controls, not the setup screen
  await host.page.goto('/');
  await host.page.getByTestId('create-home').click(); // reads "Open my home" now
  await host.page.waitForURL(new RegExp(`/room/${code}`));
  await expect(host.page.getByText('Living room').first()).toBeVisible(); // the room's name, not just its code
  await joinRoom(host.page, code, 'Host laptop', { advanced: false });
  await expect(host.page.getByTestId('room-health')).toBeVisible();
  expect((await state(host.page)).room.scene.layout).toBe('stereo');
  await expect(host.page.getByTestId('tune-label')).toHaveText('1 of 2 speakers tuned');

  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
