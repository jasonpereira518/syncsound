import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, spread, waitConverged, waitForSchedule } from './helpers';

type Win = {
  __syncsound: {
    getState(): {
      engine: { bufferState: string };
      room: { scene: { objects: Array<{ channel: string }> }; queue: Array<{ title: string; channels?: number }> };
    };
    mix(): { objectGains: Record<string, number> } | null;
  };
};

// Upload a 5.1 WAV: every device downloads + decodes it, the host maps the six channels to objects,
// and playback starts in sync from the uploaded asset.
test('upload a 5.1 file: channel-aware objects + synchronized playback', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const guest = await newPage(browser);
  const code = await createRoom(host.page);
  await joinRoom(host.page, code, 'Host');
  await joinRoom(guest.page, code, 'Guest');
  await waitConverged(host.page);
  await waitConverged(guest.page);

  await host.page.getByRole('tab', { name: /^upload$/i }).click();
  const file = resolve(import.meta.dirname, '../apps/server/data/demo/surround-51-test.wav');
  await host.page.locator('input[type="file"]').first().setInputFiles(file);
  for (const p of [host.page, guest.page]) {
    await expect(p.getByTestId('queue-item').filter({ hasText: /surround/i })).toBeVisible({ timeout: 20_000 });
  }
  await host.page.getByTestId('queue-item').filter({ hasText: /surround/i }).first().click().catch(() => {});
  await host.page.getByTestId('play-pause').click();

  const plays = await Promise.all(
    [host.page, guest.page].map((p) => waitForSchedule(p, (s) => s.action === 'play')),
  );
  expect(spread(plays.map((s) => s.expectedHeardEpochMs))).toBeLessThan(10);
  await expect
    .poll(() => guest.page.evaluate(() => (window as unknown as Win).__syncsound.getState().engine.bufferState))
    .toBe('playing');
  // six channel objects (L R C LFE SL SR) in the shared scene, on every client
  for (const p of [host.page, guest.page]) {
    await expect
      .poll(() =>
        p.evaluate(() =>
          (window as unknown as Win).__syncsound
            .getState()
            .room.scene.objects.map((o) => o.channel)
            .sort()
            .join(','),
        ),
      )
      .toBe('C,L,LFE,R,SL,SR');
  }
  expect(pageErrors(host.page)).toEqual([]);
  expect(pageErrors(guest.page)).toEqual([]);
  await host.ctx.close();
  await guest.ctx.close();
});
