import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, schedules, waitConverged, waitForSchedule } from './helpers';

// Manual latency (+ve = this device plays earlier, e.g. to cancel unreported Bluetooth delay): the device must
// start its audio that much earlier in context time while its *predicted heard instant* stays on the shared timeline.
test('manual latency offset shifts the start but keeps the heard instant aligned', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);
  await host.page.getByTestId('demo-asset').filter({ hasText: /click/i }).first().click();
  await host.page.getByTestId('play-pause').click();
  const g0 = await waitForSchedule(guest.page, (s) => s.action === 'play');
  expect(g0.compensationSec).toBeCloseTo(0, 3);

  const n = (await schedules(guest.page)).length;
  const field = guest.page.getByLabel('My latency trim (ms)').first();
  await field.fill('100');
  await field.blur();
  // the drift loop sees the 100 ms compensation change and re-schedules
  const g1 = await waitForSchedule(guest.page, (s) => s.compensationSec > 0.099, n);
  expect(g1.compensationSec).toBeCloseTo(0.1, 3);
  const h = (await schedules(host.page)).filter((s) => s.action === 'play').at(-1)!;
  // heard-instant prediction for the guest's new start, mapped to the same (startRoomTime, trackOffset) origin
  const shiftMs = Math.abs(g1.expectedHeardEpochMs - h.expectedHeardEpochMs);
  console.log(`latency +100 ms: guest heard-instant vs host = ${shiftMs.toFixed(3)} ms`);
  expect(shiftMs).toBeLessThan(10);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
