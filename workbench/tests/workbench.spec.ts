import { expect, test } from '@playwright/test';

// WP-11/WP-12 smoke: node rail, mode bar, center inspector tabs, run dock —
// against the fixture data in src/api/fixtures (VITE_MOCK default). Mirrors
// the pattern in tests/shell.spec.ts / tests/data.spec.ts: one cohesive
// session-shaped test, screenshots at the end of the relevant states.

const TAB_LABELS = [
  'This run',
  'Prompt',
  'Tools',
  'Skills',
  'Schemas',
  'Model & limits',
  'Dependencies',
  'History',
  'Learning',
];

async function cycleAllTabs(page: import('@playwright/test').Page) {
  for (const label of TAB_LABELS) {
    await page.locator('.tabs button', { hasText: label }).click();
    await expect(page.locator('.tabs button.on', { hasText: label })).toBeVisible();
    // Every tab renders at least one .card (or, for This run's "not engaged"
    // state, at least the informational card) — a blank center means a crash.
    await expect(page.locator('.center .card').first()).toBeVisible();
  }
}

test('workbench: rail, tabs, dock render correctly across nodes, themes and modes', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();

  // --- default state: publishing_conductor, run bound, publish_executor selected ---
  await expect(page.locator('.nhead h2')).toHaveText('Publish Executor');
  await expect(page.locator('.nhead .id')).toHaveText('publish_executor');
  await expect(page.locator('.nhead .risk')).toHaveText('publish');
  // "This run" is the default landing tab when a run is bound — and must
  // stay that way once the run finishes loading (not get knocked over to
  // Prompt by the tab-list settling before the run query resolves).
  await expect(page.locator('.tabs button.on')).toHaveText('This run');

  // Rail shows every phase group for publishing_conductor (9 phases).
  await expect(page.locator('.rail .phase')).toHaveCount(9);
  await expect(page.locator('.rail .phase .lbl').first()).toHaveText('Intake');

  // publish_executor's row carries the publish-risk "P" badge and is selected.
  const publishRow = page.locator('.rail .nrow', { hasText: 'publish_executor' });
  await expect(publishRow).toHaveClass(/sel/);
  await expect(publishRow.locator('.risk.publish')).toHaveText('P');

  // Let the This-run tab's several sub-queries (schema, effective prompt,
  // tool-call/output placeholders) settle before screenshotting, so the
  // shots show the loaded state rather than a mid-flight loading flicker.
  await expect(page.getByText('loading execution record…')).toHaveCount(0);
  await expect(page.getByText('loading stage output…')).toHaveCount(0);
  await expect(page.getByText('checking declared schema…')).toHaveCount(0);
  await expect(page.getByText('resolving effective prompt…')).toHaveCount(0);

  // Screenshots — run-bound state, both themes.
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
  await page.screenshot({ path: 'shots/bench-run-light.png', fullPage: true });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'shots/bench-run-dark.png', fullPage: true });
  // Back to light for the rest of the run (deterministic screenshots/assertions below).
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
  await page.emulateMedia({ colorScheme: 'light' });

  // All 9 tabs render without error for publish_executor (blocked, publish risk).
  await expect(page.locator('.tabs button')).toHaveCount(9);
  await cycleAllTabs(page);
  // Blocked status surfaces a gate card on "This run".
  await page.locator('.tabs button', { hasText: 'This run' }).click();
  await expect(page.locator('.center .lbl', { hasText: /^gate$/ })).toHaveCount(1);

  // --- unengaged toggle: dims + hides nodes downstream of the run's stopped node ---
  const dimRows = page.locator('.rail .nrow.dim');
  await expect(dimRows).toHaveCount(1); // learning_recorder, the only node after publish_executor
  await page.locator('.railfoot input[type="checkbox"]').uncheck();
  await expect(dimRows).toHaveCount(0);
  await page.locator('.railfoot input[type="checkbox"]').check();
  await expect(dimRows).toHaveCount(1);

  // --- keyboard: ArrowDown/ArrowUp move the rail selection ---
  await publishRow.click(); // focus a known row first
  const headerIdBefore = (await page.locator('.nhead .id').textContent()) ?? '';
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.nhead .id')).not.toHaveText(headerIdBefore);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.nhead .id')).toHaveText(headerIdBefore);

  // --- draft_writer: real live prompt + model config ---
  await page.locator('.rail .nrow', { hasText: 'draft_writer' }).click();
  await expect(page.locator('.nhead h2')).toHaveText('Full Draft Writer');
  await expect(page.locator('.tabs button')).toHaveCount(9); // run still bound
  await cycleAllTabs(page);

  await page.locator('.tabs button', { hasText: 'Prompt' }).click();
  const promptText = await page.locator('.promptbox').first().textContent();
  expect(promptText ?? '').toContain('Objective:'); // real prompt, not the synthesized fallback

  await page.locator('.tabs button', { hasText: 'Model & limits' }).click();
  await expect(page.locator('.center .kv .num').first()).toHaveText('0.5'); // real budgetUsd from the fixture

  // --- theme_bind: clone_conductor, gate node — switch workflow + mode ---
  await page.locator('#wfsel').click();
  await page.locator('#wfmenu button', { hasText: 'Clone conductor' }).click();

  // No run bound yet — clicking Run auto-binds the workflow's most recent
  // run, but that read depends on a runs query keyed to the new workflow
  // that may not have resolved the instant the workflow switch renders;
  // retry the click until a run is actually bound (This run tab present).
  await expect(async () => {
    await page.locator('#mode-run').click();
    await expect(page.locator('.tabs button', { hasText: 'This run' })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 8000 });

  await page.locator('.rail .nrow', { hasText: 'theme_bind' }).click();
  await expect(page.locator('.nhead h2')).toHaveText('Theme Bind');
  await expect(page.locator('.nhead .id')).toHaveText('theme_bind');
  await expect(page.locator('.nhead .risk')).toHaveText('publish');
  await expect(page.locator('.tabs button')).toHaveCount(9);
  await cycleAllTabs(page);

  // Dependencies tab: the re-seed sentence, verbatim.
  await page.locator('.tabs button', { hasText: 'Dependencies' }).click();
  await expect(page.locator('.center .pin.pinned')).toHaveText('pinned to seed');
  await expect(page.locator('.center')).toContainText('npm run nodes:update');

  // --- Build mode: the dock's "▸ Start run…" opens the start-run modal
  // (WP-22 — see tests/runcontrol.spec.ts for the modal's own behaviour) ---
  await page.locator('#mode-build').click();
  await expect(page.locator('#mode-build')).toHaveClass(/on/);
  await expect(page.locator('.dock button', { hasText: '▸ Start run…' })).toBeEnabled();
  await page.screenshot({ path: 'shots/bench-build.png', fullPage: true });

  // Graph overlay (WP-42b) — real now, not a toast stub. Still on
  // clone_conductor here, so it must state the honest gap rather than
  // render an empty or misleading graph (see tests/palette.spec.ts for the
  // full graph-overlay coverage on publishing_conductor).
  await page.locator('.railfoot .ghost').click();
  await expect(page.locator('.scrim.open .modal h3')).toHaveText('Graph overlay — Clone conductor');
  await expect(page.locator('.scrim.open .modal')).toContainText('workspace_get_graph');
  await page.keyboard.press('Escape');
  await expect(page.locator('.scrim.open')).toHaveCount(0);

  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
