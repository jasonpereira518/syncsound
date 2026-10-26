import { defineConfig, devices } from '@playwright/test';

// Ports are overridable so two checkouts (worktrees) can run the suite at the same time:
// E2E_SERVER_PORT=8931 E2E_WEB_PORT=3131 pnpm e2e
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 8899);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    actionTimeout: 15_000,
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @syncsound/server start',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      env: { PORT: String(SERVER_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @syncsound/web build && pnpm --filter @syncsound/web exec next start -H 127.0.0.1 -p ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { NEXT_PUBLIC_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
