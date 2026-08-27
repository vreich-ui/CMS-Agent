import { expect, test, type Page } from '@playwright/test';

// U3 smoke: drive mode (hand-driving a run) and the override-output modal,
// against fixture data (VITE_MOCK default, VITE_READ_ONLY=0 there — see
// api/client.ts's IS_READ_ONLY doc comment: fixture mode is writable by
// default, no .env needed). Conventions mirror tests/runcontrol.spec.ts:
// bind runs directly via the store, assert against real fixture ids.

interface StoreSnapshot {
  mode: string;
  runId: string | null;
  wf: string;
  node: string;
}

async function readStore(page: Page): Promise<StoreSnapshot> {
  return page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => StoreSnapshot } };
    const s = mod.useStore.getState();
    return { mode: s.mode, runId: s.runId, wf: s.wf, node: s.node };
  });
}

/** Binds a run and lands in drive mode in one store update — the same
 * pattern runcontrol.spec.ts's bindRunDirectly uses for 'run' mode. */
async function bindDrive(page: Page, runId: string, wf: string, node: string) {
  await page.evaluate(
    async ({ runId, wf, node }) => {
      const mod = (await import('/src/store.ts')) as {
        useStore: { getState: () => { bindRunForDrive: (r: string, w: string, n: string) => void } };
      };
      mod.useStore.getState().bindRunForDrive(runId, wf, node);
    },
    { runId, wf, node },
  );
}

/** Opens the override modal the same way ⌘K's "override output on <node>"
 * action does — store.openModal — for tests whose focus is elsewhere (draft
 * persistence, unparseable JSON) and don't need to exercise a particular
 * button's wiring to get there (that wiring has its own coverage below). */
async function openOverride(page: Page, node: string, run: string) {
  await page.evaluate(
    async ({ node, run }) => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { openModal: (k: string, p: object) => void } } };
      mod.useStore.getState().openModal('override', { node, run });
    },
    { node, run },
  );
}

const confirmDialog = (page: Page) => page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });
const overrideModal = (page: Page) => page.locator('.modal.ovl-work');

async function expectConfirmVerb(page: Page, verb: string) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.sub')).toHaveText(verb);
  return dialog;
}

// publishing_conductor: input_triage (Intake) -> placement_resolver
// (Strategy) is a real dependsOn edge (fixtures/nodes.json). run_
// 1786970270844_pmoodj is a real fixture run whose currentNodeId is
// input_triage and whose status is 'failed' — Run next/Run until are only
// disabled for completed/cancelled runs (Dock.tsx), so a failed run's
// controls are genuinely available.
const WF = 'publishing_conductor';
const RUN_STEP = 'run_1786970270844_pmoodj';
const NODE_STEP = 'input_triage';
const NODE_DOWNSTREAM = 'placement_resolver';

// input_triage's real declared output schema (fixtures/nodes.json) requires
// exactly these four fields — used both for a valid seed (test 2) and to
// derive a schema-invalid-but-parseable one deliberately (test 4).
const VALID_OUTPUT = {
  artifact: 'content_source.v1',
  summary: 'operator-supplied summary',
  trafficSource: 'organic',
  awarenessStage: 'aware',
};

// publish_executor is a real 'publish'-risk node (fixtures/nodes.json
// riskLevel) — run_1787492010814_kxdbeb is the same blocked fixture run
// tests/runcontrol.spec.ts already uses for it.
const RUN_PUBLISH = 'run_1787492010814_kxdbeb';
const NODE_PUBLISH = 'publish_executor';

test.describe('drive mode', () => {
  test('entering drive mode and stepping one node shows its result in the centre pane', async ({ page }) => {
    await page.goto('/');
    await bindDrive(page, RUN_STEP, WF, NODE_STEP);

    const state = await readStore(page);
    expect(state.mode).toBe('drive');
    expect(state.runId).toBe(RUN_STEP);

    // "up next" names the real current node, not a placeholder.
    await expect(page.locator('.center')).toContainText('up next');
    const stepBtn = page.locator('.center button', { hasText: `Step (run ${NODE_STEP})` });
    await expect(stepBtn).toBeVisible();

    await stepBtn.click();
    await expectConfirmVerb(page, 'workflow_run_next_node');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_run_next_node');

    // The just-stepped node's result panel — status/duration/cost/validation
    // — appears immediately, without navigating anywhere.
    const resultCard = page.locator('.card', { has: page.locator('.lbl', { hasText: `just ran · ${NODE_STEP}` }) });
    await expect(resultCard).toBeVisible();
    await expect(resultCard).toContainText('validation');
    await expect(resultCard.locator('button', { hasText: 'Accept & step again' })).toBeVisible();
    await expect(resultCard.locator('button', { hasText: 'Retry with edited prompt' })).toBeVisible();
    await expect(resultCard.locator('button', { hasText: 'Override output' })).toBeVisible();

    await page.screenshot({ path: 'shots/drive-step.png' });
  });

  test('overriding an output and seeing a downstream node read it', async ({ page }) => {
    await page.goto('/');
    await bindDrive(page, RUN_STEP, WF, NODE_STEP);

    // Override input_triage's output directly from the "up next" card —
    // before it has even run, which is exactly "insert manually the output
    // variant I prefer" instead of executing the node.
    await page.locator('.center button', { hasText: 'Override output' }).click();
    await expect(overrideModal(page)).toBeVisible();
    await expect(overrideModal(page)).toContainText('Every downstream node in this run will read');

    await page.locator('#override-json').fill(JSON.stringify(VALID_OUTPUT));
    await page.locator('#override-note').fill('seeded manually for the U3 test');
    await overrideModal(page).locator('button', { hasText: 'Save override' }).click();
    await expectConfirmVerb(page, 'stage_save_output');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('stage_save_output');
    await expect(overrideModal(page)).toHaveCount(0); // modal closes on a successful save

    // Advance to the real downstream node with the dock's own "Run
    // until…" — workflow_run_until, which genuinely moves the fixture
    // store's currentNodeId (mockStore.ts), not just an optimistic patch —
    // so the drive pane's next read of run.cur is placement_resolver for real.
    await page.locator('.dock .ctl button', { hasText: 'Run until' }).click();
    const picker = page.locator('#dock-until-target');
    await expect(picker).toBeVisible();
    await picker.selectOption(NODE_DOWNSTREAM);
    await page.locator('.dock button', { hasText: 'Go' }).click();
    await expectConfirmVerb(page, 'workflow_run_until');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_run_until');

    // The now-current node's "up next" panel names input_triage as an
    // upstream dependency AND says, in words, that it carries an operator
    // override — not silently, not as if placement_resolver will read
    // something ordinary.
    const upNext = page.locator('.center .card', { has: page.locator('.lbl', { hasText: 'up next' }) });
    await expect(upNext.locator('.mono', { hasText: NODE_DOWNSTREAM })).toBeVisible();
    await expect(upNext).toContainText(`${NODE_DOWNSTREAM} reads from:`);
    await expect(upNext).toContainText(NODE_STEP);
    await expect(upNext).toContainText('operator override');

    await page.screenshot({ path: 'shots/drive-override-downstream.png' });
  });

  test('unparseable JSON blocks Save, with a precise line/column error', async ({ page }) => {
    await page.goto('/');
    await bindDrive(page, RUN_STEP, WF, NODE_STEP);
    await openOverride(page, NODE_STEP, RUN_STEP);
    await expect(overrideModal(page)).toBeVisible();

    const saveBtn = overrideModal(page).locator('button', { hasText: 'Save override' });
    await page.locator('#override-json').fill('{\n  "artifact": "content_source.v1"\n  "missing": "comma"\n}');

    await expect(overrideModal(page)).toContainText('Malformed JSON');
    await expect(overrideModal(page)).toContainText(/line \d+, column \d+/);
    await expect(saveBtn).toBeDisabled();

    // Fixing the JSON clears the error and the block.
    await page.locator('#override-json').fill(JSON.stringify(VALID_OUTPUT));
    await expect(overrideModal(page)).not.toContainText('Malformed JSON');
    await expect(saveBtn).toBeEnabled();
  });

  test('a schema-invalid-but-parseable save requires a second, explicit, issue-naming confirmation', async ({ page }) => {
    await page.goto('/');
    await bindDrive(page, RUN_STEP, WF, NODE_STEP);
    await openOverride(page, NODE_STEP, RUN_STEP);
    await expect(overrideModal(page)).toBeVisible();

    // Parseable, but missing every field input_triage's declared output
    // schema requires.
    await page.locator('#override-json').fill('{}');
    const saveBtn = overrideModal(page).locator('button', { hasText: 'Save override' });
    await saveBtn.click();

    // First click only validates and surfaces the issues — it does NOT open
    // the confirmAction dialog yet.
    await expect(overrideModal(page)).toContainText('second confirmation — schema invalid');
    await expect(overrideModal(page).locator('.mono', { hasText: 'artifact' })).toBeVisible();
    await expect(confirmDialog(page)).toHaveCount(0);

    // The explicit second confirmation names the issue count and, only once
    // clicked, triggers the standard (unsoftened) confirmAction gate.
    const confirmAnyway = overrideModal(page).locator('button', { hasText: /Yes — save despite \d+ issues?/ });
    await expect(confirmAnyway).toBeVisible();
    await confirmAnyway.click();
    await expectConfirmVerb(page, 'stage_save_output');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('stage_save_output');
    await expect(overrideModal(page)).toHaveCount(0);
  });

  test("a publish-risk node defaults to a breakpoint; an ordinary node doesn't", async ({ page }) => {
    await page.goto('/');
    await bindDrive(page, RUN_PUBLISH, 'publishing_conductor', NODE_PUBLISH);

    // "up next" is publish_executor itself — its own breakpoint checkbox
    // reads checked with no prior operator choice (nothing in localStorage
    // for this run yet).
    const upNext = page.locator('.center .card', { has: page.locator('.lbl', { hasText: 'up next' }) });
    await expect(upNext.locator('.mono', { hasText: NODE_PUBLISH })).toBeVisible();
    await expect(upNext.locator('input[type=checkbox]')).toBeChecked();

    // The node grid agrees: publish_executor's row is checked, and at least
    // one non-publish-risk row is not.
    const grid = page.locator('.card', { has: page.locator('.lbl', { hasText: 'node grid' }) });
    const pubRow = grid.locator('tr', { has: page.locator('button', { hasText: NODE_PUBLISH }) });
    await expect(pubRow.locator('input[type=checkbox]')).toBeChecked();
    const readRow = grid.locator('tr', { has: page.locator('button', { hasText: 'input_triage' }) });
    await expect(readRow.locator('input[type=checkbox]')).not.toBeChecked();

    // Toggling it off persists to localStorage, per run.
    await readRow.locator('input[type=checkbox]').check();
    const explicit = await page.evaluate(
      async ({ runId }) => {
        const mod = (await import('/src/components/drive/breakpoints.ts')) as {
          readExplicitBreakpoints: (r: string) => Record<string, boolean>;
        };
        return mod.readExplicitBreakpoints(runId);
      },
      { runId: RUN_PUBLISH },
    );
    expect(explicit.input_triage).toBe(true);
  });

  test('Escape preserves a typed override draft', async ({ page }) => {
    await page.goto('/');
    await bindDrive(page, RUN_STEP, WF, NODE_STEP);
    await openOverride(page, NODE_STEP, RUN_STEP);
    await expect(overrideModal(page)).toBeVisible();

    const draftText = '{\n  "summary": "not yet finished typing this'; // deliberately unparseable mid-edit
    await page.locator('#override-json').fill(draftText);
    await expect(page.locator('#override-json')).toHaveValue(draftText);

    await page.keyboard.press('Escape');
    await expect(overrideModal(page)).toHaveCount(0);

    // Reopening the exact same modal instance (same node + run) restores
    // the typed text — nothing was lost.
    await openOverride(page, NODE_STEP, RUN_STEP);
    await expect(overrideModal(page)).toBeVisible();
    await expect(page.locator('#override-json')).toHaveValue(draftText);
  });
});
