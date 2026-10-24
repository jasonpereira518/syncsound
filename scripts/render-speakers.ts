/**
 * Speaker renders for the landing page: `pnpm render:speakers` renders scripts/render-speakers.html (three.js) in
 * headless Chromium and writes transparent/opaque WebPs into apps/web/public/landing/ plus the woofer position of
 * each shot into apps/web/src/components/landing/renders.json. Deterministic (seeded textures); needs `cwebp`.
 * Visitors only download the stills; three.js stays a dev dependency.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'apps/web/public/landing');
const META = join(root, 'apps/web/src/components/landing/renders.json');
const SHOTS = [
  'front-cabinet',
  'front-cone',
  'three-quarter-cabinet',
  'three-quarter-cone',
  'macro-cone',
  'macro-tweeter',
  'macro-corner',
  'room',
];
const ORIGIN = 'http://render.local';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
const only = process.argv.slice(2);

mkdirSync(OUT, { recursive: true });
const tmp = join(tmpdir(), `syncsound-render-${process.pid}`);
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let meta: Record<string, unknown> = {};
try {
  meta = JSON.parse(readFileSync(META, 'utf8'));
} catch {
  // first run
}
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e));
  // serve the scene and three.js from disk under a fake origin so the import map resolves
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = path.startsWith('/three/') ? join(root, 'node_modules', path) : join(root, 'scripts', path);
    const ext = file.slice(file.lastIndexOf('.'));
    await route.fulfill({ body: readFileSync(file), contentType: TYPES[ext] ?? 'application/octet-stream' });
  });
  for (const shot of only.length ? only : SHOTS) {
    await page.goto(`${ORIGIN}/render-speakers.html?shot=${shot}`);
    const info = await page.waitForFunction(() => (window as unknown as { __done?: object }).__done, null, {
      timeout: 120_000,
    });
    meta[shot] = await info.jsonValue();
    const dataUrl = await page.evaluate(() => document.querySelector('canvas')!.toDataURL('image/png'));
    const png = join(tmp, `${shot}.png`);
    writeFileSync(png, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    execFileSync('cwebp', [
      '-quiet',
      '-q',
      '82',
      '-alpha_q',
      '90',
      '-m',
      '6',
      png,
      '-o',
      join(OUT, `${shot}.webp`),
    ]);
    console.log(`rendered ${shot}`);
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
