// Fixture-mode verb resolution — the whole mock plane, in its own module.
//
// Why this is not in api/client.ts any more: the fixture set is ~600 KB of
// JSON (48 real node definitions with their prompts and schemas, 200-odd run
// records, change history). Imported statically from client.ts it shipped in
// the production bundle — half a megabyte of data that a deployed build can
// never reach, paid for on every cold load, against a 2.5 s
// time-to-interactive budget.
//
// It now lives behind a dynamic `import()` in client.ts's callVerbMock, so
// the bundler splits it into a chunk that a deployed build never requests.
// Nothing about fixture-mode behaviour changes: same handlers, same store,
// same artificial delay.

import { mockStore } from '../mockStore';
import * as adapters from '../adapters';
import { MUTATING_VERBS } from '../client';
import type { Skill } from '../../types';

const MOCK_DELAY_MS = 120;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}
// Opaque page token minted by this fixture's workflow_list_runs. Live encodes
// (startedAt, runId); the client never looks inside either, so an offset is enough here.
const MOCK_RUN_CURSOR = 'mock-run-cursor:';

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
function optNum(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

let mockIdCounter = 0;
let mockWorkspaceVersion = 1;
let mockRevisionId = 'mock-rev-1';
function genId(prefix: string): string {
  mockIdCounter += 1;
  return `${prefix}_${Date.now()}_${mockIdCounter.toString(36)}`;
}

function assertMockPrecondition(a: Args) {
  const expected = optNum(a, 'expectedWorkspaceVersion');
  const base = optStr(a, 'baseRevisionId');
  if (expected !== undefined && expected !== mockWorkspaceVersion) {
    throw new Error(`workspace_version_conflict: expected ${expected}, current ${mockWorkspaceVersion}`);
  }
  if (base !== undefined && base !== mockRevisionId) {
    throw new Error(`revision_conflict: expected ${base}, current ${mockRevisionId}`);
  }
}

function commitMockWorkspace() {
  mockWorkspaceVersion += 1;
  mockRevisionId = `mock-rev-${mockWorkspaceVersion}`;
}

function schemaStub(nodeId: string, kind: 'input' | 'output'): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
    description: `No live ${kind} schema captured for "${nodeId}" in the fixture set — placeholder schema.`,
  };
}

function toolsFor(node: adapters.RawWorkflowNode | undefined): adapters.RawToolDef[] {
  if (!node) return [];
  const all = mockStore.getTools();
  return node.allowedTools.map((id) => all.find((t) => t.toolId === id)).filter((t): t is adapters.RawToolDef => Boolean(t));
}
function skillsFor(node: adapters.RawWorkflowNode | undefined): Skill[] {
  if (!node) return [];
  const all = mockStore.getSkills();
  return node.assignedSkills
    .map((id) => all.find((s) => s.skillId === id))
    .filter((s): s is adapters.RawSkill => Boolean(s))
    .map((s) => adapters.toSkill(s, mockStore.assignedToFor(s.skillId)));
}

/**
 * WP-00 CORRECTION. Live `workspace_get_graph` returns FULL node objects —
 * the same fields `workspace_get_nodes` returns — plus an `edges` array,
 * and it genuinely honours `workflowId`. This mock previously returned
 * `{id, deps}` stubs, which was fine while nothing consumed graph nodes as
 * nodes; now that the rail's node set comes from the graph (see
 * verbs.workspaceGetNodes), a stub here would give fixture mode a rail of
 * nameless rows while live mode looked right. Mirror the live shape.
 *
 * With no workflowId, live returns the flat store view of every node —
 * mirrored here too.
 */
// The registry the live server reports, which is deliberately LARGER than WORKFLOW_CATALOG — the
// Workbench has to render a workflow whose presentation config it does not have, and fixture mode
// is where that is proven.
const MOCK_REGISTERED_WORKFLOW_IDS = [
  'publishing_conductor', 'clone_conductor', 'capture_conductor',
  // Registered on the live plane, absent from WORKFLOW_CATALOG — the case the deck has to render
  // honestly rather than silently omit. One is enough to prove it; the live registry has five.
  'visual_identity',
];

/** Mirrors summarizeWorkspaceNode: absent means empty, absent means false. */
function summarizeMockNode(node: adapters.RawWorkflowNode & { metadata?: Record<string, unknown>; position?: { x: number; y: number } }) {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    executionKind: (node.metadata && Object.keys(node.metadata).some((key) => key.toLowerCase().includes('deterministic'))) ? 'deterministic' : 'model',
    status: node.status ?? 'active',
    riskLevel: node.riskLevel,
    ...(node.dependsOn?.length ? { dependsOn: node.dependsOn } : {}),
    ...(node.requiredInputs?.length ? { requiredInputs: node.requiredInputs } : {}),
    ...(node.produces?.length ? { produces: node.produces } : {}),
    ...(node.position ? { position: node.position } : {}),
    ...(node.defaultOutput ? { hasDefaultOutput: true } : {}),
    promptSha: `mock${(node.prompt ?? '').length.toString(16).padStart(8, '0')}`,
    updatedAt: node.updatedAt,
  };
}

function graphFor(workflowId: string): {
  workflowId: string;
  nodes: adapters.RawWorkflowNode[];
  edges: Array<{ from: string; to: string }>;
} {
  const all = mockStore.getNodes();
  const wf = workflowId ? mockStore.getWorkflow(workflowId) : undefined;
  if (!workflowId || !wf) {
    const edges: Array<{ from: string; to: string }> = [];
    for (const n of all) {
      for (const dep of (n.dependsOn as string[] | undefined) ?? []) edges.push({ from: dep, to: n.id });
    }
    return { workflowId, nodes: all, edges };
  }
  const order: string[] = wf.phases.flatMap(([, ids]) => ids);
  const byId = new Map(all.map((n) => [n.id, n]));
  const nodes = order.map((id) => byId.get(id)).filter((n): n is adapters.RawWorkflowNode => Boolean(n));
  const edges: Array<{ from: string; to: string }> = [];
  for (let i = 1; i < order.length; i++) edges.push({ from: order[i - 1], to: order[i] });
  return { workflowId, nodes, edges };
}

/** `err`/`done` — the same two counts toRun() itself derives from a raw
 *  run's `nodes[]`/`errors[]` — needed by a couple of mock handlers below
 *  that reason about run progress without going through the full adapter. */
function errCount(run: adapters.RawRun): number {
  return run.errors.length;
}
function doneCount(run: adapters.RawRun): number {
  return run.nodes.filter((n) => n.status === 'completed').length;
}

const MOCK_HANDLERS: Record<string, (args: Args) => unknown> = {
  // -- workspace / node reads --
  // workspace_get_graph honours `workflowId` live (WP-00 capture);
  // workspace_get_nodes takes no arguments at all and always returns the
  // whole workspace. Both mirrored exactly.
  workspace_get_graph: (a) => graphFor(str(a, 'workflowId')),
  // W3 — the fixture must answer the same one-call first paint live does, or fixture mode stops
  // being evidence about the client. The `detail: "summary"` projection is mirrored field for
  // field (src/agent/workspace/nodeProjection.ts), including "absent means empty".
  workbench_bootstrap: (a) => {
    const workflowId = optStr(a, 'workflowId');
    const registeredWorkflowIds = MOCK_REGISTERED_WORKFLOW_IDS;
    const known = workflowId ? registeredWorkflowIds.includes(workflowId) : false;
    const graph = workflowId && known ? graphFor(workflowId) : null;
    const runs = workflowId && known
      ? mockStore.getRuns({ workflowId }).slice(0, 5).map(({ nodes, errors, ...row }) => ({
          ...row,
          nodeCount: nodes?.length ?? 0,
          completedCount: (nodes ?? []).filter((n) => n.status === 'completed').length,
          failedCount: (nodes ?? []).filter((n) => n.status === 'failed').length,
          errorCount: errors?.length ?? 0,
          nodeStatuses: Object.fromEntries((nodes ?? []).map((n) => [n.nodeId, n.status.charAt(0)])),
          modeRef: 'm0',
        }))
      : [];
    const all = mockStore.getRuns({});
    const countOf = (status: string) => all.filter((run) => run.status === status).length;
    return {
      registeredWorkflowIds,
      nodeCounts: Object.fromEntries(registeredWorkflowIds.map((id) => [id, graphFor(id).nodes.length])),
      ...(workflowId && !known ? { unknownWorkflowId: workflowId } : {}),
      graph: graph ? { workflowId: graph.workflowId, nodes: graph.nodes.map(summarizeMockNode), edges: graph.edges, detail: 'summary' } : null,
      recentRuns: runs,
      modes: { m0: { executionMode: 'mock', live: false, declared: true } },
      attentionCounts: { running: countOf('running'), paused: countOf('paused'), blocked: countOf('blocked'), failed: countOf('failed') },
      workspaceVersion: mockWorkspaceVersion,
    };
  },
  // W2/W6 — `detail` is honoured here exactly as live: "summary" returns the list projection and
  // nothing else. A fixture that ignored it would hand the adapter full nodes to summarize, which
  // is the one thing fixture mode must never do — agree with the client while the server does not.
  workspace_get_nodes: (a) => (optStr(a, 'detail') === 'summary'
    ? { nodes: mockStore.getNodes().map(summarizeMockNode), detail: 'summary' }
    : { nodes: mockStore.getNodes() }),
  workspace_get_node: (a) => ({ node: mockStore.getNode(str(a, 'id')) ?? null }),
  workspace_export_workspace: () => ({ workspaceVersion: mockWorkspaceVersion, currentRevisionId: mockRevisionId }),
  workspace_get_node_effective_config: (a) => {
    const node = mockStore.getNode(str(a, 'id'));
    return {
      config: {
        nodeId: str(a, 'id'),
        model: node?.modelConfig ? adapters.toModelConfig(node.modelConfig) : null,
        tools: node?.allowedTools ?? [],
        skills: node?.assignedSkills ?? [],
        prompt: node?.prompt ?? null,
        source: 'seed',
      },
    };
  },
  node_get_effective_prompt: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return { nodeId: str(a, 'nodeId'), prompt: node?.prompt ?? '', diverged: false, source: 'canonical' };
  },
  node_get_effective_skills: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return { policy: { nodeId: str(a, 'nodeId'), skillIds: node?.assignedSkills ?? [], effectiveTools: node?.allowedTools ?? [], deniedTools: [], conflicts: [] } };
  },
  node_get_effective_tools: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    const deterministic = node?.id === 'publish_payload';
    return {
      tools: toolsFor(node),
      engine: deterministic ? ['project_call_tool'] : [],
      capability: { executionKind: deterministic ? 'deterministic' : 'model', deadGrants: deterministic ? node?.allowedTools ?? [] : [], findings: [] },
      // W4 — the canonical algorithm a deterministic node carries live
      // (src/agent/workspace/nodeAlgorithms.ts). Mirrored here for the one node this fixture calls
      // deterministic, so the Algorithm panel is exercised rather than only type-checked.
      algorithm: deterministic
        ? {
            nodeId: node?.id ?? 'publish_payload',
            summary: 'Assembles the publish payload from what the run produced, and validates it before anything is offered to a tenant.',
            source: 'src/agent/workspace/publishExecution.ts',
            reads: ["every upstream node's stage output", "the run's contract intelligence"],
            steps: [
              'Collect the produced artifacts and the article body the run emitted.',
              "Shape them into the tenant's declared object contract.",
              'Validate the assembled payload against that contract and fail here rather than at the tenant.',
              'Emit the payload for publication_controller to decide on. Assembling it authorizes nothing.',
            ],
            engineTools: [{ verb: 'object_validate', risk: 'read', description: 'Validate the candidate body against the tenant contract.' }],
            route: { routeId: 'publish_payload' },
          }
        : null,
      resolvedAgainst: 'node_declaration',
    };
  },
  // Live nodes carry their own input/output JSON Schema (`inputSchema`/
  // `outputSchema`) — fall back to a labeled placeholder only for the rare
  // node this fixture set doesn't have one for.
  node_get_input_schema: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return { schema: node?.inputSchema ?? schemaStub(str(a, 'nodeId'), 'input') };
  },
  node_get_output_schema: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return { schema: node?.outputSchema ?? schemaStub(str(a, 'nodeId'), 'output') };
  },
  node_validate_input: (a) => {
    const hasInput = a.input !== undefined && a.input !== null;
    return { valid: hasInput, errors: hasInput ? [] : ['Missing input payload.'] };
  },
  node_list_executions: (a) => {
    const nodeId = str(a, 'nodeId');
    const runId = optStr(a, 'runId');
    if (runId) {
      const run = mockStore.getRun(runId);
      if (!run) return [];
      return [
        {
          id: `${runId}_${nodeId}`,
          runId,
          nodeId,
          status: run.currentNodeId === nodeId ? run.status : 'completed',
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ];
    }
    const wfId = mockStore.getWorkflowIdForNode(nodeId);
    return mockStore
      .getRuns({ workflowId: wfId, limit: 5 })
      .map((run) => ({
        id: `${run.runId}_${nodeId}`,
        runId: run.runId,
        nodeId,
        status: run.currentNodeId === nodeId ? run.status : 'completed',
        startedAt: null,
        completedAt: null,
        durationMs: null,
      }));
  },

  // -- workflow / run reads --
  // W1 — this guard is INVERTED from its W1.2 form. It used to throw on a call with no
  // `projectId`, because an unscoped call then meant a full-fleet blob fetch server-side.
  // That is no longer true: BlobExecutionRepository.listRunsPage takes the full-fleet path
  // only when BOTH `limit` and `projectId` are absent, and windows over the run index
  // otherwise. The shape that costs money now is the UNWINDOWED one, so that is what this
  // refuses — the one regression that would otherwise be invisible in fixture mode.
  workflow_list_runs: (a) => {
    const limit = optNum(a, 'limit');
    if (limit === undefined) {
      throw new Error(
        '[api mock] workflow_list_runs called with no limit — an unwindowed call is the one shape that still pays a full-fleet blob fetch server-side (BlobExecutionRepository.listRunsPage). Go through verbs.ts workflowListRunsPage(), which always sends a limit.',
      );
    }
    // `status` is one value or an array (live accepts both) — normalised to a set here.
    const rawStatus = a.status;
    const statuses = Array.isArray(rawStatus)
      ? (rawStatus as string[])
      : typeof rawStatus === 'string'
        ? [rawStatus]
        : undefined;
    const matched = mockStore
      .getRuns({ workflowId: optStr(a, 'workflowId'), projectId: optStr(a, 'projectId') })
      .filter((run) => !statuses || statuses.includes(run.status));
    // Cursor paging, mirroring live's contract rather than its encoding: the client only
    // ever passes `page.nextCursor` back verbatim, so the token's shape is ours to choose.
    const cursor = optStr(a, 'cursor');
    const offset = cursor?.startsWith(MOCK_RUN_CURSOR) ? Number(cursor.slice(MOCK_RUN_CURSOR.length)) : 0;
    const page = matched.slice(offset, offset + limit);
    // W4 — the fixture must answer the SAME two shapes live does, or fixture mode stops being
    // evidence about the client. "summary" (the default) replaces nodes[]/errors[] with counts;
    // "full" returns the captured row untouched.
    const detail = optStr(a, 'detail') === 'full' ? 'full' : 'summary';
    // W5 — `include` is opt-in, exactly as live. `scores` is synthesized from the fixture's own
    // completed scoring nodes by the SAME rule the server applies (runScores.ts): a node that did
    // not complete contributes nothing, and a run with no scoring node completed carries no
    // `scores` field at all rather than an empty object.
    const include = new Set(Array.isArray(a.include) ? (a.include as string[]) : []);
    const SCORING_NODE_IDS = ['human_texture', 'trust_factual', 'emotional_resonance', 'reader_simulation', 'review_aggregator', 'contract_intelligence', 'capture_score', 'gap_adjudicator', 'fit_adjudicator'];
    const FIXTURE_VERDICTS: Record<string, string> = { human_texture: 'pass', trust_factual: 'pass', review_aggregator: 'revise' };
    const scoresFor = (row: { runId: string; nodes?: Array<{ nodeId: string; status: string }> }) => {
      const completed = new Set((row.nodes ?? []).filter((n) => n.status === 'completed').map((n) => n.nodeId));
      const seed = Number(/(\d+)/.exec(row.runId)?.[1] ?? 0);
      const out: Record<string, number | string> = {};
      for (const nodeId of SCORING_NODE_IDS) {
        if (!completed.has(nodeId)) continue;
        out[nodeId] = FIXTURE_VERDICTS[nodeId] ?? Number((0.55 + ((seed + nodeId.length) % 40) / 100).toFixed(2));
      }
      return out;
    };
    const runs =
      detail === 'full'
        ? page
        : page.map(({ nodes, errors, ...row }) => {
            const scores = include.has('scores') ? scoresFor({ runId: row.runId, nodes }) : {};
            return {
              ...row,
              nodeCount: nodes?.length ?? 0,
              completedCount: (nodes ?? []).filter((n) => n.status === 'completed').length,
              failedCount: (nodes ?? []).filter((n) => n.status === 'failed').length,
              errorCount: errors?.length ?? 0,
              artifactCount: (row as { artifactCount?: number }).artifactCount ?? 0,
              ...(Object.keys(scores).length ? { scores } : {}),
            };
          });
    const nextOffset = offset + runs.length;
    const hasMore = nextOffset < matched.length;
    return {
      detail,
      runs,
      page: {
        limit,
        // Counts every matching row, not the windowed ones — the same thing live's
        // `matchedCount` means, and what the Runs header reports as the fleet size.
        matchedCount: matched.length,
        hasMore,
        ...(hasMore ? { nextCursor: `${MOCK_RUN_CURSOR}${nextOffset}` } : {}),
      },
    };
  },
  // Live wraps `{ run, mode, stall }` — mode/stall are siblings of `run`,
  // not nested inside it (verbs.ts's workflowGetRun folds them back on
  // before adapting) — mirrored here rather than nesting them in `run`.
  workflow_get_run: (a) => {
    const run = mockStore.getRun(str(a, 'runId'));
    if (!run) return null;
    // W7 FIXTURE CORRECTION — this ALWAYS attached stageOutputs/initialInput, while the live
    // default (`detail: "compact"`) carries neither. That gap is what hid a defect that would have
    // left the I/O tab and the replay empty in production. The fixture now answers the way the
    // server does: only on `detail: "full"` or `include: ["stageOutputs"]`.
    const includes = Array.isArray(a.include) ? (a.include as string[]) : [];
    const carriesStageOutputs = optStr(a, 'detail') === 'full' || includes.includes('stageOutputs');
    // W4 — the live `workflow_get_run` carries the run's stage outputs and the input it was started
    // with; the fixture runs predate both. Synthesized from what the fixture DOES record (each
    // completed node's canonical artifact) rather than invented, so the I/O tab is exercised
    // against the same shape live returns instead of only against an empty map.
    const stageOutputs: Record<string, unknown> = {};
    for (const node of run.nodes ?? []) {
      if (node.status !== 'completed') continue;
      const entry = mockStore.listNodeOutputs(node.nodeId, run.runId)[0];
      stageOutputs[node.nodeId] = entry?.value ?? { nodeId: node.nodeId, note: 'fixture output' };
    }
    return {
      run: {
        ...run,
        ...(carriesStageOutputs ? { stageOutputs, initialInput: run.initialInput ?? { topic: 'fixture run input' } } : {}),
      },
      detail: optStr(a, 'detail') ?? 'compact',
      mode: { executionMode: run.mode?.executionMode ?? run.executionMode },
      stall: run.stall ?? null,
    };
  },
  workflow_get_run_context: (a) => {
    const run = mockStore.getRun(str(a, 'runId'));
    if (!run) return null;
    return {
      runId: run.runId,
      workflowId: run.workflowId,
      projectId: run.projectId,
      currentNodeId: run.currentNodeId ?? null,
      status: run.status,
      nodesCompleted: doneCount(run),
      nodesErrored: errCount(run),
      dryRun: run.dryRun,
      executionMode: run.mode?.executionMode ?? run.executionMode,
    };
  },
  // Live wraps `{ ledger, plan }` (LIVE-VERIFIED CORRECTION, workbench-verb-fixes
  // — see verbs.ts's workflowGetRunCost doc comment). `plan` carries no field
  // any adapter reads, so the mock returns `null` for it rather than
  // fabricating the resume/reuse recommendation live actually computes.
  workflow_get_run_cost: (a) => {
    const runId = str(a, 'runId');
    return { ledger: mockStore.getCostLedger(runId) ?? { runId, totalCostUsdEstimate: 0 }, plan: null };
  },
  // Added by WP-23 (gate panel readiness viewer). Every check below is
  // derived from fields this fixture set actually carries on the run record
  // (error count, progress, budget) — see PublishReadiness's doc comment in
  // ../types.ts. The operator-decision check is deliberately never reported
  // as a pass here: it is exactly the thing Approve/Decline records.
  workflow_publish_readiness: (a) => {
    const runId = str(a, 'runId');
    const run = mockStore.getRun(runId);
    if (!run) return { runId, nodeId: null, checks: [], overallGo: false, source: 'derived' };
    const wf = mockStore.getWorkflow(run.workflowId);
    const order: string[] = wf ? wf.phases.flatMap(([, ids]) => ids) : [];
    const cur = run.currentNodeId ?? null;
    const gateIdx = cur ? order.indexOf(cur) : -1;
    const done = doneCount(run);
    const err = errCount(run);
    const ledger = mockStore.getCostLedger(runId);
    const cost = ledger?.totalCostUsdEstimate ?? 0;
    const budget = ledger?.budget?.budgetUsd ?? run.budgetUsd ?? null;
    const checks = [
      {
        id: 'errors',
        label: 'No node errors recorded on this run',
        pass: err === 0,
        detail: `${err} error${err === 1 ? '' : 's'} recorded on this run.`,
      },
      {
        id: 'progress',
        label: 'Every upstream node has completed',
        pass: gateIdx < 0 || done >= gateIdx,
        detail: `${done}/${order.length} nodes completed before ${cur ?? 'this gate'}.`,
      },
      {
        id: 'budget',
        label: 'Run is within its budget cap',
        pass: !budget || cost <= budget,
        detail: budget
          ? `$${cost.toFixed(2)} spent of a $${budget} cap.`
          : `$${cost.toFixed(2)} spent — no budget cap set on this run.`,
      },
      {
        id: 'operator_decision',
        label: 'Durable operator publish decision recorded',
        pass: false,
        detail: 'Not yet recorded for this run — Approve below records "approved"; Decline records nothing and cancels the run.',
      },
    ];
    return { runId, nodeId: cur, checks, overallGo: checks.every((c) => c.pass === true), source: 'derived' };
  },
  // Real schema is `{stage?}` (stage == nodeId), returning full entries —
  // `{id, stage, value, createdAt}` — never a bare id list, and never keyed
  // by runId. verbs.ts's stageGetOutput composes on top of this list by
  // filtering for an id scoped to the requested run.
  //
  // Defect A fixture correction — this used to synthesize a record for
  // EVERY "done" node in every run, which is backwards: most completed
  // nodes carry a canonical `node_list_outputs` artifact and NO legacy
  // stage-store record. See mockStore.ts's own comment on
  // LEGACY_STAGE_RECORDS for the (small, explicit) scenario set this now
  // answers from instead — everything else answers honestly empty.
  stage_list_outputs: (a) => {
    const stage = optStr(a, 'stage');
    return { outputs: mockStore.listLegacyStageOutputs(stage || undefined) };
  },
  stage_get_output: (a) => {
    const id = str(a, 'id');
    const hit = mockStore.listLegacyStageOutputs().find((o) => o.id === id);
    return { output: hit ? { id, value: hit.value } : { id, value: null } };
  },

  // -- changes --
  // Real schema wraps in `{events}` (not a bare array) with eventId /
  // resultingRevisionId / target.id / actor / createdAt fields.
  // `actorKind`, `operation` and `source` are real server-side filters
  // (live-verified, WP-00) — mirrored here so a feed filtered to
  // learning-attributed actors behaves the same in fixture mode.
  changes_list: (a) => {
    const nodeId = str(a, 'nodeId');
    const actorKind = str(a, 'actorKind');
    const source = str(a, 'source');
    const operation = str(a, 'operation');
    const limit = typeof a.limit === 'number' ? a.limit : undefined;
    let events = mockStore.getChangeEvents();
    if (nodeId) events = events.filter((e) => e.target?.id === nodeId);
    if (actorKind) events = events.filter((e) => e.actor?.kind === actorKind);
    if (source) events = events.filter((e) => e.source === source);
    if (operation) events = events.filter((e) => e.operation === operation);
    if (limit) events = events.slice(0, limit);
    return { events, nextCursor: null };
  },
  changes_get: (a) => {
    const id = str(a, 'eventId');
    return { event: mockStore.getChangeEvents().find((e) => e.eventId === id) ?? null };
  },

  // -- attention & metrics (U1/U5) --
  constellation_get_attention: () => ({ items: mockStore.getAttention() }),
  constellation_get_metrics: () => ({
    metrics: mockStore.getNodes().map((n) => ({
      nodeId: n.id,
      runs: 0,
      failures: 0,
      note: 'fixture mode records no per-node metrics',
    })),
  }),

  // -- drive mode: output override (U3) --
  node_validate_output: (a) => mockStore.validateNodeOutput(str(a, 'nodeId'), a.output),
  node_list_outputs: (a) => ({ outputs: mockStore.listNodeOutputs(str(a, 'nodeId'), str(a, 'runId')) }),
  stage_save_output: (a) =>
    mockStore.saveStageOutput(str(a, 'runId'), str(a, 'nodeId'), a.value, str(a, 'note') || undefined),

  // -- node-default-output (W4) --
  // Real schema wraps a single record in `{output}` (never a bare list) —
  // "most recent" reuses listNodeOutputs' own precedence (override still
  // wins if one exists), sorted newest-first the same way adoptOutputAsDefault does.
  node_get_latest_output: (a) => {
    const nodeId = str(a, 'nodeId');
    const runId = optStr(a, 'runId');
    const list = [...mockStore.listNodeOutputs(nodeId, runId)].sort((x, y) =>
      String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? '')),
    );
    return { output: list[0] ?? null };
  },
  // `value: null` clears (mirrors the real tool's contract — see
  // defaultOutput.ts's doc comment, read-only). Without `force`, a value
  // that fails this node's own declared output schema is refused with the
  // same `default_output_schema_invalid` code the live tool throws — the
  // Default output tab validates proactively via node_validate_output
  // before ever getting here, so in normal use this is a safety net, not
  // the primary path.
  workspace_update_node_default_output: (a) => {
    const nodeId = str(a, 'nodeId');
    const value = a.value;
    if (value === null || value === undefined) {
      const updated = mockStore.setNodeDefaultOutput(nodeId, null) ?? null;
      return { node: updated, workspaceVersion: mockWorkspaceVersion };
    }
    const force = a.force === true;
    const validation = mockStore.validateNodeOutput(nodeId, value);
    if (!validation.valid && !force) {
      throw new Error(
        `default_output_schema_invalid: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ') || 'value does not match this node’s declared output schema'}`,
      );
    }
    const now = new Date().toISOString();
    const updated =
      mockStore.setNodeDefaultOutput(nodeId, {
        value,
        note: optStr(a, 'note'),
        updatedAt: now,
        updatedBy: 'human',
        schemaValidAt: validation.valid ? now : null,
      }) ?? null;
    return { node: updated, workspaceVersion: mockWorkspaceVersion };
  },
  // W6 — replay. Fixture mode has no model, so `executionMode: "openai"` is refused here rather
  // than quietly answered with a placeholder: the whole point of the control is that a live replay
  // costs money, and a fixture that pretended to make one would be more generous than the server.
  node_execute: (a) => {
    if (optStr(a, 'executionMode') === 'openai') {
      throw new Error('fixture mode makes no model calls — node_execute is available in mock mode only here');
    }
    return mockStore.executeNode(str(a, 'nodeId'), {
      runId: optStr(a, 'runId'),
      dependencyOutputs: (a.dependencyOutputs as Record<string, unknown> | undefined) ?? undefined,
    });
  },
  // W6 FIXTURE CORRECTION — this returned `{ node: null }` when the node had no recorded output to
  // adopt, so the caller saw a resolved promise and reported success. The live tool
  // (tools.ts, workspace.adopt_output_as_default) THROWS `node_output_unavailable` in exactly that
  // case. A node being `completed` on a run is not the same as having a recorded output the
  // execution repository can hand back — the Workbench cannot tell the two apart without a second
  // round trip, so the refusal is the only thing that tells an operator the truth, and a fixture
  // that swallowed it hid a live failure path from every test that runs against it.
  workspace_adopt_output_as_default: (a) => {
    const nodeId = str(a, 'nodeId');
    const runId = optStr(a, 'runId');
    const updated = mockStore.adoptOutputAsDefault(nodeId, runId, optStr(a, 'note'));
    if (!updated) {
      throw new Error(
        `node_output_unavailable: Node ${nodeId} has no recorded output${runId ? ` in run ${runId}` : ''} to adopt. Run it once, or supply the value directly with workspace.update_node_default_output.`,
      );
    }
    return { node: updated, workspaceVersion: mockWorkspaceVersion };
  },
  changes_compare: (a) => ({
    diff: {
      fromRevisionId: str(a, 'fromRevisionId'),
      toRevisionId: str(a, 'toRevisionId'),
      nodes: { added: [], removed: [], changed: [] },
      relationships: { added: [], removed: [], changedIds: [] },
    },
  }),

  // -- registry --
  project_list: () => ({ projects: mockStore.getProjects() }),
  project_test_connection: (a) => {
    const project = mockStore.getProject(str(a, 'projectId'));
    const ok = Boolean(project?.connection?.endpointConfigured && project?.connection?.tokenConfigured);
    return {
      projectId: str(a, 'projectId'),
      ok,
      latencyMs: ok ? 120 : null,
      message: ok ? 'Connection healthy.' : 'Endpoint unset or unreachable.',
    };
  },
  tool_list: () => ({ tools: mockStore.getTools() }),
  // W5 T4 — fixture mode has no captured tool ledger (no fixtures/toolExecutions.json exists, and
  // inventing one would put fabricated publishes and releases in front of an operator who cannot
  // tell fixture mode from live at a glance). An empty list is the honest answer, and it is a REAL
  // state the screen already handles: every run that finished before the durable ledger began
  // recording returns exactly this.
  // REBASE RECONCILIATION — two handlers for this verb existed after the rebase, and an object
  // literal may not declare the same key twice. One handler, both behaviours:
  //   * Unscoped, or scoped to a run only (main's W5 T4 Tools timeline): an EMPTY list, for the
  //     reason above — the fixture set records no ledger, and inventing one would put fabricated
  //     publishes and releases in front of an operator who cannot tell fixture mode from live.
  //   * Scoped to a run AND a node (workbench-v2 W4's per-node I/O tab): the synthesised calls
  //     mockStore makes for the one node that tab's own test drives, so the populated state is
  //     exercised as well as the empty one.
  tool_list_executions: (a) => {
    const runId = optStr(a, 'runId');
    const nodeId = optStr(a, 'nodeId');
    if (!runId || !nodeId) return { executions: [] };
    return { executions: mockStore.listToolExecutions(runId, nodeId) };
  },
  skill_list: () => ({ skills: mockStore.getSkills() }),
  skill_resolve_for_node: (a) => skillsFor(mockStore.getNode(str(a, 'nodeId'))),
  agent_list: () => ({ agents: mockStore.getAgents() }),
  agent_get: (a) => {
    const agent = mockStore.getAgents().find((entry) => entry.id === str(a, 'id'));
    if (!agent) throw new Error(`agent_unresolved: no conversational agent matches "${str(a, 'id')}".`);
    return { agent, workspaceVersion: mockWorkspaceVersion };
  },
  agent_update: (a) => {
    const patch = (a.patch ?? {}) as { prompt?: string };
    const agent = mockStore.updateAgent(str(a, 'id'), patch);
    if (!agent) throw new Error(`agent_unresolved: no conversational agent matches "${str(a, 'id')}".`);
    mockWorkspaceVersion += 1;
    return { agent, workspaceVersion: mockWorkspaceVersion };
  },
  // W5 — CMS-Agent's own bounded audit mirror of what the agent has been saying. The fixture set
  // captures no conversations (the live mirror is per-tenant chat traffic, which a workbench
  // fixture has no business carrying), so this answers honestly with an empty list and a scan that
  // did not hit its cap — which is the state the page's empty branch has to handle anyway.
  agent_list_conversations: (a) => ({
    agentId: str(a, 'agentId'),
    conversations: mockStore.listAgentConversations(str(a, 'agentId')),
    scanned: 0,
    scanCapped: false,
  }),
  repository_get_health: () => ({ ok: true, checkedAt: new Date().toISOString(), issues: [] }),

  // -- learning --
  // Real schema is `{includeArchived?}` — no node filter live; verbs.ts
  // fetches everything and filters client-side on the raw item's `nodeId`
  // field, which this fixture set's items already carry natively.
  learning_list_observations: () => ({ observations: mockStore.getObservations() }),
  playbook_get: (a) => ({
    nodeId: str(a, 'nodeId'),
    lessons: [],
    version: 0,
    note: 'No playbook captured in fixtures for this node yet.',
  }),

  // -- evaluation --
  evaluation_list_rubrics: () => ({ rubrics: mockStore.getRubrics() }),
  // W7 FIXTURE CORRECTION — this returned a BARE ARRAY where the live tool returns
  // `ok({ results: [...] })` (improvementTools.ts), like every other list verb. The client wrapper
  // was typed against this fixture rather than against the server, so W5's Scores tab iterated an
  // object on the live plane and threw inside a render. Both planes now return the same envelope.
  evaluation_list_results: (a) => {
    const nodeId = optStr(a, 'nodeId');
    return {
      results: mockStore
        .getRegressionReports(nodeId)
        .map((r) => ({ nodeId: r.nodeId, score: r.summary?.meanScore ?? null, verdict: r.verdict })),
    };
  },
  evaluation_list_regression_reports: (a) => ({ reports: mockStore.getRegressionReports(optStr(a, 'nodeId')) }),

  // -- optimizer --
  optimizer_status: (a) => ({ nodeId: optStr(a, 'nodeId') ?? null, proposals: [], lastTrial: null, state: 'idle' }),

  // -- dataset --
  dataset_list: () => ({ datasets: mockStore.getDatasets() }),
  dataset_finetune_readiness: () => ({ readiness: mockStore.getReadiness() }),

  // -- feedback --
  feedback_list: () => [],

  // -- usage --
  usage_get_summary: (a) => {
    const wfId = optStr(a, 'workflowId');
    if (!wfId) return mockStore.getUsageOverall();
    return mockStore.getUsageByWorkflow(wfId) ?? { totalCostUsdEstimate: 0 };
  },
  usage_get_budget_status: (a) => {
    const runId = optStr(a, 'runId');
    if (runId) {
      const ledger = mockStore.getCostLedger(runId);
      const spent = ledger?.totalCostUsdEstimate ?? 0;
      const budget = ledger?.budget?.budgetUsd ?? null;
      return { runId, spentUsd: spent, budgetUsd: budget, pctUsed: budget ? spent / budget : null };
    }
    const overall = mockStore.getUsageOverall();
    return { runId: null, spentUsd: overall.totalCostUsdEstimate ?? overall.costUsdEstimate ?? 0, budgetUsd: null, pctUsed: null };
  },

  // ==== mutating verbs (logged; mutate mockStore; return a plausible result) ====

  workflow_start_dry_run: (a) => {
    // `dry` defaults true (undefined/anything but literal `false`); mirrors
    // verbs.ts's workflowStartDryRun doc comment. Added by WP-22 so a live
    // launch from the start-run modal actually comes back live in mock mode
    // too, instead of silently reporting dry·mock regardless of the operator's
    // choice (HANDOFF §7.9 — nothing pretends).
    const dry = a.dry !== false;
    const execRaw = optStr(a, 'executionMode');
    const exec = execRaw === 'openai' ? 'openai' : 'mock';
    // node-default-output (W4) — an unrecognized/absent value reads as the
    // contract's own default ("live"), same as the server does (see
    // defaultOutput.ts's DEFAULT_RUN_OUTPUT_MODE, read-only) rather than
    // silently accepting a typo'd mode string.
    const outputModeRaw = optStr(a, 'outputMode');
    const outputMode =
      outputModeRaw === 'defaults_where_set' || outputModeRaw === 'defaults_only' ? outputModeRaw : 'live';
    const run: adapters.RawRun = {
      runId: genId('run'),
      requestId: optStr(a, 'requestId'),
      workflowId: str(a, 'workflowId'),
      projectId: str(a, 'projectId'),
      status: 'queued',
      currentNodeId: null,
      startedAt: new Date().toISOString(),
      nodes: [],
      errors: [],
      dryRun: dry,
      executionMode: exec,
      budgetUsd: optNum(a, 'budgetUsd') ?? null,
      mode: { executionMode: exec },
      outputMode,
      defaultedNodeIds: [],
    };
    return mockStore.addRun(run);
  },
  workflow_run_all: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_run_next_node: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_run_until: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  // node-default-output (W4) — `useDefaultOutput: true` branches into
  // applyDefaultOutputToRun instead of the ordinary "mark it running"
  // simulation: pushing through is a completion, not a step-and-wait, so
  // the run record it returns already reflects the node as done.
  workflow_run_node: (a) => {
    const runId = str(a, 'runId');
    const nodeId = str(a, 'nodeId');
    if (a.useDefaultOutput === true) return mockStore.applyDefaultOutputToRun(runId, nodeId) ?? null;
    return mockStore.updateRunRaw(runId, { status: 'running', currentNodeId: nodeId }) ?? null;
  },
  workflow_pause_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'paused' }) ?? null,
  workflow_resume_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_cancel_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'cancelled' }) ?? null,
  workflow_reset_run: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'queued', currentNodeId: null, nodes: [], errors: [] }) ?? null,
  workflow_retry_node: (a) => {
    const runId = str(a, 'runId');
    const nodeId = str(a, 'nodeId');
    if (a.useDefaultOutput === true) return mockStore.applyDefaultOutputToRun(runId, nodeId) ?? null;
    // Adversarial-review fix (post-W4, server-contract follow-up) — a
    // plain retry (no useDefaultOutput) on a defaults-mode run marks the
    // node so a future dispatch runs it live instead of re-applying its
    // default; a no-op for a `live` run (see mockStore's own comment).
    mockStore.markDefaultOutputOverride(runId, nodeId);
    return mockStore.updateRunRaw(runId, { status: 'running', currentNodeId: nodeId }) ?? null;
  },
  workflow_set_operator_publish_decision: (a) => {
    const decision = str(a, 'decision');
    return mockStore.updateRunRaw(str(a, 'runId'), { status: decision === 'approve' ? 'running' : 'cancelled' }) ?? null;
  },
  // Adversarial-review fix (post-W4, server-contract follow-up) —
  // workflow.publish_run refuses outright when the run carries any
  // defaulted node: a run that reached a live publish gate with even one
  // node's output SUPPLIED rather than produced can never actually go
  // live. Mirrors src/agent/workspace/defaultOutput.ts's
  // defaultedUpstreamRefusal (read-only).
  workflow_publish_run: (a) => {
    const runId = str(a, 'runId');
    const run = mockStore.getRun(runId);
    if (run?.defaultedNodeIds && run.defaultedNodeIds.length > 0) {
      throw new Error(
        `defaulted_upstream_refusal: ${runId} can never publish live — ${run.defaultedNodeIds.join(', ')} supplied output instead of producing it.`,
      );
    }
    return mockStore.updateRunRaw(runId, { status: 'completed' }) ?? null;
  },

  workspace_update_node_prompt: (a) => mockStore.updateNode(str(a, 'id'), { prompt: str(a, 'prompt') }) ?? null,
  workspace_update_node_tools: (a) => {
    assertMockPrecondition(a);
    const patch = (a.patch ?? {}) as { allowedTools?: string[] };
    const updated = mockStore.updateNode(str(a, 'id'), { allowedTools: patch.allowedTools ?? [] }) ?? null;
    if (updated) commitMockWorkspace();
    return { node: updated, workspaceVersion: mockWorkspaceVersion };
  },
  workspace_update_node_skills: (a) => {
    assertMockPrecondition(a);
    const patch = (a.patch ?? {}) as { assignedSkills?: string[] };
    const updated = mockStore.updateNode(str(a, 'id'), { assignedSkills: patch.assignedSkills ?? [] }) ?? null;
    if (updated) commitMockWorkspace();
    return { node: updated, workspaceVersion: mockWorkspaceVersion };
  },
  // LIVE-VERIFIED CORRECTION (budget-override-and-ui-save): the live tool
  // takes `{id, patch: {modelConfig}}` and MERGES patch.modelConfig onto the
  // existing config (tools.ts's deepMergeRecords) — mirrored here so fixture
  // mode exercises the same "send only the changed fields" contract verbs.ts
  // now relies on, instead of a wholesale replace that happened to match the
  // old (wrong) full-object payload.
  workspace_update_node_model_config: (a) => {
    const id = str(a, 'id');
    const patch = (a.patch ?? {}) as { modelConfig?: Partial<adapters.RawModelConfig> };
    const incoming = patch.modelConfig ?? {};
    const existing = mockStore.getNode(id);
    const merged = { ...(existing?.modelConfig ?? {}), ...incoming } as adapters.RawModelConfig;
    return mockStore.updateNode(id, { modelConfig: merged }) ?? null;
  },
  workspace_update_node_input_schema: (a) => {
    assertMockPrecondition(a);
    const schema = a.schema as Record<string, unknown>;
    // Fixture fault injection exercises the UI's honest readback-uncertain
    // path without pretending this branch committed.
    if ((schema as { __readbackFailure?: unknown })?.__readbackFailure === true) return { node: mockStore.getNode(str(a, 'id')) ?? null, workspaceVersion: mockWorkspaceVersion };
    const updated = mockStore.updateNode(str(a, 'id'), { inputSchema: schema }) ?? null;
    if (updated) commitMockWorkspace();
    return { node: updated, workspaceVersion: mockWorkspaceVersion };
  },
  workspace_update_node_output_schema: (a) => {
    assertMockPrecondition(a);
    const schema = a.schema as Record<string, unknown>;
    if ((schema as { __readbackFailure?: unknown })?.__readbackFailure === true) return { node: mockStore.getNode(str(a, 'id')) ?? null, workspaceVersion: mockWorkspaceVersion };
    const updated = mockStore.updateNode(str(a, 'id'), { outputSchema: schema }) ?? null;
    if (updated) commitMockWorkspace();
    return { node: updated, workspaceVersion: mockWorkspaceVersion };
  },
  workspace_update_node_metadata: (a) => {
    const metadata = (a.metadata ?? {}) as Partial<Pick<adapters.RawWorkflowNode, 'name' | 'description' | 'kind' | 'riskLevel'>>;
    return mockStore.updateNode(str(a, 'nodeId'), metadata) ?? null;
  },
  workspace_validate_node: (a) => {
    const node = a.node as { inputSchema?: unknown; outputSchema?: unknown } | undefined;
    if (!node || typeof node !== 'object') return { valid: false, errors: ['A complete node is required.'] };
    if ((node.inputSchema as { __backendRefusal?: unknown } | undefined)?.__backendRefusal === true) {
      return { valid: false, errors: ['The backend refused this candidate schema.'] };
    }
    return { valid: true, errors: [] };
  },

  changes_restore: (a) => ({ nodeId: str(a, 'nodeId'), changeId: str(a, 'revisionId'), restored: true }),

  skill_update: (a) => mockStore.updateSkill(str(a, 'skillId'), (a.patch as Partial<adapters.RawSkill>) ?? {}) ?? null,
  skill_assign: (a) => mockStore.assignSkill(str(a, 'nodeId'), str(a, 'skillId')) ?? null,
  skill_unassign: (a) => mockStore.unassignSkill(str(a, 'nodeId'), str(a, 'skillId')) ?? null,
  skill_restore_version: (a) => mockStore.updateSkill(str(a, 'skillId'), { version: str(a, 'version') }) ?? null,

  learning_record_observation: (a): adapters.RawObservation =>
    mockStore.addObservation({
      id: genId('learning'),
      observation: str(a, 'txt'),
      nodeId: optStr(a, 'nodeId') ?? null,
      runId: optStr(a, 'runId') ?? null,
      createdAt: new Date().toISOString(),
    }),
  learning_archive_observation: (a) => mockStore.archiveObservation(str(a, 'id')) ?? null,

  playbook_curate: (a) => ({ nodeId: str(a, 'nodeId'), lesson: a.lesson ?? null, applied: true }),
  playbook_apply_delta: (a) => ({ nodeId: str(a, 'nodeId'), delta: a.delta ?? null, applied: true }),
  playbook_migrate_observations: () => ({ migrated: 0 }),

  feedback_record: (a) => {
    mockStore.recordPreferencePair();
    return { id: genId('feedback'), ...a, recordedAt: new Date().toISOString() };
  },

  evaluation_create_rubric: (a): adapters.RawRubric | null => {
    const rubric: adapters.RawRubric = {
      nodeId: str(a, 'node'),
      criteria: [],
    };
    return mockStore.updateRubric(rubric.nodeId, rubric) ?? rubric;
  },
  evaluation_update_rubric: (a) =>
    mockStore.updateRubric(str(a, 'node'), (a.patch as Partial<adapters.RawRubric>) ?? {}) ?? null,
  evaluation_run: (a) => {
    const report = mockStore.getRegressionReports(str(a, 'node'))[0];
    return {
      node: str(a, 'node'),
      score: report?.summary?.meanScore ?? null,
      verdict: report?.verdict ?? 'pending',
      ranAt: new Date().toISOString(),
    };
  },
  evaluation_run_regression: (a) => {
    const report = mockStore.getRegressionReports(str(a, 'node'))[0];
    return {
      node: str(a, 'node'),
      score: report?.summary?.meanScore ?? null,
      verdict: report?.verdict ?? 'pending',
      baseline: report?.summary?.meanScore ?? null,
      ranAt: new Date().toISOString(),
    };
  },
  evaluation_restore_rubric_version: (a) => mockStore.getRubric(str(a, 'node')) ?? null,

  optimizer_analyze: (a) => ({ nodeId: str(a, 'nodeId'), findings: [], analyzedAt: new Date().toISOString() }),
  optimizer_propose: (a) => ({ nodeId: str(a, 'nodeId'), proposalId: genId('prop'), promptDiff: '', createdAt: new Date().toISOString() }),
  optimizer_run_trial: (a) => ({ proposalId: str(a, 'proposalId'), trialId: genId('trial'), score: null, status: 'queued' }),
  optimizer_promote: (a) => ({ proposalId: str(a, 'proposalId'), promoted: true, promotedAt: new Date().toISOString() }),
  optimizer_auto_promote: (a) => ({
    nodeId: str(a, 'nodeId'),
    autoPromoted: false,
    reason: 'Auto-promote thresholds not met in mock mode.',
  }),

  dataset_build: (a): adapters.RawDataset =>
    mockStore.addDataset({
      datasetId: genId('ds'),
      nodeId: str(a, 'node'),
      name: 'Built via dataset_build (mock).',
      cases: Array.from({ length: optNum(a, 'cases') ?? 0 }, (_, i) => ({ caseId: genId(`case_${i}`), nodeId: str(a, 'node') })),
      createdAt: new Date().toISOString(),
    }),
  dataset_export_sft: (a) => ({ datasetId: str(a, 'datasetId'), format: 'sft', ready: true, downloadUrl: null }),
  dataset_export_preferences: (a) => ({
    datasetId: str(a, 'datasetId'),
    format: 'preferences',
    ready: true,
    downloadUrl: null,
  }),
};

/**
 * W2 test seam — make any verb reject, from a test, without a network transport.
 *
 * Fixture mode has no way for a verb to fail, which is precisely why every
 * `isLoading` skeleton in this app went so long without an `isError` sibling: the
 * failure path was unreachable in the only mode the suite runs in. AttentionStrip
 * already carried a bespoke one-verb version of this (`__ATTN_FORCE_FAILURE__`);
 * this is the general form, so any panel's error rendering can be exercised.
 *
 * A `window` global rather than an exported setter, for the same reason that one is:
 * a test must be able to arm it in `addInitScript`, BEFORE the app's first render and
 * therefore before the module could have been imported.
 */
type ForcedFailures = Record<string, string>;
const forcedFailure = (verb: string): string | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { __MOCK_FAIL_VERBS__?: ForcedFailures }).__MOCK_FAIL_VERBS__?.[verb];

export async function runMockVerb<T>(verb: string, args: Args): Promise<T> {
  await delay(MOCK_DELAY_MS);
  const forced = forcedFailure(verb);
  if (forced) throw new Error(forced);
  const handler = MOCK_HANDLERS[verb];
  if (!handler) {
    // eslint-disable-next-line no-console
    console.warn(`[api mock] no fixture handler for verb "${verb}" — returning null.`);
    return null as T;
  }
  if (MUTATING_VERBS.has(verb)) {
    // eslint-disable-next-line no-console
    console.log(`[api mock] ${verb}`, args);
  }
  return handler(args) as T;
}
