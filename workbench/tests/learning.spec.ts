import { expect, test, type Page } from '@playwright/test';

// WP-51/52/53/54 smoke — the Learning screen's seven tabs, the flywheel's
// live counts against real fixture data, the curate→playbook loop, Compare's
// keyboard-only verdict speed + blind-mode reveal, and the
// contract_intelligence held-gate story. Fixture mode (VITE_MOCK default,
// VITE_READ_ONLY=0 in .env.development so the mutating verbs this surface
// leans on actually run) — same pattern as tests/runcontrol.spec.ts.

const confirmDialog = (page: Page) =>
  page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });

async function expectConfirmVerb(page: Page, verb: string) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.sub')).toHaveText(verb);
  return dialog;
}

async function gotoLearning(page: Page) {
  await page.goto('/');
  await page.locator('nav.main button[data-s="learning"]').click();
  await expect(page.locator('.pagehead h1')).toHaveText('Learning');
}

async function openSubtab(page: Page, t: 'fly' | 'obs' | 'pb' | 'cmp' | 'eval' | 'opt' | 'ds') {
  await page.locator(`#lrntabs button[data-t="${t}"]`).click();
}

test.describe('Learning', () => {
  test('all seven tabs render in both themes; flywheel counts match fixture data', async ({ page }) => {
    await gotoLearning(page);

    // Flywheel — real fixture counts (11 observations, 5 rubrics; see
    // api/fixtures/README.md), Curate starts at 0 since nothing has been
    // curated yet this session.
    const stages = page.locator('.fly .fstage');
    await expect(stages).toHaveCount(7);
    await expect(stages.filter({ hasText: 'Observe' }).locator('.big')).toHaveText('11');
    await expect(stages.filter({ hasText: 'Curate' }).locator('.big')).toHaveText('0');
    await expect(stages.filter({ hasText: 'Curate' }).locator('.big')).toHaveClass(/zero/);
    await expect(stages.filter({ hasText: 'Evaluate' }).locator('.big')).toHaveText('5');
    await expect(page.locator('.card', { hasText: 'the finding' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'three paths' })).toBeVisible();

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'shots/learning-flywheel.png', fullPage: true });

    // Every subtab renders without error, in both themes.
    const tabs: Array<'obs' | 'pb' | 'cmp' | 'eval' | 'opt' | 'ds'> = ['obs', 'pb', 'cmp', 'eval', 'opt', 'ds'];
    for (const t of tabs) {
      await openSubtab(page, t);
      await expect(page.locator(`#lrntabs button[data-t="${t}"]`)).toHaveClass(/on/);
      await expect(page.locator('#lrnbody .card, #lrnbody .cmpbar').first()).toBeVisible();
    }

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await expect(page.locator('#lrnbody')).toBeVisible();
    for (const t of ['fly', ...tabs] as const) {
      await openSubtab(page, t);
      await expect(page.locator(`#lrntabs button[data-t="${t}"]`)).toHaveClass(/on/);
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  });

  test('curating an observation moves the flywheel counts and the lesson appears in the node’s Learning tab', async ({
    page,
  }) => {
    await gotoLearning(page);
    await openSubtab(page, 'obs');

    const row = page.locator('.obsrow', { hasText: 'Fix the id extraction in the publish sequencer' });
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: 'curate →' }).click();

    const form = page.locator('.card', { hasText: 'curate into playbook' }).last();
    await expect(form).toBeVisible();
    // node select pre-fills from the observation's own node (publish_executor).
    await expect(form.locator('select')).toHaveValue('publish_executor');

    await form.locator('button', { hasText: 'Curate → playbook_curate' }).click();
    const dialog = await expectConfirmVerb(page, 'playbook_curate');
    await dialog.locator('button', { hasText: 'Confirm' }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText('playbook_curate');

    await openSubtab(page, 'fly');
    await expect(page.locator('.fstage', { hasText: 'Curate' }).locator('.big')).toHaveText('1');

    // The lesson shows up on publish_executor's own Learning tab.
    await page.locator('nav.main button[data-s="bench"]').click();
    await expect(page.locator('.nhead .id')).toHaveText('publish_executor');
    await page.locator('.center .tabs button', { hasText: 'Learning' }).click();
    await expect(page.locator('.card', { hasText: 'playbook · injected lessons' })).toContainText('1 lesson curated');
    await expect(page.locator('.card', { hasText: 'playbook · injected lessons' })).toContainText(
      'create_missing_object_id',
    );
  });

  test('Compare: blind mode hides the champion until a verdict is recorded; ten keyboard verdicts complete in under twenty seconds', async ({
    page,
  }) => {
    await gotoLearning(page);
    await openSubtab(page, 'cmp');
    await expect(page.locator('.cmp .cand')).toHaveCount(2);

    // Blind by default — no champion/challenger badge anywhere before a verdict.
    await expect(page.locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.locator('.cand .chip')).toHaveCount(0);
    await expect(page.locator('.note', { hasText: 'Last:' })).toHaveCount(0);

    // Ten keyboard-only verdicts, timed as one run (WP-52's literal done-
    // criterion). Screenshot right after the first — reveal has happened
    // (the meter and the "last verdict" strip populate) without ever
    // badging the live pair, and only one toast has landed yet, before the
    // rest of the burst piles more on top of it.
    const keys = ['1', '2', '0', 'x', '1', '2', '0', 'x', '1', '2'];
    const start = Date.now();
    await page.keyboard.press(keys[0]);
    await expect(page.locator('.chip.num')).toHaveText('1 / 200 preference pairs');
    await expect(page.locator('.note', { hasText: 'Last:' })).toContainText('champion was');
    await expect(page.locator('.cand .chip')).toHaveCount(0);
    await page.screenshot({ path: 'shots/learning-compare.png', fullPage: true });

    for (const k of keys.slice(1)) {
      await page.keyboard.press(k);
    }
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(20_000);
    await expect(page.locator('.chip.num')).toHaveText('10 / 200 preference pairs');
    // Still no badge on the *current* (now-advanced) pair — blind stays blind.
    await expect(page.locator('.cand .chip')).toHaveCount(0);

    // Undo steps the tally back and doesn't require a mouse.
    await page.keyboard.press('Backspace');
    await expect(page.locator('.chip.num')).toHaveText('9 / 200 preference pairs');
    await expect(page.locator('#toasts')).toContainText('Verdict undone');

    // Turning blind mode off reveals the badge on the live pair immediately.
    await page.locator('input[type="checkbox"]').uncheck();
    await expect(page.locator('.cand .chip')).toHaveCount(2);
  });

  test('the contract_intelligence held-gate story reads exactly as speced', async ({ page }) => {
    await gotoLearning(page);
    await openSubtab(page, 'eval');

    const rubricRow = page.locator('.toolrow', { hasText: 'contract_intelligence' });
    await expect(rubricRow.locator('.regverdict.held')).toContainText('held');
    await expect(rubricRow.locator('.regverdict.held')).toContainText('0.484');

    const board = page.locator('.card', { hasText: 'regression watchboard' });
    await expect(board).toContainText('mean 0.484');
    await expect(board).toContainText('threshold 0.85');
    await expect(board).toContainText('4 replay cases');
    await expect(board.locator('.regverdict')).toHaveText('held');
    await expect(board).toContainText('Baseline set 3 Aug');
    await expect(board).toContainText('no movement');
    await expect(board.locator('.spark i.hi')).toHaveCount(4);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'shots/learning-evaluate.png', fullPage: true });
  });
});
