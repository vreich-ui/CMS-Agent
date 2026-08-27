import { expect, test } from '@playwright/test';

// WP-15 — Workflows library screen. Fixtures carry 55 real runs (not the
// mockup's 15 — workbench-verb-fixes recaptured the full live run history,
// minus independent_node/trial rows) — see api/fixtures/README.md. This
// spec asserts the real numbers, not the mockup's hand-drawn ones.
//
// U1(c) — node counts are now driven by the live workspace_get_graph query
// (WorkflowCard in screens/Library/index.tsx), not the static catalog's
// phase list, which workflowCatalog.ts's own doc comment admits is stale
// for two of three conductors (clone_conductor: catalog 9 vs. live 18;
// capture_conductor: catalog 11 vs. live 16 — see contracts/README.md).
// The fixture workspace is now a verbatim live capture of all 48 nodes
// across all three conductors (api/fixtures/README.md — it used to hold
// only publishing_conductor's 23), so the live graph query returns each
// conductor's real topology: publishing_conductor 24, capture_conductor
// 16, clone_conductor 18 (contracts/README.md). There is no more "0
// nodes" gap for clone/capture. See tests/deck.spec.ts for the fuller U1
// coverage (AttentionStrip, resume chip, the jump); this spec keeps the
// rest of the card's existing behaviour under test.

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

  // Node counts: live query, not catalog prose — all three conductors now
  // carry real live node records (see this file's header comment).
  await expect(pub.locator('.stats span').nth(0)).toHaveText('24 nodes');
  await expect(clone.locator('.stats span').nth(0)).toHaveText('18 nodes');
  await expect(capture.locator('.stats span').nth(0)).toHaveText('16 nodes');

  // U1(c) — recent run count, new stat.
  await expect(pub.locator('.stats span').nth(1)).toHaveText('31 runs');
  await expect(clone.locator('.stats span').nth(1)).toHaveText('6 runs');
  await expect(capture.locator('.stats span').nth(1)).toHaveText('18 runs');

  // "needing attention" / "last" reflect the real 55-run fixture set.
  await expect(pub.locator('.stats span').nth(2)).toHaveText('13 needing attention');
  await expect(clone.locator('.stats span').nth(2)).toHaveText('4 needing attention');
  await expect(capture.locator('.stats span').nth(2)).toHaveText('7 needing attention');

  await expect(pub.locator('.stats .chip')).toHaveText('blocked');
  await expect(clone.locator('.stats .chip')).toHaveText('blocked');
  await expect(capture.locator('.stats .chip')).toHaveText('completed');

  // U1(c) — last run's "when", new alongside the existing status chip.
  await expect(pub.locator('.stats span').nth(3)).toContainText('25 Aug');
  await expect(clone.locator('.stats span').nth(3)).toContainText('24 Aug');
  await expect(capture.locator('.stats span').nth(3)).toContainText('25 Aug');

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
