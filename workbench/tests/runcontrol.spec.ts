import { expect, test, type Page } from '@playwright/test';

// WP-21/22/23 smoke: run-dock controls, the confirm dialog, the start-run
// modal, and the gate panel — against fixture data (VITE_MOCK default,
// VITE_READ_ONLY=0 in .env.development so mutations actually run). Mirrors
// the pattern in tests/runs.spec.ts: bind runs directly via the store
// (readStore/bindRunDirectly), assert against real fixture ids rather than
// hardcoded counts, screenshot the three required states.

interface StoreSnapshot {
  screen: string;
  mode: string;
  runId: string | null;
  wf: string;
  node: string;
}

async function readStore(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => StoreSnapshot } };
    const s = mod.useStore.getState();
    return { screen: s.screen, mode: s.mode, runId: s.runId, wf: s.wf, node: s.node };
  });
}

/** Binds a run the same way a Runs-table row click does (store.bindRun), without needing to navigate the Runs screen's filters first — lets each gate-copy case jump straight to the run/node it needs. */
async function bindRunDirectly(page: Page, runId: string, wf: string, node: string) {
  await page.evaluate(
    async ({ runId, wf, node }) => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
      mod.useStore.getState().bindRun(runId, wf, node);
    },
    { runId, wf, node },
  );
}

const confirmDialog = (page: Page) => page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });

async function expectConfirmVerb(page: Page, verb: string) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.sub')).toHaveText(verb);
  return dialog;
}

test.describe('run dock controls', () => {
  test('confirm dialog: names the verb, blocks the mutation until confirmed, cancels cleanly on Escape/scrim/Cancel, returns focus', async ({
    page,
  }) => {
    await page.goto('/');
    // Default bound state: publish_executor, blocked — Reset is never
    // disabled by run status (mirrors the mockup exactly), so it's a safe,
    // always-available control to exercise the confirm lifecycle against.
    const resetBtn = page.locator('.dock .ctl button', { hasText: 'Reset' });
    await expect(resetBtn).toBeEnabled();

    // --- Escape cancels, state unchanged, focus returns to the trigger ---
    await resetBtn.click();
    await expectConfirmVerb(page, 'workflow_reset_run');
    await page.keyboard.press('Escape');
    await expect(confirmDialog(page)).toHaveCount(0);
    await expect(page.locator('.dock .card .chip.blocked').first()).toBeVisible();
    await expect(resetBtn).toBeFocused();

    // --- Scrim click cancels ---
    await resetBtn.click();
    await expectConfirmVerb(page, 'workflow_reset_run');
    await page.locator('.scrim.open').click({ position: { x: 4, y: 4 } });
    await expect(confirmDialog(page)).toHaveCount(0);
    await expect(page.locator('.dock .card .chip.blocked').first()).toBeVisible(); // still blocked — reset never ran

    // --- Cancel button cancels ---
    await resetBtn.click();
    const dialog = await expectConfirmVerb(page, 'workflow_reset_run');
    await dialog.locator('button', { hasText: 'Cancel' }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
    await expect(page.locator('.dock .card .chip.blocked').first()).toBeVisible();

    // --- Confirm actually runs the mutation ---
    await resetBtn.click();
    const dialog2 = await expectConfirmVerb(page, 'workflow_reset_run');
    await page.screenshot({ path: 'shots/confirm-dialog.png' });
    await dialog2.locator('button', { hasText: 'Confirm' }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText('workflow_reset_run');
    await expect(page.locator('.dock .card .chip.queued').first()).toBeVisible();
    await expect(page.locator('.dock .gate')).toHaveCount(0); // no longer blocked
  });

  test('controls fire the right verb; disabled states match run status', async ({ page }) => {
    await page.goto('/');

    // --- cancelled run: cur is set, but the run is already over ---
    await bindRunDirectly(page, 'run_1787503507240_hytb76', 'clone_conductor', 'clone_intake');
    await expect(page.locator('.dock .ctl button', { hasText: 'Pause' })).toBeDisabled();
    await expect(page.locator('.dock .ctl button', { hasText: 'Pause' })).toHaveAttribute('title', /already cancelled/);
    await expect(page.locator('.dock .ctl button', { hasText: 'Run next' })).toBeDisabled();
    await expect(page.locator('.dock .ctl button', { hasText: 'Run until' })).toBeDisabled();
    await expect(page.locator('.dock .ctl button', { hasText: 'Cancel' })).toBeDisabled();
    await expect(page.locator('.dock .ctl button', { hasText: 'Reset' })).toBeEnabled();
    await expect(page.locator('.dock .ctl button', { hasText: 'Retry node' })).toBeEnabled(); // cur is set

    // --- completed run: no current node ---
    await bindRunDirectly(page, 'run_1787567811920_hevotl', 'publishing_conductor', 'learning_recorder');
    await expect(page.locator('.dock .ctl button', { hasText: 'Retry node' })).toBeDisabled();
    await expect(page.locator('.dock .ctl button', { hasText: 'Retry node' })).toHaveAttribute('title', /no current node/);
    await expect(page.locator('.dock .ctl button', { hasText: 'Reset' })).toBeEnabled();

    // --- a fresh run started via the Library, exercised through every verb ---
    await page.locator('nav.main button', { hasText: 'Workflows' }).click();
    const clone = page.locator('.cards .wfcard').filter({ has: page.locator('h3', { hasText: 'Clone conductor' }) });
    await clone.locator('button', { hasText: 'Start run' }).click();
    await expect(page.locator('#startmodal-title')).toBeVisible();
    await expect(async () => {
      await expect(page.locator('.valnote')).toHaveText(/validates/, { timeout: 500 });
    }).toPass({ timeout: 5000 });
    const startBtn = page.locator('.modal button', { hasText: 'Start run' });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();
    // workflow_start_dry_run is a mutating verb too — it goes through the
    // same confirmAction gate as every dock control.
    await expectConfirmVerb(page, 'workflow_start_dry_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#startmodal-title')).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText('workflow_start_dry_run');

    const state = await readStore(page);
    expect(state.mode).toBe('run');
    expect(state.wf).toBe('clone_conductor');
    const runId = state.runId as string;
    expect(runId).toBeTruthy();

    // queued -> Pause is available (only completed/failed/cancelled disable it)
    await page.locator('.dock .ctl button', { hasText: 'Pause' }).click();
    await expectConfirmVerb(page, 'workflow_pause_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_pause_run');
    await expect(page.locator('.dock .card .chip.paused').first()).toBeVisible();

    // paused -> Resume replaces Pause
    await expect(page.locator('.dock .ctl button', { hasText: 'Pause' })).toHaveCount(0);
    await page.locator('.dock .ctl button', { hasText: 'Resume' }).click();
    await expectConfirmVerb(page, 'workflow_resume_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_resume_run');
    await expect(page.locator('.dock .card .chip.running').first()).toBeVisible();

    // Run next
    await page.locator('.dock .ctl button', { hasText: 'Run next' }).click();
    await expectConfirmVerb(page, 'workflow_run_next_node');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_run_next_node');

    // Run until — the node picker lists remaining nodes in execution order
    await expect(page.locator('.dock .ctl button', { hasText: 'Retry node' })).toBeDisabled(); // no cur yet
    await page.locator('.dock .ctl button', { hasText: 'Run until' }).click();
    const picker = page.locator('#dock-until-target');
    await expect(picker).toBeVisible();
    const options = await picker.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);
    const target = options[0];
    await page.locator('.dock button', { hasText: 'Go' }).click();
    await expectConfirmVerb(page, 'workflow_run_until');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Running until ' + target);

    // Retry node — now enabled, since run_until set a current node
    await expect(page.locator('.dock .ctl button', { hasText: 'Retry node' })).toBeEnabled();
    await page.locator('.dock .ctl button', { hasText: 'Retry node' }).click();
    await expectConfirmVerb(page, 'workflow_retry_node');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_retry_node');

    // Cancel — destructive: danger button copy, confirm button says so
    await page.locator('.dock .ctl button', { hasText: 'Cancel' }).click();
    const cancelDialog = await expectConfirmVerb(page, 'workflow_cancel_run');
    await expect(cancelDialog.locator('button', { hasText: 'cannot be undone' })).toBeVisible();
    await cancelDialog.locator('button', { hasText: 'cannot be undone' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_cancel_run');
    await expect(page.locator('.dock .card .chip.cancelled').first()).toBeVisible();

    // Reset — always available regardless of status
    await page.locator('.dock .ctl button', { hasText: 'Reset' }).click();
    await expectConfirmVerb(page, 'workflow_reset_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('.dock .card .chip.queued').first()).toBeVisible();

    // --- cost vs budget: an operator should never discover a blown budget
    // by reading the number twice. No fixture run happens to be over
    // budget, so simulate one directly on the mock store the same run's
    // query already reads from, then re-trigger a refetch via a real
    // (already-tested) control. ---
    await page.evaluate(
      async ({ runId }) => {
        const mod = (await import('/src/api/mockStore.ts')) as { mockStore: { updateRun: (id: string, patch: object) => void } };
        mod.mockStore.updateRun(runId, { cost: 12, budget: 10 });
      },
      { runId },
    );
    await page.locator('.dock .ctl button', { hasText: 'Reset' }).click();
    await expectConfirmVerb(page, 'workflow_reset_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('.dock .card .note', { hasText: /over budget by \$/ })).toBeVisible();
  });
});

test.describe('gate panel', () => {
  test('renders correct copy for theme_bind, publication_controller, and the default publish_executor run; readiness + approve/decline', async ({
    page,
  }) => {
    await page.goto('/');

    // --- default bound run: publish_executor — the "makes it live" gate ---
    await expect(page.locator('.dock .gate .lbl')).toHaveText('⛔ gate · publish_executor');
    await expect(page.locator('.dock .gate')).toContainText('publish_executor then executes the real publish sequence');
    await expect(page.locator('.dock .gate')).toContainText('expected to publish live content');

    await page.locator('.dock .gate button', { hasText: 'View readiness' }).click();
    await expect(page.locator('.dock .gate')).toContainText('Durable operator publish decision recorded');
    await expect(page.locator('.dock .gate')).toContainText('the evidence, not a vibe');
    await page.screenshot({ path: 'shots/gate-panel.png' });

    await page.locator('.dock .gate button', { hasText: 'Decline' }).click();
    await expectConfirmVerb(page, 'workflow_set_operator_publish_decision');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('.dock .gate')).toHaveCount(0);
    await expect(page.locator('.dock .card .chip.cancelled').first()).toBeVisible();

    // --- theme_bind: exact-replace write, no live-publish emphasis ---
    await bindRunDirectly(page, 'run_1787572511291_qmw645', 'clone_conductor', 'theme_bind');
    await expect(page.locator('.dock .gate .lbl')).toHaveText('⛔ gate · theme_bind');
    await expect(page.locator('.dock .gate')).toContainText('theme_not_total');
    await expect(page.locator('.dock .gate')).not.toContainText('expected to publish live content');

    await page.locator('.dock .gate button', { hasText: 'Approve & resume' }).click();
    const themeDialog = await expectConfirmVerb(page, 'workflow_set_operator_publish_decision');
    await expect(themeDialog).toContainText('exact-replace theme apply');
    await themeDialog.locator('button', { hasText: 'Confirm' }).click();
    await expect(page.locator('.dock .gate')).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText('workflow_set_operator_publish_decision');

    // --- publication_controller: prepares a recommendation, never publishes itself ---
    await bindRunDirectly(page, 'run_1787578716097_4t7uo1', 'publishing_conductor', 'publication_controller');
    await expect(page.locator('.dock .gate .lbl')).toHaveText('⛔ gate · publication_controller');
    await expect(page.locator('.dock .gate')).toContainText('it never publishes');
    await expect(page.locator('.dock .gate')).not.toContainText('expected to publish live content');
  });
});

test.describe('start-run modal', () => {
  test('blocks invalid input with a reason, requires a deliberate click for live, launches on valid', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav.main button', { hasText: 'Workflows' }).click();
    const pub = page.locator('.cards .wfcard').filter({ has: page.locator('h3', { hasText: 'Publishing conductor' }) });
    await pub.locator('button', { hasText: 'Start run' }).click();

    await expect(page.locator('#sm-wf')).toHaveValue('publishing_conductor');

    // Project connection health: monetizer is a real un-launchable case —
    // present but disabled, not silently missing; fernwell (disabled:true)
    // is filtered out of the list entirely.
    const projectOptions = page.locator('#sm-proj option');
    await expect(projectOptions.filter({ hasText: 'Fernwell' })).toHaveCount(0);
    const monetizerOption = projectOptions.filter({ hasText: 'Monetizer' });
    await expect(monetizerOption).toHaveAttribute('disabled', '');
    await expect(monetizerOption).toContainText('endpoint unset');

    // Default state: dry, valid input, Start enabled.
    const startBtn = page.locator('.modal button', { hasText: 'Start run' });
    await expect(async () => {
      await expect(page.locator('.valnote')).toContainText('validates', { timeout: 500 });
    }).toPass({ timeout: 5000 });
    await expect(startBtn).toBeEnabled();
    await page.screenshot({ path: 'shots/start-modal.png' });

    // Clearing the brief invalidates it — blocked, with a stated reason.
    await page.locator('#sm-brief').fill('');
    await expect(async () => {
      await expect(page.locator('.valnote')).toContainText('does not validate', { timeout: 500 });
    }).toPass({ timeout: 5000 });
    await expect(page.locator('.modal .note', { hasText: /blocked:/ })).toBeVisible();
    await expect(startBtn).toBeDisabled();

    // Retyping restores validity.
    await page.locator('#sm-brief').fill('Draft a piece about sensitive-skin retinol alternatives.');
    await expect(async () => {
      await expect(page.locator('.valnote')).toContainText('validates', { timeout: 500 });
    }).toPass({ timeout: 5000 });
    await expect(startBtn).toBeEnabled();

    // Live requires a deliberate click — it is never the default, and once
    // chosen the button itself becomes unmistakable about the stakes.
    await expect(page.locator('.modal .seg button.on').nth(1)).toHaveText('dry run');
    await page.locator('.modal .seg button', { hasText: /^live$/ }).click();
    await expect(page.locator('.modal')).toContainText('live — not a drill');
    await expect(page.locator('.modal button', { hasText: 'Start LIVE run' })).toBeVisible();
    await page.locator('.modal .seg button', { hasText: /^dry run$/ }).click(); // back to dry for the launch below

    await startBtn.click();
    await expectConfirmVerb(page, 'workflow_start_dry_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#startmodal-title')).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText('workflow_start_dry_run');
    const state = await readStore(page);
    expect(state.mode).toBe('run');
    expect(state.wf).toBe('publishing_conductor');
    expect(state.runId).toBeTruthy();
  });
});
