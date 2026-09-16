import { expect, test, type Page } from '@playwright/test';
import contract from '../contracts/first-paint.json' with { type: 'json' };

// W3 acceptance — the load budget, asserted against the same file that records what the budget is
// (workbench/contracts/first-paint.json), so the number is never typed twice.
//
// Measured on 2026-09-16, a cold paint fired FIFTEEN verbs, five of them taking 12-24 s each:
// four whole graphs (three only so the workflow menu could print a node COUNT), a 310 KB flat node
// list and a run page fired by a command palette that was not open, the entire skill catalogue for
// a row of chips, and per-node reads for a tab nobody had chosen. Every one of them was
// individually reasonable. Together they were a page that could not paint.
//
// The seam is `window.__verbCalls` (api/client.ts, DEV-only): in fixture mode the mock plane
// resolves in-process, so there is no network panel to read a call count from.

type VerbCall = { verb: string; at: number; bytes: number };

const readCalls = (page: Page): Promise<VerbCall[]> =>
  page.evaluate(() => (window as unknown as { __verbCalls?: VerbCall[] }).__verbCalls ?? []);

/**
 * The verbs the first paint BLOCKS on: every call started at or before the moment the rail became
 * interactive (`__railInteractiveAt`, stamped by Rail.tsx in DEV). The distinction matters and
 * cannot be made by sampling: the inspector's read of the node the rail just adopted, the score
 * glyphs and the learned badges all start in the same instant the rail becomes usable, and none of
 * them is something an operator waits for. What the budget governs is what they DO wait for.
 */
async function callsBeforeRailInteractive(page: Page): Promise<VerbCall[]> {
  const at = await page.evaluate(() => (window as unknown as { __railInteractiveAt?: number }).__railInteractiveAt ?? null);
  expect(at, 'the rail never reported becoming interactive').not.toBeNull();
  // Strictly before. A call that starts in the SAME millisecond the rail became interactive is a
  // consequence of it, not a precondition for it: `workspace_get_node` is issued by the inspector
  // for the node the rail has just adopted, in the same React commit. Nobody waits for it to use
  // the rail.
  return (await readCalls(page)).filter((call) => call.at < (at as number));
}

const budget = contract.budget;

test('first paint stays inside its verb-call and payload budget', async ({ page }) => {
  await page.goto('/');

  // "Before the rail is interactive" — the rail has rows and one of them is selected.
  await expect(page.locator('.rail .nrow').first()).toBeVisible();
  await expect(page.locator('.rail .nrow.sel')).toHaveCount(1);

  const calls = await callsBeforeRailInteractive(page);
  const verbs = calls.map((call) => call.verb);
  const bytes = calls.reduce((total, call) => total + call.bytes, 0);

  expect(verbs.length, `first paint fired ${verbs.length} verbs: ${verbs.join(', ')}`).toBeLessThanOrEqual(budget.maxVerbCalls);
  expect(bytes, `first paint transferred ${bytes} bytes`).toBeLessThanOrEqual(budget.maxTransferredBytes);

  // And they are the two the contract names, not two others that happen to total two.
  expect(new Set(verbs)).toEqual(new Set(contract.after.calls.map((call) => call.verb)));
});

test('none of the verbs the contract moved off first paint are fired before the rail is interactive', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.rail .nrow.sel')).toHaveCount(1);

  const fired = new Set((await callsBeforeRailInteractive(page)).map((call) => call.verb));
  for (const moved of contract.after.movedOffFirstPaint) {
    expect(fired.has(moved.verb), `${moved.verb} should have moved to: ${moved.to}`).toBe(false);
  }
});

test('the palette index costs nothing until the palette is opened', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.rail .nrow.sel')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect((await readCalls(page)).map((c) => c.verb)).not.toContain('workspace_get_nodes');

  await page.keyboard.press('Control+k');
  await expect(page.locator('#palinput')).toBeFocused();
  await expect.poll(async () => (await readCalls(page)).map((c) => c.verb)).toContain('workspace_get_nodes');
});

test('a second visit paints from the persisted cache, with no verb call at all', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __PERSIST_IN_FIXTURES__?: boolean }).__PERSIST_IN_FIXTURES__ = true;
  });

  // Visit one: fill the cache and let it be written (the persister throttles at 2 s).
  await page.goto('/');
  await expect(page.locator('.rail .nrow.sel')).toHaveCount(1);
  await page.waitForTimeout(2600);

  // Visit two: the rail must be interactive before anything could possibly have been fetched.
  await page.goto('/');
  const startedAt = Date.now();
  await expect(page.locator('.rail .nrow').first()).toBeVisible();
  const paintedInMs = Date.now() - startedAt;

  const calls = await readCalls(page);
  expect(calls.length, `second visit fired ${calls.map((c) => c.verb).join(', ')} before painting`).toBe(0);
  expect(paintedInMs).toBeLessThan(300);
});

test('every workflow the server registers is reachable, including ones this build has no config for', async ({ page }) => {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workflows' }).click();

  const registered: string[] = await page.evaluate(async () => {
    const verbs = (await import('/src/api/verbs.ts')) as { workbenchBootstrap: (a?: object) => Promise<{ registeredWorkflowIds: string[] }> };
    return (await verbs.workbenchBootstrap()).registeredWorkflowIds;
  });
  expect(registered.length).toBeGreaterThan(3);

  // Every registered id has a card...
  const cardTitles = await page.locator('.cards .wfcard h3').allTextContents();
  for (const id of registered) {
    const expected = id.replace(/_/g, ' ');
    const matched = cardTitles.some((title) => title.toLowerCase().replace(/[^a-z]+/g, ' ').includes(expected.split('_')[0]) || title.toLowerCase().includes(expected));
    expect(matched, `no card for registered workflow ${id} (cards: ${cardTitles.join(', ')})`).toBe(true);
  }

  // ...and the switcher lists them too.
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();
  await page.locator('#wfsel').click();
  await expect(page.locator('#wfmenu button')).toHaveCount(cardTitles.length);
});
