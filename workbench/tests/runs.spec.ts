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

/**
 * W1 — the History and Grid tabs fetch ONE windowed page (20 rows) and leave the rest of the
 * fleet behind an explicit "load more". Every count assertion below is written against the WHOLE
 * fixture set, so this drains the pages first: that keeps those assertions meaning what they
 * always meant, and makes "load more actually reaches every run" a precondition of the suite
 * rather than one isolated test.
 *
 * Review fix — filters now go to the SERVER, so the window is of MATCHING rows and has to be
 * drained again after every filter change. The Live tab is exempt: it asks its own status-scoped
 * question and is never windowed, which is why the header shows no "showing X of Y" there.
 */
/** Wait out an in-flight refetch — while one is running the screen shows the PREVIOUS page's
 *  rows (dimmed, `#runbody[aria-busy]`), so counts read here would be the old filter's. */
async function settled(page: Page) {
  await expect(page.locator('#runbody')).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
}

async function exhaustPages(page: Page) {
  const sub = page.locator('.pagehead .sub');
  await settled(page);
  // The header only claims "showing X of Y" once a page has actually landed — waiting on that is
  // what keeps this from racing past a still-loading screen and silently leaving the suite
  // testing 20 rows instead of the fleet.
  await expect(sub).toContainText(/showing \d+ of \d+/, { timeout: 15_000 });
  for (let guard = 0; guard < 20; guard++) {
    const text = (await sub.textContent()) ?? '';
    const shown = Number(/showing (\d+) of (\d+)/.exec(text)?.[1] ?? 0);
    const total = Number(/showing (\d+) of (\d+)/.exec(text)?.[2] ?? 0);
    if (shown >= total) return;
    await page.locator('#runs-loadmore').click();
    await expect
      .poll(async () => Number(/showing (\d+)/.exec((await sub.textContent()) ?? '')?.[1] ?? 0), { timeout: 10_000 })
      .toBeGreaterThan(shown);
    await settled(page);
  }
  throw new Error('runs "load more" never exhausted — paging is not terminating');
}

async function gotoRuns(page: Page) {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Runs' }).click();
  await expect(page.locator('.pagehead h1')).toHaveText('Runs');
}

/**
 * Switch to a windowed tab and, on History, drain its pages.
 *
 * The Grid is not drained: it renders only its newest GRID_CAP columns, so later pages add
 * nothing it can show — which is why the "load more" control is History-only. Its query is
 * scoped to one workflow server-side, so its first page is already the right 20 runs.
 */
async function gotoPagedTab(page: Page, label: 'History' | 'Grid') {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: label }).click();
  if (label === 'History') await exhaustPages(page);
  else await settled(page);
}

test('Runs: Live tab renders cards from fixtures, blocked runs name their cause', async ({ page }) => {
  await gotoRuns(page);

  const runs = await loadRuns(page);
  const liveExpected = runs.filter((r) => r.status === 'running' || r.status === 'paused' || r.status === 'blocked');
  expect(liveExpected.length).toBeGreaterThan(0); // the fixtures do carry live (blocked) runs today

  // Review fix — the Live tab asks its own status-scoped question instead of filtering the
  // screen's newest-20 window. Note there is NO exhaustPages() above: every live run has to be
  // here on first paint, including the ones the window would never have reached.
  //
  // Pin that this test still covers the case it was written for: a run that is blocked on an
  // operator stops advancing while newer runs keep being created, so it falls out of a
  // startedAt-ordered window — and an empty Live tab claims "the pipeline is caught up".
  const newestTwenty = new Set(
    [...runs].sort((a, b) => Number(/^run_(\d+)_/.exec(b.id)?.[1] ?? 0) - Number(/^run_(\d+)_/.exec(a.id)?.[1] ?? 0))
      .slice(0, 20)
      .map((r) => r.id),
  );
  expect(liveExpected.some((r) => !newestTwenty.has(r.id))).toBe(true);

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
  await gotoPagedTab(page, 'History');

  const runs = await loadRuns(page);
  const rows = page.locator('table.runs tbody tr');
  await expect(rows).toHaveCount(runs.length, { timeout: 10_000 });
  await expect(page.locator('.note')).toContainText(`${runs.length} runs · ${runs.length} shown`);

  // Stack workflow -> project -> status filters; each step must not
  // increase the row count, and the full stack must be a proper subset.
  const byWf = runs.filter((r) => r.wf === 'clone_conductor');
  await page.locator('.filters select').nth(0).selectOption('clone_conductor');
  await exhaustPages(page);
  await expect(rows).toHaveCount(byWf.length, { timeout: 10_000 });
  expect(byWf.length).toBeLessThan(runs.length);

  const someProj = byWf[0].proj;
  const byWfProj = byWf.filter((r) => r.proj === someProj);
  await page.locator('.filters select').nth(1).selectOption(someProj);
  await exhaustPages(page);
  await expect(rows).toHaveCount(byWfProj.length, { timeout: 10_000 });

  const someStatus = byWfProj[0].status;
  const byWfProjStatus = byWfProj.filter((r) => r.status === someStatus);
  await page.locator('.filters select').nth(2).selectOption(someStatus);
  await exhaustPages(page);
  await expect(rows).toHaveCount(byWfProjStatus.length, { timeout: 10_000 });
  expect(byWfProjStatus.length).toBeLessThanOrEqual(byWfProj.length);

  await page.screenshot({ path: 'shots/runs-history.png', fullPage: true });

  // Reset filters so the first row is deterministic (fixture order, newest first).
  await page.locator('.filters select').nth(0).selectOption('');
  await page.locator('.filters select').nth(1).selectOption('');
  await page.locator('.filters select').nth(2).selectOption('');
  await exhaustPages(page);
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
  await gotoPagedTab(page, 'Grid');

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
  await gotoPagedTab(page, 'Grid');
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

// W1 — the INVERSE of the W1.2 guard this replaces. Back then an unscoped
// `workflow_list_runs` meant a full-fleet blob fetch server-side, so the client fanned
// out one scoped call per project and the mock threw on an unscoped one. The server has
// since outgrown that: BlobExecutionRepository.listRunsPage takes the full-fleet path
// only when BOTH `limit` and `projectId` are absent, and otherwise windows over the run
// index. So the expensive shape is now the UNWINDOWED call, and that is what the mock
// refuses — while an unscoped WINDOWED call is exactly what this client should make.
test('Runs: an unscoped runs query is ONE windowed call, and paging still reaches every run', async ({
  page,
}) => {
  await page.goto('/');
  // W3 — let the app's own first paint settle before the counter below is installed. The counter
  // patches `mockStore.getRuns`, which is shared: `workbench.bootstrap` reads runs through it too,
  // so a still-in-flight bootstrap would be counted against `workflowListRunsPage` and the
  // assertion would be measuring the wrong thing. The bootstrap fires once per load (5-minute
  // staleTime) and is long finished by here.
  await expect(page.locator('.topbar')).toBeVisible();
  await page.waitForTimeout(1200);

  const result = await page.evaluate(async () => {
    const verbs = await import('/src/api/verbs.ts');
    const client = await import('/src/api/client.ts');

    // A regression to an UNWINDOWED call is the expensive one now — the mock's own guard.
    let threwOnUnwindowed = false;
    try {
      // @ts-expect-error — deliberately calling the internal verb without a limit.
      await client.callVerb('workflow_list_runs', {});
    } catch {
      threwOnUnwindowed = true;
    }

    // Count the list calls workflowListRunsPage() makes: exactly one, scoped or not.
    // Counted at the fixture store rather than at callVerb — an ES module's exported
    // binding is read-only, and mockStore's own method is the next thing down the
    // stack that only `workflow_list_runs` reaches.
    const { mockStore } = (await import('/src/api/mockStore.ts')) as {
      mockStore: { getRuns: (filter?: unknown) => unknown[] };
    };
    const realGetRuns = mockStore.getRuns.bind(mockStore);
    let calls = 0;
    mockStore.getRuns = (filter?: unknown) => {
      calls += 1;
      return realGetRuns(filter);
    };

    let first;
    try {
      first = await verbs.workflowListRunsPage();
    } finally {
      mockStore.getRuns = realGetRuns;
    }

    // Walk the cursor to the end — every fixture run must still be reachable.
    const seen = new Set(first.runs.map((r) => r.id));
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor && pages < 20) {
      const next = await verbs.workflowListRunsPage({ cursor });
      for (const run of next.runs) seen.add(run.id);
      cursor = next.nextCursor;
      pages += 1;
    }

    const fixtureRuns = ((await import('/src/api/fixtures/runs.json')) as { default: { runs: unknown[] } }).default.runs;

    return {
      threwOnUnwindowed,
      callsForFirstPage: calls,
      firstPageSize: first.runs.length,
      matchedCount: first.matchedCount,
      pages,
      reachedCount: seen.size,
      fixtureRunsCount: fixtureRuns.length,
      distinctProjectsInResult: new Set(first.runs.map((r) => r.proj)).size,
    };
  });

  expect(result.threwOnUnwindowed).toBe(true);
  // ONE call — not one per configured project.
  expect(result.callsForFirstPage).toBe(1);
  expect(result.firstPageSize).toBe(20);
  // The first page already knows the true fleet size, which is what the header reports.
  expect(result.matchedCount).toBe(result.fixtureRunsCount);
  expect(result.pages).toBeGreaterThan(1);
  // Nothing is dropped by windowing: the cursor walk reaches every run.
  expect(result.reachedCount).toBe(result.fixtureRunsCount);
  // An unscoped page is genuinely cross-project, not one project's runs.
  expect(result.distinctProjectsInResult).toBeGreaterThan(1);
});

test('Runs: the first paint is one windowed page, with the rest of the fleet behind "load more"', async ({
  page,
}) => {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: 'History' }).click();

  const rows = page.locator('table.runs tbody tr');
  await expect(rows).toHaveCount(20, { timeout: 10_000 });

  const total = (await loadRuns(page)).length;
  // The header never lies about the fleet size just because it only fetched a window —
  // this is the defect where Workflows said "48 runs" and Runs said "0".
  await expect(page.locator('.pagehead .sub')).toContainText(`showing 20 of ${total}`);

  const more = page.locator('#runs-loadmore');
  await expect(more).toBeVisible();
  await more.click();
  await expect(rows).toHaveCount(40, { timeout: 10_000 });
});

// Review round 2 — the Grid tab is ALWAYS scoped to one workflow (its select has no "all"
// option), so that scope belongs in the QUERY. Filtering an unscoped newest-20 window down to
// publishing_conductor meant a fleet whose newest runs belonged to other conductors rendered
// "No runs yet for Publishing Conductor" — the same false all-clear as the Live tab's "the
// pipeline is caught up", one tab over. Note there is no exhaustPages() here.
test('Runs: the Grid is scoped by its own workflow select, and its footer counts that workflow, not the window', async ({
  page,
}) => {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: 'Grid' }).click();

  const runs = await loadRuns(page);
  const pubRuns = runs.filter((r) => r.wf === 'publishing_conductor');
  expect(pubRuns.length).toBeGreaterThan(20); // otherwise this proves nothing

  await expect(page.locator('.grid table tbody tr').first()).toBeVisible({ timeout: 10_000 });
  // The footer names the workflow's whole fleet, from page.matchedCount — not the rows loaded.
  await expect(page.locator('.note')).toContainText(`of ${pubRuns.length} runs`);
});

test('Runs: changing a filter never unmounts the filter controls', async ({ page }) => {
  await gotoRuns(page);
  await page.locator('.subtabs button', { hasText: 'History' }).click();
  const selects = page.locator('.filters select');
  await expect(selects).toHaveCount(3);

  // A filter change mints a new query key. Treating that as "loading" replaced the whole tab
  // body — which CONTAINS these selects — for the length of the round trip, so the operator
  // could not stack a second filter or correct a mis-click until it came back.
  const all = await loadRuns(page);
  const cloneRuns = all.filter((r) => r.wf === 'clone_conductor');
  expect(cloneRuns.length).toBeGreaterThan(0);
  // Pick a status the fixture actually has for this workflow, rather than assuming one — an
  // empty result would prove nothing about the controls surviving the round trip.
  const status = cloneRuns[0].status;

  await selects.nth(0).selectOption('clone_conductor');
  await expect(selects).toHaveCount(3);
  await expect(selects.nth(0)).toHaveValue('clone_conductor');
  await selects.nth(2).selectOption(status);
  await expect(selects).toHaveCount(3);

  await exhaustPages(page);
  const rows = page.locator('table.runs tbody tr');
  const expected = cloneRuns.filter((r) => r.status === status);
  await expect(rows).toHaveCount(expected.length, { timeout: 10_000 });
});
