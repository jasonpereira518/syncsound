import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged } from './helpers';

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
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});
