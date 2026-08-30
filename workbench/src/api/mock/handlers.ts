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
function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
function optNum(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

let mockIdCounter = 0;
function genId(prefix: string): string {
  mockIdCounter += 1;
  return `${prefix}_${Date.now()}_${mockIdCounter.toString(36)}`;
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
  workspace_get_nodes: () => ({ nodes: mockStore.getNodes() }),
  workspace_get_node: (a) => ({ node: mockStore.getNode(str(a, 'id')) ?? null }),
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
  node_get_effective_skills: (a) => skillsFor(mockStore.getNode(str(a, 'nodeId'))),
  node_get_effective_tools: (a) => toolsFor(mockStore.getNode(str(a, 'nodeId'))).map(adapters.toToolDef),
  // Live nodes carry their own input/output JSON Schema (`inputSchema`/
  // `outputSchema`) — fall back to a labeled placeholder only for the rare
  // node this fixture set doesn't have one for.
  node_get_input_schema: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return node?.inputSchema ?? schemaStub(str(a, 'nodeId'), 'input');
  },
  node_get_output_schema: (a) => {
    const node = mockStore.getNode(str(a, 'nodeId'));
    return node?.outputSchema ?? schemaStub(str(a, 'nodeId'), 'output');
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
  // W1.2 — live pays a full-fleet blob fetch for every call with no `projectId` (every run blob
  // across every project, filtered only afterward), which is what made the Runs page, Drive's
  // bind-run panel, and the recent-runs panels fail outright ("Failed to fetch"). Fixture mode has
  // no such cost to reproduce, so this throws instead: the one signal that would otherwise be
  // invisible here is verbs.ts regressing to an unscoped call. workflowListRuns() (and
  // usageGetSummary()'s per-workflow run count) always fan out one call per configured project.
  workflow_list_runs: (a) => {
    const projectId = optStr(a, 'projectId');
    if (!projectId) {
      throw new Error(
        '[api mock] workflow_list_runs called with no projectId — this client must always scope this call per project (see verbs.ts workflowListRuns()); an unscoped call is what made the Runs page, Drive bind-run panel, and recent-runs panels fail live.',
      );
    }
    const runs = mockStore.getRuns({
      workflowId: optStr(a, 'workflowId'),
      projectId,
      status: optStr(a, 'status'),
      limit: optNum(a, 'limit'),
    });
    return { runs, page: { limit: optNum(a, 'limit') ?? runs.length, matchedCount: runs.length, hasMore: false } };
  },
  // Live wraps `{ run, mode, stall }` — mode/stall are siblings of `run`,
  // not nested inside it (verbs.ts's workflowGetRun folds them back on
  // before adapting) — mirrored here rather than nesting them in `run`.
  workflow_get_run: (a) => {
    const run = mockStore.getRun(str(a, 'runId'));
    if (!run) return null;
    return { run, mode: { executionMode: run.mode?.executionMode ?? run.executionMode }, stall: run.stall ?? null };
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
  stage_list_outputs: (a) => {
    const stage = optStr(a, 'stage');
    const outputs = mockStore
      .getRuns()
      .filter((run) => !stage || mockStore.getNodes(run.workflowId).some((n) => n.id === stage))
      .flatMap((run) =>
        mockStore
          .getNodes(run.workflowId)
          .slice(0, doneCount(run))
          .filter((n) => !stage || n.id === stage)
          .map((n) => ({
            id: `${run.runId}:${n.id}`,
            stage: n.id,
            value: { note: 'No live stage output captured for this fixture — placeholder.' },
            createdAt: run.startedAt,
          })),
      );
    return { outputs };
  },
  stage_get_output: (a) => ({
    output: { id: str(a, 'id'), value: { note: 'No live stage output captured for this fixture — placeholder.' } },
  }),

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
  skill_list: () => ({ skills: mockStore.getSkills() }),
  skill_resolve_for_node: (a) => skillsFor(mockStore.getNode(str(a, 'nodeId'))),
  agent_list: () => ({ agents: mockStore.getAgents() }),
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
  evaluation_list_results: (a) => {
    const nodeId = optStr(a, 'nodeId');
    return mockStore
      .getRegressionReports(nodeId)
      .map((r) => ({ nodeId: r.nodeId, score: r.summary?.meanScore ?? null, verdict: r.verdict }));
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
    };
    return mockStore.addRun(run);
  },
  workflow_run_all: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_run_next_node: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_run_until: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  workflow_run_node: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  workflow_pause_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'paused' }) ?? null,
  workflow_resume_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'running' }) ?? null,
  workflow_cancel_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'cancelled' }) ?? null,
  workflow_reset_run: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'queued', currentNodeId: null, nodes: [], errors: [] }) ?? null,
  workflow_retry_node: (a) =>
    mockStore.updateRunRaw(str(a, 'runId'), { status: 'running', currentNodeId: str(a, 'nodeId') }) ?? null,
  workflow_set_operator_publish_decision: (a) => {
    const decision = str(a, 'decision');
    return mockStore.updateRunRaw(str(a, 'runId'), { status: decision === 'approve' ? 'running' : 'cancelled' }) ?? null;
  },
  workflow_publish_run: (a) => mockStore.updateRunRaw(str(a, 'runId'), { status: 'completed' }) ?? null,

  workspace_update_node_prompt: (a) => mockStore.updateNode(str(a, 'nodeId'), { prompt: str(a, 'prompt') }) ?? null,
  workspace_update_node_tools: (a) =>
    mockStore.updateNode(str(a, 'nodeId'), { allowedTools: (a.tools as string[]) ?? [] }) ?? null,
  workspace_update_node_skills: (a) =>
    mockStore.updateNode(str(a, 'nodeId'), { assignedSkills: (a.skills as string[]) ?? [] }) ?? null,
  workspace_update_node_model_config: (a) =>
    mockStore.updateNode(str(a, 'nodeId'), { modelConfig: a.model as adapters.RawModelConfig }) ?? null,
  workspace_update_node_input_schema: (a) => ({ nodeId: str(a, 'nodeId'), schema: a.schema ?? null, applied: true }),
  workspace_update_node_output_schema: (a) => ({ nodeId: str(a, 'nodeId'), schema: a.schema ?? null, applied: true }),
  workspace_update_node_metadata: (a) => {
    const metadata = (a.metadata ?? {}) as Partial<Pick<adapters.RawWorkflowNode, 'name' | 'description' | 'kind' | 'riskLevel'>>;
    return mockStore.updateNode(str(a, 'nodeId'), metadata) ?? null;
  },
  workspace_validate_node: () => ({ valid: true, errors: [] }),

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

export async function runMockVerb<T>(verb: string, args: Args): Promise<T> {
  await delay(MOCK_DELAY_MS);
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
