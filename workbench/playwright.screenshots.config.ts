// Screenshot capture only — kept out of playwright.config.ts's testDir so `npx playwright test`
// (what CI runs) never takes screenshots as part of the acceptance suite.
import baseConfig from './playwright.config';
import { defineConfig } from '@playwright/test';

export default defineConfig({ ...baseConfig, testDir: './screenshots', fullyParallel: false });
