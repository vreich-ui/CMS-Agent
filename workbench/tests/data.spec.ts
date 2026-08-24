import { expect, test } from '@playwright/test';

// DataDemo (WP-03) isn't wired into App.tsx's screen switch — see the comment
// at the top of src/screens/DataDemo.tsx for why. So this smoke loads the
// shell (to warm the dev server / module graph) then mounts DataDemo
// standalone into a fresh container via its exported `mountDataDemo`,
// dynamically imported straight from Vite's dev server — no changes to
// App.tsx, main.tsx, or index.html required.

test('data demo lists workflows and runs from fixtures', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(async () => {
    const mod = (await import('/src/screens/DataDemo.tsx')) as { mountDataDemo: (el: HTMLElement) => void };
    const el = document.createElement('div');
    el.id = 'data-demo-root';
    document.body.appendChild(el);
    mod.mountDataDemo(el);
  });

  const root = page.locator('#data-demo-root');
  await expect(root.locator('.pagewrap .pagehead h1')).toHaveText('Data layer demo');

  // Workflow cards: one .card per workflow, each naming its node count.
  const workflowCards = root.locator('.card').filter({ has: page.locator('.chip', { hasText: 'nodes' }) });
  await expect(workflowCards).toHaveCount(3, { timeout: 10_000 });
  await expect(workflowCards.first().locator('.chip')).toContainText('nodes');

  // Runs table: fixtures carry 39 runs, well over the required 15. Poll
  // rather than a one-shot count — the first visible row may still be the
  // "Loading runs…" placeholder if the mock's artificial delay hasn't
  // resolved yet.
  const runRows = root.locator('table.runs tbody tr');
  await expect(async () => {
    expect(await runRows.count()).toBeGreaterThanOrEqual(15);
  }).toPass({ timeout: 10_000 });

  // Status chips render with the shared .chip/.dot vocabulary.
  await expect(root.locator('table.runs .chip .dot').first()).toBeVisible();

  await page.screenshot({ path: 'shots/data-demo.png', fullPage: true });
});
