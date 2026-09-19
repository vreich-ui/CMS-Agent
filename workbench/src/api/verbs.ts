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
import type { ToolExecutionRow } from '../screens/Runs/toolTimeline';
import * as adapters from './adapters';
import type {
  Agent,
  Dataset,
  FinetuneReadiness,
  ModelConfig,
  NodeDefaultOutput,
  Observation,
  Project,
  PublishReadiness,
  Risk,
  Rubric,
  Run,
  RunOutputMode,
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

/**
 * W3 — the catalog is presentation config, the SERVER says which workflows exist.
 *
 * WORKFLOW_CATALOG lists three; the live registry registers eight (publishing, clone, capture,
 * visual_identity, pdf_template_studio, asset_lookup, document_render, image_template_revision).
 * Five workflows the workspace actually runs were simply not on this screen. A registered id the
 * catalog does not know now gets a generic card whose single phase is "ungrouped (live)" — the
 * same honesty rule the rail already applies to a node no phase claims.
 *
 * Called with no argument (fixture mode before the registry lands, and any caller that does not
 * have it) it returns the catalog alone, exactly as it always did.
 */
export const workflowList = (registeredWorkflowIds?: string[]): Promise<Workflow[]> => {
  const catalog = Object.values(WORKFLOWS);
  if (!registeredWorkflowIds?.length) return Promise.resolve(catalog);
  const known = new Set(catalog.map((workflow) => workflow.id));
  const live = registeredWorkflowIds
    .filter((id) => !known.has(id))
    .map((id) => ({
      id,
      name: id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      fn: 'Registered workflow — no presentation config',
      icon: 'ic-pub',
      short: 'Live in the server registry; this build has no phase config for it.',
      desc: 'This workflow is registered and runnable on the control plane. The Workbench has no phase names for it, so its nodes are listed under "ungrouped (live)" in the order the graph returns them.',
      phases: [] as Array<[string, string[]]>,
    }));
  // Catalog order first (it is editorial), then whatever else the server runs. Catalog entries are
  // never filtered OUT by the registry: a catalog card may be a `planned` workflow that is
  // deliberately not registered yet, and dropping it would delete a deliberate piece of the deck.
  return Promise.resolve([...catalog, ...live]);
};

export const workflowGet = (args: { workflowId: string }): Promise<Workflow | undefined> =>
  Promise.resolve(WORKFLOWS[args.workflowId]);

// --- shapes with no fixture — fixture-mode guesses, see report ---------------

/** JSON Schema 2020-12 permits either an object or a boolean schema. */
export type JSONSchema = Record<string, unknown> | boolean;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** The two optimistic-concurrency tokens CMS-Agent actually accepts. */
export interface WorkspacePrecondition {
  expectedWorkspaceVersion?: number;
  baseRevisionId?: string;
}

export interface SchemaEditPreparation {
  /** Complete stored node sent to workspace_validate_node as `node`, never an unsupported patch. */
  node: Record<string, unknown>;
  precondition: WorkspacePrecondition;
}

export type SchemaSaveReadback =
  | { state: 'confirmed'; schema: JSONSchema; workspaceVersion?: number }
  | { state: 'uncertain'; message: string; workspaceVersion?: number };

export class WorkspaceEditConflictError extends Error {
  readonly currentVersion?: number;
  readonly currentRevisionId?: string;

  constructor(message: string, details: { currentVersion?: number; currentRevisionId?: string } = {}) {
    super(message);
    this.name = 'WorkspaceEditConflictError';
    this.currentVersion = details.currentVersion;
    this.currentRevisionId = details.currentRevisionId;
  }
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

/**
 * WP-00 CORRECTION (live capture). `workspace_get_graph` returns FULL node
 * objects — the same fields `workspace_get_nodes` returns, minus its legacy
 * `schema` alias — not the `{id, deps}` stub previously declared here. Typed
 * as `RawWorkflowNode & {deps?}` so the graph can feed the same adapter the
 * node list does; `deps` is kept optional because the live payload expresses
 * dependencies as `dependsOn` on the node plus a top-level `edges` array.
 */
export interface WorkspaceGraph {
  workflowId?: string;
  nodes: Array<adapters.RawWorkflowNode & { deps?: string[] }>;
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

export interface EvaluationResult {
  nodeId: string;
  score: number | null;
  verdict: string | null;
  ranAt?: string;
  /** W5 — present when the evaluation was run against a specific run; the Scores tab joins on it. */
  runId?: string;
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
  node?: Record<string, unknown>;
  workspaceVersion?: number;
}

// ============================== workspace ====================================

/**
 * WP-00 CORRECTION (live capture, 2026-08-26). The previous comment here —
 * "`workspace_get_graph` takes NO arguments live" — was wrong, and it is
 * the reason the rail lied about two of the three conductors.
 *
 * Live behaviour: called with no arguments it returns the flat store view
 * (48 nodes, 92 edges, every conductor merged). Called with a `workflowId`
 * it returns THAT conductor's real run topology — canonical `dependsOn`
 * overlaid with store-edited prompt/schema/tools, i.e. exactly what the
 * executor is handed. Per-conductor counts as captured:
 * publishing_conductor 24 nodes / 50 edges, capture_conductor 16 / 28,
 * clone_conductor 18 / 35 (they share the publish tail:
 * publish_payload, publication_controller, publish_executor,
 * release_executor, learning_recorder).
 *
 * So this is the one verb that can answer "what does this workflow
 * actually look like", and it is now sent the argument it always
 * accepted. Node objects come back with the same fields
 * `workspace_get_nodes` returns (minus the legacy `schema` alias).
 */
export const workspaceGetGraph = (args?: { workflowId?: string }) =>
  callVerb<WorkspaceGraph>('workspace_get_graph', args?.workflowId ? { workflowId: args.workflowId } : {});

/** Counts are a property of the resolved run graph, never the presentation phase catalog. */
export const workspaceGetResolvedWorkflowNodeCount = async (workflowId: string): Promise<number> =>
  (await workspaceGetGraph({ workflowId })).nodes.length;

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
 * P2-03 / rail truth.
 *
 * Without a `workflowId` this is the flat store view: every node in the
 * workspace, wrapped as `{ nodes: [...] }` (`workspace_get_nodes` accepts
 * no arguments live — its schema is literally `{properties:{}}`).
 *
 * WITH a `workflowId` it now asks `workspace_get_graph({workflowId})`,
 * which returns that conductor's real topology. This replaces a
 * client-side filter against WORKFLOW_CATALOG's hardcoded id lists — and
 * that filter was wrong: the catalog claimed 9 nodes for clone_conductor
 * where the live graph has 18 (the four `pdf_template_*` nodes and the
 * whole shared publish tail were simply missing), and 11 for
 * capture_conductor where live has 16. Two of the three workflows showed
 * the operator a rail that did not match the pipeline that actually runs.
 *
 * The catalog survives as presentation config only — phase names and
 * ordering (see workflowCatalog.ts) — never again as the source of truth
 * for which nodes exist.
 *
 * The fallback matters: if the graph call fails for one workflow, the flat
 * node list still answers, filtered by the catalog, rather than leaving
 * the rail empty.
 */
export const workspaceGetNodes = async (args?: { workflowId?: string; detail?: 'summary' | 'full' }): Promise<WorkflowNode[]> => {
  if (args?.workflowId) {
    try {
      const graph = await workspaceGetGraph({ workflowId: args.workflowId });
      if (graph?.nodes?.length) return graph.nodes.map((n) => adapters.toNode(n));
    } catch {
      // fall through to the flat list below
    }
  }
  // W2/W6 — `detail: "summary"` is the list projection: identity, shape, status, executionKind and
  // a promptSha, and none of the prompt/schema/tool payload that is 82 % of a full node. A caller
  // that draws a LIST asks for it; the inspector still fetches the one node it opened in full.
  if (args?.detail === 'summary') {
    const summary = await callVerb<{ nodes: adapters.RawWorkflowNodeSummary[] }>('workspace_get_nodes', { detail: 'summary' });
    return summary.nodes.map(adapters.toNodeSummary);
  }
  const raw = await callVerb<{ nodes: adapters.RawWorkflowNode[] }>('workspace_get_nodes', {});
  const nodes = raw.nodes.map(adapters.toNode);
  if (!args?.workflowId) return nodes;
  const ids = nodeIdsForWorkflow(args.workflowId);
  return ids ? nodes.filter((n) => ids.has(n.id)) : nodes;
};

/**
 * W3 — `workbench.bootstrap`: the whole first paint, in one call.
 *
 * Before it, a cold load fired FIFTEEN verbs (see workbench/contracts/first-paint.json), five of
 * which took 12-24 s each. This one returns the registry, the requested workflow's summary graph,
 * its recent run rows, the attention counts and the workspace version — the version being the key
 * a persisted client cache is invalidated on.
 *
 * `registeredWorkflowIds` is the server's own registry. WORKFLOW_CATALOG is presentation config
 * and knows three; the registry has more, and a workflow missing from the Workbench because a
 * constant in this repo was never updated is exactly the defect that field closes.
 */
export interface BootstrapEnvelope {
  registeredWorkflowIds: string[];
  /** Node count per registered workflow — what the workflow menu and the deck print, without a
   *  graph download each. */
  nodeCounts: Record<string, number>;
  unknownWorkflowId?: string;
  graph: { workflowId: string; nodes: WorkflowNode[]; edges: Array<{ from: string; to: string }> } | null;
  recentRuns: Run[];
  attentionCounts: { running: number; paused: number; blocked: number; failed: number };
  workspaceVersion: number;
}

interface RawBootstrap {
  registeredWorkflowIds?: string[];
  nodeCounts?: Record<string, number>;
  unknownWorkflowId?: string;
  graph?: { workflowId: string; nodes: adapters.RawWorkflowNodeSummary[]; edges: Array<{ from: string; to: string }> } | null;
  recentRuns?: adapters.RawRun[];
  modes?: Record<string, { executionMode?: string }>;
  attentionCounts?: Partial<BootstrapEnvelope['attentionCounts']>;
  workspaceVersion?: number;
}

export const workbenchBootstrap = async (args: { workflowId?: string } = {}): Promise<BootstrapEnvelope> => {
  const raw = await callVerb<RawBootstrap>('workbench_bootstrap', args.workflowId ? { workflowId: args.workflowId } : {});
  return {
    registeredWorkflowIds: raw.registeredWorkflowIds ?? [],
    nodeCounts: raw.nodeCounts ?? {},
    ...(raw.unknownWorkflowId ? { unknownWorkflowId: raw.unknownWorkflowId } : {}),
    graph: raw.graph
      ? { workflowId: raw.graph.workflowId, nodes: (raw.graph.nodes ?? []).map(adapters.toNodeSummary), edges: raw.graph.edges ?? [] }
      : null,
    recentRuns: (raw.recentRuns ?? []).map((row) => adapters.toRun(row.modeRef && raw.modes?.[row.modeRef] ? { ...row, mode: raw.modes[row.modeRef] } : row)),
    attentionCounts: {
      running: raw.attentionCounts?.running ?? 0,
      paused: raw.attentionCounts?.paused ?? 0,
      blocked: raw.attentionCounts?.blocked ?? 0,
      failed: raw.attentionCounts?.failed ?? 0,
    },
    workspaceVersion: raw.workspaceVersion ?? 0,
  };
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
    { id: args.nodeId, prompt: args.prompt },
  );

export const workspaceUpdateNodeTools = (args: { nodeId: string; tools: string[] } & WorkspacePrecondition) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_tools',
    `Set the tool list for node ${args.nodeId} (${args.tools.length} tools).`,
    { id: args.nodeId, patch: { allowedTools: args.tools }, ...preconditionArgs(args) },
  );

export const workspaceUpdateNodeSkills = (args: { nodeId: string; skills: string[] } & WorkspacePrecondition) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_skills',
    `Set the skill list for node ${args.nodeId} (${args.skills.length} skills).`,
    { id: args.nodeId, patch: { assignedSkills: args.skills }, ...preconditionArgs(args) },
  );

/**
 * LIVE-VERIFIED CORRECTION (budget-override-and-ui-save): the live tool's
 * input schema is `updateNodeInput` (tools.ts) — `{ id, patch }`, `.strict()`
 * — same as every other `workspace_update_node_*` verb in this file. This
 * verb alone used to send a bespoke flat `{ nodeId, model }`, which the live
 * server refused outright: `additionalProperties: false` means an unknown
 * top-level key doesn't get ignored, and `requirePatchField(data.patch,
 * "modelConfig", ...)` throws `missing_patch_field` when `patch` itself is
 * absent. Every mutation lands on the WIRE shape `{ id, patch: { modelConfig:
 * {...} } }`; the server deep-merges `patch.modelConfig` onto the node's
 * existing config (tools.ts's deepMergeRecords), so `patch` here only needs
 * to carry the fields that actually changed — ModelTab.tsx builds exactly
 * that diff, in server units (`timeout` in ms, not the UI's "Ns" string).
 */
export const workspaceUpdateNodeModelConfig = (args: { nodeId: string; patch: Partial<adapters.RawModelConfig> }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_model_config',
    `Update model & limits for node ${args.nodeId}.`,
    { id: args.nodeId, patch: { modelConfig: args.patch } },
  );

export const workspaceUpdateNodeInputSchema = (args: { nodeId: string; schema: JSONSchema } & WorkspacePrecondition) =>
  mutate<SchemaUpdateResult>(
    'workspace_update_node_input_schema',
    `Update the input schema for node ${args.nodeId}.`,
    { id: args.nodeId, schema: args.schema, ...preconditionArgs(args) },
  );

export const workspaceUpdateNodeOutputSchema = (args: { nodeId: string; schema: JSONSchema } & WorkspacePrecondition) =>
  mutate<SchemaUpdateResult>(
    'workspace_update_node_output_schema',
    `Update the output schema for node ${args.nodeId}.`,
    { id: args.nodeId, schema: args.schema, ...preconditionArgs(args) },
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

function preconditionArgs(args: WorkspacePrecondition): WorkspacePrecondition {
  return {
    ...(args.expectedWorkspaceVersion === undefined ? {} : { expectedWorkspaceVersion: args.expectedWorkspaceVersion }),
    ...(args.baseRevisionId === undefined ? {} : { baseRevisionId: args.baseRevisionId }),
  };
}

/** Read-shaped — validate the complete candidate with the actual `{ node }` contract. */
export const workspaceValidateNode = async (args: { node: Record<string, unknown> }): Promise<ValidationResult> => {
  const raw = await callVerb<{ valid?: unknown; errors?: unknown }>('workspace_validate_node', args);
  return {
    valid: raw.valid === true,
    errors: Array.isArray(raw.errors) ? raw.errors.map(String) : raw.valid === true ? [] : ['The workspace rejected this node configuration.'],
  };
};

/**
 * Fetch the exact node and its only advertised workspace-wide concurrency
 * tokens. The export is intentionally a save-time read, not a background
 * screen fetch: it can be large and is used solely to avoid blind writes.
 */
export const workspacePrepareNodeEdit = async (nodeId: string): Promise<SchemaEditPreparation> => {
  const [nodeEnvelope, workspace] = await Promise.all([
    callVerb<{ node: Record<string, unknown> | null }>('workspace_get_node', { id: nodeId }),
    callVerb<{ workspaceVersion?: unknown; currentRevisionId?: unknown }>('workspace_export_workspace', {}),
  ]);
  if (!nodeEnvelope.node) throw new Error(`Unknown node: ${nodeId}`);
  return {
    node: nodeEnvelope.node,
    precondition: {
      ...(typeof workspace.workspaceVersion === 'number' ? { expectedWorkspaceVersion: workspace.workspaceVersion } : {}),
      ...(typeof workspace.currentRevisionId === 'string' ? { baseRevisionId: workspace.currentRevisionId } : {}),
    },
  };
};

/** @deprecated use workspacePrepareNodeEdit; kept temporarily for callers in this package. */
export const workspacePrepareSchemaEdit = workspacePrepareNodeEdit;

export function candidateWithSchema(prepared: SchemaEditPreparation, kind: 'input' | 'output', schema: JSONSchema): Record<string, unknown> {
  // `schema` is a deprecated output alias. Keep it aligned only for candidate
  // validation; the real output writer owns the stored alias behavior.
  return kind === 'input'
    ? { ...prepared.node, inputSchema: schema }
    : { ...prepared.node, outputSchema: schema, schema };
}

function schemasEqual(a: JSONSchema | null, b: JSONSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function conflictFrom(error: unknown): WorkspaceEditConflictError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b(?:revision_conflict|workspace_version|conflict)\b/i.test(message)) return null;
  const version = /current(?:Version| version)[:= ]+(\d+)/i.exec(message)?.[1];
  const revision = /currentRevisionId[:= ]+([\w-]+)/i.exec(message)?.[1];
  return new WorkspaceEditConflictError(message, {
    ...(version ? { currentVersion: Number(version) } : {}),
    ...(revision ? { currentRevisionId: revision } : {}),
  });
}

/** Save a schema only after a complete-node validation, then prove it by reading it back. */
export async function workspaceSaveSchemaWithReadback(args: {
  nodeId: string;
  kind: 'input' | 'output';
  schema: JSONSchema;
  prepared: SchemaEditPreparation;
}): Promise<SchemaSaveReadback> {
  const candidate = candidateWithSchema(args.prepared, args.kind, args.schema);
  const validation = await workspaceValidateNode({ node: candidate });
  if (!validation.valid) throw new Error(validation.errors.join(' ') || 'The workspace rejected this complete node configuration.');

  let mutation: SchemaUpdateResult;
  try {
    mutation = args.kind === 'input'
      ? await workspaceUpdateNodeInputSchema({ nodeId: args.nodeId, schema: args.schema, ...args.prepared.precondition })
      : await workspaceUpdateNodeOutputSchema({ nodeId: args.nodeId, schema: args.schema, ...args.prepared.precondition });
  } catch (error) {
    const conflict = conflictFrom(error);
    if (conflict) throw conflict;
    throw error;
  }

  try {
    const readback = args.kind === 'input'
      ? await nodeGetInputSchema({ nodeId: args.nodeId })
      : await nodeGetOutputSchema({ nodeId: args.nodeId });
    if (schemasEqual(readback, args.schema)) {
      return { state: 'confirmed', schema: readback, workspaceVersion: mutation.workspaceVersion };
    }
    return { state: 'uncertain', workspaceVersion: mutation.workspaceVersion, message: 'The workspace accepted the save, but the readback did not match. Reload before editing again.' };
  } catch (error) {
    return {
      state: 'uncertain',
      workspaceVersion: mutation.workspaceVersion,
      message: `The workspace accepted the save, but committed readback failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

export async function workspaceSaveToolsWithReadback(args: {
  nodeId: string;
  tools: string[];
  prepared: SchemaEditPreparation;
}): Promise<{ state: 'confirmed' } | { state: 'uncertain'; message: string }> {
  const candidate = { ...args.prepared.node, allowedTools: args.tools };
  const validation = await workspaceValidateNode({ node: candidate });
  if (!validation.valid) throw new Error(validation.errors.join(' ') || 'The workspace rejected this complete node configuration.');
  try {
    await workspaceUpdateNodeTools({ nodeId: args.nodeId, tools: args.tools, ...args.prepared.precondition });
  } catch (error) {
    const conflict = conflictFrom(error);
    if (conflict) throw conflict;
    throw error;
  }
  try {
    const readback = await workspaceGetNode({ nodeId: args.nodeId });
    if (readback && JSON.stringify(readback.tools) === JSON.stringify(args.tools)) return { state: 'confirmed' };
    return { state: 'uncertain', message: 'The workspace accepted the tool save, but readback did not match. Reload before editing again.' };
  } catch (error) {
    return { state: 'uncertain', message: `The workspace accepted the tool save, but committed readback failed: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
}

export async function workspaceSaveSkillsWithReadback(args: {
  nodeId: string;
  skills: string[];
  prepared: SchemaEditPreparation;
}): Promise<{ state: 'confirmed' } | { state: 'uncertain'; message: string }> {
  const candidate = { ...args.prepared.node, assignedSkills: args.skills };
  const validation = await workspaceValidateNode({ node: candidate });
  if (!validation.valid) throw new Error(validation.errors.join(' ') || 'The workspace rejected this complete node configuration.');
  try {
    await workspaceUpdateNodeSkills({ nodeId: args.nodeId, skills: args.skills, ...args.prepared.precondition });
  } catch (error) {
    const conflict = conflictFrom(error);
    if (conflict) throw conflict;
    throw error;
  }
  try {
    const readback = await workspaceGetNode({ nodeId: args.nodeId });
    if (readback && JSON.stringify(readback.skills) === JSON.stringify(args.skills)) return { state: 'confirmed' };
    return { state: 'uncertain', message: 'The workspace accepted the skill save, but readback did not match. Reload before editing again.' };
  } catch (error) {
    return { state: 'uncertain', message: `The workspace accepted the skill save, but committed readback failed: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
}

// ============================ node-default-output (W4) ========================
// A node's STANDING output — a value written into a run as though the node
// produced it, with no model turn and no cost. Distinct from an operator
// override (stage_save_output, above): a default is a property of the NODE,
// reused across every run that pushes it through or starts in a defaults
// output mode; an override is pasted into ONE run. Keep that vocabulary
// distinct everywhere this surfaces — see components/drive/overrideStatus.ts.
//
// Server contract (src/agent/workspace/defaultOutput.ts, nodeTypes.ts):
// `value: null` on workspace.update_node_default_output CLEARS the default.
// Without `force`, a value failing the node's declared outputSchema is
// refused (classified default_output_schema_invalid); with `force` it is
// stored anyway, stamped `schemaValidAt: null` so the record says which of
// the two happened. Callers here follow the same proactive-validate-then-
// confirm shape OverrideOutputModal already uses for its own second
// confirmation, rather than relying on parsing the refusal back out of a
// caught error — see DefaultOutputTab.tsx.

export interface DefaultOutputSaveResult {
  node: WorkflowNode | null;
  workspaceVersion?: number;
}

function toDefaultOutputSaveResult(raw: { node?: adapters.RawWorkflowNode | null; workspaceVersion?: number }): DefaultOutputSaveResult {
  return { node: raw?.node ? adapters.toNode(raw.node) : null, workspaceVersion: raw?.workspaceVersion };
}

export const workspaceUpdateNodeDefaultOutput = (args: {
  nodeId: string;
  /** The standing output, in the shape the node's outputSchema declares. `null` CLEARS the default. */
  value: unknown;
  note?: string;
  /** Store the value even though it fails the node's outputSchema — stamps `schemaValidAt: null`. */
  force?: boolean;
}) => {
  const clearing = args.value === null || args.value === undefined;
  return mutate<{ node?: adapters.RawWorkflowNode | null; workspaceVersion?: number }>(
    'workspace_update_node_default_output',
    clearing
      ? `Clear ${args.nodeId}'s standing default output. A push-through or a defaults-mode run then either runs this node for real or refuses it as default_output_missing.`
      : `Set ${args.nodeId}'s standing default output${
          args.force ? " — saving it even though it fails the node's declared output schema (force)" : ''
        }. Any push-through (workflow.run_node with useDefaultOutput) or defaults-mode run on this node then uses this value in place of running it — no model turn, no cost, and a run carrying it can never reach a live publish.`,
    {
      nodeId: args.nodeId,
      value: args.value,
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(args.force ? { force: true } : {}),
    },
    clearing,
  ).then(toDefaultOutputSaveResult);
};

export const workspaceAdoptOutputAsDefault = (args: {
  nodeId: string;
  /** Adopt the output this node produced in THIS run; omitted, the most recent across every run. */
  runId?: string;
  executionId?: string;
  note?: string;
  force?: boolean;
}) =>
  mutate<{ node?: adapters.RawWorkflowNode | null; workspaceVersion?: number }>(
    'workspace_adopt_output_as_default',
    `Adopt ${args.nodeId}'s last good output${args.runId ? ` from run ${args.runId}` : ' (most recent across every run)'} as its standing default. Any push-through or defaults-mode run on this node then uses that value in place of running it.`,
    {
      nodeId: args.nodeId,
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.executionId ? { executionId: args.executionId } : {}),
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(args.force ? { force: true } : {}),
    },
  ).then(toDefaultOutputSaveResult);

export interface LatestNodeOutput {
  runId?: string;
  nodeId: string;
  type?: string;
  value: unknown;
  createdAt?: string;
}

/** Read-shaped — no confirmAction. Used to seed the Default output tab's
 * editor when a node carries no default yet. */
export const nodeGetLatestOutput = async (args: { nodeId: string; runId?: string }): Promise<LatestNodeOutput | null> => {
  const raw = await callVerb<{ output: LatestNodeOutput | null } | LatestNodeOutput | null>('node_get_latest_output', args);
  if (!raw) return null;
  return 'output' in raw ? raw.output : raw;
};

// Re-exported so callers (DefaultOutputTab, StartRunModal) can name the type
// without reaching into ../types directly for just this one alias.
export type { RunOutputMode, NodeDefaultOutput };

// ================================= node ======================================

export const nodeGetEffectivePrompt = (args: { nodeId: string }) =>
  callVerb<EffectivePrompt>('node_get_effective_prompt', args);

export interface EffectiveSkillPolicy {
  nodeId: string;
  skillIds: string[];
  effectiveTools: string[];
  deniedTools: string[];
  conflicts: Array<{ severity?: string; source?: string; message?: string }>;
}

/**
 * W4 — the canonical account of what a DETERMINISTIC node does
 * (src/agent/workspace/nodeAlgorithms.ts). Null for a model node, whose explanation is its prompt.
 */
export interface NodeAlgorithm {
  nodeId: string;
  summary: string;
  source: string;
  reads: string[];
  steps: string[];
  engineTools: Array<{ verb: string; risk?: string; description?: string }>;
  route?: { routeId: string; phaseId?: string };
  engineToolsUnverified?: boolean;
}

export interface EffectiveTools {
  /** Controlled model grants. These are not the deterministic engine route. */
  tools: ToolDef[];
  /** Tenant verbs a deterministic engine route invokes directly. */
  engine: string[];
  capability: { executionKind?: 'model' | 'deterministic'; routeId?: string; deadGrants?: string[]; findings?: unknown[] } | null;
  algorithm: NodeAlgorithm | null;
  resolvedAgainst?: string;
}

/**
 * `tool.list_executions` — the controlled tool calls a node made inside a run.
 *
 * REBASE RECONCILIATION (workbench-v2 onto main's W5 T4) — both branches added a wrapper over this
 * verb, for two surfaces that want the same rows: main's run-level Tools timeline and this branch's
 * per-node I/O tab. There is one wrapper now, below, over main's `ToolExecutionRow` — the ledger
 * record's own shape, with no adapter, for the reasons its doc comment gives. This alias keeps the
 * name the I/O tab was written against.
 */
export type ToolExecution = ToolExecutionRow;

export const nodeGetEffectiveSkills = async (args: { nodeId: string }): Promise<EffectiveSkillPolicy> => {
  const raw = await callVerb<{ policy?: EffectiveSkillPolicy } | EffectiveSkillPolicy>('node_get_effective_skills', args);
  const policy = ('policy' in raw ? raw.policy : raw) as EffectiveSkillPolicy | undefined;
  if (!policy) throw new Error(`No effective skill policy returned for ${args.nodeId}.`);
  return policy;
};

export const nodeGetEffectiveTools = async (args: { nodeId: string }): Promise<EffectiveTools> => {
  const raw = await callVerb<{
    tools?: Array<adapters.RawToolDef | ToolDef>;
    engine?: unknown;
    capability?: EffectiveTools['capability'];
    algorithm?: NodeAlgorithm | null;
    resolvedAgainst?: string;
  }>('node_get_effective_tools', args);
  return {
    tools: (raw.tools ?? []).map((tool) => ('toolId' in tool ? adapters.toToolDef(tool) : tool)),
    engine: Array.isArray(raw.engine) ? raw.engine.filter((verb): verb is string => typeof verb === 'string') : [],
    capability: raw.capability ?? null,
    algorithm: raw.algorithm ?? null,
    ...(raw.resolvedAgainst ? { resolvedAgainst: raw.resolvedAgainst } : {}),
  };
};

function unwrapSchema(raw: { schema?: unknown } | JSONSchema | null, verb: string): JSONSchema {
  const schema = raw && typeof raw === 'object' && !Array.isArray(raw) && 'schema' in raw ? raw.schema : raw;
  if (schema === true || schema === false || (typeof schema === 'object' && schema !== null && !Array.isArray(schema))) {
    return schema as JSONSchema;
  }
  throw new Error(`${verb} returned no JSON Schema.`);
}

export const nodeGetInputSchema = async (args: { nodeId: string }): Promise<JSONSchema> =>
  unwrapSchema(await callVerb<{ schema?: unknown } | JSONSchema | null>('node_get_input_schema', args), 'node_get_input_schema');

export const nodeGetOutputSchema = async (args: { nodeId: string }): Promise<JSONSchema> =>
  unwrapSchema(await callVerb<{ schema?: unknown } | JSONSchema | null>('node_get_output_schema', args), 'node_get_output_schema');

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
 *
 * W1 (2026-09-14) — ONE call, always. This used to fan out one
 * projectId-scoped call per configured project and merge the results, on the
 * strength of a W1.2-era doc comment that the server has since outgrown:
 * `BlobExecutionRepository.listRunsPage` takes the full-fleet path only when
 * BOTH `limit` and `projectId` are absent. Given a `limit` it windows over the
 * per-project run INDEX — whose entries already carry
 * projectId/workflowId/status/startedAt — and fetches only the blobs for the
 * page it is about to return. So an unscoped windowed call is cheap, and the
 * fan-out was paying seven 8-second calls (measured live, 2026-09-14) to dodge
 * a cost that had already been fixed underneath it — and, batched into one
 * POST, gating every other panel on the screen behind the slowest of them.
 *
 * Which is why `limit` DEFAULTS rather than staying optional: an unscoped call
 * with no limit is the one shape that still pays the full-fleet fetch, and no
 * caller in this client wants it.
 */
export const DEFAULT_RUNS_LIMIT = 20;

export interface RunListArgs {
  workflowId?: string;
  projectId?: string;
  /** One status, or several — the server matches any of an array and counts them all in `page.matchedCount`. */
  status?: RunStatus | RunStatus[];
  limit?: number;
  /** Opaque `page.nextCursor` from a previous page, passed back verbatim. */
  cursor?: string;
  /**
   * W4 — row shape. "summary" (the server's default, and this client's) is read straight from
   * the run index: identity, status, currentNodeId, timings and per-node COUNTS, with no run
   * record opened. "full" adds the `nodes[]` array at the cost of one record read per row, so
   * ask for it only on a surface that genuinely shows per-node detail for a whole LIST — the
   * rail's per-node failure chip, the quick-look's "last run" line. For ONE run,
   * workflow_get_run was always the cheaper read.
   */
  detail?: 'summary' | 'full';
  /**
   * W2/W5 — opt-in row fields. `nodeStatuses` adds the per-node status map and failedNodeIds,
   * which only the rail's five-row strip renders; it is 18 KB across a 50-row page, so every other
   * caller (the attention strip, the runs table, the workflow deck) leaves it off. `scores` adds
   * what the run's scoring and judgement nodes recorded — the Scores tab, and nothing else.
   */
  include?: Array<'nodeStatuses' | 'scores'>;
}

/** Runs plus the page metadata — see adapters.toRunPage(), which does the reading. */
export type RunPage = adapters.RunPageView;

export const workflowListRunsPage = async (args: RunListArgs = {}): Promise<RunPage> =>
  adapters.toRunPage(
    await callVerb<{ runs: adapters.RawRun[]; page?: adapters.RawRunPage; modes?: Record<string, { executionMode?: string }> }>('workflow_list_runs', {
      limit: DEFAULT_RUNS_LIMIT,
      ...args,
    }),
  );

export const workflowListRuns = async (args: RunListArgs = {}): Promise<Run[]> =>
  (await workflowListRunsPage(args)).runs;

/**
 * `workflow_get_run` wraps `{ run, mode, stall }` — `mode`/`stall` are
 * siblings of `run`, not nested inside it (unlike a list row, which carries
 * its own `mode`/`stall` inline) — folded onto `run` here before adapting
 * so toRun() only ever has to read one shape.
 *
 * P2-03 — this no longer inline-awaits `workflow_get_run_cost`. Opening a
 * run used to mean two sequential round trips before anything could paint,
 * the second one (a cost ledger nothing above the fold displays) gating
 * the first. Cost is now its own lazy query — see useRunCost() in
 * api/hooks.ts — so the run paints on one round trip and the ledger fills
 * in when a surface actually asks for it. toRun() already defaults cost to
 * its "nothing spent yet" value, which is the right placeholder for the
 * moment before the ledger lands.
 */
export const workflowGetRun = async (args: { runId: string }): Promise<Run | null> => {
  const raw = await callVerb<{ run: adapters.RawRun; mode?: { executionMode?: string }; stall?: unknown } | null>(
    'workflow_get_run',
    {
      ...args,
      // W7 LIVE-PLANE CORRECTION. `detail` defaults to "compact" server-side, and the compact view
      // has never carried `stageOutputs` or `initialInput` — so the I/O tab's inputs and output
      // cards and W6's replay, all of which read the run record's stage outputs, would have found an
      // empty map against the live plane. The FIXTURE synthesised one, which is exactly why no test
      // on either plane could see it. `include` is the opt-in W7 added to the compact view for this;
      // `detail: "full"` would also work and would drag every node's whole input/output object
      // (100 KB+) along with it.
      include: ['stageOutputs'],
    },
  );
  if (!raw?.run) return null;
  const merged: adapters.RawRun = { ...raw.run, mode: raw.mode ?? raw.run.mode, stall: raw.stall ?? raw.run.stall };
  return adapters.toRun(merged);
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
  /** node-default-output (W4) — defaults to 'live' server-side when omitted. */
  outputMode?: RunOutputMode;
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

export const workflowRunNode = (args: { runId: string; nodeId: string; useDefaultOutput?: boolean }) =>
  mutate<Run | null>(
    'workflow_run_node',
    args.useDefaultOutput
      ? `Push ${args.nodeId} through in ${args.runId} using its standing default output — no model turn, no cost. If ${args.nodeId} has no default this is refused (default_output_missing), and ${args.runId} can never reach a live publish while any node's output was supplied rather than produced.`
      : `Run node ${args.nodeId} in ${args.runId}.`,
    args,
  );

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

export const workflowRetryNode = (args: { runId: string; nodeId: string; useDefaultOutput?: boolean }) =>
  mutate<Run | null>(
    'workflow_retry_node',
    args.useDefaultOutput
      ? `Retry ${args.nodeId} in run ${args.runId} by pushing it through with its standing default output — no model turn, no cost. If ${args.nodeId} has no default this is refused (default_output_missing).`
      : `Retry node ${args.nodeId} in run ${args.runId}.`,
    args,
  );

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

// =========================== attention & metrics =============================
// U1/U5 — `constellation_get_attention` is the workspace's own list of
// things that need a person: failed runs, pending approvals, output
// validation failures, pricing caveats, relationship issues, and
// configuration defects. Every item carries an evidence string, which is
// what makes the Attention strip actionable rather than decorative.
//
// HONESTY NOTE (WP-00, 2026-08-26): this verb was returning protocol-invalid
// content through the MCP proxy and failed 100% of calls. Track B fixed the
// server side (an unguarded read of `run.errors` on a record that had none);
// until that fix is deployed to Cloud Run, this call can still fail live.
// Every caller must therefore treat "no attention data" as a state to show
// honestly, never as "nothing needs attention" — silently reporting an all-
// clear because a verb failed is the one failure mode this surface cannot
// have.

export interface AttentionItem {
  kind: string;
  severity?: string;
  nodeId?: string;
  runId?: string;
  projectId?: string;
  title?: string;
  reason?: string;
  evidence?: string | string[];
  [key: string]: unknown;
}

export const constellationGetAttention = async (args?: { projectId?: string }): Promise<AttentionItem[]> => {
  const raw = await callVerb<{ items?: AttentionItem[]; attention?: AttentionItem[] } | AttentionItem[]>(
    'constellation_get_attention',
    args ?? {},
  );
  if (Array.isArray(raw)) return raw;
  return raw?.items ?? raw?.attention ?? [];
};

export const constellationGetMetrics = (args?: { projectId?: string; runId?: string; from?: string; to?: string }) =>
  callVerb<Record<string, unknown>>('constellation_get_metrics', args ?? {});

// ============================== stage outputs ================================
// U3 — drive mode's output override. `stage_save_output` is what makes
// "insert manually the output variant I prefer" a real thing the pipeline
// consumes rather than a note to self: the operator's chosen output is
// written into the run's stage outputs, marked as an operator override, and
// every downstream node reads it as the upstream result.

/**
 * W6 — REPLAY. `node.execute` runs ONE node outside the workflow, against dependency outputs the
 * caller supplies. Handing it a real run's upstream stage outputs is what turns "I changed this
 * prompt, is it better?" from a whole new run into one node and one answer.
 *
 * It creates its own single-node run server-side (every run does — see AGENTS.md on startDryRun),
 * so this is a MUTATING verb and goes through the confirm gate like every other one. `executionMode`
 * is explicit rather than defaulted, because the difference between a mock reply and a real model
 * call is the difference between free and not.
 */
export interface NodeExecuteResult {
  /**
   * The WHOLE synthetic run record the server wrote for this one-node execution
   * (`nodeRuntime.executeNode` returns `{ execution, executionId, trace? }` — it does NOT
   * flatten the node's own result out for you, and an earlier draft of this type that claimed
   * a top-level `output`/`status` would have read `undefined` on every call). The record's
   * `workflowId` is the literal "independent_node" and its `projectId` is the literal
   * "workspace": it is not the run you replayed against, and nothing downstream reads it.
   */
  execution?: {
    runId?: string;
    status?: string;
    errors?: string[];
    stageOutputs?: Record<string, unknown>;
    nodes?: Array<{
      nodeId: string;
      status?: string;
      output?: unknown;
      errors?: string[];
      durationMs?: number;
      blockage?: unknown;
    }>;
  };
  executionId?: string;
  trace?: unknown;
}

/**
 * The executed node's own result, dug out of the synthetic run record above. `stageOutputs`
 * carries it only on success (executeNode writes it in the completed branch); the node state
 * carries it either way, and on failure `output` is `{ error: { code, message, ... } }` rather
 * than node output — which is why the caller gets `status` alongside it and must not render a
 * failed result as if it were content.
 */
export const nodeExecuteResultOf = (result: NodeExecuteResult, nodeId: string) => {
  const state = result.execution?.nodes?.find((n) => n.nodeId === nodeId);
  return {
    status: state?.status ?? result.execution?.status,
    output: state?.status === 'completed' ? (result.execution?.stageOutputs?.[nodeId] ?? state?.output) : state?.output,
    errors: state?.errors ?? result.execution?.errors ?? [],
    durationMs: state?.durationMs,
    executionId: result.executionId,
    runId: result.execution?.runId,
  };
};

export const nodeExecute = (args: {
  nodeId: string;
  runId?: string;
  /** The run's own initial input. `executeNode` validates `input ?? {}` against the node's
   *  inputSchema before anything else, so a node with required input fields refuses a call that
   *  omits it — which is why this is threaded rather than left to default. */
  input?: unknown;
  dependencyOutputs?: Record<string, unknown>;
  modelConfig?: Record<string, unknown>;
  executionMode?: 'mock' | 'openai';
}) =>
  mutate<NodeExecuteResult>(
    'node_execute',
    `Run ${args.nodeId} on its own${args.runId ? `, against run ${args.runId}'s upstream outputs` : ''}${args.executionMode === 'openai' ? ' — a REAL model call, which costs money' : ' in mock mode (no model call, no cost)'}. This does not touch the run it reads from.`,
    {
      nodeId: args.nodeId,
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.input !== undefined ? { input: args.input } : {}),
      ...(args.dependencyOutputs ? { dependencyOutputs: args.dependencyOutputs } : {}),
      ...(args.modelConfig ? { modelConfig: args.modelConfig } : {}),
      executionMode: args.executionMode ?? 'mock',
    },
  );

export const nodeValidateOutput = (args: { nodeId: string; output: unknown }) =>
  callVerb<{ valid: boolean; issues?: unknown[] }>('node_validate_output', args);

export const nodeListOutputs = (args: { nodeId?: string; runId?: string; artifactType?: string; limit?: number }) =>
  callVerb<{ outputs?: unknown[] } | unknown[]>('node_list_outputs', args);

export const stageSaveOutput = (args: { runId: string; nodeId: string; stage?: string; value: unknown; note?: string }) =>
  mutate<unknown>(
    'stage_save_output',
    `Replace ${args.nodeId}'s output in run ${args.runId} with the variant you supplied. Every downstream node in this run will read YOUR value as this node's result, and the run record will record it as an operator override.`,
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

/**
 * U4 — the full change event, not the flattened `ChangeRecord` above.
 *
 * The learning activity feed has to answer "what did it learn, and what did
 * it change" — which needs the things the flat shape drops: who did it
 * (`actor.kind` distinguishes a human edit from an agent's promotion from
 * a system migration), why (`reason`), and which two revisions to compare
 * (`parentRevisionId` -> `resultingRevisionId`, the exact pair the diff &
 * merge studio opens on).
 *
 * `actorKind` / `operation` / `source` are real server-side filters
 * (live-verified, WP-00), so a feed filtered to learning-attributed actors
 * is one call, not a client-side sift through everything.
 */
export interface ChangeEvent {
  eventId: string;
  type: string;
  operation?: string;
  target?: { type: string; id: string };
  actor?: { kind: string; id?: string; label?: string };
  source?: string;
  reason?: string;
  parentRevisionId?: string;
  resultingRevisionId?: string;
  workspaceVersion?: string;
  riskLevel?: string;
  before?: unknown;
  after?: unknown;
  correlation?: { requestId?: string };
  createdAt: string;
}

export const changesListEvents = async (args?: {
  nodeId?: string;
  actorKind?: 'human' | 'agent' | 'system';
  operation?: string;
  source?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ events: ChangeEvent[]; nextCursor?: string }> => {
  const raw = await callVerb<{ events: ChangeEvent[]; nextCursor?: string }>('changes_list', args ?? {});
  return { events: raw.events ?? [], nextCursor: raw.nextCursor };
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
 * W5 T4 — `tool_list_executions`, scoped to one run.
 *
 * NO ADAPTER, deliberately: the timeline renders the ledger record's own fields, and every one of
 * them (caller, routeId, projectId, engineVerbUnlisted) is optional precisely because rows written
 * before W3.2.1 do not have it. Mapping through a to<Entity>() would have to invent a default for
 * each, and "this row did not say" is the fact the screen is there to show. The cast is the same
 * honest boundary-trust cast this file uses for verbs whose item shape is the live shape.
 */
export const toolListExecutions = async (args: { runId?: string; nodeId?: string; toolId?: string }): Promise<ToolExecutionRow[]> => {
  // The filters are all optional server-side (listToolExecutionsInput is `.strict()` with every
  // field optional), and the I/O tab scopes to one node of one run rather than to a whole run.
  const raw = await callVerb<{ executions?: unknown[] } | unknown[]>('tool_list_executions', args);
  return (Array.isArray(raw) ? raw : (raw.executions ?? [])) as ToolExecutionRow[];
};

/**
 * `skill_list`. Live skill records carry no `assignedTo` (see toSkill()'s
 * doc comment) — derived here from a `workspace_get_nodes` call, the same
 * one workspaceGetNodes() itself wraps, so this is a second live/fixture
 * round-trip, not a reuse of some cache.
 */
export const skillList = async (knownNodes?: WorkflowNode[]): Promise<Skill[]> => {
  // P2-03 — when the caller already holds the workspace node list (useSkills()
  // reads it straight out of the query cache), this stops being a second
  // live round trip for data the app already has.
  const [raw, nodes] = await Promise.all([
    callVerb<{ skills: adapters.RawSkill[] }>('skill_list'),
    knownNodes ? Promise.resolve(knownNodes) : workspaceGetNodes(),
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

/** `agent_get` — the same view as a list row plus the FULL prompt, which a list deliberately omits. */
export interface AgentDetail extends Agent {
  prompt: string;
  modelConfig?: { provider?: string; model?: string; timeoutMs?: number; maxOutputTokens?: number };
}

export const agentGet = async (args: { agentId: string }): Promise<AgentDetail> => {
  const raw = await callVerb<{ agent: adapters.RawAgent & { prompt?: string; modelConfig?: AgentDetail['modelConfig'] } }>('agent_get', { id: args.agentId });
  return { ...adapters.toAgent(raw.agent), prompt: raw.agent.prompt ?? '', modelConfig: raw.agent.modelConfig };
};

export const agentUpdatePrompt = (args: { agentId: string; prompt: string; expectedWorkspaceVersion?: number }) =>
  confirmAction(
    { verb: 'agent_update', effect: `Replace this agent's stored prompt. It bumps the agent's revision, which invalidates outstanding agent_ref values — the next admin-chat turn re-resolves against the new one.` },
    () => callVerb<{ agent: adapters.RawAgent; workspaceVersion: number }>('agent_update', {
      id: args.agentId,
      patch: { prompt: args.prompt },
      ...(args.expectedWorkspaceVersion !== undefined ? { expectedWorkspaceVersion: args.expectedWorkspaceVersion } : {}),
    }),
  );

/**
 * W5 — `agent.list_conversations`. CMS-Agent's own bounded audit mirror of what this agent has
 * been saying; Platform's ChatDoc remains the human-facing transcript authority. `scanCapped` says
 * whether older conversations were left unexamined, so an incomplete answer is never presented as
 * a complete one.
 */
export interface AgentTurn {
  turnId: string;
  createdAt: string;
  actor: { kind: string; id: string };
  request: { messageCount: number; latestMessagePreview?: string; toolNames?: string[] };
  assistantText?: string;
  proposedToolCalls: Array<{ name: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsdEstimate: number };
}

export interface AgentConversation {
  conversationId: string;
  projectId: string;
  agentRev?: string;
  lastTurnAt: string;
  turnCount: number;
  trimmedTurnCount?: number;
  turns: AgentTurn[];
}

export const agentListConversations = async (args: { agentId: string; projectId?: string; limit?: number }): Promise<{ conversations: AgentConversation[]; scanned: number; scanCapped: boolean }> => {
  const raw = await callVerb<{ conversations?: AgentConversation[]; scanned?: number; scanCapped?: boolean }>('agent_list_conversations', args);
  return { conversations: raw.conversations ?? [], scanned: raw.scanned ?? 0, scanCapped: Boolean(raw.scanCapped) };
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

/** `learning_archive_observation` returns `{observation: <the archived record>}`, not the record itself — a plain `mutate<Observation | null>(...)` cast to the raw envelope was never actually an Observation at runtime. Unwrap and adapt it like every other list/get verb does. */
export const learningArchiveObservation = async (args: { id: string; reason?: string }): Promise<Observation> => {
  const raw = await mutate<{ observation: adapters.RawObservation }>(
    'learning_archive_observation',
    `Archive observation ${args.id}.`,
    args,
  );
  return adapters.toObservation(raw.observation);
};

/**
 * `playbook_get`. Omit `projectId` for the FLEET record — that is the
 * backend's own spelling of "no tenant scope" (improvementTools.ts's
 * playbook.get doc comment), not something this client invents. Callers
 * (Learning/PlaybookPanel.tsx) gate this on an explicit scope selection —
 * see Learning/scope.ts for why "no projectId" and "operator hasn't picked
 * a scope yet" must never be the same client-side state even though they
 * produce the same wire call.
 */
export const playbookGet = async (args: { nodeId: string; projectId?: string }): Promise<adapters.PlaybookView> => {
  const raw = await callVerb<adapters.RawPlaybookGetResult>(
    'playbook_get',
    args.projectId ? { nodeId: args.nodeId, projectId: args.projectId } : { nodeId: args.nodeId },
  );
  return adapters.toPlaybookView(args.nodeId, raw);
};

export interface PlaybookDeltaInput {
  add?: Array<{ text: string; kind: adapters.PlaybookItemKind }>;
  markHelpful?: string[];
  markHarmful?: string[];
  retire?: string[];
}

/**
 * `playbook_apply_delta`. Real schema is `{nodeId, delta, projectId?}` where
 * `delta` is `{add?, markHelpful?, markHarmful?, retire?}` — there is no
 * `{op, lessonId}` shape and no hard delete; "remove" a lesson by passing
 * its id in `retire` (one-way), and "restore" a retired one by re-`add`ing
 * its EXACT original text — applyPlaybookDelta (improvement/playbook.ts)
 * dedupes adds by normalized text and flips a matching retired item back to
 * `active` rather than inserting a duplicate. Both are real, existing
 * backend semantics; neither is an invented tool. See
 * Learning/PlaybookPanel.tsx for where this is used that way.
 */
export const playbookApplyDelta = (args: { nodeId: string; delta: PlaybookDeltaInput; projectId?: string }) =>
  mutate<adapters.RawPlaybookApplyDeltaResult>(
    'playbook_apply_delta',
    `Apply a playbook delta to ${args.nodeId} (${args.projectId ?? 'fleet'}).`,
    args.projectId ? { nodeId: args.nodeId, delta: args.delta, projectId: args.projectId } : { nodeId: args.nodeId, delta: args.delta },
  ).then((raw) => adapters.toPlaybookRecordView(raw));

export interface PlaybookCurateResult {
  playbook: adapters.PlaybookRecordView | null;
  curated: boolean;
  mode: 'mock' | 'openai';
  reason?: string;
}

/**
 * `playbook.curate` — the Reflector→Curator pass that derives a delta from a
 * node's EVALUATION evidence and applies it. Real schema is
 * `{nodeId, mode, projectId?}`; it does NOT take a lesson's text or an
 * observationId at all, so it was never the right verb for "curate this one
 * observation into a lesson" (see the track-A report — that was
 * `playbookCurate({nodeId, observationId, lesson})` before this fix, which
 * `.strict()`-rejected on a live backend). Kept here, correctly typed, for
 * when a future WP wires up the automatic pass; Observations.tsx's curate
 * flow now calls playbookApplyDelta instead, which is what it always meant.
 */
export const playbookCurate = async (args: { nodeId: string; mode: 'mock' | 'openai'; projectId?: string }): Promise<PlaybookCurateResult> => {
  const raw = await mutate<{ playbook: adapters.RawPlaybookApplyDeltaResult['playbook'] | null; curated: boolean; mode: 'mock' | 'openai'; reason?: string }>(
    'playbook_curate',
    `Run the reflector/curator pass for ${args.nodeId} (${args.projectId ?? 'fleet'}).`,
    args.projectId ? { nodeId: args.nodeId, mode: args.mode, projectId: args.projectId } : { nodeId: args.nodeId, mode: args.mode },
  );
  return {
    playbook: raw.playbook ? adapters.toPlaybookRecordView({ playbook: raw.playbook, scope: '' }) : null,
    curated: raw.curated,
    mode: raw.mode,
    reason: raw.reason,
  };
};

export interface PlaybookMigrateObservationsResult {
  migratedNodes: number;
  migratedObservations: number;
  skippedWithoutNodeId: number;
  dryRun: boolean;
}

/**
 * `playbook.migrate_observations`. Real schema is `{dryRun?}` — GLOBAL, no
 * `nodeId` parameter at all: it sweeps every node-tagged observation in one
 * pass (improvementTools.ts). The UI used to send `{nodeId}` (an argument
 * the tool's `.strict()` zod schema rejects outright on a live backend, as
 * if a per-node migration existed; it doesn't), so this is now a single
 * global action, not one scoped to a node filter.
 */
export const playbookMigrateObservations = (args?: { dryRun?: boolean }) =>
  mutate<PlaybookMigrateObservationsResult>(
    'playbook_migrate_observations',
    'Migrate every node-tagged legacy observation into its playbook (fleet scope, all nodes).',
    args?.dryRun !== undefined ? { dryRun: args.dryRun } : {},
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

/**
 * W7 LIVE-PLANE CORRECTION — the server returns `ok({ results: [...] })` (improvementTools.ts), like
 * every other list verb, NOT a bare array. This was typed as `EvaluationResult[]`, so W5's Scores
 * tab did `for (const r of evalsQ.data)` over an object and would have thrown
 * "is not iterable" inside a render on the first live open, taking the whole Runs screen down. The
 * fixture returned a bare array, so fixture mode could never catch it. Tolerates both shapes rather
 * than swapping one assumption for another.
 */
export const evaluationListResults = async (args?: { nodeId?: string }): Promise<EvaluationResult[]> => {
  const raw = await callVerb<{ results?: EvaluationResult[] } | EvaluationResult[] | null>('evaluation_list_results', args);
  if (Array.isArray(raw)) return raw;
  return raw?.results ?? [];
};

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
 *
 * W1 — each run count is ONE unscoped `limit:1` call again, not one per
 * configured project. Under the old fan-out this composition cost
 * 1 + workflows x (1 + projects) calls — 1 + 3 x 8 = 25 against the live
 * workspace — for three integers. The count comes from `page.matchedCount`,
 * which the server computes over the whole matched set regardless of `limit`,
 * so a `limit:1` window is all it ever needed. This is also why the projectList()
 * read that fed the fan-out is gone: nothing here is per-project any more.
 *
 * This composition stays OFF the first paint by construction — UsageTab is
 * mounted only when Registry's `usage` tab is selected (Registry/index.tsx's
 * switch), so nothing above fires until an operator asks for the Usage tab.
 */
export const usageGetSummary = async (args?: { workflowId?: string }): Promise<UsageSummary> => {
  const overall = await callVerb<adapters.RawUsageSummary>(
    'usage_get_summary',
    args?.workflowId ? { workflowId: args.workflowId } : {},
  );
  const workflowIds = Object.keys(WORKFLOWS);
  const perWorkflow = await Promise.all(
    workflowIds.map(async (workflowId) => {
      const [summary, countPage] = await Promise.all([
        callVerb<adapters.RawUsageSummary>('usage_get_summary', { workflowId }),
        // `page.matchedCount` counts every row matching the filters, not the rows this
        // window returned — so one `limit:1` call answers "how many runs has this
        // workflow had" for the whole fleet.
        callVerb<{ page?: { matchedCount?: number } }>('workflow_list_runs', { workflowId, limit: 1 }),
      ]);
      return { workflowId, summary, runCount: countPage.page?.matchedCount ?? 0 };
    }),
  );
  return adapters.toUsageSummary(overall, perWorkflow);
};

export const usageGetBudgetStatus = (args?: { runId?: string }) =>
  callVerb<BudgetStatus>('usage_get_budget_status', args);

// Re-exported for callers that only need the risk type alongside these verbs.
export type { Risk, Workflow };
