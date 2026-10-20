import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default function globalSetup() {
  const manifest = resolve(import.meta.dirname, '../apps/server/data/demo/manifest.json');
  if (!existsSync(manifest)) execSync('pnpm demo', { stdio: 'inherit', cwd: resolve(import.meta.dirname, '..') });
}
