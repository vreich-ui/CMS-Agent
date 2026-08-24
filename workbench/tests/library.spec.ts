import { expect, test } from '@playwright/test';

// WP-15 — Workflows library screen. Fixtures carry 39 real runs (not the
// mockup's 15) and clone_conductor has 9 live nodes (not the mockup's 8,
// because of fit_adjudicator) — see api/fixtures/README.md. This spec
// asserts the real numbers, not the mockup's hand-drawn ones.

function cardFor(page: import('@playwright/test').Page, name: string) {
  return page.locator('.cards .wfcard').filter({ has: page.locator('h3', { hasText: name }) });
}

test('library screen renders workflow cards from live data, both themes', async ({ page }) => {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workflows' }).click();

  await expect(page.locator('.pagewrap .pagehead h1')).toHaveText('Workflows');
  await expect(page.locator('.pagewrap .pagehead .sub')).toHaveText(
    'function-based conductors — clients bind at run start, not here',
  );

  // Mock verbs carry an artificial delay, so poll rather than one-shot count.
  await expect(async () => {
    expect(await page.locator('.cards .wfcard').count()).toBe(4);
  }).toPass({ timeout: 10_000 });

  // 3 real workflow cards + the planned card.
  await expect(page.locator('.cards .wfcard:not(.planned)')).toHaveCount(3);
  const planned = page.locator('.cards .wfcard.planned');
  await expect(planned).toHaveCount(1);
  await expect(planned.locator('h3')).toHaveText('Foundation-charity conductor');
  await expect(planned.locator('.lbl')).toHaveText('foundation & charity publishing specialist');
  await expect(planned.locator('.stats span')).toHaveText('— nodes');
  // Planned card renders no "Open workbench" / "Start run" foot — it isn't a real workflow.
  await expect(planned.locator('.foot')).toHaveCount(0);

  const pub = cardFor(page, 'Publishing conductor');
  const clone = cardFor(page, 'Clone conductor');
  const capture = cardFor(page, 'Capture conductor');

  // Node counts come from live workflow data (workflows.json phases), never
  // the mockup's prose — clone_conductor is 9 (fit_adjudicator), not 8.
  await expect(pub.locator('.stats span').nth(0)).toHaveText('23 nodes');
  await expect(clone.locator('.stats span').nth(0)).toHaveText('9 nodes');
  await expect(capture.locator('.stats span').nth(0)).toHaveText('11 nodes');

  // "needing attention" / "last" reflect the real 39-run fixture set.
  await expect(pub.locator('.stats span').nth(1)).toHaveText('9 needing attention');
  await expect(clone.locator('.stats span').nth(1)).toHaveText('4 needing attention');
  await expect(capture.locator('.stats span').nth(1)).toHaveText('5 needing attention');

  await expect(pub.locator('.stats .chip')).toHaveText('blocked');
  await expect(clone.locator('.stats .chip')).toHaveText('blocked');
  await expect(capture.locator('.stats .chip')).toHaveText('completed');

  // "Start run" is wired by WP-22: it opens the start-run modal preselected
  // to that card's workflow (see tests/runcontrol.spec.ts for the modal's
  // own validate/launch behaviour — this just checks the launch point).
  await clone.locator('button', { hasText: 'Start run' }).click();
  await expect(page.locator('#startmodal-title')).toBeVisible();
  await expect(page.locator('#sm-wf')).toHaveValue('clone_conductor');
  await page.keyboard.press('Escape');
  await expect(page.locator('#startmodal-title')).toHaveCount(0);

  // "Open workbench" navigates to the bench with that workflow selected.
  await clone.locator('button', { hasText: 'Open workbench' }).click();
  await expect(page.locator('nav.main button.on', { hasText: 'Workbench' })).toBeVisible();
  await expect(page.locator('#wfsel .fn')).toContainText('Clone conductor');

  // Back to the library for the theme screenshots.
  await page.locator('nav.main button', { hasText: 'Workflows' }).click();
  await expect(page.locator('.cards .wfcard')).toHaveCount(4);

  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
  await page.screenshot({ path: 'shots/library-light.png', fullPage: true });

  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'shots/library-dark.png', fullPage: true });
});
