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

  // P2-01 — the app boots in Build mode with no run bound and no node
  // pre-selected (the rail adopts the workflow's first node once the live
  // node list arrives). Assert that first, then bind the run this test is
  // actually about.
  await expect(page.locator('.rail .nrow.sel')).toHaveCount(1);
  await expect(page.locator('nav.main button[data-s="bench"]')).toBeVisible();

  await page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as {
      useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } };
    };
    mod.useStore.getState().bindRun('run_1787492010814_kxdbeb', 'publishing_conductor', 'publish_executor');
  });
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();

  // --- bound state: publishing_conductor, run bound, publish_executor selected ---
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
  // Was 1 (learning_recorder only). The catalog's phase lists were
  // realigned to the live topology (contracts/README.md) — publishing_
  // conductor's Publish phase now also lists release_executor, one of the
  // five shared publish-tail nodes the old, pre-WP-00 23-node catalog was
  // missing — so two nodes now sit downstream of publish_executor:
  // release_executor, then learning_recorder.
  const dimRows = page.locator('.rail .nrow.dim');
  await expect(dimRows).toHaveCount(2); // release_executor, learning_recorder
  await page.locator('.railfoot input[type="checkbox"]').uncheck();
  await expect(dimRows).toHaveCount(0);
  await page.locator('.railfoot input[type="checkbox"]').check();
  await expect(dimRows).toHaveCount(2);

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
  // retry the click until a run is actually bound (the dock's "bound run"
  // panel present). The dock panel doesn't depend on the node registry at
  // all (it's driven by the run's own per-node statuses), so it's the
  // fastest-settling, most honest thing to gate this retry on regardless
  // of whether the node registry has resolved yet.
  await expect(async () => {
    await page.locator('#mode-run').click();
    await expect(page.locator('.dock .card', { hasText: 'bound run' })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 8000 });

  // The rail renders clone_conductor's real nodes, and clicking one
  // updates `node`. Was: workspace_get_node never returned a
  // clone_conductor node live (fixtures/README.md's old, pre-WP-00 gap),
  // so this asserted an honest "not found" card and zero tabs. The
  // fixture workspace is now a verbatim live capture of all 48 nodes
  // (including clone_conductor's 18 — contracts/README.md), so
  // theme_bind resolves to its real record and the center pane renders
  // the normal node view, tabs included, same as draft_writer above.
  await page.locator('.rail .nrow', { hasText: 'theme_bind' }).click();
  await expect(page.locator('.nhead h2')).toHaveText('Theme Bind (deterministic site-token write)');
  await expect(page.locator('.nhead .id')).toHaveText('theme_bind');
  await expect(page.locator('.nhead .risk')).toHaveText('write');
  await expect(page.locator('.tabs button')).toHaveCount(9);
  await expect(page.locator('.center .lbl', { hasText: 'not found' })).toHaveCount(0);

  // --- Build mode: the dock's "▸ Start run…" opens the start-run modal
  // (WP-22 — see tests/runcontrol.spec.ts for the modal's own behaviour) ---
  await page.locator('#mode-build').click();
  await expect(page.locator('#mode-build')).toHaveClass(/on/);
  await expect(page.locator('.dock button', { hasText: '▸ Start run…' })).toBeEnabled();
  await page.screenshot({ path: 'shots/bench-build.png', fullPage: true });

  // Graph overlay (WP-42b) — real now, not a toast stub. Still on
  // clone_conductor here. Was: this workflow had no live node records, so
  // the overlay stated an honest gap rather than rendering a graph. The
  // fixture workspace now carries clone_conductor's real 18-node topology
  // (contracts/README.md), so the overlay renders its real graph instead
  // (see tests/palette.spec.ts / tests/nav.spec.ts for the full
  // graph-overlay coverage across all three workflows).
  await page.locator('.railfoot .ghost').click();
  await expect(page.locator('.scrim.open .modal h3')).toHaveText('Graph overlay — Clone conductor');
  await expect(page.locator('.scrim.open .modal')).toContainText('18 nodes');
  await expect(page.locator('.scrim.open .modal button[title]')).toHaveCount(18);
  await page.keyboard.press('Escape');
  await expect(page.locator('.scrim.open')).toHaveCount(0);

  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
