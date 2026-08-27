import { expect, test, type Page } from '@playwright/test';

// U5 smoke: graph overlay (real layered DAG + honest empty state), rail
// quick-look, the trace waterfall, and ⌘K's recents/verb actions — against
// fixture data (VITE_MOCK default). Mirrors tests/palette.spec.ts and
// tests/workbench.spec.ts's own conventions: real fixture ids, screenshots
// in both themes for the surfaces that are genuinely new visual real
// estate (the graph overlay and the waterfall).

interface StoreSnapshot {
  screen: string;
  wf: string;
  node: string;
  mode: string;
  runId: string | null;
  overlay: { kind: string; params: Record<string, string> } | null;
}

async function readStore(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => StoreSnapshot } };
    const s = mod.useStore.getState();
    return { screen: s.screen, wf: s.wf, node: s.node, mode: s.mode, runId: s.runId, overlay: s.overlay };
  });
}

// run_1787492010814_kxdbeb — publishing_conductor, blocked at publish_executor.
// 22 of 23 nodes have a real measured durationMs; artifact_plan is 'skipped'
// with no duration at all — the one genuinely untimed row this suite pins
// down (contracts/README.md Finding #3's shape, straight from the fixture).
const WATERFALL_RUN = 'run_1787492010814_kxdbeb';

test.describe('graph overlay — real topology', () => {
  test('renders the live node count for all three conductors — no more empty state, the fixture now carries real topology for each', async ({ page }) => {
    // Was: "…and an honest empty state for clone/capture". The fixture
    // workspace is now a verbatim live capture of all 48 nodes across all
    // three conductors (api/fixtures/README.md — it used to hold only
    // publishing_conductor's 23), so workspace_get_graph({workflowId})
    // genuinely returns clone_conductor's and capture_conductor's real
    // topology too. Counts cited from contracts/README.md's live capture:
    // publishing_conductor 24/50e, capture_conductor 16/28e,
    // clone_conductor 18/35e. GraphOverlay's EmptyNotice fallback stays in
    // the component for any workflow the live query genuinely can't
    // resolve — it's just unreachable for these three now.
    await page.goto('/');
    await expect(page.locator('.rail')).toBeVisible();
    await expect(await readStore(page)).toMatchObject({ wf: 'publishing_conductor' });

    await page.keyboard.press('g');
    const dialog = page.locator('.scrim.open .modal');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Publishing conductor');

    // The fixture's workspace_get_graph({workflowId:'publishing_conductor'})
    // carries all 24 live nodes for it — every one drawn as a real,
    // clickable node box.
    const nodeButtons = dialog.locator('button[title]');
    await expect(nodeButtons).toHaveCount(24);
    // Layered by dependency depth, not by phase column: input_triage is the
    // sole root (helpers.layerGraph over its own dependsOn — see nav.spec.ts's
    // sibling computation in the U5 return report), so the overlay reports a
    // layer count greater than 1.
    await expect(dialog).toContainText('24 nodes');

    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
    await page.screenshot({ path: 'shots/nav-graph-light.png', fullPage: true });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'shots/nav-graph-dark.png', fullPage: true });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
    await page.emulateMedia({ colorScheme: 'light' });

    await page.keyboard.press('Escape');
    await expect(page.locator('.scrim.open')).toHaveCount(0);

    // clone_conductor and capture_conductor: both now have real live
    // topology in the fixture too (contracts/README.md: clone_conductor
    // 18 nodes, capture_conductor 16), so the overlay draws each
    // conductor's real graph rather than the old empty-state notice.
    const expectedCounts: Record<string, number> = { 'Clone conductor': 18, 'Capture conductor': 16 };
    for (const [name, count] of Object.entries(expectedCounts)) {
      await page.locator('#wfsel').click();
      await page.locator('#wfmenu button', { hasText: name }).click();
      await page.keyboard.press('g');
      await expect(dialog.locator('h3')).toHaveText(`Graph overlay — ${name}`);
      await expect(dialog).toContainText(`${count} nodes`);
      await expect(dialog.locator('button[title]')).toHaveCount(count);
      await expect(dialog.locator('.card', { hasText: 'no live graph for' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.scrim.open')).toHaveCount(0);
    }
  });

  test('clicking a graph node selects it in the rail and closes the overlay', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.rail')).toBeVisible();

    await page.keyboard.press('g');
    const dialog = page.locator('.scrim.open .modal');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Publishing conductor');

    await dialog.locator('button[title="draft_writer"]').click();
    await expect(page.locator('.scrim.open')).toHaveCount(0);

    const state = await readStore(page);
    expect(state.node).toBe('draft_writer');
    expect(state.screen).toBe('bench');
    await expect(page.locator('.rail .nrow.sel', { hasText: 'draft_writer' })).toBeVisible();
    await expect(page.locator('.nhead .id')).toHaveText('draft_writer');
  });
});

test.describe('node quick-look', () => {
  test('hovering a rail row opens a popover with glanceable facts and commits nothing', async ({ page }) => {
    await page.goto('/');
    const row = page.locator('.rail .nrow', { hasText: 'draft_writer' });
    await expect(row).toBeVisible();
    const before = await readStore(page);

    await row.hover();
    const pop = page.locator('.ovl-pop');
    await expect(pop).toBeVisible({ timeout: 2000 });
    await expect(pop).toContainText('draft_writer');
    await expect(pop.locator('.risk')).toBeVisible();
    await expect(pop).toContainText('tools');
    // A read, not a task: no commit control anywhere in the popover.
    await expect(pop.locator('.btn')).toHaveCount(0);

    // Hovering never changes the rail's own selection or binds anything.
    const after = await readStore(page);
    expect(after).toEqual(before);

    await page.mouse.move(600, 10); // move off the row
    await expect(pop).toHaveCount(0);
  });

  test('promotes to the quicklook modal on a narrow viewport instead of a popover', async ({ page }) => {
    await page.setViewportSize({ width: 620, height: 900 });
    await page.goto('/');
    const row = page.locator('.rail .nrow', { hasText: 'draft_writer' });
    await expect(row).toBeVisible();

    await row.hover();
    const modal = page.locator('.scrim.open .modal', { hasText: 'Node quick look' });
    await expect(modal).toBeVisible({ timeout: 2000 });
    await expect(modal).toContainText('draft_writer');
    await expect(page.locator('.ovl-pop')).toHaveCount(0); // promoted, not doubled up

    await page.keyboard.press('Escape');
    await expect(page.locator('.scrim.open')).toHaveCount(0);
  });
});

test.describe('trace waterfall', () => {
  test('renders measured durations in topological order, and an honest "not timed" row for the one untimed node', async ({ page }) => {
    await page.goto(`/?modal=waterfall&m.run=${WATERFALL_RUN}`);
    const modal = page.locator('.scrim.open .modal', { hasText: 'Trace waterfall' });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(WATERFALL_RUN);

    // input_triage is the graph's sole root — first row, topological order.
    const rows = modal.locator('.wf-row');
    await expect(rows.first()).toContainText('input_triage');

    // 22 of 23 nodes are genuinely timed in this fixture.
    await expect(modal).toContainText('22 of 23');

    // artifact_plan ('skipped', no durationMs) renders as honestly not
    // timed — never a zero-width bar standing in for "instant".
    const untimedRow = modal.locator('.wf-row', { hasText: 'artifact_plan' });
    await expect(untimedRow).toContainText('not timed — skipped');

    // draft_writer has a real 19643ms duration — a measured bar, not text.
    const draftRow = modal.locator('.wf-row', { hasText: 'draft_writer' });
    await expect(draftRow.locator('[title*="draft_writer"]')).toHaveCount(1);
    await expect(draftRow).toContainText('19.6s');

    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
    await page.screenshot({ path: 'shots/nav-waterfall-light.png', fullPage: true });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'shots/nav-waterfall-dark.png', fullPage: true });

    // Clicking a span binds that node into the workbench's "This run" tab
    // and closes the modal.
    await draftRow.click();
    await expect(page.locator('.scrim.open')).toHaveCount(0);
    const state = await readStore(page);
    expect(state.node).toBe('draft_writer');
    expect(state.runId).toBe(WATERFALL_RUN);
    expect(state.mode).toBe('run');
    expect(state.screen).toBe('bench');
    await expect(page.locator('.tabs button.on')).toHaveText('This run');
  });
});

test.describe('⌘K — recents and verb actions', () => {
  test('an empty query shows recents; the waterfall verb action opens the modal for the bound run', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.rail')).toBeVisible();

    await page.evaluate(async (runId) => {
      const mod = (await import('/src/store.ts')) as {
        useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } };
      };
      mod.useStore.getState().bindRun(runId, 'publishing_conductor', 'publish_executor');
    }, WATERFALL_RUN);

    await page.keyboard.press('Control+k');
    await expect(page.locator('.scrim.open .palette')).toBeVisible();
    // Empty query -> a labeled "recent" section, not the old unfiltered dump.
    await expect(page.locator('.palette .res', { hasText: 'recent' })).toBeVisible();
    await expect(page.locator('#palres button').first()).toBeVisible();

    await page.keyboard.type('open trace waterfall');
    const row = page.locator('#palres button', { hasText: /open trace waterfall for/ });
    await expect(row).toBeVisible();
    await expect(row.locator('.kind')).toHaveText('action');
    await page.keyboard.press('Enter');

    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    const modal = page.locator('.scrim.open .modal', { hasText: 'Trace waterfall' });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(WATERFALL_RUN);

    const state = await readStore(page);
    expect(state.overlay).toMatchObject({ kind: 'waterfall', params: { run: WATERFALL_RUN } });
  });
});
