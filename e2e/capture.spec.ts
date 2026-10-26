import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, schedules, waitConverged, waitForSchedule } from './helpers';

interface Cap {
  active: boolean;
  receiving: boolean;
  silent: boolean;
  error: string | null;
  peers: number;
  pipelineDelayMs: number | null;
  monitoring: boolean;
  hostPlayback: string | null;
  jitterTargetMs: number | null;
  appliedDelayMs: number | null;
  delayChanges: number;
  shortfallMs: number | null;
}
interface Reading {
  rmsDb: number;
  peaks: Array<{ hz: number; db: number }>;
}
interface Tap {
  out: Reading[];
  external: Reading[] | null;
}
interface Live {
  appliedMs: number | null;
  changes: number;
  estimateMs: number | null;
  monitoring: boolean;
  audible: boolean;
}
interface Api {
  getState(): {
    capture: Cap;
    room: { playback: { status: string }; settings: { videoBufferMs: number } } | null;
    engine: { sampleRate: number | null };
  };
  tap(): Tap | null;
  liveDelay(): Live | null;
}
const state = (p: Page) => p.evaluate(() => (window as unknown as { __syncsound: Api }).__syncsound.getState());
const cap = async (p: Page) => (await state(p)).capture;
const tap = (p: Page) => p.evaluate(() => (window as unknown as { __syncsound: Api }).__syncsound.tap());
const live = (p: Page) => p.evaluate(() => (window as unknown as { __syncsound: Api }).__syncsound.liveDelay());

async function startCapture(page: Page) {
  await page.getByRole('tab', { name: /browser tab/i }).click();
  await page.getByRole('button', { name: /start capture/i }).click();
}

/** host (with `hostQuery`) + guest (with `guestQuery`) joined and clock-converged */
async function hostAndGuest(browser: Browser, hostQuery: string, guestQuery = '') {
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?${hostQuery}`);
  await joinRoom(host.page, code, 'Host');
  if (guestQuery) await guest.page.goto(`/room/${code}?${guestQuery}`);
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);
  return { host, guest };
}

/** `n` readings of the `?tap=1` analysers, one every `everyMs` */
async function sample(page: Page, n: number, everyMs: number): Promise<Tap[]> {
  const out: Tap[] = [];
  for (let i = 0; i < n; i++) {
    const t = await tap(page);
    expect(t, 'tap=1 instrumentation is on').not.toBeNull();
    out.push(t!);
    await page.waitForTimeout(everyMs);
  }
  return out;
}
/** level of the spectral peak near `hz` among the three strongest, or −∞ when it isn't one of them */
const peakDb = (r: Reading, hz: number, tolHz = 15) => r.peaks.find((p) => Math.abs(p.hz - hz) <= tolHz)?.db ?? -Infinity;

// Video mode 1 (tab capture → WebRTC mesh → every device). `?fakeCapture=tone` stands in for getDisplayMedia with a
// 440 Hz (L) / 660 Hz (R) stereo tone; `?tap=1` puts analysers on each device's output and on the live source.
test('capture mode: a guest hears a clean, steady, stereo stream aligned by a stable delay', async ({ browser }) => {
  test.setTimeout(150_000);
  const { host, guest } = await hostAndGuest(browser, 'fakeCapture=tone&tap=1', 'tap=1');
  await startCapture(host.page);
  await expect.poll(async () => (await cap(host.page)).active).toBe(true);
  await expect.poll(async () => (await cap(host.page)).peers, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await cap(guest.page)).receiving, { timeout: 20_000 }).toBe(true);
  // the guest stays silent until its first pipeline estimate has aligned it, then fades in
  await expect.poll(async () => (await live(guest.page))?.audible, { timeout: 20_000 }).toBe(true);
  const g = await cap(guest.page);
  expect(g.pipelineDelayMs).not.toBeNull();
  expect(g.jitterTargetMs).toBe(75); // half of the 150 ms default buffer
  await guest.page.waitForTimeout(3000); // let the median window fill
  const before = (await live(guest.page))!;
  const [readings, hostReadings] = await Promise.all([sample(guest.page, 16, 250), sample(host.page, 16, 250)]);
  const after = (await live(guest.page))!;

  // level: the 0.2-amplitude tone (−17 dBFS per channel) lands around −27…−14 dBFS after the panning gains;
  // digital silence (unmapped objects, a dropped voice) reads ≤ −100. A 6 dB envelope rules out dropouts and pumping.
  const levels = readings.map((r) => r.out[0]!.rmsDb);
  for (const db of levels) expect(db).toBeGreaterThan(-50);
  expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(6);
  // both tones reach the room: the L and R objects are mapped (a leftover mono or 5.1 scene would mute one or both).
  // Panning is sharp (vbapGains), so one speaker may play only its own side: each tone must come out of the host or
  // the guest on every reading.
  readings.forEach((r, i) => {
    const h = hostReadings[i]!;
    expect(Math.max(peakDb(r.out[0]!, 440), peakDb(h.out[0]!, 440))).toBeGreaterThan(-Infinity);
    expect(Math.max(peakDb(r.out[0]!, 660), peakDb(h.out[0]!, 660))).toBeGreaterThan(-Infinity);
  });
  // stereo survives Opus and the channel mapping: L carries 440, R carries 660 (the output itself is a mono mix,
  // so this is only observable on the live source)
  for (const r of readings) {
    expect(r.external).not.toBeNull();
    const [l, rr] = r.external!;
    expect(peakDb(l!, 440) - peakDb(l!, 660)).toBeGreaterThanOrEqual(20);
    expect(peakDb(rr!, 660) - peakDb(rr!, 440)).toBeGreaterThanOrEqual(20);
  }
  // alignment: a whole number of samples, inside the buffer, and not switched again while we listened
  const sr = (await state(guest.page)).engine.sampleRate!;
  const samplesApplied = (after.appliedMs! / 1000) * sr;
  expect(Math.abs(samplesApplied - Math.round(samplesApplied))).toBeLessThan(1e-6);
  expect(after.appliedMs!).toBeGreaterThanOrEqual(0);
  expect(after.appliedMs!).toBeLessThanOrEqual(150);
  expect(after.changes - before.changes).toBeLessThanOrEqual(1);
  // the host shared a tab (the fake reports 'browser'): it monitors and plays the delayed copy itself
  const h = await cap(host.page);
  expect(h.monitoring).toBe(true);
  expect(h.hostPlayback).toBe('monitor');
  expect(h.silent).toBe(false);
  expect((await tap(host.page))!.out[0]!.rmsDb).toBeGreaterThan(-50);
  console.log(
    `capture: guest pipeline ${g.pipelineDelayMs} ms, applied delay ${after.appliedMs?.toFixed(2)} ms (${after.changes} switches), ` +
      `level ${Math.min(...levels).toFixed(1)}…${Math.max(...levels).toFixed(1)} dBFS`,
  );
  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});

// A file track can't share the output chain with the live stream: starting a share pauses it and play is refused.
test('capture mode: starting a share pauses the room and blocks play until it stops', async ({ browser }) => {
  test.setTimeout(120_000);
  const { host, guest } = await hostAndGuest(browser, 'fakeCapture=tone');
  await host.page.getByTestId('demo-asset').filter({ hasText: /click/i }).first().click();
  await host.page.getByTestId('play-pause').click();
  await waitForSchedule(guest.page, (s) => s.action === 'play');

  await startCapture(host.page);
  await expect.poll(async () => (await cap(host.page)).active).toBe(true);
  await expect.poll(async () => (await state(host.page)).room?.playback.status).toBe('paused');
  await expect.poll(async () => (await state(guest.page)).room?.playback.status).toBe('paused');

  await host.page.getByTestId('play-pause').click();
  await expect(host.page.getByRole('alert').filter({ hasText: /stop sharing audio first/i })).toBeVisible();
  expect((await state(host.page)).room?.playback.status).toBe('paused');

  await host.page.getByRole('button', { name: /stop capture/i }).click();
  await expect.poll(async () => (await cap(host.page)).active).toBe(false);
  const n = (await schedules(guest.page)).length;
  await host.page.getByTestId('play-pause').click();
  await waitForSchedule(guest.page, (s) => s.action === 'play', n);
  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});

// YouTube plays in its own tab (official player) and is shared like any tab: the helper only normalizes the link.
test('YouTube helper: the link opens in its own tab and the share controls are at hand', async ({ browser }) => {
  const host = await newPage(browser);
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await host.page.getByRole('tab', { name: /youtube/i }).click();
  const link = host.page.getByLabel('YouTube link');
  await link.fill('https://youtu.be/dQw4w9WgXcQ?t=5');
  const open = host.page.getByTestId('youtube-open');
  await expect(open).toHaveAttribute('href', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(host.page.getByRole('button', { name: /start capture/i })).toBeVisible();
  await link.fill('not a video');
  await expect(host.page.getByRole('alert').filter({ hasText: /paste a youtube video link/i })).toBeVisible();
  await expect(open).toHaveAttribute('aria-disabled', 'true');
  expect(pageErrors(host.page)).toEqual([]);
  await host.ctx.close();
});

// DRM tabs capture as digital silence: detect it and explain instead of failing quietly.
test('capture mode: a silent (DRM-like) capture is detected and explained', async ({ browser }) => {
  test.setTimeout(60_000);
  const host = await newPage(browser);
  const code = await createRoom(host.page);
  await host.page.goto(`/room/${code}?fakeCapture=silent`);
  await joinRoom(host.page, code, 'Host');
  await startCapture(host.page);
  await expect.poll(async () => (await cap(host.page)).silent, { timeout: 10_000 }).toBe(true);
  await expect(host.page.getByText(/This tab is silent/)).toBeVisible();
  await expect(host.page.getByText(/DRM-protected sites/)).toBeVisible();
  await host.ctx.close();
});
