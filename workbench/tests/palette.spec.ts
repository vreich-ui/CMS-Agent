import { expect, test, type Page } from '@playwright/test';

// WP-42/WP-42b smoke: the command palette and the graph overlay — against
// fixture data (VITE_MOCK default). Mirrors tests/runcontrol.spec.ts's
// pattern for reading store state directly (dynamic import of /src/store.ts)
// where a DOM assertion alone wouldn't pin down *which* workflow/node ended
// up selected.

interface StoreSnapshot {
  screen: string;
  wf: string;
  node: string;
  mode: string;
  paletteOpen: boolean;
  graphOverlayOpen: boolean;
}

async function readStore(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => StoreSnapshot } };
    const s = mod.useStore.getState();
    return {
      screen: s.screen,
      wf: s.wf,
      node: s.node,
      mode: s.mode,
      paletteOpen: s.paletteOpen,
      graphOverlayOpen: s.graphOverlayOpen,
    };
  });
}

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  await expect(page.locator('.scrim.open .palette')).toBeVisible();
  await expect(page.locator('#palinput')).toBeFocused();
}

/** Types `query`, presses Enter, and returns the resulting store snapshot — the palette's stated done-criterion in one call. */
async function jumpTo(page: Page, query: string): Promise<StoreSnapshot> {
  await openPalette(page);
  await page.keyboard.type(query);
  // The index (workflows/nodes) the palette searches is itself query-backed
  // data, not static — on a cold first load it can still be resolving when
  // the query finishes typing. Wait for a real, highlighted result row
  // before Enter, so Enter always has something at hi=0 to select instead
  // of racing an empty/not-yet-rendered list.
  await expect(page.locator('#palres button[aria-selected="true"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
  return readStore(page);
}

test.describe('command palette', () => {
  test('⌘K opens from anywhere; ≤3 keystrokes + Enter reaches two nodes, and a workflow jump switches workflow honestly', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.rail')).toBeVisible(); // app shell up (default screen is the Workbench)

    // Default state: publishing_conductor is active.
    const before = await readStore(page);
    expect(before.wf).toBe('publishing_conductor');

    // draft_writer — 3 keystrokes, already in the active workflow.
    const s1 = await jumpTo(page, 'dwr');
    expect(s1.node).toBe('draft_writer');
    expect(s1.wf).toBe('publishing_conductor');
    expect(s1.screen).toBe('bench');
    await expect(page.locator('.nhead .id')).toHaveText('draft_writer');

    // objection_mapping — 3 keystrokes, another node in the same workflow.
    // The fixture workspace is now a verbatim live capture of all 48 nodes
    // (api/fixtures/README.md — it used to hold only publishing_conductor's
    // 23), so the node index the palette searches (useNodes(undefined),
    // "every node across every workflow") has all 48 rows now, not 23 —
    // but 'obj' still lands uniquely on objection_mapping (no other node id
    // contains o,b,j in order), so this stays a clean same-workflow jump.
    const s2 = await jumpTo(page, 'obj');
    expect(s2.node).toBe('objection_mapping');
    expect(s2.wf).toBe('publishing_conductor');
    expect(s2.screen).toBe('bench');
    await expect(page.locator('.nhead .id')).toHaveText('objection_mapping');

    // 'clo' — 3 keystrokes, a node in a DIFFERENT (non-active) workflow.
    // Was: clone/capture nodes were invisible to workspace_get_nodes, so a
    // 3-keystroke cross-workflow node jump was impossible and this query
    // could only reach the "Clone conductor" workflow entry (landing on a
    // node with no live record). Now clone_intake is a real node, and as a
    // node-kind entry it outranks the workflow-kind entry at equal match
    // tier (KIND_BONUS: node 10 > workflow 6) — 'clo' is a startsWith match
    // for both clone_intake and clone_report (score 900-12=888+10=898,
    // tied), clone_intake winning the tie alphabetically. This is exactly
    // the honest, better-restored behaviour: ≤3 keystrokes now really does
    // reach any node, in any workflow.
    const s3 = await jumpTo(page, 'clo');
    expect(s3.node).toBe('clone_intake');
    expect(s3.wf).toBe('clone_conductor');
    expect(s3.screen).toBe('bench');
    await expect(page.locator('#wfsel')).toContainText('Clone conductor');
    await expect(page.locator('.nhead .id')).toHaveText('clone_intake');
    await expect(page.locator('.center .card .lbl', { hasText: 'not found' })).toHaveCount(0); // real node, no "not found" card
    await page.screenshot({ path: 'shots/palette.png', fullPage: true }); // the palette itself, mid-search

    // A pure workflow-kind jump still works too — typing the workflow's
    // full name is an exact match (score 1000+6), well clear of any node
    // that merely starts with the same three letters.
    await openPalette(page);
    await page.keyboard.type('Capture conductor');
    await expect(page.locator('#palres button').first()).toHaveText(/Capture conductor$/);
    await page.keyboard.press('Enter');
    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    const s4 = await readStore(page);
    expect(s4.wf).toBe('capture_conductor');
    expect(s4.node).toBe('capture_crawl'); // catalog's first phase node for capture_conductor
    expect(s4.screen).toBe('bench');
    await expect(page.locator('#wfsel')).toContainText('Capture conductor');
    await expect(page.locator('.nhead .id')).toHaveText('capture_crawl');
    await expect(page.locator('.center .card .lbl', { hasText: 'not found' })).toHaveCount(0); // real node, no "not found" card
  });

  test('rows show the .kind label; arrows move the highlight; Escape and scrim click close without navigating', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    const before = await readStore(page);

    // 'pub' is a startsWith match for three publish_* nodes (a node's own
    // KIND_BONUS outranks the "Publishing conductor" workflow entry, which
    // is also a startsWith match, at equal match tier), shortest-label-first:
    // publish_payload(15) < publish_executor(16) < publication_controller(22).
    // The fixture's 48-node set (contracts/README.md) does add a fourth
    // 'pub'-containing node, pdf_template_publish — but that's only a
    // word-boundary match (its third underscore-separated word, "publish",
    // starts with "pub"; the id itself doesn't), which scores well below
    // any startsWith match, so it never displaces these three.
    await openPalette(page);
    await page.keyboard.type('pub');
    const rows = page.locator('#palres button');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator('.kind')).toHaveText('node');
    await expect(rows.first()).toHaveText(/publish_payload$/);
    await expect(rows.first()).toHaveClass(/hi/);

    // publish_payload(0) -> ArrowDown x2 -> publication_controller(2) -> ArrowUp x1 -> publish_executor(1)
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toHaveClass(/hi/);
    await expect(rows.nth(2)).toHaveText(/publication_controller$/);
    await page.keyboard.press('ArrowUp');
    await expect(rows.nth(1)).toHaveClass(/hi/);
    await expect(rows.nth(1)).toHaveText(/publish_executor$/);

    // Escape closes without changing the selected node.
    await page.keyboard.press('Escape');
    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    expect((await readStore(page)).node).toBe(before.node);

    // Scrim click also closes without navigating.
    await openPalette(page);
    await page.keyboard.type('pub');
    await page.mouse.click(4, 4); // outside the centered .palette panel
    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    expect((await readStore(page)).node).toBe(before.node);

    // Enter on the highlighted row does navigate.
    await openPalette(page);
    await page.keyboard.type('pub');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await readStore(page)).node).toBe('publish_executor');
  });

  test('does not open while typing in a real field', async ({ page }) => {
    await page.goto('/');
    await page.locator('#mode-build').click();
    await page.locator('.dock button', { hasText: '▸ Start run…' }).click();
    const brief = page.locator('#sm-brief');
    await expect(brief).toBeVisible();
    await brief.click();
    await expect(brief).toBeFocused();

    await page.keyboard.press('Control+k');
    await expect(page.locator('#palinput')).toHaveCount(0);
    await expect(page.locator('.modal', { hasText: 'Start run' })).toBeVisible();

    await page.keyboard.press('Escape'); // close the start-run modal, cleanup
    await expect(page.locator('.scrim.open')).toHaveCount(0);
  });

  test('the palette index covers screens and sub-tabs, actions, and projects — not just nodes', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();

    await openPalette(page);
    await page.keyboard.type('registry → keys');
    const screenRow = page.locator('#palres button').first();
    await expect(screenRow.locator('.kind')).toHaveText('screen');
    await expect(screenRow).toContainText('Registry → Keys & auth');
    await page.keyboard.press('Enter');
    expect((await readStore(page)).screen).toBe('registry');
    const reg = await page.evaluate(async () => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { reg: string } } };
      return mod.useStore.getState().reg;
    });
    expect(reg).toBe('keys');

    await openPalette(page);
    await page.keyboard.type('toggle theme');
    const actionRow = page.locator('#palres button').first();
    await expect(actionRow.locator('.kind')).toHaveText('action');
    await expect(actionRow).toContainText('Toggle theme');
    await page.keyboard.press('Escape'); // don't actually flip it — just confirm it's indexed
  });
});

test.describe('graph overlay', () => {
  // U5 — the graph overlay was rebuilt from a catalog-phase-column layout
  // (with a hardcoded "publishing_conductor only" gap notice) into a real,
  // data-driven layered DAG over workspace_get_graph's own dependsOn edges,
  // for whichever workflow is active. See tests/nav.spec.ts for the full
  // U5 coverage (live node counts across all three workflows, click-to-
  // select, the honest empty state); this describe block keeps the
  // ⌘K-adjacent "G" opens/closes-correctly smoke that was already here.
  test('opens with "G", renders the 24-node publishing graph, click-to-select closes it', async ({ page }) => {
    // Was 23 nodes. The fixture workspace is now a verbatim live capture of
    // all 48 nodes (api/fixtures/README.md — it used to hold only
    // publishing_conductor's 23), and the catalog's phase lists were
    // realigned to the live topology, so publishing_conductor's real graph
    // is 24 nodes / 50 edges (contracts/README.md).
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(await readStore(page)).toMatchObject({ wf: 'publishing_conductor' });

    await page.keyboard.press('g');
    const dialog = page.locator('.scrim.open .modal');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Publishing conductor');

    const nodeButtons = dialog.locator('button[title]');
    await expect(nodeButtons).toHaveCount(24);

    await page.screenshot({ path: 'shots/graph-overlay.png', fullPage: true });

    // Click a node -> selects it and closes the overlay.
    await dialog.locator('button[title="draft_writer"]').click();
    await expect(page.locator('.scrim.open')).toHaveCount(0);
    const after = await readStore(page);
    expect(after.node).toBe('draft_writer');
    expect(after.screen).toBe('bench');
  });

  test('renders clone_conductor\'s and capture_conductor\'s real graphs — no more fabricated-graph empty state', async ({ page }) => {
    // Was: "states the honest empty state for clone_conductor and
    // capture_conductor instead of a fabricated graph". That empty state
    // existed only because the old fixture's nodes.json held just
    // publishing_conductor's 23 records. The fixture workspace is now a
    // verbatim live capture of all 48 nodes across all three conductors
    // (api/fixtures/README.md), so workspace_get_graph({workflowId})
    // genuinely returns clone_conductor's 18 nodes / 35 edges and
    // capture_conductor's 16 nodes / 28 edges (contracts/README.md) — real
    // graphs, not an empty state. See tests/nav.spec.ts for the fuller U5
    // coverage of this same fact.
    await page.goto('/');
    await page.locator('#wfsel').click();
    await page.locator('#wfmenu button', { hasText: 'Clone conductor' }).click();

    await page.keyboard.press('g');
    const dialog = page.locator('.scrim.open .modal');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Clone conductor');
    await expect(dialog).toContainText('18 nodes');
    await expect(dialog.locator('button[title]')).toHaveCount(18);
    await expect(dialog.locator('.card', { hasText: 'no live graph for' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.locator('#wfsel').click();
    await page.locator('#wfmenu button', { hasText: 'Capture conductor' }).click();
    await page.keyboard.press('g');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Capture conductor');
    await expect(dialog).toContainText('16 nodes');
    await expect(dialog.locator('button[title]')).toHaveCount(16);
    await expect(dialog.locator('.card', { hasText: 'no live graph for' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('does not open while typing in a real field', async ({ page }) => {
    await page.goto('/');
    await page.locator('#mode-build').click();
    await page.locator('.dock button', { hasText: '▸ Start run…' }).click();
    const brief = page.locator('#sm-brief');
    await brief.click();
    await page.keyboard.press('g');
    await expect(page.locator('.scrim.open .modal', { hasText: 'Graph overlay' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
