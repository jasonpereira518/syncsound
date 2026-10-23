import { expect, test } from '@playwright/test';
import { openAdvanced } from './helpers';

const noHorizontalScroll = () => document.documentElement.scrollWidth <= window.innerWidth;

// Mobile-first: usable at 360 px wide with no horizontal scrolling; keyboard reachable join flow.
test('360 px: landing + room have no horizontal scroll; join works by keyboard', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/');
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);

  await page.getByTestId('create-room').click();
  await page.waitForURL(/\/room\/[A-Z0-9]{6}/);
  expect(await page.evaluate(noHorizontalScroll)).toBe(true);

  await page.getByTestId('join-name').fill('Phone');
  await page.getByTestId('join-name').press('Tab');
  // keyboard: tab to the join button and press Enter
  for (let i = 0; i < 6 && !(await page.getByTestId('join-button').evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(page.getByTestId('join-button')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('room-code').first()).toBeVisible();
  // simple views first: the setup wizard, then the everyday controls
  await expect(page.getByTestId('wizard-title')).toBeVisible();
  expect(await page.evaluate(noHorizontalScroll), 'no horizontal scroll in the setup wizard').toBe(true);
  await page.getByTestId('wizard-later').click();
  await expect(page.getByTestId('room-health')).toBeVisible();
  expect(await page.evaluate(noHorizontalScroll), 'no horizontal scroll on Now Playing').toBe(true);
  await openAdvanced(page);
  for (const tab of [/library/i, /stage/i, /devices/i, /calibrat/i]) {
    await page.getByRole('tab', { name: tab }).last().click();
    expect(await page.evaluate(noHorizontalScroll), `no horizontal scroll on ${tab}`).toBe(true);
  }
  await ctx.close();
});
