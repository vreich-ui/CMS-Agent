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
  test('⌘K opens from anywhere; ≤3 keystrokes + Enter reaches three different nodes, including one in a non-active workflow', async ({
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

    // fit_adjudicator — 3 keystrokes, lives in clone_conductor (not active) —
    // the palette must switch workflows to land on it.
    const s2 = await jumpTo(page, 'fad');
    expect(s2.node).toBe('fit_adjudicator');
    expect(s2.wf).toBe('clone_conductor');
    expect(s2.screen).toBe('bench');
    await expect(page.locator('.nhead .id')).toHaveText('fit_adjudicator');
    await expect(page.locator('#wfsel')).toContainText('Clone conductor');

    // capture_score — 3 keystrokes, lives in capture_conductor (not active
    // either, and different from the previous jump's workflow too).
    await openPalette(page);
    await page.keyboard.type('csc');
    await expect(page.locator('#palres button').first()).toHaveText(/capture_score$/);
    await page.screenshot({ path: 'shots/palette.png', fullPage: true }); // the palette itself, mid-search
    await page.keyboard.press('Enter');
    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    const s3 = await readStore(page);
    expect(s3.node).toBe('capture_score');
    expect(s3.wf).toBe('capture_conductor');
    expect(s3.screen).toBe('bench');
    await expect(page.locator('.nhead .id')).toHaveText('capture_score');
    await expect(page.locator('#wfsel')).toContainText('Capture conductor');
  });

  test('rows show the .kind label; arrows move the highlight; Escape and scrim click close without navigating', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    const before = await readStore(page);

    await openPalette(page);
    await page.keyboard.type('cap');
    const rows = page.locator('#palres button');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator('.kind')).toHaveText('node');
    await expect(rows.first()).toHaveText(/capture_map$/);
    await expect(rows.first()).toHaveClass(/hi/);

    // capture_map(0) -> ArrowDown x2 -> capture_score(2) -> ArrowUp x1 -> capture_crawl(1)
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toHaveClass(/hi/);
    await expect(rows.nth(2)).toHaveText(/capture_score$/);
    await page.keyboard.press('ArrowUp');
    await expect(rows.nth(1)).toHaveClass(/hi/);
    await expect(rows.nth(1)).toHaveText(/capture_crawl$/);

    // Escape closes without changing the selected node.
    await page.keyboard.press('Escape');
    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    expect((await readStore(page)).node).toBe(before.node);

    // Scrim click also closes without navigating.
    await openPalette(page);
    await page.keyboard.type('cap');
    await page.mouse.click(4, 4); // outside the centered .palette panel
    await expect(page.locator('.scrim.open .palette')).toHaveCount(0);
    expect((await readStore(page)).node).toBe(before.node);

    // Enter on the highlighted row does navigate.
    await openPalette(page);
    await page.keyboard.type('cap');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await readStore(page)).node).toBe('capture_crawl');
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
  test('opens with "G", renders the 23-node publishing graph with columns per phase, click-to-select closes it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(await readStore(page)).toMatchObject({ wf: 'publishing_conductor' });

    await page.keyboard.press('g');
    const dialog = page.locator('.scrim.open .modal');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Publishing conductor');

    // 9 phase-column headers, 23 node buttons.
    const phaseHeaders = dialog.locator('div', { hasText: /^Intake$/ });
    await expect(phaseHeaders.first()).toBeVisible();
    const nodeButtons = dialog.locator('button[title]');
    await expect(nodeButtons).toHaveCount(23);

    await page.screenshot({ path: 'shots/graph-overlay.png', fullPage: true });

    // Click a node -> selects it and closes the overlay.
    await dialog.locator('button[title="draft_writer"]').click();
    await expect(page.locator('.scrim.open')).toHaveCount(0);
    const after = await readStore(page);
    expect(after.node).toBe('draft_writer');
    expect(after.screen).toBe('bench');
  });

  test('states the honest gap for clone_conductor and capture_conductor instead of a partial/empty graph', async ({ page }) => {
    await page.goto('/');
    await page.locator('#wfsel').click();
    await page.locator('#wfmenu button', { hasText: 'Clone conductor' }).click();

    await page.keyboard.press('g');
    const dialog = page.locator('.scrim.open .modal');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Clone conductor');
    await expect(dialog).toContainText('workspace_get_graph');
    await expect(dialog).toContainText("only returns publishing_conductor's 23-node graph");
    await expect(dialog.locator('button[title]')).toHaveCount(0); // no fabricated nodes
    await page.keyboard.press('Escape');

    await page.locator('#wfsel').click();
    await page.locator('#wfmenu button', { hasText: 'Capture conductor' }).click();
    await page.keyboard.press('g');
    await expect(dialog.locator('h3')).toHaveText('Graph overlay — Capture conductor');
    await expect(dialog).toContainText('workspace_get_graph');
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
