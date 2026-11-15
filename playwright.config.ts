import { defineConfig, devices } from '@playwright/test';
import { chromiumLaunchOptions } from './scripts/browser-options.ts';

export default defineConfig({
  testDir: './tests/browser',
  // Keep screenshot iteration history when Playwright clears its own outputs.
  outputDir: 'test-results/browser',
  // Software rendering in hosted CI makes the full interaction sequence slower.
  // Keep individual actions bounded while allowing the complete flow to finish.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: chromiumLaunchOptions(),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
