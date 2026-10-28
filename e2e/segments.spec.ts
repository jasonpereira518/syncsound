import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, pageErrors, waitConverged, waitForSchedule } from './helpers';

type Win = {
  __syncsound: {
    getState(): {
      engine: {
        bufferState: string;
        syncErrorMs: number;
        load: { playheadSec: number; ready: number; count: number; bufferedThroughSec: number } | null;
      };
      room: { queue: Array<{ title: string; durationSec?: number; segments?: { count: number } }> };
    };
  };
};

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// A track longer than the server's 10 minute threshold is split into FLAC segments; each device then plays it from a
// sliding window of decoded segments instead of one whole buffer. Seek to just before a seam and play across it.
test.skip(!haveFfmpeg, 'needs ffmpeg to make an 11 minute test file');
test('a long upload is segmented and plays across a segment seam in sync', async ({ browser }) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), 'syncsound-e2e-long-'));
  const file = join(dir, 'long mix.wav');
  // 11 minutes of mono 8 kHz chirp: ~10 MB, over the 10 minute segmenting threshold but light to move around
  const made = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.3*sin(2*PI*(300+0.5*t)*t):d=660:s=8000',
    file,
  ]);
  expect(made.status).toBe(0);

  try {
    const host = await newPage(browser);
    const guest = await newPage(browser);
    const code = await createRoom(host.page);
    await joinRoom(host.page, code, 'Host');
    await joinRoom(guest.page, code, 'Guest');
    await waitConverged(host.page);
    await waitConverged(guest.page);

    await host.page.getByRole('tab', { name: /^music file$/i }).click();
    await host.page.locator('input[type="file"]').first().setInputFiles(file);
    for (const p of [host.page, guest.page]) {
      await expect(p.getByTestId('queue-item').filter({ hasText: /long mix/i })).toBeVisible({
        timeout: 60_000,
      });
    }
    // the server probed + split it: the room knows its length and the segment plan
    const q = await host.page.evaluate(() => (window as unknown as Win).__syncsound.getState().room.queue[0]);
    expect(q?.durationSec).toBeCloseTo(660, 0);
    expect(q?.segments?.count).toBe(6);
    // and the player shows the real length, not 0:00
    await expect(host.page.getByTestId('seek-bar')).toHaveAttribute('max', /^66\d(\.\d+)?$/);

    await host.page.getByTestId('play-pause').click();
    await Promise.all([host.page, guest.page].map((p) => waitForSchedule(p, (s) => s.action === 'play')));
    for (const p of [host.page, guest.page])
      await expect
        .poll(() => p.evaluate(() => (window as unknown as Win).__syncsound.getState().engine.bufferState), {
          timeout: 30_000,
        })
        .toBe('playing');

    // 2.5 s before the first seam (120 s), then let it run through
    const seek = host.page.getByTestId('seek-bar');
    await seek.fill('117.5');
    await seek.blur();
    await Promise.all(
      [host.page, guest.page].map((p) =>
        waitForSchedule(p, (s) => s.action === 'seek' || s.action === 'reschedule'),
      ),
    );
    for (const p of [host.page, guest.page]) {
      await expect
        .poll(
          () =>
            p.evaluate(() => (window as unknown as Win).__syncsound.getState().engine.load?.playheadSec ?? 0),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(123);
      const e = await p.evaluate(() => (window as unknown as Win).__syncsound.getState().engine);
      expect(e.bufferState).toBe('playing'); // still sounding on the far side of the seam
      expect(e.load!.ready).toBeGreaterThanOrEqual(1);
      expect(e.syncErrorMs).toBeLessThan(20);
    }
    expect(pageErrors(host.page)).toEqual([]);
    expect(pageErrors(guest.page)).toEqual([]);
    await host.ctx.close();
    await guest.ctx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
