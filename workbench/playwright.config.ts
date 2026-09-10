import { defineConfig, devices } from '@playwright/test';

// CI keeps a hermetic browser at the pinned Linux path. Local macOS worktrees use the installed
// Chrome application unless an explicit executable override is supplied.
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');

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
