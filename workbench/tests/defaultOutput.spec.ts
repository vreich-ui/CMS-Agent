import { expect, test, type Page } from '@playwright/test';

// node-default-output (W4) acceptance test — the full deliverable chain
// through the real Workbench UI against fixture data (VITE_MOCK default):
// set research's standing default from its own tab, start a
// `defaults_where_set` dry run of Publishing conductor from the Output mode
// control (StartRunModal), push research through with its default from the
// drive-mode step panel, and confirm the rail marker + "This run" provenance
// banner both say so — plus confirm the very next node (no default of its
// own) leaves Push-through disabled with a reason. Conventions mirror
// tests/drive.spec.ts and tests/runcontrol.spec.ts: bind/select via the
// store where that's just setup, real UI interaction for every assertion
// that IS the point of the test.

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

/** Selects a node in Build mode without touching any run binding — setup
 * only, for reaching the Default output tab before any run exists. */
async function selectNode(page: Page, nodeId: string) {
  await page.evaluate(async (nodeId) => {
    const mod = (await import('/src/store.ts')) as {
      useStore: { getState: () => { setMode: (m: string) => void; setScreen: (s: string) => void; setNode: (n: string) => void } };
    };
    const s = mod.useStore.getState();
    s.setMode('build');
    s.setScreen('bench');
    s.setNode(nodeId);
  }, nodeId);
}

/** Same pattern as drive.spec.ts's bindDrive — binds a run and lands in
 * drive mode in one store update. */
async function bindRunForDrive(page: Page, runId: string, wf: string, node: string) {
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

const confirmDialog = (page: Page) => page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });
async function expectConfirmVerb(page: Page, verb: string) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.sub')).toHaveText(verb);
  return dialog;
}

/** Same pattern as tests/thisRunOutput.spec.ts's bindRunDirectly — binds a
 * run straight into run mode (no drive-mode ceremony) for the two
 * adversarial-review regression tests below, which need only the rail and
 * "This run" tab, never the drive-mode step panel. */
async function bindRunDirectly(page: Page, runId: string, wf: string, node: string) {
  await page.evaluate(
    async ({ runId, wf, node }) => {
      const mod = (await import('/src/store.ts')) as {
        useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } };
      };
      mod.useStore.getState().bindRun(runId, wf, node);
    },
    { runId, wf, node },
  );
}

/** Same pattern as tests/thisRunOutput.spec.ts's saveOverride — pins an
 * operator override directly through mockStore.saveStageOutput, bypassing
 * the override modal (already covered end-to-end by thisRunOutput.spec.ts
 * and drive.spec.ts), so this file's own tests stay focused on the marker
 * surfaces the adversarial review flagged. */
async function saveOverride(page: Page, runId: string, nodeId: string, value: unknown, note?: string) {
  await page.evaluate(
    async ({ runId, nodeId, value, note }) => {
      const mod = (await import('/src/api/mockStore.ts')) as {
        mockStore: { saveStageOutput: (r: string, n: string, v: unknown, note?: string) => void };
      };
      mod.mockStore.saveStageOutput(runId, nodeId, value, note);
    },
    { runId, nodeId, value, note },
  );
}

// mockStore.ts's CANONICAL_ARTIFACTS/LEGACY_STAGE_RECORDS scenario run
// (also used by tests/thisRunOutput.spec.ts) — a REAL live run
// (executionMode: 'openai', fixtures/runs.json) already blocked on
// publish_executor, its own real publish-tail node (kind: 'publisher',
// riskLevel: 'publish', fixtures/nodes.json), so Defect 2's coverage below
// needs no extra run-driving to reach one.
const RUN_A = 'run_1787492010814_kxdbeb';

// research's real declared output schema (fixtures/nodes.json) requires
// exactly `artifact` (const 'research_brief.v1') and `summary` — this value
// satisfies it, so saving it as the standing default lands schema-valid
// with no second confirmation needed.
const RESEARCH_DEFAULT = {
  artifact: 'research_brief.v1',
  summary: 'fixture-mode standing default for the W4 acceptance test',
  notes: ['seeded by tests/defaultOutput.spec.ts'],
};

test.describe('node-default-output', () => {
  test('set a default, push a node through with it, and see it everywhere it should', async ({ page }) => {
    await page.goto('/');

    // 1. Set research's standing default from its own tab (deliverable #1).
    await selectNode(page, 'research');
    await page.locator('#node-tab-defaultoutput').click();
    await expect(page.locator('.center')).toContainText('no default set');
    await page.locator('#default-output-json').fill(JSON.stringify(RESEARCH_DEFAULT));
    await page.locator('.center button', { hasText: 'Save default' }).click();
    await expectConfirmVerb(page, 'workspace_update_node_default_output');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workspace_update_node_default_output');
    await expect(page.locator('.center')).toContainText('schema valid');
    await expect(page.locator('.center')).not.toContainText('no default set');

    // 2. Start a `defaults_where_set` dry run of Publishing conductor —
    // the Output mode control (deliverable #4).
    await page.locator('nav.main button', { hasText: 'Workflows' }).click();
    const pub = page.locator('.cards .wfcard').filter({ has: page.locator('h3', { hasText: 'Publishing conductor' }) });
    await pub.locator('button', { hasText: 'Start run' }).click();
    await expect(page.locator('#startmodal-title')).toBeVisible();
    await expect(async () => {
      await expect(page.locator('.valnote')).toContainText('validates', { timeout: 500 });
    }).toPass({ timeout: 5000 });

    await page.locator('.modal .seg button', { hasText: 'defaults where set' }).click();
    await expect(page.locator('.modal')).toContainText('this run can never publish live');

    const startBtn = page.locator('.modal button', { hasText: 'Start run' });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();
    await expectConfirmVerb(page, 'workflow_start_dry_run');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#startmodal-title')).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText('workflow_start_dry_run');

    const state = await readStore(page);
    expect(state.mode).toBe('run');
    const runId = state.runId as string;
    expect(runId).toBeTruthy();

    // 3. Move the cursor onto research — workflow_run_until genuinely moves
    // the fixture store's currentNodeId (mockStore.ts), not just an
    // optimistic patch — see drive.spec.ts's own note on this.
    await bindRunForDrive(page, runId, 'publishing_conductor', 'research');
    await page.locator('.dock .ctl button', { hasText: 'Run until' }).click();
    const picker = page.locator('#dock-until-target');
    await expect(picker).toBeVisible();
    await picker.selectOption('research');
    await page.locator('.dock button', { hasText: 'Go' }).click();
    await expectConfirmVerb(page, 'workflow_run_until');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('workflow_run_until');

    // 4. Push research through with its default from the drive-mode step
    // panel (deliverable #2).
    const upNext = page.locator('.center .card', { has: page.locator('.lbl', { hasText: 'up next' }) });
    await expect(upNext.locator('.mono', { hasText: 'research' })).toBeVisible();
    const pushBtn = upNext.locator('button', { hasText: 'Push through with default' });
    await expect(pushBtn).toBeEnabled();
    await pushBtn.click();
    await expectConfirmVerb(page, 'workflow_run_node');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Pushed through');

    // The run advanced past research on its own — the very next node
    // (objection_mapping, no default of its own) leaves Push-through
    // disabled, with a reason, right here with no extra setup.
    await expect(upNext.locator('.mono', { hasText: 'objection_mapping' })).toBeVisible();
    const pushBtn2 = upNext.locator('button', { hasText: 'Push through with default' });
    await expect(pushBtn2).toBeDisabled();
    await expect(pushBtn2).toHaveAttribute('title', /no standing default output set/);

    // 5. Rail shows the default-output marker, visually distinct from the
    // operator-override chip (deliverable #3) — its computation is gated on
    // run mode (Rail.tsx), so switch back to it first.
    await page.locator('.center button', { hasText: '← run mode' }).click();
    await expect.poll(async () => (await readStore(page)).mode).toBe('run');
    const railRow = page.locator('.rail .nrow', { has: page.locator('.nm', { hasText: /^research$/ }) });
    await expect(railRow.locator('.chip-default')).toBeVisible();

    // 6. "This run" shows the default_output provenance banner — never
    // presented as if the node produced it.
    await page.locator('#node-tab-thisrun').click();
    await expect(page.locator('.center')).toContainText('pushed through from');
    await expect(page.locator('.center')).toContainText("standing default");
  });
});

// Adversarial-review follow-up (post-W4) — Defect 1: an operator override
// is a REAL, run-record-level fact (RunNode.outputProvenance, source:
// 'operator_override'), not something only the fixture's synthesized
// node_list_outputs row knows about — every marker surface has to read it
// and keep it visually/textually distinct from a pushed-through default.
test.describe('operator override provenance (adversarial-review Defect 1)', () => {
  test('an operator override shows a distinct marker and provenance in the rail and This-run — never the default-output ones', async ({ page }) => {
    await page.goto('/');

    // human_texture: completed in RUN_A with nothing recorded (see
    // thisRunOutput.spec.ts's "genuinely completed node" case) — a clean
    // node to pin an override onto without disturbing any other scenario
    // mockStore.ts's CANONICAL_ARTIFACTS/LEGACY_STAGE_RECORDS maps define.
    const nodeId = 'human_texture';
    const overrideValue = { marker: 'adversarial-review-defect1-override' };
    await saveOverride(page, RUN_A, nodeId, overrideValue, 'defect 1 coverage note');

    await bindRunDirectly(page, RUN_A, 'publishing_conductor', nodeId);
    await expect(page.locator('.nhead .id')).toHaveText(nodeId);

    // Rail: the override chip, never the default-output one.
    const railRow = page.locator('.rail .nrow', { has: page.locator('.nm', { hasText: new RegExp(`^${nodeId}$`) }) });
    await expect(railRow.locator('.chip-override')).toBeVisible();
    await expect(railRow.locator('.chip-default')).toHaveCount(0);

    // This-run: the operator-override banner, with the note — never the
    // "pushed through from its standing default" copy a default would show.
    await page.locator('#node-tab-thisrun').click();
    await expect(page.locator('.center')).toContainText('this output was supplied by the operator');
    await expect(page.locator('.center')).toContainText('defect 1 coverage note');
    await expect(page.locator('.center')).not.toContainText('pushed through from');
  });
});

// Adversarial-review follow-up (post-W4) — Defect 2 (server contract): a
// node that writes to a live client (publisher/releaser/emission kind, or
// publish/admin riskLevel) can never have its output supplied instead of
// produced on a live run — the server refuses with
// `defaulted_publish_node_refused`; the UI must disable push-through and
// say why before that round-trip, not just toast the refusal after.
test.describe('publish-tail push-through refusal (adversarial-review Defect 2)', () => {
  test('push-through with default is refused/disabled on a publish-tail node of a live run', async ({ page }) => {
    await page.goto('/');

    // publish_executor is RUN_A's own currentNodeId (fixtures/runs.json) —
    // a real publisher-kind, publish-riskLevel node, on a real
    // executionMode:'openai' run — needs no run-driving to reach.
    await bindRunForDrive(page, RUN_A, 'publishing_conductor', 'publish_executor');

    const upNext = page.locator('.center .card', { has: page.locator('.lbl', { hasText: 'up next' }) });
    await expect(upNext.locator('.mono', { hasText: 'publish_executor' })).toBeVisible();
    const pushBtn = upNext.locator('button', { hasText: 'Push through with default' });
    await expect(pushBtn).toBeDisabled();
    await expect(pushBtn).toHaveAttribute('title', /defaulted_publish_node_refused/);
  });
});
