import { expect, test } from '@playwright/test';
import { joinRoom, newPage, pageErrors, waitConverged, waitForSchedule } from './helpers';

// Two rooms in one home: the owner plays the current track in both at once (same start instant), and a speaker
// that leaves gets "Rejoin <room>" on the landing page.
test('group play starts two home rooms together; speakers get a rejoin button', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await newPage(browser);
  const kitchenSpeaker = await newPage(browser);

  await owner.page.goto('/');
  await owner.page.getByTestId('create-home').click();
  await owner.page.waitForURL(/\/room\//); // a new home lands in its room; the home page holds the room list
  const homeId = await owner.page.evaluate(() => JSON.parse(localStorage.getItem('syncsound:home') ?? '{}').homeId as string);
  await owner.page.goto(`/h/${homeId}`);
  await expect(owner.page.locator('[data-testid^="open-room-"]')).toHaveCount(1);
  await owner.page.getByTestId('new-room-name').fill('Kitchen');
  await owner.page.getByTestId('add-room').click();
  const opens = owner.page.locator('[data-testid^="open-room-"]');
  await expect(opens).toHaveCount(2);
  const [living, kitchen] = (await opens.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('open-room-', '')))) as [string, string];

  await owner.page.goto(`/room/${living}`);
  await joinRoom(owner.page, living, 'Owner laptop', { advanced: false });
  await owner.page.getByTestId('wizard-later').click();
  await joinRoom(kitchenSpeaker.page, kitchen, 'Kitchen speaker', { advanced: false });
  await expect(kitchenSpeaker.page.getByTestId('speaker-screen')).toBeVisible();
  await waitConverged(owner.page);
  await waitConverged(kitchenSpeaker.page);

  await owner.page.getByTestId('demo-asset').filter({ hasText: /click/i }).first().click();
  await owner.page.getByTestId(`group-room-${kitchen}`).click();
  await owner.page.getByTestId('group-play').click();

  const [a, b] = await Promise.all([
    waitForSchedule(owner.page, (s) => s.action === 'play'),
    waitForSchedule(kitchenSpeaker.page, (s) => s.action === 'play'),
  ]);
  expect(b.startRoomTime).toBe(a.startRoomTime);
  expect(b.trackId).toBe(a.trackId);

  await kitchenSpeaker.page.goto('/');
  await expect(kitchenSpeaker.page.getByTestId('rejoin-room')).toHaveText(/Rejoin Kitchen/);

  expect(pageErrors(owner.page)).toEqual([]);
  expect(pageErrors(kitchenSpeaker.page)).toEqual([]);
  await owner.ctx.close();
  await kitchenSpeaker.ctx.close();
});
