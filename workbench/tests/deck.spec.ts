import { expect, test, type Page } from '@playwright/test';

// U1 — the command deck (home / Workflows screen). Covers the
// AttentionStrip's four states (loading is covered implicitly — every
// other test waits it out via Playwright's auto-retrying locators), the
// one-click jump, the resume chip's round trip, and the workflow cards'
// live per-workflow facts. Fixture ids below (run_1787492010814_kxdbeb /
// publishing_conductor / publish_executor, and the clone_conductor failed
// run run_1787503522535_8lj04d / layout_analyst) are real rows in
// api/fixtures/runs.json — not invented — cross-checked against
// tests/runcontrol.spec.ts and tests/workbench.spec.ts, which already rely
// on the first one rendering correctly.

function cardFor(page: Page, name: string) {
  return page.locator('.cards .wfcard').filter({ has: page.locator('h3', { hasText: name }) });
}

async function bindRunDirectly(page: Page, runId: string, wf: string, node: string) {
  await page.evaluate(
    async ({ runId, wf, node }) => {
      const mod = (await import('/src/store.ts')) as {
        useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } };
      };
      mod.useStore.getState().bindRun(runId, wf, node);
    },
    { runId, wf, node },
  );
}

async function goToWorkflows(page: Page) {
  await page.locator('nav.main button', { hasText: 'Workflows' }).click();
  await expect(page.locator('.pagewrap .pagehead h1')).toHaveText('Workflows');
}

test.describe('attention strip', () => {
  test('lists items ranked most-severe-first, each with its evidence string visible with no click', async ({
    page,
  }) => {
    await page.goto('/');
    await goToWorkflows(page);

    const strip = page.locator('.attn-strip');
    await expect(strip).toHaveClass(/attn-strip--items/, { timeout: 10_000 });

    // Fixture mode's mockStore.getAttention() yields 12 items off the real
    // 55-run fixture set: 1 failed_run (severity "blocker") and 11
    // pending_approval (severity "attention"). Sorted most-severe-first,
    // the single blocker must lead regardless of its position in the raw
    // feed (it's 11th in run order, not 1st).
    const items = strip.locator('.attn-item');
    await expect(items).toHaveCount(12);

    const first = items.nth(0);
    await expect(first.locator('.attn-sev')).toContainText('blocker');
    await expect(first.locator('.attn-kind')).toHaveText('Failed run');
    // Evidence is right there in the row — no expand, no click.
    await expect(first.locator('.attn-evidence')).toHaveText('layout_analyst:model_error');

    const second = items.nth(1);
    await expect(second.locator('.attn-sev')).toContainText('attention');
    await expect(second.locator('.attn-kind')).toHaveText('Pending approval');
    await expect(second.locator('.attn-evidence')).not.toBeEmpty();

    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
    await page.screenshot({ path: 'shots/deck-light.png', fullPage: true });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'shots/deck-dark.png', fullPage: true });
  });

  test('one click on an item jumps straight to its run and node in the workbench — no intermediate screen', async ({
    page,
  }) => {
    await page.goto('/');
    await goToWorkflows(page);

    const strip = page.locator('.attn-strip');
    await expect(strip).toHaveClass(/attn-strip--items/, { timeout: 10_000 });

    // A pending_approval item whose run/node are a known-good fixture combo
    // (also used by tests/runcontrol.spec.ts and tests/workbench.spec.ts).
    const row = strip.locator('.attn-item', { hasText: 'run_1787492010814_kxdbeb' });
    await expect(row).toBeVisible();
    const jump = row.locator('.attn-jump');
    await expect(jump).toHaveText('Jump to publish_executor · run …kxdbeb');

    await jump.click();

    // Landed on the workbench directly (no click through Runs/a modal).
    await expect(page.locator('nav.main button.on', { hasText: 'Workbench' })).toBeVisible();
    await expect(page.locator('#wfsel .fn')).toContainText('Publishing conductor');
    await expect(page.locator('#runchip')).toContainText('814_kxdbeb');
    await expect(page.locator('.nrow.sel .nm')).toHaveText('publish_executor');
  });

  test('a failed attention verb never renders as an all-clear, names the failure, and offers retry', async ({
    page,
  }) => {
    // Pre-armed before the app's first render — see AttentionStrip.tsx's
    // own doc comment on why this is a `window` global rather than the
    // module-level flag tests/auth.spec.ts's __test_setUnauthenticated
    // uses: that pattern reacts to a later call, but the very first
    // fetchAttention() call here must already see the failure.
    await page.addInitScript(() => {
      (window as unknown as { __ATTN_FORCE_FAILURE__?: string | null }).__ATTN_FORCE_FAILURE__ =
        'Anthropic Proxy: Invalid content from server (constellation_get_attention)';
    });
    await page.goto('/');
    await goToWorkflows(page);

    const strip = page.locator('.attn-strip');
    await expect(strip).toHaveClass(/attn-strip--error/, { timeout: 10_000 });
    await expect(strip).toContainText('The attention check could not run');
    await expect(strip).toContainText('Anthropic Proxy: Invalid content from server');
    // The one failure mode this surface must never have.
    await expect(strip).not.toContainText('nothing is waiting on you');
    await expect(strip.locator('.attn-item')).toHaveCount(0);

    const retry = strip.locator('button', { hasText: 'Retry' });
    await expect(retry).toBeVisible();

    // Clear the stub and retry — the strip must actually recover, not get
    // stuck permanently rendering the error shape.
    await page.evaluate(() => {
      (window as unknown as { __ATTN_FORCE_FAILURE__?: string | null }).__ATTN_FORCE_FAILURE__ = null;
    });
    await retry.click();
    await expect(page.locator('.attn-strip--error')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.attn-strip--items')).toHaveCount(1);
  });
});

test.describe('resume where I left off', () => {
  test('hidden with nothing to resume; after binding a run elsewhere, shows what it will restore in words and round-trips on click', async ({
    page,
  }) => {
    await page.goto('/');
    await goToWorkflows(page);
    await expect(page.locator('#resume-chip')).toHaveCount(0);

    // Bind a run the way a Runs-table row click would, from a different
    // screen entirely — resume.ts's subscriber must pick this up without
    // Library (or ResumeChip) ever having been mounted for it.
    await bindRunDirectly(page, 'run_1787492010814_kxdbeb', 'publishing_conductor', 'publish_executor');
    await expect(page.locator('nav.main button.on', { hasText: 'Workbench' })).toBeVisible();

    await goToWorkflows(page);
    const chip = page.locator('#resume-chip');
    await expect(chip).toBeVisible();
    await expect(chip.locator('.k')).toHaveText('resume');
    // Exactly the operator-facing format the spec calls for — words, not a
    // bare "Resume" — read off the .mono span so this isn't hostage to
    // whether JSX happens to insert whitespace between the two spans.
    await expect(chip.locator('.mono')).toHaveText('publishing_conductor · publish_executor · run …kxdbeb');

    await chip.click();
    await expect(page.locator('nav.main button.on', { hasText: 'Workbench' })).toBeVisible();
    await expect(page.locator('#wfsel .fn')).toContainText('Publishing conductor');
    await expect(page.locator('#runchip')).toContainText('814_kxdbeb');
    await expect(page.locator('.nrow.sel .nm')).toHaveText('publish_executor');
  });
});

test.describe('workflow cards — live facts', () => {
  test('node count comes from workspace_get_graph, plus recent-run count and last-run status/when', async ({
    page,
  }) => {
    await page.goto('/');
    await goToWorkflows(page);

    await expect(async () => {
      expect(await page.locator('.cards .wfcard').count()).toBe(4);
    }).toPass({ timeout: 10_000 });

    const pub = cardFor(page, 'Publishing conductor');
    const clone = cardFor(page, 'Clone conductor');
    const capture = cardFor(page, 'Capture conductor');

    // Node counts come from the live workspace_get_graph({workflowId})
    // query (graphQ), not the static catalog length — that's the whole
    // point of this change (the catalog is stale for two of three
    // workflows: it claims 9/11, production's live graph reports 18/16 —
    // see workflowCatalog.ts). The fixture workspace is now a verbatim
    // live capture of all 48 nodes across all three conductors (it used
    // to hold only publishing_conductor's 23 — see api/fixtures/
    // README.md), so all three cards show real per-conductor topology
    // counts, cited from contracts/README.md's live capture:
    // publishing_conductor 24, capture_conductor 16, clone_conductor 18
    // (24+16+18 > 48 because the publish tail — publish_payload,
    // publication_controller, publish_executor, release_executor,
    // learning_recorder — is shared across all three conductors). There
    // is no more "0 nodes" gap and thus no more explanatory tooltip.
    await expect(pub.locator('.stats span').nth(0)).toHaveText('24 nodes');
    await expect(clone.locator('.stats span').nth(0)).toHaveText('18 nodes');
    await expect(capture.locator('.stats span').nth(0)).toHaveText('16 nodes');

    // Recent run count — new stat, total runs fetched for that workflow.
    await expect(pub.locator('.stats span').nth(1)).toHaveText('31 runs');
    await expect(clone.locator('.stats span').nth(1)).toHaveText('6 runs');
    await expect(capture.locator('.stats span').nth(1)).toHaveText('18 runs');

    await expect(pub.locator('.stats span').nth(2)).toHaveText('13 needing attention');
    await expect(clone.locator('.stats span').nth(2)).toHaveText('4 needing attention');
    await expect(capture.locator('.stats span').nth(2)).toHaveText('7 needing attention');

    // Last run status AND when — "when" is new.
    await expect(pub.locator('.stats .chip')).toHaveText('blocked');
    await expect(pub.locator('.stats span').nth(3)).toContainText('25 Aug');
    await expect(clone.locator('.stats .chip')).toHaveText('blocked');
    await expect(clone.locator('.stats span').nth(3)).toContainText('24 Aug');
    await expect(capture.locator('.stats .chip')).toHaveText('completed');
    await expect(capture.locator('.stats span').nth(3)).toContainText('25 Aug');
  });
});
