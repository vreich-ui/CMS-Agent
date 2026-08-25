import { expect, test } from '@playwright/test';

const NAV_ITEMS = ['Workflows', 'Workbench', 'Runs', 'Learning', 'Registry'];

test('shell renders nav, workflow switcher, and both themes', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.wordmark')).toContainText('Conductor');

  for (const label of NAV_ITEMS) {
    await expect(page.locator('nav.main button', { hasText: label })).toBeVisible();
  }

  for (const label of NAV_ITEMS) {
    await page.locator('nav.main button', { hasText: label }).click();
    await expect(page.locator('nav.main button.on', { hasText: label })).toBeVisible();
  }

  await page.locator('#wfsel').click();
  await expect(page.locator('#wfmenu')).toHaveClass(/open/);
  await expect(page.locator('#wfmenu button')).toHaveCount(4);
  await page.keyboard.press('Escape');

  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
  await page.screenshot({ path: 'shots/shell-light.png', fullPage: true });

  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'shots/shell-dark.png', fullPage: true });
});
