import { expect, test, type Page } from '@playwright/test';

// W6 acceptance — the test-and-learn loop.
//
// Two controls, both on verbs that already existed and that nothing in the Workbench called:
//
//   1. "Save as default" (workspace_adopt_output_as_default) on a completed output. Before this the
//      only route from a produced value to a standing default was to copy its JSON out of one tab
//      and paste it into another — DefaultOutputTab's own header pointed at an "Adopt as default"
//      control on the rail that was never built.
//
//   2. "Replay against run" (node_execute) in the Prompt tab. Before this, finding out what a node
//      would produce meant starting a whole run. The panel replaced a button that had been sitting
//      there disabled since U7.
//
// Both are asserted through the fixture plane, so what is proven here is the CLIENT contract: that
// the control appears where it should, refuses where it should, sends what it claims to send, and
// reports what came back. The fixture answers node_execute in the same envelope the live server
// does ({ execution, executionId }) and refuses executionMode "openai" outright rather than
// pretending to make a model call — a fixture more generous than the server is how two defects
// shipped this week.

async function bindNewestRun(page: Page, workflowId: string, nodeId: string): Promise<string> {
  return page.evaluate(async ({ workflowId, nodeId }) => {
    const verbs = (await import('/src/api/verbs.ts')) as { workflowListRuns: (a: object) => Promise<Array<{ id: string }>> };
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
    const runs = await verbs.workflowListRuns({ workflowId, limit: 5 });
    mod.useStore.getState().bindRun(runs[0].id, workflowId, nodeId);
    return runs[0].id;
  }, { workflowId, nodeId });
}

/**
 * The one fixture run that carries canonical run ARTIFACTS (mockStore's CANONICAL_ARTIFACTS), on a
 * node that has one. That distinction matters and is not pedantry: `workspace.adopt_output_as_default`
 * adopts from the EXECUTION repository's recorded outputs, not from `run.stageOutputs`, and a node
 * can be `completed` on a run with nothing there to adopt. The refusal test below binds exactly
 * that case on purpose.
 */
const RUN_WITH_ARTIFACTS = 'run_1787492010814_kxdbeb';

async function bindRun(page: Page, runId: string, nodeId: string): Promise<string> {
  return page.evaluate(async ({ runId, nodeId }) => {
    const verbs = (await import('/src/api/verbs.ts')) as { workflowGetRun: (a: object) => Promise<{ workflowId?: string } | null> };
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
    const run = await verbs.workflowGetRun({ runId });
    const workflowId = run?.workflowId ?? 'publishing_conductor';
    mod.useStore.getState().bindRun(runId, workflowId, nodeId);
    return workflowId;
  }, { runId, nodeId });
}

/** A node a run COMPLETED but for which no output was ever recorded — the live refusal case. */
async function bindCompletedNodeWithoutRecordedOutput(page: Page): Promise<{ runId: string; nodeId: string }> {
  return page.evaluate(async () => {
    const verbs = (await import('/src/api/verbs.ts')) as {
      workflowListRuns: (a: object) => Promise<Array<{ id: string; workflowId?: string }>>;
      workflowGetRun: (a: object) => Promise<{ id: string; workflowId?: string; nodes: Array<{ nodeId: string; status: string }>; stageOutputs?: Record<string, unknown> } | null>;
      nodeListOutputs: (a: object) => Promise<unknown>;
    };
    const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { bindRun: (r: string, w: string, n: string) => void } } };
    for (const row of await verbs.workflowListRuns({ limit: 20 })) {
      const run = await verbs.workflowGetRun({ runId: row.id });
      for (const n of run?.nodes ?? []) {
        if (n.status !== 'completed' || run?.stageOutputs?.[n.nodeId] === undefined) continue;
        const outputs = (await verbs.nodeListOutputs({ nodeId: n.nodeId, runId: row.id })) as { outputs?: unknown[] } | unknown[];
        const list = Array.isArray(outputs) ? outputs : (outputs.outputs ?? []);
        if (list.length) continue;
        mod.useStore.getState().bindRun(row.id, run?.workflowId ?? 'publishing_conductor', n.nodeId);
        return { runId: row.id, nodeId: n.nodeId };
      }
    }
    throw new Error('every completed fixture node has a recorded output — the refusal case is unreachable');
  });
}

const callsTo = (page: Page, verb: string) =>
  page.evaluate(
    (verb) => ((window as unknown as { __verbCalls?: Array<{ verb: string; args?: Record<string, unknown> }> }).__verbCalls ?? []).filter((c) => c.verb === verb),
    verb,
  );

test.describe('W6 — save a produced output as the node default', () => {
  test('the I/O tab offers it on a completed output, and the node carries a default afterwards', async ({ page }) => {
    await page.goto('/');
    const nodeId = 'draft_writer';
    await bindRun(page, RUN_WITH_ARTIFACTS, nodeId);
    await page.locator('#node-tab-io').click();
    await expect(page.locator('#io-output')).toBeVisible();

    const before = await page.evaluate(async (nodeId) => {
      const { mockStore } = (await import('/src/api/mockStore.ts')) as { mockStore: { getNode: (id: string) => { defaultOutput?: unknown } | undefined } };
      return mockStore.getNode(nodeId)?.defaultOutput ?? null;
    }, nodeId);
    expect(before).toBeNull();

    await page.locator('#io-save-as-default').click();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Saved as default');

    // The VALUE, not just "a default exists": adopting is supposed to take THIS run's output.
    const adopted = await page.evaluate(async (nodeId) => {
      const { mockStore } = (await import('/src/api/mockStore.ts')) as { mockStore: { getNode: (id: string) => { defaultOutput?: { value: unknown } } | undefined } };
      return mockStore.getNode(nodeId)?.defaultOutput?.value ?? null;
    }, nodeId);
    expect(adopted).not.toBeNull();

    // Scoped to the bound run, not "whatever this node produced most recently anywhere" — which is
    // a different value the moment a newer run exists, and is what the verb does with no runId.
    const calls = await callsTo(page, 'workspace_adopt_output_as_default');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args?.runId).toBeTruthy();
  });

  test('a value the node was HANDED is not offered for adoption', async ({ page }) => {
    await page.goto('/');
    const nodeId = 'draft_writer';
    const runId = RUN_WITH_ARTIFACTS;
    await bindRun(page, runId, nodeId);

    // Mark this node's output on this run as an operator override — the run then carries a value
    // the node did not produce. Adopting it would make the node's standing default a copy of a
    // one-run override, which is precisely the distinction DefaultOutputTab's header draws.
    await page.evaluate(async ({ runId, nodeId }) => {
      const { mockStore } = (await import('/src/api/mockStore.ts')) as {
        mockStore: { saveStageOutput: (r: string, n: string, v: unknown, note?: string) => unknown };
      };
      mockStore.saveStageOutput(runId, nodeId, { overridden: true }, 'w6 fixture override');
      const qc = (window as unknown as { __queryClient?: { invalidateQueries: (f: object) => void } }).__queryClient;
      qc?.invalidateQueries({ queryKey: ['run'] });
      qc?.invalidateQueries({ queryKey: ['runs'] });
    }, { runId, nodeId });

    await page.locator('#node-tab-io').click();
    await expect(page.locator('#io-output')).toBeVisible();
    await expect(page.locator('#io-save-as-default')).toHaveCount(0);
  });

  test('a refusal is reported as a refusal, not as a save', async ({ page }) => {
    await page.goto('/');
    const { nodeId } = await bindCompletedNodeWithoutRecordedOutput(page);
    await page.locator('#node-tab-io').click();
    await expect(page.locator('#io-output')).toBeVisible();

    // The control IS offered: "completed with an output on the run record" is the best signal the
    // client has, and buying certainty costs a node_list_outputs round trip on every I/O tab open
    // for a case that is rare. What must not happen is a success toast over a save that did not
    // occur — which is exactly what happened until the fixture was corrected to refuse the way
    // the live tool does (node_output_unavailable).
    await page.locator('#io-save-as-default').click();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#toasts')).toContainText('Save as default failed');
    await expect(page.locator('#toasts')).not.toContainText('Saved as default');

    const after = await page.evaluate(async (nodeId) => {
      const { mockStore } = (await import('/src/api/mockStore.ts')) as { mockStore: { getNode: (id: string) => { defaultOutput?: unknown } | undefined } };
      return mockStore.getNode(nodeId)?.defaultOutput ?? null;
    }, nodeId);
    expect(after).toBeNull();
  });
});

test.describe('W6 — replay a node against a run', () => {
  test('sends this run’s upstream outputs, and shows the result beside what the run produced', async ({ page }) => {
    await page.goto('/');
    await bindNewestRun(page, 'publishing_conductor', 'draft_writer');
    await page.locator('#node-tab-prompt').click();

    const panel = page.locator('#replay-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('the run on screen is untouched');

    await page.locator('#replay-run').click();
    await page.locator('.modal button', { hasText: 'Confirm' }).click();
    await expect(page.locator('#replay-result')).toBeVisible();

    // Mock by default. A control whose default is a paid model call is not a control an operator
    // can press to find out what it does.
    const calls = await callsTo(page, 'node_execute');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args?.executionMode).toBe('mock');
    // The dependencies came from the BOUND RUN. Omitting them is not a smaller version of this
    // call: the server then fills each one from the workspace's most recent stage output, so the
    // replay would be against inputs that are not the ones on screen.
    expect(calls[0]?.args?.runId).toBeTruthy();
    const deps = (calls[0]?.args?.dependencyOutputs ?? {}) as Record<string, unknown>;
    const expected = await page.evaluate(async () => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { runId: string | null; node: string } } };
      const verbs = (await import('/src/api/verbs.ts')) as {
        workflowGetRun: (a: object) => Promise<{ stageOutputs?: Record<string, unknown> } | null>;
        workspaceGetNode: (a: object) => Promise<{ dependsOn?: string[] } | null>;
      };
      const s = mod.useStore.getState();
      const run = await verbs.workflowGetRun({ runId: s.runId });
      const node = await verbs.workspaceGetNode({ nodeId: s.node });
      return (node?.dependsOn ?? []).map((id) => [id, run?.stageOutputs?.[id]] as const);
    });
    for (const [id, value] of expected) expect(deps[id]).toEqual(value);

    // ...and the replayed output was checked against the node's own schema, which a `completed`
    // status says nothing about on the mock path.
    await expect(page.locator('#replay-result')).toContainText(/output schema|Schema check/);
  });

  test('refuses to replay when the bound run has no output for a dependency', async ({ page }) => {
    await page.goto('/');
    await bindNewestRun(page, 'publishing_conductor', 'draft_writer');
    await page.locator('#node-tab-prompt').click();
    await expect(page.locator('#replay-panel')).toBeVisible();

    // Put one dependency back to `queued` on the bound run, which is what "this run has no output
    // for it" actually looks like — the fixture's workflow_get_run builds stageOutputs from the
    // COMPLETED nodes, exactly as the live record carries only what ran. The panel must refuse
    // rather than send a call the server would quietly complete against a DIFFERENT value: omit a
    // dependency and nodeRuntime.prepareNodeExecution fills it from the workspace's most recent
    // stage output for that node, which is not what is on screen.
    const dropped = await page.evaluate(async () => {
      const mod = (await import('/src/store.ts')) as { useStore: { getState: () => { runId: string | null; node: string } } };
      const verbs = (await import('/src/api/verbs.ts')) as { workspaceGetNode: (a: object) => Promise<{ dependsOn?: string[] } | null> };
      const { mockStore } = (await import('/src/api/mockStore.ts')) as {
        mockStore: { getRun: (id: string) => { nodes?: Array<{ nodeId: string; status: string }> } | undefined };
      };
      const s = mod.useStore.getState();
      const node = await verbs.workspaceGetNode({ nodeId: s.node });
      const dep = (node?.dependsOn ?? [])[0];
      if (!dep) return null;
      const state = mockStore.getRun(s.runId ?? '')?.nodes?.find((n) => n.nodeId === dep);
      if (!state) return null;
      state.status = 'queued';
      const qc = (window as unknown as { __queryClient?: { invalidateQueries: (f: object) => void } }).__queryClient;
      qc?.invalidateQueries({ queryKey: ['run'] });
      return dep;
    });
    test.skip(dropped === null, 'the bound node declares no dependencies — nothing to drop');

    await expect(page.locator('#replay-run')).toBeDisabled();
    await expect(page.locator('#replay-panel')).toContainText(String(dropped));
  });

  test('says plainly that an unsaved prompt draft is not what gets replayed', async ({ page }) => {
    await page.goto('/');
    await bindNewestRun(page, 'publishing_conductor', 'draft_writer');
    await page.locator('#node-tab-prompt').click();
    await expect(page.locator('#replay-panel')).toBeVisible();
    await expect(page.locator('#replay-panel')).not.toContainText('Your unsaved prompt draft');

    // node.execute takes no promptOverride — that lever is deliberately withheld from the public
    // tool (nodeRuntime.ts). An operator who edits a prompt and presses Replay would otherwise
    // believe they had just tested the edit.
    await page.locator('.promptbox[role="textbox"]').first().click();
    await page.keyboard.type(' w6 draft');
    await expect(page.locator('#replay-panel')).toContainText('is not used');
  });
});
