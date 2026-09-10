import { expect, test, type Page } from '@playwright/test';

// Defect A/B integration coverage — the real Workbench UI against fixture
// data (VITE_MOCK default), not just outputResolution.ts's pure unit tests
// (tests/outputResolution.spec.ts). Conventions mirror tests/runcontrol.spec.ts
// and tests/drive.spec.ts: bind a run directly via the store, assert against
// real fixture ids, and — new here — against the mock fixture scenarios
// mockStore.ts's CANONICAL_ARTIFACTS / LEGACY_STAGE_RECORDS now carry (see
// that file's own header for why the fixture used to hide this defect).

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

async function setNodeStatus(page: Page, runId: string, nodeId: string, status: string, runStatus?: string) {
  await page.evaluate(
    async ({ runId, nodeId, status, runStatus }) => {
      const mod = (await import('/src/api/mockStore.ts')) as {
        mockStore: { setNodeStatus: (r: string, n: string, patch: object, runStatus?: string) => void };
      };
      mod.mockStore.setNodeStatus(runId, nodeId, { status }, runStatus);
    },
    { runId, nodeId, status, runStatus },
  );
}

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

async function queryStateUpdatedAt(page: Page, runId: string): Promise<number> {
  return page.evaluate((runId) => {
    const qc = (window as unknown as { __queryClient?: { getQueryState: (k: unknown[]) => { dataUpdatedAt: number } | undefined } })
      .__queryClient;
    return qc?.getQueryState(['run', runId])?.dataUpdatedAt ?? 0;
  }, runId);
}

const outputCard = (page: Page) => page.locator('.card', { has: page.locator('.lbl', { hasText: /^output$/ }) });
const confirmDialog = (page: Page) => page.locator('.scrim.open .modal').filter({ has: page.locator('#confirmdialog-title') });
const overrideModal = (page: Page) => page.locator('.modal.ovl-work');

async function waitSettled(page: Page) {
  await expect(page.getByText('loading stage output…')).toHaveCount(0);
}

const WF = 'publishing_conductor';
// mockStore.ts's CANONICAL_ARTIFACTS / LEGACY_STAGE_RECORDS scenario run.
const RUN_A = 'run_1787492010814_kxdbeb';

test.describe('This-run output resolution (Defect A)', () => {
  test('a node with a canonical current-run artifact and no legacy stage record renders the artifact, not the old "no stage output recorded" message', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'draft_writer');
    await waitSettled(page);
    const card = outputCard(page);
    await expect(card).toContainText('current-run artifact');
    await expect(card).toContainText('draft.v1');
    await expect(card).toContainText('"artifact": "draft.v1"');
    await expect(card).not.toContainText('No stage output recorded');
    await expect(card).not.toContainText('legacy stage-store record');
  });

  test('a node with BOTH a canonical artifact and a legacy stage record resolves to the canonical one, never the legacy one', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'publish_payload');
    await waitSettled(page);
    const card = outputCard(page);
    await expect(card).toContainText('current-run artifact');
    await expect(card).toContainText('publish_payload.v1');
    await expect(card).not.toContainText('legacy stage-store record');
  });

  test('a node with ONLY a legacy stage record (no canonical artifact) still renders it, explicitly labelled legacy and unscoped', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'research');
    await waitSettled(page);
    const card = outputCard(page);
    await expect(card).toContainText('legacy stage-store record');
    await expect(card).toContainText("doesn't confirm it belongs to this exact run");
    await expect(card).not.toContainText('current-run artifact');
  });

  test('an operator override beats the current-run canonical artifact', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'input_triage');
    await waitSettled(page);
    const card = outputCard(page);
    await expect(card).toContainText('current-run artifact'); // baseline, before the override

    // input_triage's real declared output schema (fixtures/nodes.json)
    // requires artifact/summary/trafficSource/awarenessStage — a
    // schema-valid override so this test exercises precedence, not the
    // separate second-confirmation path tests/drive.spec.ts already covers.
    const overrideValue = {
      artifact: 'content_source.v1',
      summary: 'override wins test summary',
      trafficSource: 'organic',
      awarenessStage: 'aware',
      marker: 'operator-supplied',
    };
    await card.locator('button', { hasText: '⎘ Override output…' }).click();
    const modal = overrideModal(page);
    await expect(modal).toBeVisible();
    await page.locator('#override-json').fill(JSON.stringify(overrideValue));
    await page.locator('#override-note').fill('override wins test note');
    await modal.locator('button', { hasText: 'Save override' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('stage_save_output');
    await expect(modal).toHaveCount(0);

    await expect(card).toContainText('this output was supplied by the operator');
    await expect(card).toContainText('override wins test note');
    await expect(card).toContainText('"marker": "operator-supplied"');
    await expect(card).not.toContainText('current-run artifact ·');
  });

  test('a large output (well past the initial bound) stays usable: a capped preview, an honest full size, and the complete value on demand', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'draft_writer');
    await waitSettled(page);

    // draft_writer's declared output schema requires artifact (const
    // 'draft.v1') + summary — kept schema-valid so this exercises the
    // bound, not the separate second-confirmation path.
    const bigValue = {
      artifact: 'draft.v1',
      summary: 'large output test',
      blob: 'A'.repeat(50_000),
      marker: 'END-OF-BLOB-MARKER',
    };
    await outputCard(page).locator('button', { hasText: '⎘ Override output…' }).click();
    const modal = overrideModal(page);
    await page.locator('#override-json').fill(JSON.stringify(bigValue));
    await modal.locator('button', { hasText: 'Save override' }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(modal).toHaveCount(0);

    const card = outputCard(page);
    await expect(card).toContainText('Showing the first 8,000 of');
    await expect(card).not.toContainText('END-OF-BLOB-MARKER'); // not in the DOM yet — genuinely capped, not just visually clipped
    await card.locator('button', { hasText: 'show full value' }).click();
    await expect(card).toContainText('Showing the full value —');
    await expect(card).toContainText('END-OF-BLOB-MARKER'); // now reachable — nothing was discarded
  });
});

test.describe('This-run empty-state honesty (Defect B)', () => {
  test('a node not yet engaged in this run says so plainly — never a stage-output claim', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, 'run_1786970270844_pmoodj', 'publishing_conductor', 'placement_resolver');
    await expect(page.locator('.nhead .id')).toHaveText('placement_resolver');
    await expect(page.locator('.center')).toContainText('Not engaged in');
    await expect(page.locator('.center')).not.toContainText('No stage output recorded');
  });

  test('a blocked node gets an honest "blocked on a gate" empty message', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'publish_executor');
    await waitSettled(page);
    await expect(outputCard(page)).toContainText('blocked on a gate');
  });

  test('a failed node with nothing recorded gets a precise "failed" message, not the old generic one', async ({ page }) => {
    await page.goto('/');
    // reader_simulation in this run is a real failed node with neither a
    // canonical artifact nor a legacy stage record — unlike input_triage,
    // draft_writer, publish_payload or research, which the fixture
    // deliberately seeds with one or the other for the precedence tests
    // above, and which would leak an unscoped legacy record here (stage
    // lookups are scoped by nodeId only, never by run).
    await bindRunDirectly(page, 'run_1787408495018_e97wrk', 'publishing_conductor', 'reader_simulation');
    await waitSettled(page);
    await expect(outputCard(page)).toContainText('failed and recorded no output');
  });

  test('a genuinely completed node with nothing recorded gets a precise "completed" message, not the old generic one', async ({ page }) => {
    await page.goto('/');
    await bindRunDirectly(page, RUN_A, WF, 'human_texture');
    await waitSettled(page);
    await expect(outputCard(page)).toContainText('completed but recorded no output');
  });

  // REVIEW FIX (R3) — these two together are the whole paused-vs-blocked contract.
  // A run-level pause is a fact about the RUN; it is not a licence to overwrite what a
  // node's own record says. Pausing a run that had stopped on the publish-approval gate
  // used to repaint that node 'paused' and drop the gate card, which took away the only
  // explanation of why the run stopped.
  test('a paused run keeps its run-level "run paused here" chip but does NOT erase a gate-blocked node\'s own state — the gate is still explained', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async (runId) => {
      const mod = (await import('/src/api/mockStore.ts')) as { mockStore: { updateRunRaw: (id: string, patch: object) => void } };
      mod.mockStore.updateRunRaw(runId, { status: 'paused' });
    }, RUN_A);
    await bindRunDirectly(page, RUN_A, WF, 'publish_executor');
    await waitSettled(page);

    // The run's own pause is still stated, in the run's own chip.
    await expect(page.locator('.nhead .chip.paused')).toHaveText('run paused here');
    // ...and the node still reports the gate it is actually stopped on.
    await expect(outputCard(page)).toContainText('blocked on a gate');
  });

  test('a node that had not itself reached a state DOES read paused under a paused run — never blocked — with paused-specific copy', async ({ page }) => {
    await page.goto('/');
    await setNodeStatus(page, RUN_A, 'publish_executor', 'running', 'paused');
    await bindRunDirectly(page, RUN_A, WF, 'publish_executor');
    await waitSettled(page);

    await expect(page.locator('.nhead .chip.paused')).toHaveText('run paused here');
    await expect(page.locator('.center .kv .chip.paused')).toBeVisible();
    await expect(page.locator('.center .lbl', { hasText: /^gate$/ })).toHaveCount(0); // not painted as a blocked gate
    await expect(outputCard(page)).toContainText('This run is paused before this node finished');
  });
});

test.describe('Active-run freshness (Defect B)', () => {
  test('a non-terminal bound run polls in the background; a terminal run does not', async ({ page }) => {
    await page.goto('/');
    await setNodeStatus(page, RUN_A, 'publish_executor', 'running', 'running');
    await bindRunDirectly(page, RUN_A, WF, 'publish_executor');
    await expect(page.locator('.center .kv .chip.running')).toBeVisible();

    await expect.poll(() => queryStateUpdatedAt(page, RUN_A)).toBeGreaterThan(0);
    const t0 = await queryStateUpdatedAt(page, RUN_A);
    await page.waitForTimeout(5000);
    const t1 = await queryStateUpdatedAt(page, RUN_A);
    expect(t1).toBeGreaterThan(t0); // the active run kept refreshing on its own

    // A terminal (completed) run is a different query key — confirm it does
    // NOT keep refreshing once bound.
    const RUN_DONE = 'run_1787660289228_5ypfpm';
    await bindRunDirectly(page, RUN_DONE, 'capture_conductor', 'capture_crawl');
    await expect(page.locator('.nhead .id')).toHaveText('capture_crawl');
    await expect.poll(() => queryStateUpdatedAt(page, RUN_DONE)).toBeGreaterThan(0);
    const d0 = await queryStateUpdatedAt(page, RUN_DONE);
    await page.waitForTimeout(5000);
    const d1 = await queryStateUpdatedAt(page, RUN_DONE);
    expect(d1).toBe(d0);
  });

  test('a node transitioning into a terminal state refreshes its output without a page reload', async ({ page }) => {
    await page.goto('/');
    const nodeId = 'human_texture';
    await setNodeStatus(page, RUN_A, nodeId, 'running', 'running');
    await bindRunDirectly(page, RUN_A, WF, nodeId);
    await waitSettled(page);
    await expect(page.locator('.center .kv .chip.running')).toBeVisible();
    const card = outputCard(page);
    await expect(card).toContainText('This node is still running');

    // Simulate the node completing with a real output landing — mutating
    // the store directly (no verb call, no invalidation of our own), the
    // same way an actual background poll would observe a backend change.
    await setNodeStatus(page, RUN_A, nodeId, 'completed');
    await saveOverride(page, RUN_A, nodeId, { landed: 'just now' }, 'simulated completion');

    // No reload anywhere above — active-run polling has to pick up the
    // status change, and the transition-invalidation effect has to refetch
    // the output query, entirely on its own.
    await expect(page.locator('.center .kv .chip.completed')).toBeVisible({ timeout: 9000 });
    await expect(card).toContainText('this output was supplied by the operator', { timeout: 9000 });
    await expect(card).toContainText('"landed": "just now"');
  });
});
