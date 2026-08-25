import { expect, test, type Page } from '@playwright/test';

// WP-41 — the Registry surface. spec/mockup.html: markup `#s-registry`
// (~line 355), behaviour `renderReg()` (~line 975). Live fixtures disagree
// with the mockup's excerpts in several ways (see api/fixtures/README.md) —
// this spec asserts the real numbers: 42 tools (not 10), monetizer's unset
// endpoint/token, and the 5 skills assigned to zero live nodes.

async function openRegistry(page: Page) {
  await page.goto('/');
  await page.locator('nav.main button', { hasText: 'Registry' }).click();
  await expect(page.locator('.pagewrap .pagehead h1')).toHaveText('Registry');
}

function nav(page: Page, label: string) {
  return page.locator('.regnav button', { hasText: label });
}

test('registry: projects & connections shows monetizer unset, scannable policy bar, live test connection', async ({
  page,
}) => {
  await openRegistry(page);
  await expect(nav(page, 'Projects & connections')).toHaveClass(/on/);

  await expect(async () => {
    expect(await page.locator('#regbody .projcard').count()).toBe(6);
  }).toPass({ timeout: 10_000 });

  const monetizer = page
    .locator('.projcard')
    .filter({ has: page.locator('h3', { hasText: 'Monetizer' }) });
  await expect(monetizer.locator('.badmark').first()).toHaveText('○ endpoint unset');

  const fernwell = page
    .locator('.projcard')
    .filter({ has: page.locator('h3', { hasText: 'Fernwell' }) });
  await expect(fernwell.locator('.chip.cancelled')).toHaveText('disabled');
  // Fernwell being disabled doesn't mean its endpoint reads as unset — those
  // are two different facts and the mockup's own PROJECTS fixture agrees.
  await expect(fernwell.locator('.okmark').first()).toHaveText('● endpoint + token configured');

  // Tool-policy split renders as a bar + legend, not a JSON blob.
  await expect(monetizer.locator('.polbar i')).toHaveCount(3);
  await expect(monetizer.locator('.pollegend')).toContainText('allowed');
  await expect(monetizer.locator('.pollegend')).toContainText('needs approval');
  await expect(monetizer.locator('.pollegend')).toContainText('blocked');

  // "test connection" is a READ verb — it must succeed even though the
  // workbench runs read-only by default (VITE_READ_ONLY unset -> on). If it
  // were wrongly routed through confirmAction it would fail with a
  // read-only error instead of the backend's own connection message.
  await monetizer.locator('button', { hasText: 'test connection' }).click();
  const result = monetizer.locator('.badmark').last();
  await expect(result).toBeVisible({ timeout: 10_000 });
  await expect(result).not.toContainText('read-only');
  await expect(result).toContainText('unreachable');

  const drLurie = page
    .locator('.projcard')
    .filter({ has: page.locator('h3', { hasText: 'Dr. Lurie' }) });
  await drLurie.locator('button', { hasText: 'test connection' }).click();
  const okResult = drLurie.locator('.okmark').last();
  await expect(okResult).toBeVisible({ timeout: 10_000 });
  await expect(okResult).toContainText('healthy');
});

test('registry: keys & auth shows presence/source only — zero input elements', async ({ page }) => {
  await openRegistry(page);
  await nav(page, 'Keys & auth').click();
  await expect(nav(page, 'Keys & auth')).toHaveClass(/on/);

  await expect(async () => {
    expect(await page.locator('#regbody .keyrow').count()).toBeGreaterThan(10);
  }).toPass({ timeout: 10_000 });

  // Security property, not a style choice: no secret input anywhere here.
  await expect(page.locator('#regbody input')).toHaveCount(0);
  await expect(page.locator('#regbody textarea')).toHaveCount(0);

  const tokenRow = page.locator('.keyrow').filter({ hasText: 'MONETIZER_MCP_TOKEN' });
  await expect(tokenRow).toHaveCount(1);
  await expect(tokenRow.locator('.badmark')).toContainText('unset');
  await expect(tokenRow.locator('.badmark')).toContainText('refuse');

  const endpointRow = page.locator('.keyrow').filter({ hasText: 'MONETIZER_MCP_ENDPOINT' });
  await expect(endpointRow.locator('.badmark')).toContainText('unset');

  // A configured project reads as set, source shown (never a value).
  const drLurieToken = page.locator('.keyrow').filter({ hasText: 'DR_LURIE_MCP_TOKEN' });
  await expect(drLurieToken.locator('.okmark')).toContainText('set');
  await expect(drLurieToken.locator('.src')).toHaveText('env');

  // Workspace-level group and the auth broker group are both present and
  // clearly separated from the per-project rows.
  await expect(page.locator('#regbody')).toContainText('Workspace-level');
  await expect(page.locator('#regbody')).toContainText('OPENAI_API_KEY');
  await expect(page.locator('#regbody')).toContainText('Authentication broker');
  await expect(page.locator('#regbody')).toContainText('SESSION_SECRET');
  await expect(page.locator('#regbody')).toContainText('READ_ONLY');
});

test('registry: tool registry lists all 42 live tools, grouped and filterable', async ({ page }) => {
  await openRegistry(page);
  await nav(page, 'Tool registry').click();

  await expect(async () => {
    expect(await page.locator('#regbody .toolrow').count()).toBe(42);
  }).toPass({ timeout: 10_000 });

  await expect(page.locator('#regbody')).toContainText('42 tools');

  // Read/write filter narrows the visible rows (reuses the existing .seg
  // control — no new CSS) without changing the underlying total.
  await page.locator('.seg button', { hasText: 'write' }).click();
  await expect(async () => {
    const count = await page.locator('#regbody .toolrow').count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(42);
  }).toPass({ timeout: 10_000 });
  await expect(page.locator('#regbody .risk.read')).toHaveCount(0);

  await page.locator('.seg button', { hasText: 'all' }).click();
  await expect(page.locator('#regbody .toolrow')).toHaveCount(42);
});

test('registry: skills library flags the 5 skills assigned to zero nodes', async ({ page }) => {
  await openRegistry(page);
  await nav(page, 'Skills library').click();

  await expect(async () => {
    expect(await page.locator('#regbody .toolrow').count()).toBe(12);
  }).toPass({ timeout: 10_000 });

  await expect(page.locator('#regbody')).toContainText('12 registered');
  await expect(page.locator('#regbody')).toContainText('5 unused');

  const unassigned = [
    'article_body_builder',
    'artifact_handling',
    'editorial_review',
    'publication_readiness',
    'learning_observation',
  ];
  for (const id of unassigned) {
    const row = page.locator('.toolrow').filter({ has: page.locator('.tn', { hasText: id }) });
    await expect(row).toContainText('assigned to nobody');
    await expect(row.locator('.chip')).toHaveText('unused');
  }

  // A skill that IS used shows who uses it, no "unused" chip.
  const used = page.locator('.toolrow').filter({ has: page.locator('.tn', { hasText: 'editorial_craft' }) });
  await expect(used).toContainText('brief_architect');
  await expect(used.locator('.chip')).toHaveCount(0);

  // Version editing is Phase 3 — disabled with a title, not a silent toast.
  const versionsBtn = page.locator('.toolrow button', { hasText: 'versions' }).first();
  await expect(versionsBtn).toBeDisabled();
  await expect(versionsBtn).toHaveAttribute('title', 'Phase 3');
});

test('registry: agents and usage sections render live data honestly', async ({ page }) => {
  await openRegistry(page);

  await nav(page, 'Agents').click();
  await expect(page.locator('#regbody')).toContainText('agt_client_manager');
  await expect(page.locator('#regbody')).toContainText("editors’ admin-chat");
  await expect(page.locator('#regbody')).toContainText('diverged from canonical');

  await nav(page, 'Usage & budgets').click();
  // The headline figure is labelled honestly as an all-time total (the
  // fixture's weekTotal carries no rolling window — api/fixtures/
  // README.md) — the .k label itself must not claim "this week", even
  // though the on-page explanation is allowed to name that mislabel.
  await expect(page.locator('#regbody .kv .k').first()).toHaveText('all-time total');
  await expect(page.locator('#regbody')).toContainText('non-workflow usage');
  await expect(page.locator('#regbody')).toContainText('publishing_conductor');
});

test('registry screen renders all six sections and both themes', async ({ page }) => {
  await openRegistry(page);

  const sections = [
    'Projects & connections',
    'Keys & auth',
    'Tool registry',
    'Skills library',
    'Agents',
    'Usage & budgets',
  ];
  for (const label of sections) {
    await nav(page, label).click();
    await expect(nav(page, label)).toHaveClass(/on/);
    await expect(page.locator('#regbody')).not.toBeEmpty();
  }

  await nav(page, 'Projects & connections').click();
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'light');
  await expect(async () => {
    expect(await page.locator('#regbody .projcard').count()).toBe(6);
  }).toPass({ timeout: 10_000 });
  await page.screenshot({ path: 'shots/registry-projects.png', fullPage: true });

  await nav(page, 'Keys & auth').click();
  await page.screenshot({ path: 'shots/registry-keys.png', fullPage: true });

  await nav(page, 'Tool registry').click();
  await expect(page.locator('#regbody .toolrow')).toHaveCount(42);
  await page.screenshot({ path: 'shots/registry-tools.png', fullPage: true });

  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.pagewrap .pagehead h1')).toHaveText('Registry');
  await nav(page, 'Skills library').click();
  await expect(page.locator('#regbody .toolrow')).toHaveCount(12);
  await nav(page, 'Agents').click();
  await expect(page.locator('#regbody')).toContainText('agt_client_manager');
  await nav(page, 'Usage & budgets').click();
  await expect(page.locator('#regbody')).toContainText('all-time total');
});

test('registry left nav is keyboard-navigable with visible focus', async ({ page }) => {
  await openRegistry(page);

  const first = nav(page, 'Projects & connections');
  await first.focus();
  await expect(first).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(nav(page, 'Keys & auth')).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(nav(page, 'Keys & auth')).toHaveClass(/on/);
});
