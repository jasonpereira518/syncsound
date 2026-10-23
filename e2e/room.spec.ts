import { expect, test } from '@playwright/test';
import {
  createRoom,
  joinRoom,
  newPage,
  pageErrors,
  schedules,
  spread,
  waitConverged,
  waitForSchedule,
  type Joined,
} from './helpers';

/** Max allowed spread (ms) between contexts' predicted "heard" instant for the same track position. */
const MAX_START_DEVIATION_MS = 10;

test.describe.configure({ mode: 'serial' });

test('3 contexts: create, join, sync, play/pause/seek, late join, drag, calibration', async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await newPage(browser);
  const g1 = await newPage(browser);
  const g2 = await newPage(browser);
  const all: Joined[] = [host, g1, g2];

  // --- create + join via code ---
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await g1.page.goto('/');
  await g1.page.getByTestId('join-code-input').fill(code);
  await g1.page.getByTestId('join-code-submit').click();
  await joinRoom(g1.page, code, 'Guest One');
  await joinRoom(g2.page, code, 'Guest Two');

  // --- device list everywhere ---
  for (const { page } of all) await expect(page.getByTestId('device-row')).toHaveCount(3, { timeout: 15_000 });

  // --- clock sync converges ---
  for (const { page } of all) await waitConverged(page);

  // --- queue a demo track and play ---
  await host.page.getByRole('tab', { name: /library/i }).click({ timeout: 1500 }).catch(() => {});
  await host.page.getByTestId('demo-asset').filter({ hasText: /click/i }).first().click();
  await expect(host.page.getByTestId('queue-item').first()).toBeVisible();
  await host.page.getByTestId('play-pause').click();

  const plays = await Promise.all(all.map(({ page }) => waitForSchedule(page, (s) => s.action === 'play')));
  const startRoomTimes = new Set(plays.map((p) => p.startRoomTime));
  expect(startRoomTimes.size).toBe(1);
  const heard = plays.map((p) => p.expectedHeardEpochMs);
  console.log('play: predicted heard-instant spread (ms) =', spread(heard).toFixed(3));
  expect(spread(heard)).toBeLessThan(MAX_START_DEVIATION_MS);
  // the seek bar shows the live room position (a couple of seconds in, not pinned at an end)
  await host.page.waitForTimeout(2500);
  const shown = Number(await host.page.getByTestId('seek-bar').inputValue());
  expect(shown).toBeGreaterThan(0.5);
  expect(shown).toBeLessThan(10);

  // --- pause ---
  const before = await Promise.all(all.map(({ page }) => schedules(page).then((s) => s.length)));
  await host.page.getByTestId('play-pause').click();
  const pauses = await Promise.all(
    all.map(({ page }, i) => waitForSchedule(page, (s) => s.action === 'pause', before[i])),
  );
  expect(new Set(pauses.map((p) => p.trackOffset.toFixed(6))).size).toBe(1);

  // --- resume, then seek to ~20 s ---
  const before2 = await Promise.all(all.map(({ page }) => schedules(page).then((s) => s.length)));
  await host.page.getByTestId('play-pause').click();
  await Promise.all(all.map(({ page }, i) => waitForSchedule(page, (s) => s.action === 'play', before2[i])));
  const before3 = await Promise.all(all.map(({ page }) => schedules(page).then((s) => s.length)));
  const seek = host.page.getByTestId('seek-bar');
  await seek.fill('20');
  await seek.blur();
  const seeks = await Promise.all(
    all.map(({ page }, i) =>
      waitForSchedule(page, (s) => (s.action === 'seek' || s.action === 'play') && s.trackOffset >= 19, before3[i]),
    ),
  );
  const seekHeard = seeks.map((s) => s.expectedHeardEpochMs);
  console.log('seek: predicted heard-instant spread (ms) =', spread(seekHeard).toFixed(3));
  expect(spread(seekHeard)).toBeLessThan(MAX_START_DEVIATION_MS);

  // --- late joiner lands on the running timeline ---
  const late = await newPage(browser);
  await joinRoom(late.page, code, 'Late Guest');
  await waitConverged(late.page);
  const lateStart = await waitForSchedule(late.page, (s) => s.action === 'play' || s.action === 'seek');
  // Same timeline origin: the late joiner's predicted heard instant for the room's (startRoomTime, trackOffset)
  // must match the others'.
  expect(lateStart.startRoomTime).toBe(seeks[0]!.startRoomTime);
  const lateSpread = spread([...seekHeard, lateStart.expectedHeardEpochMs]);
  console.log('late join: predicted heard-instant spread (ms) =', lateSpread.toFixed(3));
  expect(lateSpread).toBeLessThan(MAX_START_DEVIATION_MS);
  all.push(late);

  // --- drag an object on the stage: every client's computed gains update ---
  await host.page.getByRole('tab', { name: /stage/i }).click({ timeout: 1500 }).catch(() => {});
  const ids = await Promise.all(
    all.map(({ page }) => page.evaluate(() => (window as unknown as { __syncsound: { getState(): { deviceId: string } } }).__syncsound.getState().deviceId)),
  );
  type Win = { __syncsound: { getState(): { room: { scene: { objects: Array<{ id: string; position: { x: number; y: number } }> } } }; mix(): { objectGains: Record<string, number> } | null } };
  const objId = await host.page.evaluate(() => (window as unknown as Win).__syncsound.getState().room.scene.objects[0]!.id);
  const gainOf = (page: Joined['page']) =>
    page.evaluate((id) => (window as unknown as Win).__syncsound.mix()?.objectGains[id] ?? null, objId);
  const g1Before = await gainOf(g1.page);
  const obj = host.page.getByTestId(`stage-object-${objId}`);
  const target = host.page.getByTestId(`stage-device-${ids[1]}`);
  const ob = (await obj.boundingBox())!;
  const tb = (await target.boundingBox())!;
  await host.page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await host.page.mouse.down();
  await host.page.mouse.move(tb.x + tb.width / 2 + 4, tb.y + tb.height / 2 + 4, { steps: 12 });
  await host.page.mouse.up();
  const hostPos = await host.page.evaluate(
    (id) => (window as unknown as Win).__syncsound.getState().room.scene.objects.find((o) => o.id === id)!.position,
    objId,
  );
  for (const { page } of all) {
    await page.waitForFunction(
      ({ p, id }) => {
        const o = (window as unknown as Win).__syncsound.getState().room.scene.objects.find((x) => x.id === id);
        return !!o && Math.abs(o.position.x - p.x) < 1e-6 && Math.abs(o.position.y - p.y) < 1e-6;
      },
      { p: hostPos, id: objId },
      { timeout: 10_000 },
    );
  }
  // object moved next to guest one → guest one's gain for it increased
  await expect.poll(() => gainOf(g1.page), { timeout: 10_000 }).toBeGreaterThan((g1Before ?? 0) + 0.05);

  // --- calibration wizard against the fake microphone ---
  await host.page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  await host.page.getByTestId('calibrate-start').click();
  await expect(host.page.getByTestId('calibration-step')).toHaveAttribute('data-step', /done|error/, {
    timeout: 90_000,
  });
  const step = await host.page.getByTestId('calibration-step').getAttribute('data-step');
  const message = await host.page.evaluate(
    () => (window as unknown as { __syncsound: { getState(): { calibration: { message: string } } } }).__syncsound.getState().calibration.message,
  );
  console.log(`calibration (fake mic) ended in '${step}': ${message}`);
  expect(message.length).toBeGreaterThan(0);

  for (const { page } of all) expect(pageErrors(page)).toEqual([]);
  for (const { ctx } of all) await ctx.close();
});
