import { defineConfig, devices } from '@playwright/test';

const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  webServer: {
    command: 'npm run dev',
    // Pinned off the Vite default (5173) — see vite.config.ts's own note:
    // sibling worktrees run their own dev servers, and a port collision
    // with `reuseExistingServer: true` means this suite would silently test
    // whatever already happens to be listening, not this worktree's build.
    port: 5183,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:5183',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          executablePath: CHROMIUM_PATH,
        },
      },
    },
  ],
});
