import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, openAdvanced, pageErrors, waitConverged } from './helpers';

interface CalDevice {
  deviceId: string;
  heard: boolean;
  relativeLatencyMs: number | null;
  beforeDb: number[] | null;
  afterDb: number[] | null;
}
type Win = {
  __syncsound: {
    getState(): {
      calibration: { step: string; message: string; freqs: number[] | null; devices: CalDevice[]; warnings: string[] };
      room: { devices: Array<{ id: string; calibratedLatencyMs: number | null; eq: { source: string } }> };
    };
  };
};

// Loopback "microphone" (?loopbackMic=<delayMs>): the device's own calibration emissions are recorded through a
// delayed MediaStream instead of a mic. Exercises the whole wizard + real measurement code in a real browser.
// A loopback is acoustically flat, so the measured response must be flat.
test('calibration wizard completes against a loopback microphone', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await page.goto(`/room/${code}?loopbackMic=120`);
  await joinRoom(page, code, 'Listener');
  await waitConverged(page);
  await page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  await page.getByTestId('calibrate-start').click();
  await expect(page.getByTestId('calibration-step')).toHaveAttribute('data-step', /done|error/, { timeout: 90_000 });
  const cal = await page.evaluate(() => (window as unknown as Win).__syncsound.getState().calibration);
  console.log('loopback calibration:', cal.step, '-', cal.message, cal.warnings);
  expect(cal.step).toBe('done');
  expect(cal.devices).toHaveLength(1);
  const d = cal.devices[0]!;
  expect(d.heard).toBe(true);
  expect(d.relativeLatencyMs).toBe(0); // the only (hence earliest) device

  // flat loopback → measured response flat within ±1.5 dB over 100 Hz – 12 kHz
  const freqs = cal.freqs!;
  const band = freqs.map((f, i) => [f, d.beforeDb![i]!] as const).filter(([f]) => f >= 100 && f <= 12000);
  const mean = band.reduce((a, [, v]) => a + v, 0) / band.length;
  const maxDev = Math.max(...band.map(([, v]) => Math.abs(v - mean)));
  console.log(`loopback response max deviation 100 Hz–12 kHz: ${maxDev.toFixed(2)} dB`);
  expect(maxDev).toBeLessThan(1.5);

  // result was applied to the room's device record (server round trip)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Win).__syncsound.getState().room.devices[0]!.eq.source))
    .toBe('measured');

  // quick re-sync: timing-only pass completes and leaves the measured EQ in place
  await page.getByTestId('calibrate-quick').click();
  await expect(page.getByTestId('calibration-step')).toHaveAttribute('data-step', /done|error/, { timeout: 60_000 });
  const quick = await page.evaluate(() => (window as unknown as Win).__syncsound.getState().calibration);
  console.log('quick re-sync:', quick.step, '-', quick.message);
  expect(quick.step).toBe('done');
  expect(quick.devices[0]!.heard).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Win).__syncsound.getState().room.devices[0]!.eq.source)).toBe('measured');
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});

// Two devices, each with its own loopback "mic" (which hears only that device's own sweep): the guest records the
// listener's all-recorders plan and sends its rows; the listener collects them and solves. With no cross cells there
// is nothing to range, so positions stay as placed — the plumbing (plan → recorders → rows → solve) is what's tested.
test('tune: every device records and sends its rows to the listener, which solves', async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await newPage(browser);
  const code = await createRoom(host.page);
  const logs: string[] = [];
  host.page.on('console', (m) => logs.push(m.text()));
  await host.page.goto(`/room/${code}?loopbackMic=60`);
  await joinRoom(host.page, code, 'Listener');
  const guest = await newPage(browser);
  guest.page.on('console', (m) => logs.push(`guest: ${m.text()}`));
  await guest.page.goto(`/room/${code}?loopbackMic=90`);
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);
  type S = { deviceId: string; room: { scene: { devices: Record<string, unknown> } } };
  const state = (p: typeof host.page) => p.evaluate(() => (window as unknown as { __syncsound: { getState(): S } }).__syncsound.getState());
  const guestId = (await state(guest.page)).deviceId;
  const before = (await state(host.page)).room.scene.devices;
  await host.page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  await host.page.getByTestId('calibrate-start').click();
  await expect(host.page.getByTestId('calibration-step')).toHaveAttribute('data-step', /done|error/, { timeout: 120_000 });
  const cal = await host.page.evaluate(() => (window as unknown as Win).__syncsound.getState().calibration);
  console.log('two-device tune:', cal.step, '-', cal.message, cal.warnings);
  console.log(logs.filter((l) => /calibration|error|warn/i.test(l)).join('\n'));
  expect(cal.step).toBe('done');
  expect(cal.devices).toHaveLength(2);
  expect(cal.devices.find((d) => d.deviceId !== guestId)!.heard).toBe(true);
  // the guest's own loopback heard its own sweep; its row reached the listener
  expect(logs.some((l) => l.includes(`rows from ${guestId} 1 heard`))).toBe(true);
  expect((await state(host.page)).room.scene.devices).toEqual(before);
  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});

// Mic path latency beyond the old −100/+600 ms chirp search window must still calibrate (flagged by a warning).
test('calibration tolerates a loopback microphone delayed past the old search window', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await page.goto(`/room/${code}?loopbackMic=800`);
  await joinRoom(page, code, 'Listener');
  await waitConverged(page);
  await page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  await page.getByTestId('calibrate-start').click();
  await expect(page.getByTestId('calibration-step')).toHaveAttribute('data-step', /done|error/, { timeout: 90_000 });
  const cal = await page.evaluate(() => (window as unknown as Win).__syncsound.getState().calibration);
  console.log('800 ms loopback calibration:', cal.step, '-', cal.message, cal.warnings);
  expect(cal.step).toBe('done');
  expect(cal.devices[0]!.heard).toBe(true);
  await ctx.close();
});

// Sync-measurement tool through the loopback mic: each click is independently scheduled from the live clock
// mapping (lookahead), so its timing jitter at the "microphone" measures scheduling stability in a real browser.
test('sync measurement tool: loopback clicks are detected and stable', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await page.goto(`/room/${code}?loopbackMic=40`);
  await joinRoom(page, code, 'Listener');
  await waitConverged(page);
  await page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  // The clock mapping keeps tightening for a moment after waitConverged; the jitter bound below assumes that
  // settle (it used to come implicitly from the tab click above timing out on desktop, where no tab was shown).
  await page.waitForTimeout(1500);
  await page.getByTestId('sync-measure-duration').selectOption('10');
  await page.getByTestId('sync-measure-start').click();
  await expect(page.getByTestId('sync-measure-status')).toHaveAttribute('data-step', /done|error/, { timeout: 60_000 });
  type M = { step: string; message: string; devices: Array<{ detected: number; total: number; stdMs: number; maxAbsMs: number }> };
  const m = await page.evaluate(
    () => (window as unknown as { __syncsound: { getState(): { syncMeasure: M } } }).__syncsound.getState().syncMeasure,
  );
  console.log('sync measurement (loopback):', m.step, '-', m.message);
  expect(m.step).toBe('done');
  const d = m.devices[0]!;
  expect(d.total).toBe(10);
  expect(d.detected).toBe(10);
  expect(d.stdMs).toBeLessThan(1);
  expect(d.maxAbsMs).toBeLessThan(2);
  await expect(page.getByTestId('sync-measure-result')).toBeVisible();
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});

// Pressing Calibrate right after joining (before the audio clock has converged) must wait for it, not fail.
test('calibration started immediately after joining waits for the clocks and completes', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await page.goto(`/room/${code}?loopbackMic=80`);
  await page.getByTestId('join-name').fill('Eager');
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('room-code').first()).toBeVisible();
  await openAdvanced(page);
  await page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  await page.getByTestId('calibrate-start').click(); // no waitConverged: the earliest a user can tap it
  await expect(page.getByTestId('calibration-step')).toHaveAttribute('data-step', /done|error/, { timeout: 90_000 });
  const cal = await page.evaluate(
    () => (window as unknown as { __syncsound: { getState(): { calibration: { step: string; message: string } } } }).__syncsound.getState().calibration,
  );
  console.log('early calibration:', cal.step, '-', cal.message);
  expect(cal.step).toBe('done');
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});
