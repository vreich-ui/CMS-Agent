// One typed function per MCP verb in spec/HANDOFF.md §6. Read verbs call
// `callVerb` directly; every mutating verb is built on `confirmAction` (never
// on callVerb directly) so the read-only flag and the confirm gate always
// apply. Grouped to match the areas called out in the WP-03 brief.
//
// Shapes marked "(fixture-mode guess)" have no live fixture in
// api/fixtures/*.json — see the WP-03 report for the full list; treat their
// fields as a reasonable placeholder contract, not a verified live shape.
//
// LIVE-VERIFIED CORRECTION (workbench-verb-fixes): every control-plane MCP
// tool declares `additionalProperties: false` on its input, and every
// successful call wraps its payload one level deep — e.g.
// `workspace_get_nodes` returns `{ nodes: [...] }`, not a bare array;
// `workspace_get_node` returns `{ node: {...} }`. The verbs below send the
// live argument keys, unwrap the live envelope, and — for the entities
// whose item shape differs from ../types.ts (nodes, runs, projects, tools,
// skills, agents, observations, rubrics, datasets, usage, finetune
// readiness) — run the unwrapped payload through the matching `to<Entity>()`
// in ./adapters.ts, the single mapping both this transport and the fixture
// mock transport (client.ts's MOCK_HANDLERS) share. Where a raw item is
// still cast straight to a ../types.ts shape below (e.g. verbs with no
// fixture at all), that's the pre-existing honest boundary-trust cast
// (`unknown` -> the type) — not a claim of a verified live mapping.

import { callVerb } from './client';
import { confirmAction } from './confirmAction';
import { WORKFLOW_CATALOG } from './workflowCatalog';
import * as adapters from './adapters';
import type {
  Agent,
  Dataset,
  FinetuneReadiness,
  ModelConfig,
  Observation,
  Project,
  PublishReadiness,
  Risk,
  Rubric,
  Run,
  RunStatus,
  Skill,
  ToolDef,
  UsageSummary,
  WorkflowNode,
  Workflow,
} from '../types';

function mutate<T>(verb: string, effect: string, args?: object, danger = false): Promise<T> {
  return confirmAction<T>({ verb, effect, danger }, () => callVerb<T>(verb, args));
}

// ============================ workflow catalog ================================
// HANDOFF §6 has no "list workflows" MCP verb — the 3 (+1 planned) conductor
// workflows are static app config (icon/short/desc marketing copy, per
// fixtures/README.md), not a live query. This mirrors components/TopBar.tsx's
// WF_SWITCHER placeholder, which a later WP swaps for this fixture-backed
// list. Kept Promise-returning so it composes with the same hooks as every
// other verb, but it never touches callVerb/the broker in either mode.

const WORKFLOWS = WORKFLOW_CATALOG;

export const workflowList = (): Promise<Workflow[]> => Promise.resolve(Object.values(WORKFLOWS));

export const workflowGet = (args: { workflowId: string }): Promise<Workflow | undefined> =>
  Promise.resolve(WORKFLOWS[args.workflowId]);

// --- shapes with no fixture — fixture-mode guesses, see report ---------------

export type JSONSchema = Record<string, unknown>;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface EffectivePrompt {
  nodeId: string;
  prompt: string;
  diverged: boolean;
  source: string;
}

export interface EffectiveNodeConfig {
  nodeId: string;
  model: ModelConfig | null;
  tools: string[];
  skills: string[];
  prompt: string | null;
  source: string;
}

export interface NodeExecution {
  id: string;
  runId: string;
  nodeId: string;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface RunContext {
  runId: string;
  workflowId: string;
  projectId: string;
  currentNodeId: string | null;
  status: RunStatus;
  nodesCompleted: number;
  nodesErrored: number;
  dryRun: boolean;
  executionMode: 'openai' | 'mock';
}

export interface RunCost {
  runId: string;
  costUsd: number;
  budgetUsd: number | null;
}

export interface StageOutput {
  runId: string;
  nodeId: string;
  output: unknown;
  note?: string;
}

export interface WorkspaceGraph {
  workflowId: string;
  nodes: Array<{ id: string; deps: string[] }>;
  edges: Array<{ from: string; to: string }>;
}

export interface ChangeRecord {
  id: string;
  nodeId: string;
  field: string;
  before?: unknown;
  after?: unknown;
  when: string;
  author?: string;
}

export interface ChangeDiff {
  nodeId: string;
  from: string;
  to: string;
  diff: Array<{ op: string; path: string; before?: unknown; after?: unknown }>;
}

export interface RestoreResult {
  nodeId: string;
  changeId: string;
  restored: boolean;
}

export interface ConnectionTestResult {
  projectId: string;
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

export interface RepositoryHealth {
  ok: boolean;
  checkedAt: string;
  issues: string[];
}

export interface Playbook {
  nodeId: string;
  lessons: unknown[];
  version: number;
  note?: string;
}

export interface PlaybookMutationResult {
  nodeId: string;
  applied?: boolean;
  migrated?: number;
  [key: string]: unknown;
}

export interface EvaluationResult {
  nodeId: string;
  score: number | null;
  verdict: string | null;
  ranAt?: string;
}

export interface RegressionReport {
  nodeId: string;
  score: number | null;
  verdict: string | null;
  baseline: number | null;
  ranAt?: string;
}

export interface OptimizerStatus {
  nodeId: string | null;
  proposals: unknown[];
  lastTrial: unknown | null;
  state: string;
}

export interface OptimizerAnalysis {
  nodeId: string;
  findings: unknown[];
  analyzedAt: string;
}

export interface OptimizerProposal {
  nodeId: string;
  proposalId: string;
  promptDiff: string;
  createdAt: string;
}

export interface OptimizerTrial {
  proposalId: string;
  trialId: string;
  score: number | null;
  status: string;
}

export interface OptimizerPromoteResult {
  proposalId: string;
  promoted: boolean;
  promotedAt: string;
}

export interface OptimizerAutoPromoteResult {
  nodeId: string;
  autoPromoted: boolean;
  reason: string;
}

export interface DatasetExportResult {
  datasetId: string;
  format: string;
  ready: boolean;
  downloadUrl: string | null;
}

export interface FeedbackItem {
  id: string;
  nodeId?: string;
  runId?: string;
  verdict?: string;
  note?: string;
  recordedAt: string;
}

export interface BudgetStatus {
  runId: string | null;
  spentUsd: number;
  budgetUsd: number | null;
  pctUsed: number | null;
}

export interface SchemaUpdateResult {
  nodeId: string;
  schema: JSONSchema;
  applied: boolean;
}

// ============================== workspace ====================================

/**
 * `workspace_get_graph` takes NO arguments live (`additionalProperties:
 * false` on an empty schema, verified) — like `workspace_get_nodes`, it
 * always returns the full graph. `workflowId` is accepted here only to
 * keep this call-site-compatible with GraphOverlay.tsx; it is not sent.
 */
export const workspaceGetGraph = (_args: { workflowId: string }) =>
  callVerb<WorkspaceGraph>('workspace_get_graph', {});

/** nodeId -> workflowId, from each workflow's phases (mirrors mockStore.ts). */
function nodeIdsForWorkflow(workflowId: string): Set<string> | null {
  const wf = WORKFLOWS[workflowId];
  if (!wf) return null;
  const ids = new Set<string>();
  for (const [, nodeIds] of wf.phases) {
    for (const id of nodeIds) ids.add(id);
  }
  return ids;
}

/**
 * `workspace_get_nodes` takes NO arguments live (`additionalProperties:
 * false` on an empty schema) — it always returns every node across every
 * workflow, wrapped as `{ nodes: [...] }`. `workflowId` filtering, when
 * requested, happens client-side here instead.
 */
export const workspaceGetNodes = async (args?: { workflowId?: string }): Promise<WorkflowNode[]> => {
  const raw = await callVerb<{ nodes: adapters.RawWorkflowNode[] }>('workspace_get_nodes', {});
  const nodes = raw.nodes.map(adapters.toNode);
  if (!args?.workflowId) return nodes;
  const ids = nodeIdsForWorkflow(args.workflowId);
  return ids ? nodes.filter((n) => ids.has(n.id)) : nodes;
};

export const workspaceGetNode = async (args: { nodeId: string }): Promise<WorkflowNode | null> => {
  const raw = await callVerb<{ node: adapters.RawWorkflowNode } | null>('workspace_get_node', { id: args.nodeId });
  return raw?.node ? adapters.toNode(raw.node) : null;
};

export const workspaceGetNodeEffectiveConfig = async (args: {
  nodeId: string;
}): Promise<EffectiveNodeConfig> => {
  const raw = await callVerb<{ config: unknown }>('workspace_get_node_effective_config', { id: args.nodeId });
  return raw.config as unknown as EffectiveNodeConfig;
};

export const workspaceUpdateNodePrompt = (args: { nodeId: string; prompt: string }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_prompt',
    `Save the edited prompt for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeTools = (args: { nodeId: string; tools: string[] }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_tools',
    `Set the tool list for node ${args.nodeId} (${args.tools.length} tools).`,
    args,
  );

export const workspaceUpdateNodeSkills = (args: { nodeId: string; skills: string[] }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_skills',
    `Set the skill list for node ${args.nodeId} (${args.skills.length} skills).`,
    args,
  );

export const workspaceUpdateNodeModelConfig = (args: { nodeId: string; model: ModelConfig }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_model_config',
    `Update model & limits for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeInputSchema = (args: { nodeId: string; schema: JSONSchema }) =>
  mutate<SchemaUpdateResult>(
    'workspace_update_node_input_schema',
    `Update the input schema for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeOutputSchema = (args: { nodeId: string; schema: JSONSchema }) =>
  mutate<SchemaUpdateResult>(
    'workspace_update_node_output_schema',
    `Update the output schema for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeMetadata = (args: {
  nodeId: string;
  metadata: Partial<Pick<WorkflowNode, 'name' | 'desc' | 'kind' | 'risk' | 'fan'>>;
}) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_metadata',
    `Update metadata for node ${args.nodeId}.`,
    args,
  );

/** Read-shaped — no confirmAction (HANDOFF §6 marks this "no confirm"). */
export const workspaceValidateNode = (args: { nodeId: string; patch?: unknown }) =>
  callVerb<ValidationResult>('workspace_validate_node', args);

// ================================= node ======================================

export const nodeGetEffectivePrompt = (args: { nodeId: string }) =>
  callVerb<EffectivePrompt>('node_get_effective_prompt', args);

export const nodeGetEffectiveSkills = (args: { nodeId: string }) =>
  callVerb<Skill[]>('node_get_effective_skills', args);

export const nodeGetEffectiveTools = (args: { nodeId: string }) =>
  callVerb<ToolDef[]>('node_get_effective_tools', args);

export const nodeGetInputSchema = (args: { nodeId: string }) =>
  callVerb<JSONSchema>('node_get_input_schema', args);

export const nodeGetOutputSchema = (args: { nodeId: string }) =>
  callVerb<JSONSchema>('node_get_output_schema', args);

/** Read-shaped — no confirmAction (HANDOFF §6 marks this "no confirm"). */
export const nodeValidateInput = (args: { nodeId: string; input: unknown }) =>
  callVerb<ValidationResult>('node_validate_input', args);

export const nodeListExecutions = (args: { nodeId: string; runId?: string }) =>
  callVerb<NodeExecution[]>('node_list_executions', args);

// ============================ workflow + runs ================================

/**
 * Live carries no cost on a list row (see toRun()'s doc comment) — fetching
 * a ledger per row would mean one `workflow_get_run_cost` call per run
 * returned, which the live API only ever intends as a single-run detail
 * lookup, not a bulk one. So a list row's `cost` reports 0 (the type's own
 * "nothing spent yet" default) until that run is opened — see
 * workflowGetRun() below, the one place cost IS composed in.
 */
export const workflowListRuns = async (args?: {
  workflowId?: string;
  projectId?: string;
  status?: RunStatus;
  limit?: number;
}): Promise<Run[]> => {
  const raw = await callVerb<{ runs: adapters.RawRun[]; page?: unknown }>('workflow_list_runs', args);
  return raw.runs.map((r) => adapters.toRun(r));
};

/**
 * `workflow_get_run` wraps `{ run, mode, stall }` — `mode`/`stall` are
 * siblings of `run`, not nested inside it (unlike a list row, which carries
 * its own `mode`/`stall` inline) — folded onto `run` here before adapting
 * so toRun() only ever has to read one shape. Also composes the run's real
 * cost via `workflow_get_run_cost`, the one place this app fetches it.
 */
export const workflowGetRun = async (args: { runId: string }): Promise<Run | null> => {
  const raw = await callVerb<{ run: adapters.RawRun; mode?: { executionMode?: string }; stall?: unknown } | null>(
    'workflow_get_run',
    args,
  );
  if (!raw?.run) return null;
  const merged: adapters.RawRun = { ...raw.run, mode: raw.mode ?? raw.run.mode, stall: raw.stall ?? raw.run.stall };
  let cost: adapters.RawRunCostLedger | undefined;
  try {
    const costRaw = await callVerb<{ ledger: adapters.RawRunCostLedger; plan?: unknown }>('workflow_get_run_cost', {
      runId: args.runId,
    });
    cost = costRaw.ledger;
  } catch {
    // Cost is a best-effort enrichment — a run whose cost lookup fails
    // still renders via toRun()'s own "unknown" default (0 / null), not a
    // hard failure of the run fetch itself.
  }
  return adapters.toRun(merged, cost);
};

/**
 * Live schema requires BOTH `runId` and `projectId` — unlike every other
 * `runId`-only run verb here. No current caller (useRunContext in
 * screens/Workbench/queries.ts is itself unused), so this is a
 * correctness-only fix: the next caller gets the real required shape.
 */
export const workflowGetRunContext = (args: { runId: string; projectId: string }) =>
  callVerb<RunContext | null>('workflow_get_run_context', args);

/**
 * LIVE-VERIFIED CORRECTION (workbench-verb-fixes): the response wraps
 * `{ ledger, plan }`, not the flat `{runId, costUsd, budgetUsd}` `RunCost`
 * previously guessed here — no current caller (workflowGetRun composes its
 * own cost fetch above instead), so this is a correctness-only fix for the
 * next one.
 */
export const workflowGetRunCost = async (
  args: { runId: string },
): Promise<{ ledger: adapters.RawRunCostLedger; plan: unknown }> =>
  callVerb('workflow_get_run_cost', args);

export interface StageOutputEntry {
  id: string;
  stage: string;
  value: unknown;
  createdAt: string;
}

/**
 * Real schema: `{stage?}` — filters by stage name (== nodeId), never by
 * run. Returns full entries `{id, stage, value, createdAt}`, not a bare id
 * list (the previous `string[]` return type never matched the live shape
 * either — the WP-03 fixture guessed both the argument and the shape wrong).
 */
export const stageListOutputs = async (args?: { stage?: string }): Promise<StageOutputEntry[]> => {
  const raw = await callVerb<{ outputs: StageOutputEntry[] }>('stage_list_outputs', args ?? {});
  return raw.outputs;
};

/**
 * Real schema: `{id}`, where `id` is the composite key stage_list_outputs
 * hands back — observed live as `${runId}:${stage}` for current-format
 * runs, and a legacy `${legacyKey}:${nodeExecId}:${stage}` for older ones.
 * There is no server verb that answers "the output of node X in run Y"
 * directly, so this lists the stage's outputs and picks the entry scoped to
 * `runId`. When none matches — output not produced yet, or a legacy id this
 * can't reconstruct — it resolves an honest "unavailable" StageOutput
 * instead of firing a call the real schema has no way to satisfy.
 */
export const stageGetOutput = async (args: { runId: string; nodeId: string }): Promise<StageOutput> => {
  const entries = await stageListOutputs({ stage: args.nodeId });
  const match = entries.find((e) => e.id === `${args.runId}:${args.nodeId}` || e.id.startsWith(`${args.runId}:`));
  if (!match) {
    return {
      runId: args.runId,
      nodeId: args.nodeId,
      output: null,
      note: 'No stage output recorded for this node in this run.',
    };
  }
  return { runId: args.runId, nodeId: args.nodeId, output: match.value };
};

/**
 * Read-shaped — no confirmAction, same treatment as `node_validate_input` /
 * `workspace_validate_node` (HANDOFF §6 marks those "no confirm"; this verb
 * is absent from §6 entirely, but WP-23 names it explicitly as the gate
 * panel's evidence source). Added by WP-23 (Phase 2, gate panel) — additive
 * only, no existing export touched. See `PublishReadiness` in ../types.ts
 * and the mock handler in client.ts for what "derived" evidence means here.
 */
export const workflowPublishReadiness = (args: { runId: string }) =>
  callVerb<PublishReadiness>('workflow_publish_readiness', args);

export const workflowStartDryRun = (args: {
  workflowId: string;
  projectId: string;
  brief?: string;
  budgetUsd?: number;
  /**
   * Added by WP-23/22 (Phase 2) — additive, optional, so every existing
   * caller keeps compiling unchanged. `dry` defaults true (the verb's own
   * name) when omitted; only an explicit `dry: false` is a live launch.
   */
  dry?: boolean;
  executionMode?: 'openai' | 'mock';
  requestId?: string;
}): Promise<Run> =>
  // LIVE-VERIFIED CORRECTION (workbench-verb-fixes): this verb, like every
  // other run verb, returns the raw run shape — `mutate<Run>` cast straight
  // to the UI type used to leave `run.id`/`run.wf`/`run.cur` undefined on a
  // real response (StartRunModal.tsx read `run.id.slice(...)` and threw).
  // Routed through the same toRun() the reads use.
  mutate<adapters.RawRun>(
    'workflow_start_dry_run',
    args.dry === false
      ? `Start a LIVE run of ${args.workflowId} against project ${args.projectId} — not a dry run. Real, potentially irreversible actions may be taken depending on where the run stops.`
      : `Start a dry run of ${args.workflowId} against project ${args.projectId}.`,
    args,
    args.dry === false,
  ).then((raw) => adapters.toRun(raw));

export const workflowRunAll = (args: { runId: string }) =>
  mutate<Run | null>('workflow_run_all', `Run every remaining node in ${args.runId} to completion.`, args);

export const workflowRunNextNode = (args: { runId: string }) =>
  mutate<Run | null>('workflow_run_next_node', `Run just the next node in ${args.runId}.`, args);

export const workflowRunUntil = (args: { runId: string; nodeId: string }) =>
  mutate<Run | null>(
    'workflow_run_until',
    `Run ${args.runId} forward until node ${args.nodeId}.`,
    args,
  );

export const workflowRunNode = (args: { runId: string; nodeId: string }) =>
  mutate<Run | null>('workflow_run_node', `Run node ${args.nodeId} in ${args.runId}.`, args);

export const workflowPauseRun = (args: { runId: string }) =>
  mutate<Run | null>('workflow_pause_run', `Pause run ${args.runId}.`, args);

export const workflowResumeRun = (args: { runId: string }) =>
  mutate<Run | null>('workflow_resume_run', `Resume run ${args.runId}.`, args);

export const workflowCancelRun = (args: { runId: string; reason?: string }) =>
  mutate<Run | null>('workflow_cancel_run', `Cancel run ${args.runId}. This cannot be undone.`, args, true);

export const workflowResetRun = (args: { runId: string }) =>
  mutate<Run | null>(
    'workflow_reset_run',
    `Reset run ${args.runId} back to queued, clearing progress.`,
    args,
    true,
  );

export const workflowRetryNode = (args: { runId: string; nodeId: string }) =>
  mutate<Run | null>('workflow_retry_node', `Retry node ${args.nodeId} in run ${args.runId}.`, args);

export const workflowSetOperatorPublishDecision = (args: {
  runId: string;
  decision: 'approve' | 'decline';
  reason?: string;
}) =>
  mutate<Run | null>(
    'workflow_set_operator_publish_decision',
    `Record operator decision "${args.decision}" on the publish gate for ${args.runId}.`,
    args,
    args.decision === 'approve',
  );

export const workflowPublishRun = (args: { runId: string }) =>
  mutate<Run | null>(
    'workflow_publish_run',
    `Publish run ${args.runId} to the live site. This cannot be undone.`,
    args,
    true,
  );

// ================================ changes ====================================
// Live change events (`changes_list`/`changes_get`) carry a full before/after
// node snapshot, an `eventId`, and separate `parentRevisionId` /
// `resultingRevisionId` fields — not the flat `id`/`field`/`when`/`author`
// shape `ChangeRecord` models (a WP-03 fixture guess). `changesList` maps
// each event into that flat shape below so HistoryTab.tsx keeps working,
// and — importantly — so `entry.id` is the event's `resultingRevisionId`:
// the real `changes_restore` verb takes a `revisionId`, not an event id, so
// this mapping is what makes restore actually resolve to a real revision.

interface RawChangeEvent {
  eventId: string;
  type: string;
  target?: { type: string; id: string };
  actor?: { kind: string; id?: string; label?: string };
  resultingRevisionId?: string;
  before?: unknown;
  after?: unknown;
  createdAt: string;
}

/** "node.output_schema_updated" -> "output_schema"; falls back to the raw type. */
function fieldLabelFromEventType(type: string): string {
  const label = type.replace(/^node\./, '').replace(/_updated$/, '');
  return label || type;
}

export const changesList = async (args: { nodeId: string }): Promise<ChangeRecord[]> => {
  const raw = await callVerb<{ events: RawChangeEvent[] }>('changes_list', args);
  return raw.events.map((e) => ({
    id: e.resultingRevisionId ?? e.eventId,
    nodeId: e.target?.id ?? args.nodeId,
    field: fieldLabelFromEventType(e.type),
    before: e.before,
    after: e.after,
    when: e.createdAt,
    author: e.actor?.label ?? e.actor?.id ?? e.actor?.kind,
  }));
};

export const changesGet = async (args: { changeId: string }): Promise<ChangeRecord | null> => {
  const raw = await callVerb<{ event: RawChangeEvent } | null>('changes_get', { eventId: args.changeId });
  if (!raw?.event) return null;
  const e = raw.event;
  return {
    id: e.resultingRevisionId ?? e.eventId,
    nodeId: e.target?.id ?? '',
    field: fieldLabelFromEventType(e.type),
    before: e.before,
    after: e.after,
    when: e.createdAt,
    author: e.actor?.label ?? e.actor?.id ?? e.actor?.kind,
  };
};

export const changesCompare = async (args: {
  fromRevisionId: string;
  toRevisionId: string;
}): Promise<ChangeDiff> => {
  const raw = await callVerb<{ diff: unknown }>('changes_compare', args);
  return raw.diff as unknown as ChangeDiff;
};

export const changesRestore = (args: { nodeId: string; revisionId: string }) =>
  mutate<RestoreResult>(
    'changes_restore',
    `Restore node ${args.nodeId} to revision ${args.revisionId}.`,
    args,
    true,
  );

// ================================ registry ===================================

export const projectList = async (): Promise<Project[]> => {
  const raw = await callVerb<{ projects: adapters.RawProject[] }>('project_list');
  return raw.projects.map(adapters.toProject);
};

export const projectTestConnection = (args: { projectId: string }) =>
  callVerb<ConnectionTestResult>('project_test_connection', args);

export const toolList = async (): Promise<ToolDef[]> => {
  const raw = await callVerb<{ tools: adapters.RawToolDef[] }>('tool_list');
  return raw.tools.map(adapters.toToolDef);
};

/**
 * `skill_list`. Live skill records carry no `assignedTo` (see toSkill()'s
 * doc comment) — derived here from a `workspace_get_nodes` call, the same
 * one workspaceGetNodes() itself wraps, so this is a second live/fixture
 * round-trip, not a reuse of some cache.
 */
export const skillList = async (): Promise<Skill[]> => {
  const [raw, nodes] = await Promise.all([
    callVerb<{ skills: adapters.RawSkill[] }>('skill_list'),
    workspaceGetNodes(),
  ]);
  const assigned = adapters.assignedSkillsByNode(nodes);
  return raw.skills.map((s) => adapters.toSkill(s, assigned.get(s.skillId) ?? []));
};

export const skillResolveForNode = (args: { nodeId: string }) =>
  callVerb<Skill[]>('skill_resolve_for_node', args);

export const skillUpdate = (args: { skillId: string; patch: Partial<Skill> }) =>
  mutate<Skill | null>('skill_update', `Update skill ${args.skillId}.`, args);

export const skillAssign = (args: { nodeId: string; skillId: string }) =>
  mutate<Skill | null>(
    'skill_assign',
    `Assign skill ${args.skillId} to node ${args.nodeId}.`,
    args,
  );

export const skillUnassign = (args: { nodeId: string; skillId: string }) =>
  mutate<Skill | null>(
    'skill_unassign',
    `Remove skill ${args.skillId} from node ${args.nodeId}.`,
    args,
  );

export const skillRestoreVersion = (args: { skillId: string; version: string }) =>
  mutate<Skill | null>(
    'skill_restore_version',
    `Restore skill ${args.skillId} to version ${args.version}.`,
    args,
    true,
  );

export const agentList = async (): Promise<Agent[]> => {
  const raw = await callVerb<{ agents: adapters.RawAgent[] }>('agent_list');
  return raw.agents.map(adapters.toAgent);
};

export const repositoryGetHealth = () => callVerb<RepositoryHealth>('repository_get_health');

// ================================ learning ===================================

/**
 * Real schema is `{includeArchived?}` — there is no node filter live. Fetch
 * everything and filter client-side on the raw `nodeId` field (observations
 * with no `nodeId` at all are workspace-wide lessons, not node-scoped).
 */
export const learningListObservations = async (args?: { nodeId?: string }): Promise<Observation[]> => {
  const raw = await callVerb<{ observations: adapters.RawObservation[] }>('learning_list_observations', {});
  const filtered = args?.nodeId ? raw.observations.filter((o) => o.nodeId === args.nodeId) : raw.observations;
  return filtered.map(adapters.toObservation);
};

export const learningRecordObservation = (args: { nodeId?: string; runId?: string; txt: string }) =>
  mutate<Observation>(
    'learning_record_observation',
    'Record a new learning observation.',
    args,
  );

export const learningArchiveObservation = (args: { id: string }) =>
  mutate<Observation | null>(
    'learning_archive_observation',
    `Archive observation ${args.id}.`,
    args,
  );

export const playbookGet = (args: { nodeId: string }) => callVerb<Playbook>('playbook_get', args);

export const playbookCurate = (args: { nodeId: string; observationId?: string; lesson: string }) =>
  mutate<PlaybookMutationResult>(
    'playbook_curate',
    `Curate a lesson into the playbook for node ${args.nodeId}.`,
    args,
  );

export const playbookApplyDelta = (args: { nodeId: string; delta: unknown }) =>
  mutate<PlaybookMutationResult>(
    'playbook_apply_delta',
    `Apply a playbook delta to node ${args.nodeId}.`,
    args,
  );

export const playbookMigrateObservations = (args: { nodeId: string }) =>
  mutate<PlaybookMutationResult>(
    'playbook_migrate_observations',
    `Migrate accumulated observations into the playbook for node ${args.nodeId}.`,
    args,
  );

// =============================== evaluation ==================================

/**
 * `evaluation_list_rubrics` for the shape + `evaluation_list_regression_reports`
 * for score/verdict (see toRubric()'s doc comment) — picks each node's
 * newest report by `createdAt`, since a node can have more than one.
 */
export const evaluationListRubrics = async (): Promise<Rubric[]> => {
  const [raw, reportsRaw] = await Promise.all([
    callVerb<{ rubrics: adapters.RawRubric[] }>('evaluation_list_rubrics'),
    callVerb<{ reports: Array<adapters.RawRegressionReport & { createdAt?: string }> }>(
      'evaluation_list_regression_reports',
      {},
    ),
  ]);
  const newestByNode = new Map<string, adapters.RawRegressionReport & { createdAt?: string }>();
  for (const r of reportsRaw.reports) {
    const existing = newestByNode.get(r.nodeId);
    if (!existing || (r.createdAt ?? '') > (existing.createdAt ?? '')) newestByNode.set(r.nodeId, r);
  }
  return raw.rubrics.map((r) => adapters.toRubric(r, newestByNode.get(r.nodeId)));
};

export const evaluationListResults = (args?: { nodeId?: string }) =>
  callVerb<EvaluationResult[]>('evaluation_list_results', args);

/**
 * LIVE-VERIFIED CORRECTION (workbench-verb-fixes): wraps `{ reports: [...] }`
 * like every other list verb here, not a bare array as `RegressionReport[]`
 * previously assumed. `score`←summary.meanScore, `baseline`←baseline.meanScore
 * when present (a "held" report's own comparison point), `ranAt`←createdAt.
 */
export const evaluationListRegressionReports = async (args?: { nodeId?: string }): Promise<RegressionReport[]> => {
  const raw = await callVerb<{
    reports: Array<
      adapters.RawRegressionReport & { baseline?: { meanScore?: number | null } | null; createdAt?: string }
    >;
  }>('evaluation_list_regression_reports', args);
  return raw.reports.map((r) => ({
    nodeId: r.nodeId,
    score: r.summary?.meanScore ?? null,
    verdict: r.verdict,
    baseline: r.baseline?.meanScore ?? null,
    ranAt: r.createdAt,
  }));
};

export const evaluationCreateRubric = (args: { node: string; crit: number; top: string }) =>
  mutate<Rubric | null>('evaluation_create_rubric', `Create a rubric for node ${args.node}.`, args);

export const evaluationUpdateRubric = (args: { node: string; patch: Partial<Rubric> }) =>
  mutate<Rubric | null>('evaluation_update_rubric', `Update the rubric for node ${args.node}.`, args);

export const evaluationRun = (args: { node: string }) =>
  mutate<EvaluationResult>('evaluation_run', `Run evaluation for node ${args.node}.`, args);

export const evaluationRunRegression = (args: { node: string }) =>
  mutate<RegressionReport>(
    'evaluation_run_regression',
    `Run a regression evaluation for node ${args.node}.`,
    args,
  );

export const evaluationRestoreRubricVersion = (args: { node: string; version: string }) =>
  mutate<Rubric | null>(
    'evaluation_restore_rubric_version',
    `Restore the rubric for node ${args.node} to version ${args.version}.`,
    args,
    true,
  );

// =============================== optimizer ===================================

export const optimizerStatus = (args?: { nodeId?: string }) =>
  callVerb<OptimizerStatus>('optimizer_status', args);

export const optimizerAnalyze = (args: { nodeId: string }) =>
  mutate<OptimizerAnalysis>('optimizer_analyze', `Analyze node ${args.nodeId} for optimization.`, args);

export const optimizerPropose = (args: { nodeId: string }) =>
  mutate<OptimizerProposal>(
    'optimizer_propose',
    `Generate an optimizer proposal for node ${args.nodeId}.`,
    args,
  );

export const optimizerRunTrial = (args: { proposalId: string }) =>
  mutate<OptimizerTrial>(
    'optimizer_run_trial',
    `Run a trial for optimizer proposal ${args.proposalId}.`,
    args,
  );

export const optimizerPromote = (args: { proposalId: string }) =>
  mutate<OptimizerPromoteResult>(
    'optimizer_promote',
    `Promote optimizer proposal ${args.proposalId} into the live prompt.`,
    args,
    true,
  );

export const optimizerAutoPromote = (args: { nodeId: string }) =>
  mutate<OptimizerAutoPromoteResult>(
    'optimizer_auto_promote',
    `Allow auto-promotion of winning proposals for node ${args.nodeId}.`,
    args,
    true,
  );

// ================================ dataset =====================================

export const datasetList = async (): Promise<Dataset[]> => {
  const raw = await callVerb<{ datasets: adapters.RawDataset[] }>('dataset_list');
  return raw.datasets.map(adapters.toDataset);
};

export const datasetFinetuneReadiness = async (args?: { nodeId?: string }): Promise<FinetuneReadiness> => {
  const raw = await callVerb<{ readiness: adapters.RawFinetuneReadiness }>('dataset_finetune_readiness', args);
  return adapters.toFinetuneReadiness(raw.readiness);
};

export const datasetBuild = (args: { node: string; cases?: number }) =>
  mutate<Dataset>('dataset_build', `Build a replay dataset for node ${args.node}.`, args);

export const datasetExportSft = (args: { datasetId: string }) =>
  mutate<DatasetExportResult>(
    'dataset_export_sft',
    `Export dataset ${args.datasetId} in SFT format.`,
    args,
  );

export const datasetExportPreferences = (args: { datasetId: string }) =>
  mutate<DatasetExportResult>(
    'dataset_export_preferences',
    `Export dataset ${args.datasetId} as preference pairs.`,
    args,
  );

// ================================ feedback ====================================

export const feedbackList = (args?: { nodeId?: string }) => callVerb<FeedbackItem[]>('feedback_list', args);

export const feedbackRecord = (args: {
  nodeId?: string;
  runId?: string;
  verdict: string;
  note?: string;
}) => mutate<FeedbackItem>('feedback_record', 'Record a feedback verdict.', args);

// ================================== usage =====================================

/**
 * `usage_get_summary` (filtered by `args.workflowId` when given, else
 * unfiltered) for the overall total, composed with one
 * `usage_get_summary({workflowId})` + one `workflow_list_runs({workflowId,
 * limit:1})` (for `page.matchedCount`) per known conductor workflow, for
 * `byWorkflow` — see toUsageSummary()'s doc comment; live has no single
 * verb with a per-workflow breakdown. `byWorkflow` always covers every
 * known workflow regardless of `args.workflowId`, matching UsageTab.tsx's
 * one unfiltered caller.
 */
export const usageGetSummary = async (args?: { workflowId?: string }): Promise<UsageSummary> => {
  const overall = await callVerb<adapters.RawUsageSummary>(
    'usage_get_summary',
    args?.workflowId ? { workflowId: args.workflowId } : {},
  );
  const workflowIds = Object.keys(WORKFLOWS);
  const perWorkflow = await Promise.all(
    workflowIds.map(async (workflowId) => {
      const [summary, runsPage] = await Promise.all([
        callVerb<adapters.RawUsageSummary>('usage_get_summary', { workflowId }),
        callVerb<{ page?: { matchedCount?: number } }>('workflow_list_runs', { workflowId, limit: 1 }),
      ]);
      return { workflowId, summary, runCount: runsPage.page?.matchedCount ?? 0 };
    }),
  );
  return adapters.toUsageSummary(overall, perWorkflow);
};

export const usageGetBudgetStatus = (args?: { runId?: string }) =>
  callVerb<BudgetStatus>('usage_get_budget_status', args);

// Re-exported for callers that only need the risk type alongside these verbs.
export type { Risk, Workflow };
