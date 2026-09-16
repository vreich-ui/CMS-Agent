import { expect, test, type Page } from '@playwright/test';

// W2 acceptance — no `isLoading` skeleton in this app is allowed to be a dead end.
// Every one of them now has an `isError` sibling that names what the backend said and
// offers a Retry, and the failure has to become VISIBLE promptly rather than after the
// query policy's retry budget has been spent.

async function goToWorkflows(page: Page) {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workflows' }).click();
  await expect(page.locator('.pagehead h1')).toHaveText('Workflows');
}

/**
 * W3 — the attention strip is a COUNT until it is expanded.
 *
 * The count is free (`workbench.bootstrap` reads it off the run index, opening no run records);
 * the LIST is `constellation_get_attention`, which has to read the runs it cites and was measured
 * at 13-56s. So the expensive verb runs when the operator asks the question, not on every mount of
 * three different screens. Everything these tests assert about the list still holds — it just
 * takes one click to get there.
 */
async function expandAttention(page: Page) {
  await page.locator('.attn-strip button').first().click();
}

test('a rejected attention verb shows its error card + Retry promptly, not after a retry budget', async ({ page }) => {
  // Armed before first render — AttentionStrip's own test seam (see deck.spec.ts).
  await page.addInitScript(() => {
    (window as unknown as { __ATTN_FORCE_FAILURE__?: string | null }).__ATTN_FORCE_FAILURE__ =
      'Cloud Run MCP request failed: timed out after 25s';
  });

  await goToWorkflows(page);
  await expandAttention(page);

  // The whole point of `retry: 0` on this query: the app-wide policy is retry 1 with a
  // 1000ms delay, which on a verb that takes 25s to fail means the operator waits out
  // TWO timeouts before anything appears. With one attempt the rejection reaches the
  // screen immediately — well inside a second of the query settling.
  const strip = page.locator('.attn-strip');
  const startedAt = Date.now();
  await expect(strip).toHaveClass(/attn-strip--error/, { timeout: 10_000 });
  await expect(strip).toContainText('timed out after 25s');
  await expect(strip.locator('button', { hasText: 'Retry' })).toBeVisible();
  // Generous bound — this is asserting "no second attempt + 1s backoff was waited out",
  // not a performance budget on the fixture transport.
  expect(Date.now() - startedAt).toBeLessThan(5_000);

  // Never an all-clear: a failed check is not "nothing needs attention".
  await expect(strip).not.toContainText('nothing is waiting on you');
});

test('the attention query is not refetched on every screen switch', async ({ page }) => {
  await goToWorkflows(page);
  await expect(page.locator('.attn-strip')).toBeVisible();
  await expandAttention(page);

  const read = async () =>
    page.evaluate(() => {
      const qc = (window as unknown as { __queryClient?: { getQueryState: (k: unknown[]) => { dataUpdatedAt: number } | undefined } })
        .__queryClient;
      return qc?.getQueryState(['attention-strip'])?.dataUpdatedAt ?? null;
    });

  // Wait for the query to actually settle — `dataUpdatedAt` is 0 while it is pending,
  // and comparing two zeroes would prove nothing.
  await expect.poll(read, { timeout: 10_000 }).toBeGreaterThan(0);
  const first = await read();

  // Leave and come back: under the old `staleTime: 0` this refired the single most
  // expensive verb on the plane on every mount of Workflows / Workbench / Learning.
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();
  await page.locator('nav.main button', { hasText: 'Workflows' }).click();
  await expect(page.locator('.attn-strip')).toBeVisible();
  await page.waitForTimeout(300);

  expect(await read()).toBe(first);
});

test('a rejected rail verb renders the backend message inline with a Retry that recovers', async ({ page }) => {
  // The general fixture-mode failure seam (mock/handlers.ts) — armed before first render.
  await page.addInitScript(() => {
    (window as unknown as { __MOCK_FAIL_VERBS__?: Record<string, string> }).__MOCK_FAIL_VERBS__ = {
      // W3 — the rail's node set comes from `workbench.bootstrap` now, not from a graph call per
      // surface. The other two stay armed: the assertion is about the rail's error card, and it
      // must not accidentally pass because some other verb happened to fail instead.
      workbench_bootstrap: 'Cloud Run MCP request failed with HTTP 502: ERR_REQUIRE_ESM',
      workspace_get_graph: 'Cloud Run MCP request failed with HTTP 502: ERR_REQUIRE_ESM',
      workspace_get_nodes: 'Cloud Run MCP request failed with HTTP 502: ERR_REQUIRE_ESM',
    };
  });

  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Workbench' }).click();

  const err = page.locator('.qerr[role="alert"]').first();
  await expect(err).toBeVisible({ timeout: 10_000 });
  // The BACKEND's own words, not a paraphrase of them.
  await expect(err.locator('.qerr-msg')).toContainText('HTTP 502');
  await expect(err.locator('.qerr-msg')).toContainText('ERR_REQUIRE_ESM');

  // The skeleton is genuinely gone — not shimmering underneath the error.
  await expect(page.locator('#rail')).toHaveCount(0);

  const retry = err.locator('.qerr-retry');
  await expect(retry).toHaveText('Retry');

  // Clear the stub and retry: the panel must actually recover, not latch into the error
  // shape until a page reload.
  await page.evaluate(() => {
    (window as unknown as { __MOCK_FAIL_VERBS__?: Record<string, string> }).__MOCK_FAIL_VERBS__ = {};
  });
  await retry.click();
  await expect(page.locator('#rail')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.qerr[role="alert"]')).toHaveCount(0);
});
