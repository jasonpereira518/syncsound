import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

// Chromium's fake capture device beeps instead of hearing the room: a stand-in for "the wrong microphone".
// The mic check must show it is live, and a tuning run through it must fail with the mic named + diagnostics.
test('mic check shows a live level; tuning through a mic that misses the speakers explains why', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await joinRoom(page, code, 'Laptop', { advanced: false });
  await waitConverged(page);
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('mic-check')).toBeVisible();

  await page.getByTestId('mic-test').click();
  await expect.poll(async () => Number(await page.getByTestId('mic-level').getAttribute('data-level')), { timeout: 10_000 }).toBeGreaterThan(0.2);
  await expect(page.getByTestId('mic-check')).toContainText('Listening with');
  expect(await page.getByTestId('mic-select').locator('option').count()).toBeGreaterThan(1); // default + the fake device(s)

  await page.getByTestId('wizard-tune').click();
  const status = page.getByTestId('wizard-tune-status');
  await expect(status).toHaveAttribute('data-step', /done|error/, { timeout: 90_000 });
  await expect(status).toHaveAttribute('data-step', 'error');
  await expect(status).toContainText(/No speakers were heard through .+|recorded almost nothing/);
  const dx = page.getByTestId('tuning-diagnostics');
  await expect(dx).toBeVisible();
  await expect(dx).toContainText('Microphone:');
  await expect(dx).toContainText('Laptop: not heard');
  await expect(page.getByTestId('wizard-tune')).toHaveText(/Try again/);

  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});
