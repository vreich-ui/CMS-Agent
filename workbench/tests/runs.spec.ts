import { expect, test, type Page } from '@playwright/test';

// Runs surface (WP-13 Live/History + WP-14 Grid). Ground truth for every
// count/identity assertion below is read straight from the fixtures inside
// the page, rather than hardcoded — so the test stays correct if the
// fixture data changes, and genuinely exercises the screen's own filtering
// / grid logic rather than a copy of it.
//
// workbench-verb-fixes: fixtures/runs.json is now a RAW live capture
// (`{runs:[...], page:{...}}`, live field names) rather than a pre-adapted
// flat array — loadRuns() below runs it through the real api/adapters.ts
// toRun(), the same function verbs.ts calls for both transports, so this
// stays "ground truth read the way the app itself reads it" rather than a
// second, parallel reshaping.

interface FixtureRun {
  id: string;
  wf: string;
  proj: string;
  status: string;
  cur: string | null;
  started: string;
  dur: string;
  cost: number;
  err: number;
  done: number;
  stall?: boolean;
}

async function loadRuns(page: Page): Promise<FixtureRun[]> {
  return page.evaluate(async () => {
    const raw = (await import('/src/api/fixtures/runs.json')) as { default: { runs: unknown[] } };
    const { toRun } = await import('/src/api/adapters.ts');
    return raw.default.runs.map((r) => toRun(r as Parameters<typeof toRun>[0]));
  });
}

interface StoreSnapshot {
  screen: string;
  mode: string;
  runId: string | null;
  wf: string;
  node: string;
}

async function readStore(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as {
      useStore: { getState: () => StoreSnapshot };
    };
    const s = mod.useStore.getState();
    return { screen: s.screen, mode: s.mode, runId: s.runId, wf: s.wf, node: s.node };
  });
}

async function gotoRuns(page: Page) {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Runs' }).click();
  await expect(page.locator('.pagehead h1')).toHaveText('Runs');
}

test('Runs: Live tab renders cards from fixtures, blocked runs name their cause', async ({ page }) => {
  await gotoRuns(page);

  const runs = await loadRuns(page);
  const liveExpected = runs.filter((r) => r.status === 'running' || r.status === 'paused' || r.status === 'blocked');
  expect(liveExpected.length).toBeGreaterThan(0); // the fixtures do carry live (blocked) runs today

  const cards = page.locator('.livecards .livecard');
  await expect(cards).toHaveCount(liveExpected.length, { timeout: 10_000 });

  // Every card carries a status chip and a primary action.
  await expect(cards.first().locator('.chip .dot')).toBeVisible();
  await expect(cards.first().getByRole('button', { name: /Open in workbench/ })).toBeVisible();

  // Blocked is never a dead end: at least one card explains why it stopped
  // — and, per node, precisely: a real operator-decision gate names what
  // it's awaiting rather than a one-size-fits-all "publish decision".
  await expect(page.locator('.livecard', { hasText: 'awaiting your publish decision' }).first()).toBeVisible();
  await expect(page.locator('.livecard', { hasText: 'awaiting your theme-apply confirmation' }).first()).toBeVisible();

  await page.screenshot({ path: 'shots/runs-live.png', fullPage: true });
});

test('Runs: History filters compose and a row binds the run + stopped node', async ({ page }) => {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: 'History' }).click();

  const runs = await loadRuns(page);
  const rows = page.locator('table.runs tbody tr');
  await expect(rows).toHaveCount(runs.length, { timeout: 10_000 });
  await expect(page.locator('.note')).toContainText(`${runs.length} runs · ${runs.length} shown`);

  // Stack workflow -> project -> status filters; each step must not
  // increase the row count, and the full stack must be a proper subset.
  const byWf = runs.filter((r) => r.wf === 'clone_conductor');
  await page.locator('.filters select').nth(0).selectOption('clone_conductor');
  await expect(rows).toHaveCount(byWf.length, { timeout: 10_000 });
  expect(byWf.length).toBeLessThan(runs.length);

  const someProj = byWf[0].proj;
  const byWfProj = byWf.filter((r) => r.proj === someProj);
  await page.locator('.filters select').nth(1).selectOption(someProj);
  await expect(rows).toHaveCount(byWfProj.length, { timeout: 10_000 });

  const someStatus = byWfProj[0].status;
  const byWfProjStatus = byWfProj.filter((r) => r.status === someStatus);
  await page.locator('.filters select').nth(2).selectOption(someStatus);
  await expect(rows).toHaveCount(byWfProjStatus.length, { timeout: 10_000 });
  expect(byWfProjStatus.length).toBeLessThanOrEqual(byWfProj.length);

  await page.screenshot({ path: 'shots/runs-history.png', fullPage: true });

  // Reset filters so the first row is deterministic (fixture order, newest first).
  await page.locator('.filters select').nth(0).selectOption('');
  await page.locator('.filters select').nth(1).selectOption('');
  await page.locator('.filters select').nth(2).selectOption('');
  await expect(rows).toHaveCount(runs.length, { timeout: 10_000 });

  // workbench-verb-fixes: runs[0] (the real newest run) happens to be a
  // completed capture_conductor run today, so `cur` is null there — pick
  // the first row (in the same fixture/table order) that actually has a
  // stopped node to bind, rather than assuming index 0 always does.
  const rowIdx = runs.findIndex((r) => r.cur !== null);
  expect(rowIdx).toBeGreaterThanOrEqual(0);
  const firstRun = runs[rowIdx];
  const expectedNode = firstRun.cur ?? '';
  expect(expectedNode).not.toBe('');

  const firstRow = rows.nth(rowIdx);
  await expect(firstRow.locator('td').first()).toContainText(firstRun.id.slice(-10));
  await firstRow.click();

  await expect(page.locator('nav.main button.on', { hasText: 'Workbench' })).toBeVisible();
  const state = await readStore(page);
  expect(state.screen).toBe('bench');
  expect(state.mode).toBe('run');
  expect(state.runId).toBe(firstRun.id);
  expect(state.wf).toBe(firstRun.wf);
  expect(state.node).toBe(expectedNode);
});

test('Runs: Grid renders the publishing_conductor matrix and a cell binds', async ({ page }) => {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: 'Grid' }).click();

  const runs = await loadRuns(page);
  const workflows = await page.evaluate(async () => {
    const mod = (await import('/src/api/workflowCatalog.ts')) as {
      WORKFLOW_CATALOG: Record<string, { phases: Array<[string, string[]]> }>;
    };
    return mod.WORKFLOW_CATALOG;
  });
  const pubOrder = workflows.publishing_conductor.phases.flatMap(([, ids]) => ids);
  const pubRuns = runs.filter((r) => r.wf === 'publishing_conductor');
  const cap = Math.min(9, pubRuns.length);

  // Grid defaults to publishing_conductor even before the operator touches the select.
  await expect(page.locator('.filters select')).toHaveValue('publishing_conductor');

  const headerCells = page.locator('.grid table thead th');
  await expect(headerCells).toHaveCount(cap + 1, { timeout: 10_000 }); // +1 blank corner cell
  await expect(page.locator('.grid table tbody tr')).toHaveCount(pubOrder.length);
  await expect(page.locator('.note')).toContainText(`Showing ${cap} of ${pubRuns.length} runs`);

  // Cap disclosure is honest, not silent: only meaningful to assert when
  // the fixtures actually exceed the cap (they do — 18 publishing_conductor
  // runs today).
  if (pubRuns.length > cap) {
    expect(cap).toBeLessThan(pubRuns.length);
  }

  // The newest run is the rightmost column; find its row (its own `cur`
  // node) and click that cell — it must bind exactly that run + node,
  // regardless of which node row the button happened to render in.
  const newest = [...pubRuns].sort((a, b) => Number(b.id.split('_')[1]) - Number(a.id.split('_')[1]))[0];
  expect(newest.cur).not.toBeNull();
  const targetRow = page.locator('.grid table tbody tr').filter({
    has: page.locator('th', { hasText: newest.cur as string }),
  });
  const targetCell = targetRow.locator('td button.cell').last();
  await expect(targetCell).toHaveAttribute('aria-label', new RegExp(newest.cur as string));
  await targetCell.click();

  await expect(page.locator('nav.main button.on', { hasText: 'Workbench' })).toBeVisible();
  const state = await readStore(page);
  expect(state.screen).toBe('bench');
  expect(state.runId).toBe(newest.id);
  expect(state.node).toBe(newest.cur);
});

test('Runs: Grid screenshots in both themes', async ({ page }) => {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: 'Grid' }).click();
  await expect(page.locator('.grid table tbody tr').first()).toBeVisible();

  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
  await page.screenshot({ path: 'shots/runs-grid-light.png', fullPage: true });

  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'shots/runs-grid-dark.png', fullPage: true });

  // The page body itself must never scroll sideways — only .grid may.
  const bodyOverflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(bodyOverflowsX).toBe(false);
});
