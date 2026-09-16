import { expect, test, type Page } from '@playwright/test';

// W5 acceptance — the two surfaces this system did not have.
//
// The Client Manager's prompt IS the editorial policy of this workspace, and it was the only
// prompt in the system the Workbench could not show, let alone change. And every workflow ends in
// judgement — four editorial reviews and an aggregator, a fidelity score, a fit adjudication — all
// of it reachable only by opening a run, then a node, then a JSON blob.

const openRegistryAgents = async (page: Page) => {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Registry' }).click();
  await page.locator('.regnav button', { hasText: 'Agents' }).click();
};

test.describe('W5 — the Client Manager page', () => {
  test('shows the prompt in full, says whose text it is, and saves an edit', async ({ page }) => {
    await openRegistryAgents(page);

    const prompt = page.locator('#client-manager-prompt-text');
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveValue(/client-management agent/);
    // promptState is the one thing a prompt editor must never leave ambiguous.
    await expect(page.locator('#client-manager-prompt .pin')).toHaveText('diverged');

    // Saving is gated like every other mutating verb, and it bumps the agent's revision — which
    // invalidates every outstanding agent_ref, which is why it is worth confirming.
    await prompt.fill('You are the client-management agent. Edited by the W5 acceptance test.');
    await page.locator('#client-manager-prompt button', { hasText: 'Save prompt' }).click();
    const dialog = page.locator('.modal').filter({ has: page.locator('#confirmdialog-title') });
    await expect(dialog.locator('.sub')).toHaveText('agent_update');
    await dialog.locator('button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Prompt saved');
    await expect(prompt).toHaveValue(/W5 acceptance test/);
  });

  test('says why there are no conversations rather than implying the agent is unused', async ({ page }) => {
    await openRegistryAgents(page);
    // The fixture set captures none — the human-facing transcript lives in Platform's ChatDoc and
    // CMS-Agent keeps only a bounded audit mirror. The empty state has to say so.
    await expect(page.locator('#client-manager-conversations-empty')).toContainText('ChatDoc');
    await expect(page.locator('#client-manager-conversations-empty')).toContainText('bounded audit history');
  });
});

test.describe('W5 — Scores', () => {
  test('renders a run with all five review nodes, and never turns a verdict into a number', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav.main button', { hasText: 'Runs' }).click();
    await page.locator('.subtabs button', { hasText: 'Scores' }).click();

    const table = page.locator('#scores-table');
    await expect(table).toBeVisible();

    // The five publishing reviews, as columns — the whole point: one row per run, one column per
    // judgement, instead of a JSON blob three clicks down.
    for (const nodeId of ['human_texture', 'trust_factual', 'emotional_resonance', 'reader_simulation', 'review_aggregator']) {
      await expect(table.locator('thead th', { hasText: nodeId })).toHaveCount(1);
    }

    // A verdict is shown as itself. Averaging "pass" into a trend line would be inventing a number.
    await expect(table).toContainText('pass');
    await expect(page.locator('#scores-workflow')).toBeVisible();
    await expect(page.locator('.pagewrap')).toContainText('never averaged into the line');

    // A dash is "recorded nothing", never a zero.
    await expect(page.locator('.pagewrap')).toContainText('never a zero');

    // The trend is drawn from the numeric scores only, and it is an image with an honest label.
    await expect(page.locator('svg[role="img"]')).toBeVisible();
  });

  test('scoping to another workflow re-asks rather than filtering what it already had', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav.main button', { hasText: 'Runs' }).click();
    await page.locator('.subtabs button', { hasText: 'Scores' }).click();
    await expect(page.locator('#scores-table, #scores-none')).toBeVisible();

    await page.locator('#scores-workflow').selectOption('capture_conductor');
    // Either a table for capture's own scoring nodes, or the honest "none of these runs recorded a
    // score" — never publishing_conductor's columns under capture_conductor's name.
    await expect(page.locator('#scores-table, #scores-none')).toBeVisible();
    await expect(page.locator('#scores-table thead th', { hasText: 'human_texture' })).toHaveCount(0);
  });
});
