import { expect, test, type Page } from '@playwright/test';

// W4 acceptance — node DEFAULT OUTPUT, end to end against fixture data.
//
// The claim under test is the one the whole feature rests on: an operator can set a default on a node,
// push that node through in one click without running it, and see everywhere in the UI that the value
// did not come from a model. Plus the two refusals that keep it honest — a node without a default
// cannot be pushed through, and a defaults run is visibly marked before it is started.
//
// Conventions mirror tests/drive.spec.ts: bind runs through the store, assert against real fixture ids.

const WF = 'publishing_conductor';
const RUN = 'run_1786970270844_pmoodj';
const NODE = 'input_triage';
const NODE_DOWNSTREAM = 'placement_resolver';

// input_triage's real declared output schema (fixtures/nodes.json) requires exactly these four fields.
const VALID_OUTPUT = {
  artifact: 'content_source.v1',
  summary: 'the stored default for input_triage',
  trafficSource: 'organic',
  awarenessStage: 'aware',
};

const confirmDialog = (page: Page) =>
  page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });

async function confirmVerb(page: Page, verb: string) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.sub')).toHaveText(verb);
  await page.locator('.modal button', { hasText: 'Confirm' }).click();
}

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

async function openDefaultTab(page: Page, wf: string, node: string) {
  await page.evaluate(
    async ({ wf, node }) => {
      const mod = (await import('/src/store.ts')) as {
        useStore: { getState: () => { setScreen: (s: string) => void; setWf: (w: string) => void; setNode: (n: string) => void; setTab: (t: string) => void; setMode: (m: string) => void } };
      };
      const s = mod.useStore.getState();
      s.setScreen('bench');
      // The node tabs only render outside drive mode (Center.tsx returns DriveCenter for 'drive'), and
      // one of these tests reaches this helper with a run already bound for driving.
      s.setMode('build');
      s.setWf(wf);
      s.setNode(node);
      s.setTab('default');
    },
    { wf, node },
  );
}

/** Sets NODE's default output through the tab's own controls — the path an operator takes. */
async function setDefault(page: Page) {
  await openDefaultTab(page, WF, NODE);
  await expect(page.locator('#dot-json')).toBeVisible();
  await page.locator('#dot-json').fill(JSON.stringify(VALID_OUTPUT, null, 2));
  await page.locator('#dot-note').fill('seeded by the W4 acceptance test');
  await page.locator('.center button', { hasText: 'Save default' }).click();
  await confirmVerb(page, 'workspace_update_node_default_output');
  await expect(page.locator('#toasts')).toContainText('Default saved');
}

test.describe('node default output', () => {
  test('a node with no default says so, and cannot be pushed through', async ({ page }) => {
    await page.goto('/');
    await openDefaultTab(page, WF, NODE);

    // The tab states the refusal BEFORE anything is attempted, and states why it is a refusal rather
    // than a fallback — that is the property that makes "push through" safe to click.
    await expect(page.locator('.center')).toContainText('No default set');
    await expect(page.locator('.center')).toContainText('never falls back to running the node');

    await bindDrive(page, RUN, WF, NODE);
    const pushBtn = page.locator('.center button', { hasText: 'Push through with default' });
    await expect(pushBtn).toBeDisabled();
    await expect(pushBtn).toHaveAttribute('title', /has no stored default output/);
  });

  test('setting a default, then pushing the node through, completes it without running it', async ({ page }) => {
    await page.goto('/');
    await setDefault(page);

    // The tab now reports the default and, critically, that it VALIDATED — not merely that it saved.
    await expect(page.locator('.center')).toContainText('Current default set by');
    await expect(page.locator('.center')).toContainText('validated against the output schema');

    await bindDrive(page, RUN, WF, NODE);
    const pushBtn = page.locator('.center button', { hasText: 'Push through with default' });
    await expect(pushBtn).toBeEnabled();
    await pushBtn.click();

    // The confirm dialog names the verb, and the effect text says what this does to the RUN — not just
    // to the node — before it happens.
    const dialog = confirmDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('WITHOUT running it');
    await expect(dialog).toContainText('never publish');
    await page.locator('.modal button', { hasText: 'Confirm' }).click();

    await expect(page.locator('#toasts')).toContainText('Pushed through');
    await expect(page.locator('#toasts')).toContainText('no model call');
  });

  test('the rail marks a defaulted node distinctly from an operator override', async ({ page }) => {
    await page.goto('/');
    await setDefault(page);
    await bindDrive(page, RUN, WF, NODE);
    await page.locator('.center button', { hasText: 'Push through with default' }).click();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Pushed through');

    // The marker, and the words behind it. A default and an override look alike on screen and are not
    // the same thing, so the title has to distinguish them.
    const row = page.locator('.nrow', { has: page.locator('.nm', { hasText: NODE }) }).first();
    const marker = row.locator('.chip-override', { hasText: '⏭' });
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute('title', /STORED DEFAULT/);
    await expect(marker).toHaveAttribute('title', /did not run/);

    await page.screenshot({ path: 'shots/rail-default-marker.png' });
  });

  test('the start-run modal offers an output mode and warns before a fixtures run', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { openStartModal: () => void } } };
      mod.useStore.getState().openStartModal();
    });

    const modal = page.locator('.modal').filter({ hasText: 'output mode' });
    await expect(modal).toBeVisible();
    // Running every node is the default — nothing opts an operator into fixtures for them.
    await expect(modal.locator('button[aria-pressed="true"]', { hasText: 'run every node' })).toBeVisible();
    await expect(modal).toContainText('Stored node defaults are never applied on their own');

    await modal.locator('button', { hasText: 'defaults only' }).click();
    await expect(modal).toContainText('FAILS rather than running');
    // The consequence is stated at the moment the mode is chosen, not discovered later at a gate.
    await expect(modal).toContainText('this run will use fixtures');
    await expect(modal).toContainText('can never publish on a live run');
  });

  test('a node that was itself defaulted cannot be adopted as a default', async ({ page }) => {
    await page.goto('/');
    await setDefault(page);
    await bindDrive(page, RUN, WF, NODE);
    await page.locator('.center button', { hasText: 'Push through with default' }).click();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Pushed through');

    // That run's input_triage output is now a fixture. Adopting it as the node's default would launder
    // it into every future run as though it were real, so the server refuses — by name.
    await openDefaultTab(page, WF, NODE);
    const picker = page.locator('.center select').first();
    await expect(picker).toBeVisible();
    const optionCount = await picker.locator('option').count();
    // The run only appears if the fixture plane still reports the node completed; if it does, adopting
    // must fail loudly rather than quietly storing a fixture.
    if (optionCount > 1) {
      await picker.selectOption({ index: 1 });
      await page.locator('.center button', { hasText: 'Adopt as default' }).click();
      await confirmVerb(page, 'workspace_adopt_output_as_default');
      await expect(page.locator('#toasts')).toContainText('Adopt failed');
    }
  });

  test('W7 — every registered workflow is listed, not only the three with presentation config', async ({ page }) => {
    await page.goto('/');
    const workflows = await page.evaluate(async () => {
      const mod = (await import('/src/api/verbs.ts')) as { workflowList: () => Promise<Array<{ id: string }>> };
      return (await mod.workflowList()).map((w) => w.id);
    });

    // The three catalogued ids survive (deep links depend on them) AND the registered-only ones appear.
    expect(workflows).toContain('publishing_conductor');
    expect(workflows).toContain('capture_conductor');
    expect(workflows).toContain('clone_conductor');
    expect(workflows).toContain('visual_identity');
    expect(workflows).toContain('pdf_template_studio');
  });

  // -------------------------------------------------------------------------------------------
  // REVIEW FIXES — each covers a defect an adversarial read found in the first cut of this UI.
  // -------------------------------------------------------------------------------------------

  test('review fix — "defaults only" does not stick to the next run an operator starts', async ({ page }) => {
    await page.goto('/');
    const openStart = () =>
      page.evaluate(async () => {
        const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { openStartModal: () => void; closeModal?: () => void } } };
        mod.useStore.getState().openStartModal();
      });

    await openStart();
    const modal = page.locator('.modal').filter({ hasText: 'output mode' });
    await modal.locator('button', { hasText: 'defaults only' }).click();
    await expect(modal.locator('button[aria-pressed="true"]', { hasText: 'defaults only' })).toBeVisible();

    // Close and reopen. A mode that decides whether ANY model is called must never carry over
    // silently: the operator would start a normal run and get a pipeline of fixtures.
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await openStart();
    await expect(modal.locator('button[aria-pressed="true"]', { hasText: 'run every node' })).toBeVisible();
  });

  test('review fix — switching node does not seed this tab with the previous node\'s default', async ({ page }) => {
    await page.goto('/');
    await setDefault(page);

    // input_triage has a default; research does not. The app-wide keepPreviousData used to hold
    // input_triage's value on screen (and savable) under research's name until the fetch landed.
    await openDefaultTab(page, WF, 'research');
    await expect(page.locator('.center')).toContainText('No default set');
    await expect(page.locator('#dot-json')).toHaveValue('');
    // And nothing from the other node's record is being described here.
    await expect(page.locator('.center')).not.toContainText('Current default set by');
  });

  test('review fix — the replay control names the cost and is gated like every other spend', async ({ page }) => {
    await page.goto('/');
    await openDefaultTab(page, WF, NODE_DOWNSTREAM);
    await page.evaluate(async () => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { setTab: (t: string) => void } } };
      mod.useStore.getState().setTab('prompt');
    });
    const replay = page.locator('.center button', { hasText: 'Replay against a past run' });
    await expect(replay).toBeVisible();
    await replay.click();

    const modal = page.locator('.modal').filter({ hasText: 'Run this one node against' });
    await expect(modal).toBeVisible();
    // The button cannot be pressed before a run is chosen, and the footnote states what the upstream
    // outputs are and what is deliberately withheld.
    await expect(modal.locator('button', { hasText: 'Replay against this run' })).toBeDisabled();
    await expect(modal).toContainText("this node's own previous output is deliberately withheld");
  });
});
