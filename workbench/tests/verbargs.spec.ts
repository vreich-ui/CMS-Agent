import { expect, test } from '@playwright/test';

// Regression guard (workbench-verb-fixes) — every control-plane MCP tool
// declares `additionalProperties: false`, so a wrong argument key is a hard
// rejection live, even though fixture mode never round-trips over the wire
// and so never caught it. This file pins the corrected argument keys for
// the nine verbs verbs.ts got live-verified against, the same way
// tests/runcontrol.spec.ts and tests/data.spec.ts already reach real module
// exports via a dynamic `import('/src/...')` from Vite's dev server —
// nothing here is mocked beyond the fixture-mode `mockStore` every other
// spec in this suite already runs against.
//
// Where the mock handler is argument-agnostic (changes_get always returns
// null — there is no change-history fixture to look one up in), the
// behavioural round-trip can't discriminate a wrong key, so that one case
// is pinned by asserting the corrected key literally appears in the
// verb's own source instead (see the last test below).

async function loadVerbs(page: import('@playwright/test').Page) {
  await page.goto('/');
  return page.evaluate(async () => {
    const mod = await import('/src/api/verbs.ts');
    // The booted app has already swapped in the real confirm-dialog handler
    // (WP-21) — a mutating verb called directly, outside a click, would hang
    // waiting for a click that never comes. `resetConfirmHandler` (exported
    // "mainly for tests") restores the mock-bypass default for this one
    // direct call to changesRestore below.
    const confirmMod = await import('/src/api/confirmAction.ts');
    confirmMod.resetConfirmHandler();

    // Exercise every corrected verb and hand back only the small, plain
    // facts each assertion needs — page.evaluate's return value must be
    // structured-cloneable.
    const nodeById = await mod.workspaceGetNode({ nodeId: 'input_triage' });
    const effectiveConfig = await mod.workspaceGetNodeEffectiveConfig({ nodeId: 'input_triage' });
    const allNodes = await mod.workspaceGetNodes();
    const filteredNodes = await mod.workspaceGetNodes({ workflowId: 'publishing_conductor' });
    const allObservations = await mod.learningListObservations();
    const filteredObservations = await mod.learningListObservations({ nodeId: 'publish_executor' });
    // run_1787567811920_hevotl has every publishing_conductor node done —
    // input_triage (that workflow's own node) is a guaranteed match;
    // clone_intake (a different workflow's node) can never appear in this
    // run's outputs, regardless of the mock's node ordering.
    const presentOutput = await mod.stageGetOutput({ runId: 'run_1787567811920_hevotl', nodeId: 'input_triage' });
    const missingOutput = await mod.stageGetOutput({ runId: 'run_1787567811920_hevotl', nodeId: 'clone_intake' });
    const diff = await mod.changesCompare({ fromRevisionId: 'rev-from-x', toRevisionId: 'rev-to-y' });
    const restored = await mod.changesRestore({ nodeId: 'input_triage', revisionId: 'rev-restore-z' });

    return {
      nodeById: nodeById ? { id: nodeById.id } : null,
      effectiveConfig: effectiveConfig ? { nodeId: (effectiveConfig as { nodeId?: string }).nodeId } : null,
      allNodesCount: allNodes.length,
      filteredNodesCount: filteredNodes.length,
      filteredNodesAllInAll: filteredNodes.every((n) => allNodes.some((a) => a.id === n.id)),
      allObservationsCount: allObservations.length,
      filteredObservationsCount: filteredObservations.length,
      filteredObservationsAllMatch: filteredObservations.every(
        (o) => (o as unknown as { node?: string }).node === 'publish_executor',
      ),
      presentOutput: { output: presentOutput.output, note: presentOutput.note ?? null },
      missingOutput: { output: missingOutput.output, note: missingOutput.note ?? null },
      diff: diff as unknown as { fromRevisionId?: string; toRevisionId?: string },
      restored: restored as unknown as { changeId?: string },
    };
  });
}

test('verb argument regression guard — workspace_get_node/_effective_config send {id}, not {nodeId}', async ({
  page,
}) => {
  const r = await loadVerbs(page);
  // The mock handler looks the node up by `str(a, 'id')` — if verbs.ts ever
  // regresses to sending `nodeId` again, both resolve to a miss (null /
  // undefined nodeId), same as a live `additionalProperties: false` reject
  // would (silently, via the wrong key never reaching the lookup).
  expect(r.nodeById).toEqual({ id: 'input_triage' });
  expect(r.effectiveConfig).toEqual({ nodeId: 'input_triage' });
});

test('verb argument regression guard — workspace_get_nodes takes no server args; workflowId filters client-side', async ({
  page,
}) => {
  const r = await loadVerbs(page);
  expect(r.allNodesCount).toBeGreaterThan(0);
  expect(r.filteredNodesCount).toBeGreaterThan(0);
  // workbench-verb-fixes: workspace_get_nodes only ever returns
  // publishing_conductor's nodes live (clone/capture are invisible to it —
  // see fixtures/README.md), so filtering by workflowId:'publishing_conductor'
  // no longer narrows anything — every node IS in that workflow. The filter
  // still runs (filteredNodesAllInAll proves it didn't just return
  // everything unfiltered by accident); it just has nothing to exclude.
  expect(r.filteredNodesCount).toBe(r.allNodesCount);
  expect(r.filteredNodesAllInAll).toBe(true);
});

test('verb argument regression guard — learning_list_observations takes no nodeId server-side; filters client-side', async ({
  page,
}) => {
  const r = await loadVerbs(page);
  expect(r.allObservationsCount).toBeGreaterThan(0);
  expect(r.filteredObservationsCount).toBeGreaterThan(0);
  expect(r.filteredObservationsCount).toBeLessThan(r.allObservationsCount);
  expect(r.filteredObservationsAllMatch).toBe(true);
});

test('verb argument regression guard — stage_get_output/stage_list_outputs resolve by (runId, nodeId) composed over {stage}, never a doomed direct call', async ({
  page,
}) => {
  const r = await loadVerbs(page);
  // input_triage belongs to this (fully-completed) run's own workflow — a real match.
  expect(r.presentOutput.note).toBeNull();
  expect(r.presentOutput.output).not.toBeNull();
  // clone_intake belongs to a different workflow entirely — never in this
  // run's outputs — an honest "unavailable" note, never a thrown error.
  expect(r.missingOutput.output).toBeNull();
  expect(r.missingOutput.note).toBe('No stage output recorded for this node in this run.');
});

test('verb argument regression guard — changes_compare sends {fromRevisionId, toRevisionId}, not {nodeId, from, to}', async ({
  page,
}) => {
  const r = await loadVerbs(page);
  expect(r.diff.fromRevisionId).toBe('rev-from-x');
  expect(r.diff.toRevisionId).toBe('rev-to-y');
});

test('verb argument regression guard — changes_restore sends {nodeId, revisionId}, not {nodeId, changeId}', async ({
  page,
}) => {
  const r = await loadVerbs(page);
  expect(r.restored.changeId).toBe('rev-restore-z');
});

test('verb argument regression guard — changes_get sends {eventId}, not {changeId} (source-pinned: the mock has no change-history fixture to round-trip through)', async ({
  page,
}) => {
  await page.goto('/');
  const source = await page.evaluate(() => fetch('/src/api/verbs.ts').then((r) => r.text()));
  const fn = source.slice(source.indexOf('export const changesGet'), source.indexOf('export const changesCompare'));
  // Vite serves dev-transformed source (double-quoted, comments stripped),
  // not the on-disk TS verbatim — assert on the transformed literal shape.
  expect(fn).toContain('changes_get');
  expect(fn).toContain('eventId: args.changeId');
  expect(fn).not.toContain('changeId: args.changeId');
});
