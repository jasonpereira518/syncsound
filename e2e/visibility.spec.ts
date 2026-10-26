import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, schedules, waitConverged, waitForSchedule } from './helpers';

/**
 * A tab switch while playing: the app re-bursts the clock when the tab is visible again. It must not reset the
 * clock (the estimate stays converged), must not move the mapping, and must not rebuild the playing source.
 */
test('returning to the tab re-checks the clock without a reset or a reschedule', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await joinRoom(guest.page, code, 'Guest');
  for (const { page } of [host, guest]) await waitConverged(page);

  await host.page.getByRole('tab', { name: /library/i }).click({ timeout: 1500 }).catch(() => {});
  await host.page.getByTestId('demo-asset').filter({ hasText: /click/i }).first().click();
  await host.page.getByTestId('play-pause').click();
  await Promise.all([host, guest].map(({ page }) => waitForSchedule(page, (s) => s.action === 'play')));
  await guest.page.waitForTimeout(3000); // let the drift loop settle on the new source

  const read = () =>
    guest.page.evaluate(() => {
      const s = (window as unknown as { __syncsound: { getState(): { clock: { offsetMs: number; converged: boolean; samples: number } | null }; schedules: unknown[] } }).__syncsound;
      const c = s.getState().clock!;
      return { offsetMs: c.offsetMs, converged: c.converged, samples: c.samples, schedules: s.schedules.length };
    });
  const before = await read();
  expect(before.converged).toBe(true);

  // the guest's tab goes to the background for a moment and comes back
  await guest.page.evaluate(() => {
    const setState = (v: string) => Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    setState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await guest.page.waitForTimeout(3000); // the 25-ping burst takes ~1 s, then its onSynced

  const after = await read();
  expect(after.schedules).toBe(before.schedules); // no reschedule, no rebuild
  expect(after.converged).toBe(true); // never reset
  expect(after.samples).toBeGreaterThanOrEqual(before.samples); // the window kept its samples
  expect(Math.abs(after.offsetMs - before.offsetMs)).toBeLessThan(2);
  const all = await schedules(guest.page);
  expect(all.filter((s) => s.action === 'reschedule').length).toBe(0);
  expect(pageErrors(guest.page)).toEqual([]);
  expect(pageErrors(host.page)).toEqual([]);
});
