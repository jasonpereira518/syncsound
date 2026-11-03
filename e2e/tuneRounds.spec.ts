import { expect, test, type Page } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

// A tune in rounds (docs/CALIBRATION.md "Rounds"), with loopback "mics" (?loopbackMic=<ms>: each device hears only
// its own chime) and ?dropChimes=<n> (this device stays silent for its first n chimes, like a muted speaker that
// gets turned up). Exercises the listener's round loop, the server's next-round plans and the live status.

interface Row {
  deviceId: string;
  heard: boolean;
  state?: string;
  hint?: string | null;
}
interface St {
  deviceId: string;
  calibration: {
    step: string;
    message: string;
    round: number;
    devices: Row[];
    warnings: string[];
    selfStatus: { state: string; done: boolean } | null;
  };
  room: { devices: Array<{ id: string; eq: { source: string } }> };
}
const state = (p: Page) => p.evaluate(() => (window as unknown as { __syncsound: { getState(): St } }).__syncsound.getState());

async function startTune(page: Page) {
  await page.getByRole('tab', { name: /calibrat/i }).click({ timeout: 1500 }).catch(() => {});
  await page.getByTestId('calibrate-start').click();
}

/** poll the listener's live rows until `pred` holds; every state seen per device on the way */
async function watchRows(page: Page, until: (s: St) => boolean, timeoutMs: number) {
  const seen: Record<string, Set<string>> = {};
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await state(page);
    for (const r of s.calibration.devices) if (r.state) (seen[r.deviceId] ??= new Set()).add(r.state);
    if (until(s)) return { s, seen };
    if (Date.now() > end) throw new Error(`timed out; last: ${s.calibration.step} ${s.calibration.message}`);
    await page.waitForTimeout(150);
  }
}

test('a speaker silent in round 0 is played again and confirmed: no second tap', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await page.goto(`/room/${code}?loopbackMic=120&dropChimes=1`);
  await joinRoom(page, code, 'Listener');
  await waitConverged(page);
  await startTune(page);
  const { s, seen } = await watchRows(page, (x) => x.calibration.step === 'done' || x.calibration.step === 'error', 90_000);
  console.log('recovery:', s.calibration.step, '-', s.calibration.message, s.calibration.warnings, Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v]])));
  expect(s.calibration.step).toBe('done');
  const me = s.calibration.devices.find((d) => d.deviceId === s.deviceId)!;
  expect(me.heard).toBe(true);
  expect(me.state).toBe('in-sync');
  // round 0 heard nothing; the live row said so before the next round played it again
  expect([...seen[s.deviceId]!]).toContain('not-heard');
  expect(s.calibration.message).toMatch(/in 3 rounds/);
  await expect.poll(async () => (await state(page)).room.devices[0]!.eq.source).toBe('measured');
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});

test("a speaker the listener can't hear is played again, told so on its own screen, and given up on", async ({ browser }) => {
  test.setTimeout(180_000);
  const host = await newPage(browser);
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?loopbackMic=60`);
  await joinRoom(host.page, code, 'Listener');
  const guest = await newPage(browser);
  await guest.page.goto(`/room/${code}?loopbackMic=90`);
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);
  const guestId = (await state(guest.page)).deviceId;
  await startTune(host.page);
  // the guest's own screen: "can't hear this speaker — turn it up" while the rounds go on
  await expect(guest.page.getByTestId('tune-self')).toBeVisible({ timeout: 60_000 });
  await expect(guest.page.getByTestId('tune-self')).toContainText("can't hear this speaker");
  const { s, seen } = await watchRows(host.page, (x) => x.calibration.step === 'done' || x.calibration.step === 'error', 120_000);
  console.log('give-up:', s.calibration.step, '-', s.calibration.message, s.calibration.warnings);
  expect(s.calibration.step).toBe('done');
  const g = s.calibration.devices.find((d) => d.deviceId === guestId)!;
  expect(g.heard).toBe(false);
  expect(g.state).toBe('skipped');
  expect([...seen[guestId]!]).toContain('not-heard');
  expect(s.calibration.devices.find((d) => d.deviceId !== guestId)!.state).toBe('in-sync');
  // the final status: the guest is told it isn't tuned
  await expect.poll(async () => (await state(guest.page)).calibration.selfStatus).toMatchObject({ state: 'skipped', done: true });
  await expect(guest.page.getByTestId('tune-self')).toContainText("isn't tuned");
  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});

test('Finish now stops the rounds and applies what was measured', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  // round 0 measures the device once; Finish now during round 1 (its confirmation) drops that round and keeps the one reading
  await page.goto(`/room/${code}?loopbackMic=120`);
  await joinRoom(page, code, 'Listener');
  await waitConverged(page);
  await startTune(page);
  await watchRows(page, (x) => x.calibration.round >= 1 && x.calibration.step === 'recording', 60_000);
  await page.getByTestId('tune-finish').filter({ visible: true }).first().click();
  const { s } = await watchRows(page, (x) => x.calibration.step === 'done' || x.calibration.step === 'error', 60_000);
  console.log('finish now:', s.calibration.step, '-', s.calibration.message, s.calibration.warnings);
  expect(s.calibration.step).toBe('done');
  const me = s.calibration.devices[0]!;
  expect(me).toMatchObject({ heard: true, state: 'checking' });
  expect(s.calibration.warnings.some((w) => w.includes('measured once') && w.includes('finished early'))).toBe(true);
  await expect.poll(async () => (await state(page)).room.devices[0]!.eq.source).toBe('measured');
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});
