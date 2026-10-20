import { expect, test } from '@playwright/test';

test('landing page renders without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /SyncSound/i })).toBeVisible();
  expect(errors).toEqual([]);
});
