import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, newPage, openSource, pageErrors, waitConverged, waitForSchedule } from './helpers';

// Video mode 2 (local file): audio decoded + scheduled like music; the muted <video> follows the room clock.
// The test video (canvas + tone, webm) is generated in-browser with MediaRecorder — no binary fixtures.
test('local video: muted picture tracks the room timeline', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await newPage(browser);
  const code = await createRoom(page);
  await joinRoom(page, code, 'Host');
  await waitConverged(page);

  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const g = canvas.getContext('2d')!;
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator();
    osc.connect(dest);
    osc.start();
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const t0 = performance.now();
    const draw = () => {
      g.fillStyle = `hsl(${(performance.now() - t0) / 10}, 80%, 50%)`;
      g.fillRect(0, 0, 160, 90);
      if (rec.state === 'recording') requestAnimationFrame(draw);
    };
    rec.start(250);
    draw();
    await new Promise((r) => setTimeout(r, 8000));
    await new Promise<void>((r) => {
      rec.onstop = () => r();
      rec.stop();
    });
    await ac.close();
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });

  await openSource(page, /video file/i);
  await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
    name: 'test-video.webm',
    mimeType: 'video/webm',
    buffer: Buffer.from(b64, 'base64'),
  });
  await expect(page.getByTestId('queue-item').filter({ hasText: /test-video/i })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('play-pause').click();
  await waitForSchedule(page, (s) => s.action === 'play');
  await page.waitForTimeout(3000);

  const diffs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const d = await page.evaluate(() => {
      type St = { room: { playback: { startRoomTime: number; trackOffset: number } } };
      const ss = (window as unknown as { __syncsound: { getState(): St; clock(): { offsetMs: number } | null } }).__syncsound;
      const pb = ss.getState().room.playback;
      const v = document.querySelector('video')!;
      const room = performance.now() + (ss.clock()?.offsetMs ?? 0);
      return { video: v.currentTime, expected: pb.trackOffset + (room - pb.startRoomTime) / 1000, paused: v.paused };
    });
    expect(d.paused).toBe(false);
    diffs.push(Math.abs(d.video - d.expected));
    await page.waitForTimeout(400);
  }
  console.log('local video: |video − room position| (ms) =', diffs.map((x) => (x * 1000).toFixed(0)).join(', '));
  // videoSync seeks beyond 120 ms and nudges playbackRate to within 20 ms; allow frame/report granularity
  expect(Math.max(...diffs)).toBeLessThan(0.12);
  expect(pageErrors(page)).toEqual([]);
  await ctx.close();
});
