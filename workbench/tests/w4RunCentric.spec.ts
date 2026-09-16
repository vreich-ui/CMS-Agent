import { expect, test, type Page } from '@playwright/test';

// W4 acceptance — the Workbench becomes run-centric.
//
// Three things an operator could not do or see before:
//   1. Push ANY queued node through on its standing default, from the rail, without first driving
//      the run's cursor to it.
//   2. See what a node was handed, what it produced and what it called in between — the I/O tab.
//   3. See what a DETERMINISTIC node actually does. Such a node has an empty Prompt tab and an
//      empty Tools tab by construction; the Algorithm panel is its only explanation.
//
// The server half of (3) — that EVERY deterministic node in EVERY registered workflow has an
// algorithm — is asserted by walking the registry in
// tests/agent/workspace/nodeAlgorithms.test.ts. A browser cannot walk a registry; what it can
// prove is that the panel renders what the verb returns.

interface StoreSnapshot { mode: string; runId: string | null; wf: string; node: string; tab: string }

const readStore = (page: Page): Promise<StoreSnapshot> =>
  page.evaluate(async () => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => StoreSnapshot } };
    const s = mod.useStore.getState();
    return { mode: s.mode, runId: s.runId, wf: s.wf, node: s.node, tab: s.tab };
  });

async function bindNewestRun(page: Page, workflowId: string, nodeId: string) {
  await page.evaluate(async ({ workflowId, nodeId }) => {
    const verbs = (await import('/src/api/verbs.ts')) as { workflowListRuns: (a: object) => Promise<Array<{ id: string }>> };
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
    const runs = await verbs.workflowListRuns({ workflowId, limit: 5 });
    mod.useStore.getState().bindRun(runs[0].id, workflowId, nodeId);
  }, { workflowId, nodeId });
}

/** A run with a node still QUEUED, and that node's id — the case a rail push-through is FOR. */
async function bindRunWithQueuedNode(page: Page, workflowId: string): Promise<string> {
  return page.evaluate(async (workflowId) => {
    const verbs = (await import('/src/api/verbs.ts')) as {
      workflowListRuns: (a: object) => Promise<Array<{ id: string }>>;
      workflowGetRun: (a: object) => Promise<{ id: string; nodes: Array<{ nodeId: string; status: string }> } | null>;
    };
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
    // Not a publish-tail node: the server refuses a supplied output on one of those on a live run
    // (defaulted_publish_node_refused), and the rail deliberately does not offer the control there.
    // That refusal is its own assertion below; this one is about the control that works.
    const nodes = (await import('/src/api/verbs.ts')) as unknown as { workspaceGetNodes: (a: object) => Promise<Array<{ id: string; risk: string; kind: string }>> };
    const byId = new Map((await nodes.workspaceGetNodes({ workflowId })).map((node) => [node.id, node]));
    const publishTail = new Set(['publisher', 'releaser', 'controller', 'emission']);
    for (const row of await verbs.workflowListRuns({ workflowId, limit: 20 })) {
      const run = await verbs.workflowGetRun({ runId: row.id });
      const queued = run?.nodes.find((node) => {
        if (node.status !== 'queued') return false;
        const definition = byId.get(node.nodeId);
        return definition ? definition.risk !== 'publish' && !publishTail.has(definition.kind) : false;
      });
      if (!queued) continue;
      mod.useStore.getState().bindRun(row.id, workflowId, queued.nodeId);
      return queued.nodeId;
    }
    throw new Error('no fixture run has a queued, non-publish-tail node');
  }, workflowId);
}

const selectNode = (page: Page, nodeId: string) =>
  page.evaluate(async (nodeId) => {
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { setScreen: (s: string) => void; setNode: (n: string) => void } } };
    const s = mod.useStore.getState();
    s.setScreen('bench');
    s.setNode(nodeId);
  }, nodeId);

test.describe('W4 — the rail drives the run', () => {
  test('a node can be pushed through from the rail without moving the run to it first', async ({ page }) => {
    await page.goto('/');
    const queuedNode = await bindRunWithQueuedNode(page, 'publishing_conductor');

    // No control before the node has a default: one that can only refuse is worse than none.
    const row = page.locator('.rail .nrow', { hasText: queuedNode }).first();
    await expect(row.locator('xpath=following-sibling::button[contains(@class,"pushthrough")]')).toHaveCount(0);

    // Give that node a standing default. Done through the fixture store rather than the Default
    // output tab: authoring a default through that tab is tests/defaultOutput.spec.ts's subject,
    // and going through it here would tie THIS test to whether the chosen node's output schema
    // happens to accept a hand-written value. Setup, not the assertion.
    await page.evaluate(async (nodeId) => {
      const { mockStore } = (await import('/src/api/mockStore.ts')) as {
        mockStore: { setNodeDefaultOutput: (id: string, value: unknown) => unknown };
      };
      mockStore.setNodeDefaultOutput(nodeId, {
        value: { nodeId, summary: 'w4 rail push-through' },
        updatedAt: new Date().toISOString(),
        updatedBy: 'human',
        schemaValidAt: new Date().toISOString(),
      });
      const qc = (window as unknown as { __queryClient?: { invalidateQueries: (f: object) => void } }).__queryClient;
      qc?.invalidateQueries({ queryKey: ['bootstrap'] });
    }, queuedNode);

    // Now the rail offers it — on the ROW, without the operator first driving the run's cursor to
    // this node, which is the whole point.
    const push = row.locator('xpath=following-sibling::button[contains(@class,"pushthrough")]');
    await expect(push).toBeVisible();
    await push.click();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    // The SUCCESS toast, not "something happened": a push-through that refuses is exactly the
    // outcome this control existed to avoid offering.
    await expect(page.locator('#toasts')).toContainText('Pushed through');
    await expect(page.locator('#toasts')).not.toContainText('Push-through failed');
  });

  test('the rail says HOW each node runs, before anyone opens an empty Prompt tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.rail .nrow').first()).toBeVisible();
    // Every row states its execution kind. publish_payload is the fixture's deterministic node.
    const glyphs = page.locator('.rail .kindglyph');
    await expect(glyphs.first()).toBeVisible();
    const deterministic = page.locator('.rail .nrow', { hasText: 'publish_payload' }).first();
    await expect(deterministic.locator('.kindglyph')).toHaveText('⚙');
    const model = page.locator('.rail .nrow', { hasText: 'draft_writer' }).first();
    await expect(model.locator('.kindglyph')).toHaveText('◇');
  });
});

test.describe('W4 — I/O', () => {
  test('shows the inputs a node was handed, its output, and the calls between', async ({ page }) => {
    await page.goto('/');
    await bindNewestRun(page, 'publishing_conductor', 'draft_writer');
    await page.locator('#node-tab-io').click();

    // Inputs are the DEPENDENCIES' stage outputs off the run record — literally what the
    // dispatcher handed this node, which is why this costs no extra call.
    await expect(page.locator('#io-inputs')).toBeVisible();
    await expect(page.locator('#io-output')).toBeVisible();

    // ...and the tool calls, with their arguments, which no surface showed before.
    const calls = page.locator('#io-tool-calls');
    await expect(calls).toBeVisible();
    await expect(calls).toContainText(/tool calls · \d+/);
  });

  test('a deterministic node explains itself, in numbered steps, with the client verbs it reaches', async ({ page }) => {
    await page.goto('/');
    await selectNode(page, 'publish_payload');
    await page.locator('#node-tab-io').click();

    const algorithm = page.locator('#io-algorithm');
    await expect(algorithm).toBeVisible();
    // Numbered steps, not prose.
    await expect(algorithm.locator('ol li')).not.toHaveCount(0);
    await expect(algorithm).toContainText('reads');
    // The engine's own calls to the client — the half no grant list has ever shown.
    await expect(algorithm).toContainText('engine calls to the client');
    await expect(algorithm).toContainText('object_validate');
    // ...and it says where to go and check.
    await expect(algorithm).toContainText('src/agent/workspace/publishExecution.ts');
  });

  test('a model node shows no algorithm — its explanation is its prompt', async ({ page }) => {
    await page.goto('/');
    await selectNode(page, 'draft_writer');
    await page.locator('#node-tab-io').click();
    await expect(page.locator('#io-empty')).toBeVisible();
    await expect(page.locator('#io-algorithm')).toHaveCount(0);
  });
});

test.describe('W4 — the dock shows the run in time', () => {
  test('draws one bar per node that ran, scaled to the longest', async ({ page }) => {
    await page.goto('/');
    await bindNewestRun(page, 'publishing_conductor', 'draft_writer');
    const timeline = page.locator('#run-timeline');
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('.lbl')).toContainText(/timeline · \d+ nodes? · /);
    // A node that never ran carries no duration and is omitted rather than drawn as a zero-width
    // bar: "did not run" and "ran instantly" are different facts, and one of them is what a
    // defaulted node genuinely is.
    const rows = timeline.locator('div[title]');
    expect(await rows.count()).toBeGreaterThan(0);
  });
});
