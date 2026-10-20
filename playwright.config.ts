import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
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
      url: 'http://127.0.0.1:8899/health',
      env: { PORT: '8899' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @syncsound/web build && pnpm --filter @syncsound/web exec next start -H 127.0.0.1 -p 3100',
      url: 'http://127.0.0.1:3100',
      env: { NEXT_PUBLIC_SERVER_URL: 'http://127.0.0.1:8899' },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
