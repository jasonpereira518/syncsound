import { expect, test } from '@playwright/test';

// The landing page's live layout demo runs the real audio-core layout + panner, and the closing sentence creates a home.
test('landing: layout demo places the right speakers and dragging the sound moves the mix', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your home is one speaker.');

  const speakers = page.getByTestId('demo-speaker');
  await expect(speakers).toHaveCount(6); // 5.1 by default
  await page.getByTestId('demo-layout-stereo').click();
  await expect(speakers).toHaveCount(2);
  await page.getByTestId('demo-layout-surround7').click();
  await expect(speakers).toHaveCount(8);

  const db = async (slot: string) =>
    parseFloat((await page.getByTestId(`demo-level-${slot}`).textContent()) ?? '');
  const plan = page.getByTestId('demo-plan');
  await plan.scrollIntoViewIfNeeded();
  const box = (await plan.boundingBox())!;
  // drop the sound at the front-left corner, then at the rear-right corner: the nearer speaker must get louder
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  const frontLeftNear = await db('L');
  const rearRightFar = await db('RR');
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.9);
  await expect.poll(() => db('RR')).toBeGreaterThan(rearRightFar);
  expect(await db('L')).toBeLessThan(frontLeftNear);

  // keyboard moves the sound too
  await page.getByTestId('demo-sound').focus();
  const before = await db('RR');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(() => db('RR')).toBeLessThan(before);
});

test('landing: the closing sentence names the first room and opens the new home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Name of your first room' }).fill('Den');
  await page.getByTestId('close-create-home').click();
  await page.waitForURL(/\/h\/[^/]+$/);
  await expect(page.getByText('Den').first()).toBeVisible();
});
