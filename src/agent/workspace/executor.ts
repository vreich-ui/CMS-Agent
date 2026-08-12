import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import { HALTED_EXECUTION_STATUSES, type ExecutionArtifact, type ExecutionStatus, type NodeExecutionState, type WorkflowEntrypoint, type WorkflowExecutionRecord } from "./executionTypes.js";
import { RunConcurrencyError, type ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import { recordModelUsage, summarizeModelUsage, evaluateRunBudget } from "../observability/modelUsage.js";
import { getNodeRunner } from "../execution/runnerRegistry.js";
import { validateOutput } from "../execution/outputValidator.js";
import { mockOutputForNode as mockOutputForNodeShared } from "../execution/runners/MockNodeRunner.js";
import { enforceModelLadder, modelLadderEnforcementEnabled } from "../improvement/modelLadder.js";
import { postRunReflectionEnabled, reflectAfterRun } from "../improvement/reflection.js";
import { autoPromoteEnabled, autoPromoteProposals } from "../improvement/autoPromote.js";
import type { OptimizerDeps } from "../improvement/optimizer.js";
import type { ExecutionMode } from "../execution/executionContext.js";
import { getReducedContract } from "./contractPrefetch.js";
import { getEditorialVoice } from "./voicePrefetch.js";
import { buildDeterministicContractIntelligence } from "./deterministicContractIntelligence.js";
import { runDeterministicPublishPayload } from "./publishPayload.js";
import { buildPlacementResolution, extractPlacementSignals, readPlacementTarget, resolveAggressionVector } from "./aggressionVector.js";
import { enforcePublishExecutionEvidence, findPublicationDecision, isOperatorPublishWithheld, readPublicationDecision } from "./publishDecision.js";
import { getWorkflowDefinition } from "./workflowRegistry.js";

const WORKFLOW_ID = "publishing_conductor";

// The execution mode a run gets when a caller names none.
//
// This used to be "mock" at every entry point, which meant the pipeline's DEFAULT behavior was to
// emit deterministic placeholder artifacts that are structurally indistinguishable from real model
// output — a run could look complete, produce an article body, and reach the publish gate without a
// model ever having been called. A caller who did not know the flag existed had no way to tell.
//
// Live execution is now the default and "mock" is the explicit opt-in for cheap CI//test runs. The
// failure mode this trades into is loud rather than silent: without the provider API key the first
// node fails with invalid_node_configuration naming the missing variable (OpenAINodeRunner), and the
// per-run budgetUsd ceiling still applies. Publish gates are untouched — a live-model run is still a
// dry run that stops before every publish-risk node without explicit approval.
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "openai";

// Unmissable, machine-readable statement of what a run actually executed, surfaced on
// workflow.get_run and workflow.list_runs. `live` is the field to branch on: a mock run must never be
// mistaken for a real one, and `notice` carries the same fact in prose for a human reading a
// transcript. `declared` is false only for a legacy record persisted before the mode was stamped on
// every run.
export type RunModeSummary = { executionMode: ExecutionMode; live: boolean; declared: boolean; nodeSource: "static" | "store"; notice: string };

export const runModeSummary = (run: Pick<WorkflowExecutionRecord, "executionMode">): RunModeSummary => {
  const declared = run.executionMode !== undefined;
  const executionMode = (run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode;
  const live = executionMode === "openai";
  const source = nodeSource();
  return {
    executionMode,
    live,
    declared,
    nodeSource: source,
    notice: [
      live
        ? "LIVE MODEL RUN: node outputs came from the configured model provider."
        : "MOCK RUN: every node output is a deterministic placeholder generated from the node's outputSchema. No model was called and these artifacts must not be treated as real content.",
      declared ? undefined : "This run record predates execution-mode stamping; the mode shown is the current default, not what the run recorded.",
      source === "store"
        ? "Node definitions were overlaid from the workspace store, so authoring edits (prompt, schemas, tools, skills, model config) are in this run. Topology — edges, riskLevel, new nodes — is pinned to the canonical definitions and still requires a deliberate re-seed (npm run nodes:update) plus redeploy."
        : "WORKSPACE_NODES_SOURCE=static: node definitions came from the compiled definitions, so workspace edits made over MCP are NOT in this run until nodes.ts is re-seeded and redeployed."
    ].filter(Boolean).join(" ")
  };
};

// List endpoints are discovery surfaces, not bulk-export endpoints. A persisted run can contain the
// complete input/output of every node twice (nodes + stageOutputs) and again in artifacts. Returning
// that shape for every run made workflow.list_runs grow past a million response tokens in production.
// Keep the operational fields needed by the overview and run picker; workflow.get_run is the explicit
// detail read for one selected run.
export const summarizeRunForList = (run: WorkflowExecutionRecord) => ({
  runId: run.runId,
  workflowId: run.workflowId,
  projectId: run.projectId,
  status: run.status,
  ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  nodes: run.nodes.map(({ input: _input, output: _output, ...state }) => state),
  nodeCount: run.nodes.length,
  artifactCount: run.artifacts.length,
  errors: run.errors.slice(0, 10).map((error) => error.slice(0, 2_000)),
  approvalsRequired: run.approvalsRequired,
  dryRun: run.dryRun,
  executionMode: run.executionMode,
  ...(run.rev !== undefined ? { rev: run.rev } : {}),
  ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}),
  ...(run.budgetBlock ? { budgetBlock: run.budgetBlock } : {}),
  ...(run.operatorPublishDecision ? { operatorPublishDecision: run.operatorPublishDecision } : {})
});
// Statuses from which advanceRun will not proceed. "paused" (R-18) joins them: an operator-paused run
// must stay put for exactly the same reason a blocked one does. Before "paused" existed, pause_run wrote
// "blocked" — which worked only because "blocked" was already in this set, and cost the ability to tell
// an operator pause apart from a publish hold.
const MAX_SAVE_RETRIES = 5;
// Grace period past a dispatched node's own timeout before the dispatch is considered dead. The
// runner's Promise.race timeout ends a live node at timeoutMs, so a "running" claim older than
// timeoutMs + this margin means the driver process was killed mid-node (the ~300s serverless
// ceiling), not that work is still happening.
export const STALL_MARGIN_MS = 90_000;
const now = () => new Date().toISOString();
const makeRunId = () => `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
// R-9: system-generated, one per run, distinct from publish_payload's human-authored requestId
// (req_<flow>_<topic>_<yyyymmdd>_<nn>) — this is the join key a platform-side record correlates
// against, not something a node or operator supplies.
const makeRequestId = () => `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const duration = (startedAt?: string, endedAt = now()) => startedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
const modelForDryRun = () => process.env.OPENAI_AGENT_MODEL?.trim() || "gpt-5.5";
const deterministicTokenCount = (value: unknown, minimum: number) => Math.max(minimum, Math.ceil(JSON.stringify(value ?? "").length / 4));

const recordDryRunNodeUsage = async (run: WorkflowExecutionRecord, node: WorkspaceNode, input: unknown, output: unknown) => recordModelUsage({
  runId: run.runId,
  requestId: run.requestId,
  workflowId: run.workflowId,
  projectId: run.projectId,
  nodeId: node.id,
  model: modelForDryRun(),
  provider: "openai",
  inputTokens: deterministicTokenCount({ prompt: node.prompt, input }, 64),
  outputTokens: deterministicTokenCount(output, 32),
  status: "estimated",
  metadata: { dryRun: true, source: "workflow.run_next_node", estimateMethod: "deterministic_mock_length" }
});

export type StartDryRunInput = { projectId: string; input?: unknown; workflowId?: string; executionMode?: ExecutionMode; entrypoint?: WorkflowEntrypoint; budgetUsd?: number };
export type ListRunsInput = { projectId?: string; workflowId?: string };

// Session A (2026-08-03) — cursor pagination + filters on workflow.list_runs. PR #105 made each row
// compact (~2.7KB/run); this stops the LIST regrowing as the run ledger accumulates: without a page
// bound the response grows linearly forever no matter how small each row is. The repository keeps its
// simple full-list contract (constellation tools and internal callers still need every run); the page
// window is applied here, on the newest-first ordering, so both repositories page identically.
export type ListRunsPageInput = ListRunsInput & {
  // Filter to runs with exactly this status ("failed", "running", ...).
  status?: ExecutionStatus;
  // Time-range filter on startedAt (ISO 8601, inclusive both ends).
  from?: string;
  to?: string;
  // Page size; defaults to DEFAULT_LIST_RUNS_LIMIT, capped at MAX_LIST_RUNS_LIMIT.
  limit?: number;
  // Opaque cursor from a previous page's nextCursor. Rows strictly after it (newest-first) return.
  cursor?: string;
};
export type ListRunsPage = {
  runs: WorkflowExecutionRecord[];
  page: { limit: number; matchedCount: number; hasMore: boolean; nextCursor?: string };
};

export const DEFAULT_LIST_RUNS_LIMIT = 20;
export const MAX_LIST_RUNS_LIMIT = 100;

export class InvalidListRunsCursorError extends Error {
  readonly code = "invalid_cursor";
  constructor(cursor: string) {
    super(`invalid_cursor: "${cursor.slice(0, 64)}" is not a cursor produced by workflow.list_runs. Pass the nextCursor value from a previous page verbatim, or omit it for the first page.`);
    this.name = "InvalidListRunsCursorError";
  }
}

type RunCursor = { startedAt: string; runId: string };
// The cursor encodes the SORT KEY of the last row served, not an index — deleting or adding runs
// between pages can never skip or repeat a row relative to that key.
const encodeRunCursor = (run: Pick<WorkflowExecutionRecord, "startedAt" | "runId">): string =>
  Buffer.from(JSON.stringify({ startedAt: run.startedAt, runId: run.runId }), "utf8").toString("base64url");
const decodeRunCursor = (cursor: string): RunCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as RunCursor;
    if (typeof parsed?.startedAt !== "string" || typeof parsed?.runId !== "string") throw new Error("shape");
    return parsed;
  } catch {
    throw new InvalidListRunsCursorError(cursor);
  }
};
// Newest-first, runId as deterministic tiebreak so paging is stable across same-millisecond starts.
const compareRunsNewestFirst = (a: Pick<WorkflowExecutionRecord, "startedAt" | "runId">, b: Pick<WorkflowExecutionRecord, "startedAt" | "runId">): number =>
  b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId);

export async function listRunsPage(filters: ListRunsPageInput = {}, store: ExecutionRepository = repositoryManager.getExecutionRepository()): Promise<ListRunsPage> {
  const limit = Math.max(1, Math.min(MAX_LIST_RUNS_LIMIT, Math.floor(filters.limit ?? DEFAULT_LIST_RUNS_LIMIT)));
  const cursor = filters.cursor ? decodeRunCursor(filters.cursor) : undefined;
  const matched = (await store.listRuns({ projectId: filters.projectId, workflowId: filters.workflowId }))
    .filter((run) => !filters.status || run.status === filters.status)
    .filter((run) => !filters.from || run.startedAt >= filters.from)
    .filter((run) => !filters.to || run.startedAt <= filters.to)
    .sort(compareRunsNewestFirst);
  const start = cursor ? matched.findIndex((run) => compareRunsNewestFirst(cursor, run) < 0) : 0;
  const windowStart = start === -1 ? matched.length : start;
  const runs = matched.slice(windowStart, windowStart + limit);
  const hasMore = windowStart + runs.length < matched.length;
  return {
    runs,
    page: { limit, matchedCount: matched.length, hasMore, ...(hasMore && runs.length ? { nextCursor: encodeRunCursor(runs[runs.length - 1]) } : {}) }
  };
}

// Transitive ancestors of a node (everything it depends on, directly or indirectly). Used to seed a
// late-stage entrypoint: the entry node and all its ancestors are marked completed so the run enters
// directly at the entry node's downstream successors without re-running earlier stages.
const ancestorsOf = (nodes: WorkspaceNode[], targetId: string): Set<string> => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const visit = (id: string) => { for (const dependency of byId.get(id)?.dependsOn ?? []) if (!seen.has(dependency)) { seen.add(dependency); visit(dependency); } };
  visit(targetId);
  return seen;
};

// Phase 5 (docs/platform/DIRECTION.md §5): the conductor resolves node definitions from the workspace
// store so optimizer-promoted prompts — and authoring edits to schemas, tools, skills, and model
// config — reach FULL conductor runs, not just independent node execution and replay.
//
// STORE IS NOW THE DEFAULT. It used to be "static", which meant the conductor ran the compiled
// nodes.ts and ignored the live workspace outright: every prompt, schema, tool or skill edit made
// over MCP was invisible to a run until someone re-seeded nodes.ts and redeployed. Nothing said so at
// runtime, so an operator could edit a node, start a run, and watch the old definition execute.
//
// Flipping is safe by construction rather than by hope: overlayStoreNode pins the fields that define
// the conductor — dependsOn, produces, riskLevel, position, status — to the canonical definition, so
// store mode can change how a node runs but can never rewire the graph or downgrade a publish-risk
// gate; a canonical node missing from the store falls back to its static definition, and a store read
// that fails falls back wholesale. The topology a run executes is therefore identical either way.
//
// What store mode CANNOT deliver, and what the deploy runbook must still require: topology itself.
// resolveConductorNodes maps over the canonical list, so a store node with no canonical counterpart
// is ignored, and the pinned fields above are discarded by design. Changed edges, a changed
// riskLevel, or an entirely new node reach a run only through a deliberate re-seed
// (`npm run nodes:update`, scripts/seedNodesFromWorkspace.ts) followed by a redeploy. Set
// WORKSPACE_NODES_SOURCE=static to pin a deployment to the compiled definitions.
//
// Either way the resolved source is reported on every run (runModeSummary), so which definitions a
// run executed is never a thing anyone has to infer.
const nodeSource = (): "static" | "store" => (process.env.WORKSPACE_NODES_SOURCE?.trim().toLowerCase() === "static" ? "static" : "store");

// Canonical-node guard. Fields the store OWNS (how a node runs) are overlaid from the promoted/edited
// store node; everything that defines the shape of the conductor — the DAG topology (id, dependsOn,
// produces), grid position, node status, and crucially the publish-risk classification (riskLevel) —
// stays pinned to the canonical Publishing Conductor definition. A store edit can therefore change how
// a node runs but never rewire the graph or downgrade a publish-risk gate, so promotions apply while
// the topology stays provably identical to static.
const overlayStoreNode = (canonical: WorkspaceNode, stored: WorkspaceNode): WorkspaceNode => ({
  ...canonical,
  name: stored.name ?? canonical.name,
  description: stored.description ?? canonical.description,
  prompt: stored.prompt ?? canonical.prompt,
  schema: stored.schema ?? canonical.schema,
  inputSchema: stored.inputSchema ?? canonical.inputSchema,
  outputSchema: stored.outputSchema ?? canonical.outputSchema,
  allowedTools: stored.allowedTools ? [...stored.allowedTools] : canonical.allowedTools,
  assignedSkills: stored.assignedSkills ? [...stored.assignedSkills] : canonical.assignedSkills,
  modelConfig: stored.modelConfig ?? canonical.modelConfig,
  executionConfig: stored.executionConfig ?? canonical.executionConfig,
  metadata: stored.metadata ?? canonical.metadata,
  updatedAt: stored.updatedAt ?? canonical.updatedAt
});

// Resolve the conductor node list. Static mode (default) is exactly listWorkspaceNodes(). Store mode
// overlays each canonical node with its stored counterpart when present; a canonical node MISSING from
// the store is seeded from the static definition (late-stage seeding preserved), and non-canonical
// store nodes are ignored — the conductor runs its canonical topology only. A store-read failure falls
// back to the static definitions so a transient repository error never aborts a run.
// §2.23: the canonical array is resolved through the workflow registry keyed by the run's
// workflowId, so a future second workflow (different upstream + the same shared publishing tail)
// plugs in by registering its composed node array — the store overlay below then applies unchanged,
// and an authoring edit to a shared tail node reaches every workflow. An unregistered workflowId
// resolves to the publishing_conductor canonical set, which is exactly what every run got before the
// registry existed.
export async function resolveConductorNodes(workspaceRepository?: WorkspaceRepository, workflowId: string = WORKFLOW_ID): Promise<WorkspaceNode[]> {
  const canonical = getWorkflowDefinition(workflowId)?.canonicalNodes() ?? listWorkspaceNodes();
  if (nodeSource() !== "store") return canonical;
  let stored: WorkspaceNode[];
  try {
    stored = await (workspaceRepository ?? repositoryManager.getWorkspaceRepository()).getNodes();
  } catch {
    return canonical;
  }
  const storedById = new Map(stored.map((node) => [node.id, node]));
  return canonical.map((node) => { const match = storedById.get(node.id); return match ? overlayStoreNode(node, match) : node; });
}

// A late-stage entrypoint seeds a node output the run then treats as if that node had produced it. R-16
// validates output at EXECUTION time — and a seeded node never executes, so until this existed the
// entrypoint was a way past the validator entirely: a structurally wrong body could be seeded as
// `completed`, emit an artifact, and be consumed by publish_payload and the publish gate downstream.
// That is exactly the defect F-1/T6.3 named, reachable through a different door, and it sits on the T-3
// path because workflow.get_run_cost actively recommends late-stage entry as the cheapest way to make
// progress.
//
// The seeded output is now held to the node's OWN outputSchema — whatever that schema currently is —
// so this stays correct through R-23 renaming the contract, and refuses BEFORE a run is created rather
// than leaving a half-seeded run behind.
export class InvalidEntrypointOutputError extends Error {
  readonly code = "invalid_entrypoint_output";
  constructor(readonly nodeId: string, readonly issues: string[]) {
    super(`invalid_entrypoint_output: supplied output for ${nodeId} does not satisfy that node's outputSchema: ${issues.join("; ")}`);
  }
}

const buildInitialRun = (data: StartDryRunInput, nodes: WorkspaceNode[], runId = makeRunId(), requestId = makeRequestId()): WorkflowExecutionRecord => {
  const timestamp = now();
  const entrypoint = data.entrypoint;
  if (entrypoint && !nodes.some((node) => node.id === entrypoint.nodeId)) throw new Error(`Unknown entrypoint node: ${entrypoint.nodeId}`);
  if (entrypoint) {
    const entryNode = nodes.find((node) => node.id === entrypoint.nodeId)!;
    const validation = validateOutput(entrypoint.output, entryNode.outputSchema);
    if (!validation.ok) throw new InvalidEntrypointOutputError(entrypoint.nodeId, validation.errors);
  }
  // Nodes seeded as completed for a late-stage entry: the entry node plus every ancestor. A full run
  // (no entrypoint) seeds nothing, so every node starts queued exactly as before.
  const seeded = entrypoint ? new Set([entrypoint.nodeId, ...ancestorsOf(nodes, entrypoint.nodeId)]) : new Set<string>();
  const stageOutputs: Record<string, unknown> = {};
  const artifacts: ExecutionArtifact[] = [];
  const nodeStates: NodeExecutionState[] = nodes.map((node) => {
    if (entrypoint && node.id === entrypoint.nodeId) {
      // The entry node is completed with the supplied output, seeded so downstream nodes consume it.
      stageOutputs[node.id] = entrypoint.output;
      artifacts.push(buildArtifact(node, entrypoint.output));
      return { nodeId: node.id, status: "completed", output: entrypoint.output, startedAt: timestamp, completedAt: timestamp, durationMs: 0, produces: [...node.produces], warnings: ["late_stage_entry_seeded"] };
    }
    if (seeded.has(node.id)) {
      // Upstream ancestors are marked completed (skipped) — their outputs are not consumed downstream
      // of the entry node, so only a skip marker is recorded and no stage output/artifact is emitted.
      return { nodeId: node.id, status: "completed", output: { seeded: true, skipped: true, reason: "late_stage_entry", nodeId: node.id }, startedAt: timestamp, completedAt: timestamp, durationMs: 0, produces: [...node.produces], warnings: ["late_stage_entry_skipped"] };
    }
    return { nodeId: node.id, status: "queued", produces: [...node.produces] };
  });
  const completedIds = new Set(nodeStates.filter((state) => state.status === "completed").map((state) => state.nodeId));
  // First runnable node: the first still-queued node whose dependencies are all satisfied. For a full
  // run this is the first no-dependency node; for a seeded late-stage run it is the entry node's first
  // downstream successor.
  const firstRunnable = nodes.find((node) => nodeStates.find((state) => state.nodeId === node.id)?.status === "queued" && node.dependsOn.every((dependency) => completedIds.has(dependency)));
  const anyQueued = nodeStates.some((state) => state.status === "queued");
  return {
    runId,
    requestId,
    workflowId: data.workflowId ?? WORKFLOW_ID,
    projectId: data.projectId,
    status: anyQueued ? "queued" : "completed",
    currentNodeId: firstRunnable?.id,
    startedAt: timestamp,
    updatedAt: timestamp,
    nodes: nodeStates,
    artifacts,
    errors: [],
    approvalsRequired: [],
    initialInput: data.input,
    stageOutputs,
    dryRun: true,
    executionMode: data.executionMode ?? DEFAULT_EXECUTION_MODE,
    ...(entrypoint ? { entrypoint } : {}),
    ...(data.budgetUsd !== undefined ? { budgetUsd: data.budgetUsd } : {})
  } as WorkflowExecutionRecord;
};

const nodeById = (nodes: WorkspaceNode[]) => new Map(nodes.map((node) => [node.id, node]));
const stateById = (run: WorkflowExecutionRecord) => new Map(run.nodes.map((node) => [node.nodeId, node]));

const findNextRunnableNode = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[]): WorkspaceNode | undefined => {
  const states = stateById(run);
  const completed = new Set(run.nodes.filter((node) => node.status === "completed").map((node) => node.nodeId));
  return nodes.find((node) => {
    const state = states.get(node.id);
    if (!state || state.status !== "queued") return false;
    return node.dependsOn.every((dependency) => completed.has(dependency));
  });
};

// Kept as a re-export so the existing __test__ surface stays stable. The implementation is shared with
// MockNodeRunner (R-17) — this file used to carry a SECOND hand-written copy of the same fixtures, which
// is precisely how two implementations of "what a mock output looks like" drifted apart unnoticed.
const mockOutputForNode = (node: WorkspaceNode, run: WorkflowExecutionRecord) => mockOutputForNodeShared(node, run);

const buildArtifact = (node: WorkspaceNode, output: unknown): ExecutionArtifact => ({ id: `artifact_${node.id}_${Date.now()}`, nodeId: node.id, type: node.produces[0] ?? "mock_output", value: output, createdAt: now() });

// Publish-risk nodes (riskLevel publish/admin) must never run without explicit approval — this is
// the "stop before any publishing side effect" boundary, generalized beyond the single
// publication_controller id so any future publish-risk node is gated the same way.
const isPublishRisk = (node: WorkspaceNode): boolean => node.riskLevel === "publish" || node.riskLevel === "admin";
// P0 §2.1/§2.3 — the node whose output CLAIMS a publish happened (publish_execution.v1). Matched by
// kind, per the isPublishRisk/isLearningRecorder precedent of a semantic node property rather than a
// hardcoded id, so any future publisher node is guarded identically.
const isPublishExecutorNode = (node: WorkspaceNode): boolean => node.kind === "publisher";
const isConcurrencyConflict = (error: unknown): error is RunConcurrencyError => error instanceof RunConcurrencyError;

// R-18 — look-ahead publish-gate visibility.
//
// The gate itself always worked: attempt a publish-risk node without approval and the run goes "blocked"
// with an approvalsRequired entry. The defect was the moment BEFORE that attempt. Once the last
// non-publish node finished, the run reported status "running" with approvalsRequired: [] and simply sat
// there — reproduced live: publish_payload completed, currentNodeId became publication_controller,
// approvalsRequired stayed []. A run that can never proceed on its own looked identical to a run still
// working, so neither the UI nor an operator could see the hold.
//
// This records the pending approval WITHOUT changing execution semantics: no node is started, no
// publication_decision.v1 is emitted, and run.status is deliberately left alone (see the note in the
// handoff — whether "running" should instead become a distinct awaiting-approval status is a state-machine
// decision, not a bug fix, and is left for an explicit call). Populating approvalsRequired is enough for
// RunStatusPanel (which already ORs on approvalsRequired.length) and for the attention feed.
const markPendingPublishApproval = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[], approved: boolean): void => {
  // A stale look-ahead is dropped every advance and re-derived below, so it can never outlive the gate it
  // described. An attempted (non-pending) entry is the authoritative audit record and is never touched.
  run.approvalsRequired = run.approvalsRequired.filter((approval) => approval.pending !== true);
  if (approved) return;
  const upcoming = findNextRunnableNode(run, nodes);
  if (!upcoming || !isPublishRisk(upcoming)) return;
  if (run.approvalsRequired.some((approval) => approval.nodeId === upcoming.id)) return;
  run.approvalsRequired = [...run.approvalsRequired, {
    nodeId: upcoming.id,
    type: "approval_required",
    reason: `Next dependency-ready node ${upcoming.id} is publish-risk; the run cannot advance without explicit approval. Nothing has been attempted and no publication has been performed.`,
    requestedAt: now(),
    pending: true
  }];
};

// Per-run in-process mutex. Every mutation of a given run is serialized through a promise chain
// keyed by runId, so overlapping run_next_node / reset / status calls in one process can never
// interleave their read-mutate-write cycles (which was re-running already-completed nodes). Across
// separate instances the repository's compare-and-swap is the backstop; this lock additionally
// prevents wasted node executions within a process. The chain swallows errors so one failed task
// never rejects a queued follower, and the map entry is dropped once it drains.
const runLocks = new Map<string, Promise<unknown>>();
function withRunLock<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const result = (runLocks.get(runId) ?? Promise.resolve()).then(task, task);
  const tail = result.then(() => undefined, () => undefined);
  runLocks.set(runId, tail);
  void tail.then(() => { if (runLocks.get(runId) === tail) runLocks.delete(runId); });
  return result;
}

export type RunAdvanceOptions = { executionRepository?: ExecutionRepository; workspaceRepository?: WorkspaceRepository; approved?: boolean };

// The dispatched node's effective execution timeout — the same resolution the runner applies
// (modelConfig/executionConfig.timeout, else the 120s default) — so the dispatch claim written to the
// run record describes exactly how long a live execution could possibly take.
const nodeTimeoutMs = (node: WorkspaceNode): number => {
  const merged = { ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) } as Record<string, unknown>;
  const timeout = merged.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) ? timeout : 120_000;
};

const nodeBudgetUsdOf = (node: WorkspaceNode): number | undefined => {
  const merged = { ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) } as Record<string, unknown>;
  return typeof merged.budgetUsd === "number" && Number.isFinite(merged.budgetUsd) ? merged.budgetUsd : undefined;
};

// Operator-facing liveness verdict for a run, computed purely from the persisted record. Two stall
// shapes exist and both used to be invisible (status "running" forever, nothing in flight):
//   1. mid-node death — a node carries a dispatch claim, status "running", and the claim is older
//      than its own timeout + margin: the driver was killed while the node executed;
//   2. between-node death — status "running", no node in flight, and updatedAt is old: the driver was
//      killed after a node's save but before the next dispatch.
// Both are resumable: the next advance (workflow.run_next_node / run_until / run_all, or the
// conductor job with --run) reclaims a stale dispatch and continues from persisted state.
export type RunStallInfo = {
  inFlightNodeId?: string;
  dispatchedAt?: string;
  timeoutMs?: number;
  stalledSuspected: boolean;
  advice?: string;
};

export function assessRunStall(run: WorkflowExecutionRecord, at: Date = new Date()): RunStallInfo | undefined {
  if (run.status !== "running") return undefined;
  const inFlight = run.nodes.find((node) => node.status === "running" && node.dispatch);
  if (inFlight) {
    const deadline = Date.parse(inFlight.dispatch!.dispatchedAt) + inFlight.dispatch!.timeoutMs + STALL_MARGIN_MS;
    const stalled = at.getTime() > deadline;
    return {
      inFlightNodeId: inFlight.nodeId,
      dispatchedAt: inFlight.dispatch!.dispatchedAt,
      timeoutMs: inFlight.dispatch!.timeoutMs,
      stalledSuspected: stalled,
      advice: stalled
        ? `Node ${inFlight.nodeId} was dispatched at ${inFlight.dispatch!.dispatchedAt} with a ${inFlight.dispatch!.timeoutMs}ms timeout and never reported back — the driver process died mid-node. Nothing is in flight. Advance the run (workflow.run_until / run_next_node, or the conductor job with --run) to reclaim the stale dispatch and continue.`
        : `Node ${inFlight.nodeId} is in flight within its timeout window; no action needed yet.`
    };
  }
  const idleMs = at.getTime() - Date.parse(run.updatedAt);
  const stalled = idleMs > STALL_MARGIN_MS;
  return {
    stalledSuspected: stalled,
    advice: stalled
      ? `Run status is "running" but no node is in flight and the record has not been touched for ${Math.round(idleMs / 1000)}s — the driver died between nodes. State is persisted and resumable: advance the run to continue.`
      : undefined
  };
}

export async function startDryRun(data: StartDryRunInput, store: ExecutionRepository = repositoryManager.getExecutionRepository(), workspaceRepository?: WorkspaceRepository): Promise<WorkflowExecutionRecord> {
  return store.createRun(buildInitialRun(data, await resolveConductorNodes(workspaceRepository, data.workflowId ?? WORKFLOW_ID)));
}

export async function getRun(runId: string, store: ExecutionRepository = repositoryManager.getExecutionRepository()) {
  return store.getRun(runId);
}

export async function listRuns(filters: ListRunsInput = {}, store: ExecutionRepository = repositoryManager.getExecutionRepository()) {
  return store.listRuns(filters);
}

export async function resetRun(runId: string, store: ExecutionRepository = repositoryManager.getExecutionRepository()): Promise<WorkflowExecutionRecord> {
  return withRunLock(runId, async () => {
    const existing = await store.getRun(runId);
    if (!existing) throw new Error(`Unknown run: ${runId}`);
    // Rebuild from the run's own starting shape, including a late-stage entrypoint, so reset restores
    // the seeded state it began with rather than a full ideation-to-publish run.
    const nodes = await resolveConductorNodes(undefined, existing.workflowId);
    // requestId travels with the run across a reset — it identifies the same request being retried,
    // not a new one, and a platform-side record correlating against it must still resolve. The
    // operator's durable publish decision (P0 §2.2) survives a reset for the same reason: a reset
    // retries the request, it does not un-say the operator's veto/approval.
    return store.resetRun(runId, {
      ...buildInitialRun({ projectId: existing.projectId, input: existing.initialInput, workflowId: existing.workflowId, executionMode: existing.executionMode, entrypoint: existing.entrypoint, budgetUsd: existing.budgetUsd }, nodes, runId, existing.requestId),
      ...(existing.operatorPublishDecision ? { operatorPublishDecision: existing.operatorPublishDecision } : {})
    });
  });
}

// Execute exactly one dependency-ready queued node and persist the whole state transition atomically.
// Runs under the per-run lock; if the durable compare-and-swap still rejects (a writer on another
// instance advanced the run), it reloads and retries from the fresh state — re-selecting the next
// node so an already-completed node is never re-run.
export async function runNextNode(runId: string, options: RunAdvanceOptions = {}): Promise<WorkflowExecutionRecord> {
  const store = options.executionRepository ?? repositoryManager.getExecutionRepository();
  return withRunLock(runId, () => advanceRun(runId, store, options));
}

// Phase 7 (DIRECTION §7): post-run learning-loop actions. When a run completes, two independently
// flag-gated, best-effort steps can fire so the loop advances without a human kicking it:
//   1. IMPROVEMENT_POST_RUN_REFLECT — GEPA-style reflection (optimizer.propose) for the nodes that
//      executed. PROPOSE-ONLY: nothing is applied.
//   2. IMPROVEMENT_AUTO_PROMOTE — eval-gated auto-promotion of trial-proven proposals for low-risk
//      nodes (never a publish/admin node; fresh un-trialed proposals are never touched).
// Both are fired AFTER the durable save and can never fail the run: each flag check short-circuits
// before any repository access when OFF, and every error is swallowed. The store node source (Phase 5)
// is honored via options.workspaceRepository so a reflected node's prompt matches what actually ran.
async function reflectOnCompletedRun(run: WorkflowExecutionRecord, store: ExecutionRepository, options: RunAdvanceOptions): Promise<void> {
  if (!postRunReflectionEnabled() && !autoPromoteEnabled()) return;
  const deps: OptimizerDeps = {
    workspaceRepository: options.workspaceRepository ?? repositoryManager.getWorkspaceRepository(),
    executionRepository: store,
    improvementRepository: repositoryManager.getImprovementRepository(),
    evaluationRepository: repositoryManager.getEvaluationRepository()
  };
  if (postRunReflectionEnabled()) {
    try {
      const result = await reflectAfterRun(run, deps);
      if (result.proposals.length || result.errors.length) {
        console.info("improvement.post_run_reflection", { runId: run.runId, mode: result.mode, candidates: result.candidates, proposals: result.proposals.length, skipped: result.skipped.length, errors: result.errors.length });
      }
    } catch { /* reflection is advisory; a run must never fail because the loop could not reflect */ }
  }
  if (autoPromoteEnabled()) {
    try {
      const result = await autoPromoteProposals({}, deps);
      if (result.promoted.length || result.errors.length) {
        console.info("improvement.auto_promote", { runId: run.runId, promoted: result.promoted.length, skipped: result.skipped.length, errors: result.errors.length });
      }
    } catch { /* auto-promotion is advisory; a run must never fail because the loop could not promote */ }
  }
}

// F4 (T-2, run_1785352838155_l544ye): learning_recorder depended on publication_controller reaching
// "completed" — but publication_controller is publish-risk (isPublishRisk above) and every dry run
// blocks there by design unless explicitly approved, so that dependency was permanently unsatisfiable
// on the overwhelmingly common path. Result: zero observations were ever recorded from any dry run.
// Generalized by `kind` (matching the isPublishRisk precedent of a semantic node property, not a
// hardcoded id) rather than gated by DAG dependency status: this fires whenever the run reaches ANY
// terminal outcome that matters for learning — completed, blocked, or failed — not only the one DAG
// path that almost never happens. executeRunnableNode itself never checks dependsOn (that happens in
// findNextRunnableNode, before it is called), so the node can be dispatched directly here without its
// declared dependency being satisfied; the run's own status/currentNodeId are restored immediately
// after, so this best-effort side observation can never override the run's real outcome (a
// budget-blocked run must stay "blocked" even if learning_recorder's own execution fails).
const isLearningRecorder = (node: WorkspaceNode): boolean => node.kind === "learning";

// 2.4 (handoff 2026-08-10, run_1785842430906_tqjk1o): the F4 bypass above ignores dependsOn entirely,
// which let learning_recorder fire 23 SECONDS into a run that went on to run for another hour — the
// budget gate or a first-node failure can produce a "terminal" transition (blocked/failed) before the
// run has gotten anywhere near learning_recorder's declared dependency. That is a scheduler bug, not
// F4's intended behaviour.
//
// The fix is NOT "require the dependency to be literally completed" — that would silently re-introduce
// the exact defect F4 fixed: learning_recorder's one declared dependency is publication_controller,
// which is publish-risk and reaches "completed" on essentially no dry run (it blocks there by design
// absent explicit approval). Gating on status==="completed" would mean zero observations again on the
// overwhelmingly common path, the whole reason F4 exists.
//
// Instead this checks that every declared dependency has been REACHED at least once — its state moved
// off "queued" (completed, blocked, or failed) — which is the actual signal that the run got far enough
// for a learning observation to mean anything. "Queued" means the node was never touched: the run died
// before the DAG ever got there, which is precisely the run-start-bypass bug. A dependency that reached
// "blocked" (e.g. the publish gate, attempted and refused for lack of approval) still counts as reached,
// preserving F4's fix for the common unapproved-dry-run path.
// §2.15 (handoff 2026-08-10): learning_recorder moved downstream of publish_executor (dependsOn
// [publication_controller, publish_executor]) so it can observe publish_execution.v1 outcomes —
// executor blocks, lock conflicts, failed releases, unconfirmed go-lives — which were structurally
// invisible when it hung off publication_controller in parallel with the executor. That edge would
// strand this dispatch on the overwhelmingly common path if "reached" stayed literal: an unapproved
// dry run terminal-blocks AT publication_controller, so publish_executor is still "queued" and can
// never leave it in this run's state. Hence SEALED, the second way a dependency counts as resolved:
// every one of ITS OWN direct dependencies was reached, but at least one did not complete, so the
// dependency can never become runnable — the DAG got all the way to its doorstep and was refused
// there. Deliberately ONE level and NOT recursive: recursive sealing would mark the whole graph
// sealed the moment the first node fails, silently re-introducing the exact run-start-bypass bug 2.4
// fixed (a run dead at input_triage must still skip this dispatch, because publication_controller's
// own dependencies were never reached either). A queued dependency whose deps ALL completed is NOT
// sealed — it simply has not run yet (e.g. parked behind a budget block) and may still run after a
// resume, at which point the next terminal transition fires this dispatch with more to observe.
const dependenciesReached = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[], node: WorkspaceNode): boolean => {
  const states = stateById(run);
  const byId = nodeById(nodes);
  const reached = (id: string): boolean => {
    const state = states.get(id);
    return !!state && state.status !== "queued";
  };
  const sealed = (id: string): boolean => {
    const dependencies = byId.get(id)?.dependsOn ?? [];
    return dependencies.length > 0
      && dependencies.every(reached)
      && dependencies.some((dependency) => states.get(dependency)?.status !== "completed");
  };
  return node.dependsOn.every((dependency) => reached(dependency) || sealed(dependency));
};

async function recordTerminationObservations(run: WorkflowExecutionRecord, nodes: WorkspaceNode[], store: ExecutionRepository, options: RunAdvanceOptions): Promise<WorkflowExecutionRecord> {
  const node = nodes.find(isLearningRecorder);
  if (!node) return run;
  const state = stateById(run).get(node.id);
  // Fire at most once per run: either it already ran the ordinary way (an approved run reaching it
  // through the DAG), or this hook already fired on an earlier terminal transition in this same run.
  if (!state || state.status !== "queued") return run;
  // 2.4: skip silently (rather than mark a state the runtime has no "skipped" status for) when the
  // run terminated before the node's own declared dependencies were ever reached — the run-start
  // bypass bug. This is best-effort telemetry, not a required step, so a quiet no-op is correct; the
  // next terminal transition in the same run (if any) gets another chance once more of the DAG has run.
  if (!dependenciesReached(run, nodes, node)) return run;
  const status = run.status;
  const currentNodeId = run.currentNodeId;
  try {
    const prepared = await executeRunnableNode(run, node, nodes, store, options);
    prepared.run.status = status;
    prepared.run.currentNodeId = currentNodeId;
    const saved = await store.saveRun(prepared.run);
    await prepared.commit?.().catch(() => undefined);
    return saved;
  } catch {
    // Best-effort: recording observations must never fail the run or mask its real terminal status.
    return run;
  }
}

async function advanceRun(runId: string, store: ExecutionRepository, options: RunAdvanceOptions): Promise<WorkflowExecutionRecord> {
  let latest: WorkflowExecutionRecord | undefined;
  for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    latest = run;
    if (HALTED_EXECUTION_STATUSES.has(run.status)) return run;

    const nodes = await resolveConductorNodes(options.workspaceRepository, run.workflowId);
    // Dispatch-claim bookkeeping (the ~300s silent-death fix). A node persisted as "running" either
    // IS running somewhere (another driver, within its claim window) — in which case advancing here
    // would double-dispatch it — or its driver died mid-node and the claim has expired, in which case
    // the node is reclaimed to queued so the run is resumable instead of stuck "running" forever.
    const inFlight = run.nodes.find((node) => node.status === "running" && node.dispatch);
    if (inFlight) {
      const deadline = Date.parse(inFlight.dispatch!.dispatchedAt) + inFlight.dispatch!.timeoutMs + STALL_MARGIN_MS;
      if (Date.now() <= deadline) return run;
      inFlight.status = "queued";
      delete inFlight.startedAt;
      delete inFlight.completedAt;
      delete inFlight.durationMs;
      delete inFlight.output;
      delete inFlight.errors;
      delete inFlight.dispatch;
      inFlight.warnings = [...(inFlight.warnings ?? []), "stale_dispatch_reclaimed"];
      run.updatedAt = now();
    }
    const nextNode = findNextRunnableNode(run, nodes);
    try {
      if (!nextNode) {
        // Terminal transition for a run that ran to the end. This is the single place a run becomes
        // "completed" (node execution never sets it), so it is the natural trigger for Phase 7
        // automatic post-run reflection. Reflection is fired best-effort AFTER the durable save and
        // can never fail the run (see reflectOnCompletedRun); default OFF, so this is a no-op unless
        // an operator opts in.
        const completed = await store.saveRun({ ...run, status: "completed", completedAt: now(), updatedAt: now(), currentNodeId: undefined });
        await reflectOnCompletedRun(completed, store, options);
        return await recordTerminationObservations(completed, nodes, store, options);
      }
      // Budget gate (F2, hardened after run_1785435947311_jl8hl4 landed at 138%): before dispatching
      // the next node, halt the run when accrued ACTUAL model cost has reached the
      // ceiling — OR when accrued cost plus the next node's own declared budgetUsd would cross it.
      // The reservation is what makes "a run must stop before the dispatch that would cross the
      // ceiling" true: previously a run at $2.2 of a $3 ceiling could legally dispatch a node whose
      // own budget allowed another $0.75, and the ceiling could only be defended mid-node. The
      // pending node stays queued — never partially charged — so raising budgetUsd and resuming
      // continues here. Default OFF: with no run budgetUsd configured the gate is skipped entirely.
      if (run.budgetUsd !== undefined) {
        // R-20: gate on actualCostUsdEstimate, never total — a mock run's deterministic estimates
        // (status:"estimated") must not consume the ceiling (T-2 F-5).
        const usage = await summarizeModelUsage({ runId });
        const budget = evaluateRunBudget(run.budgetUsd, usage.actualCostUsdEstimate);
        const nodeReserveUsd = nodeBudgetUsdOf(nextNode) ?? 0;
        const reservationExceeded = budget !== undefined && !budget.overBudget && budget.spentUsdEstimate + nodeReserveUsd > budget.budgetUsd;
        if (budget?.overBudget || reservationExceeded) {
          const blockedAt = now();
          const blocked = await store.saveRun({
            ...run,
            status: "blocked",
            currentNodeId: nextNode.id,
            updatedAt: blockedAt,
            budgetBlock: {
              blockedAt,
              budgetUsd: budget!.budgetUsd,
              spentUsdEstimate: budget!.spentUsdEstimate,
              nextNodeId: nextNode.id,
              reason: budget!.overBudget
                ? `Run paused for budget: estimated spend $${budget!.spentUsdEstimate} reached the configured ceiling $${budget!.budgetUsd}; node ${nextNode.id} was not executed. Raise budgetUsd and resume to continue.`
                : `Run paused for budget: estimated spend $${budget!.spentUsdEstimate} plus node ${nextNode.id}'s own $${nodeReserveUsd} budget reservation would cross the $${budget!.budgetUsd} ceiling, so the node was not dispatched. Raise budgetUsd and resume to continue.`
            }
          });
          return await recordTerminationObservations(blocked, nodes, store, options);
        }
      }
      const prepared = await executeRunnableNode(run, nextNode, nodes, store, options, true);
      // A run that clears the budget gate is no longer paused for budget: drop any stale marker so a
      // resumed-under-ceiling run doesn't keep reporting "paused for budget".
      if (prepared.run.budgetBlock) prepared.run.budgetBlock = undefined;
      // R-18: record (or clear) a look-ahead publish-approval hold before the state is committed, so the
      // hold is durable and visible on the very next read rather than only after another advance attempt.
      markPendingPublishApproval(prepared.run, nodes, options.approved === true);
      const saved = await store.saveRun(prepared.run);
      // Side effects (usage telemetry, workspace stage-output mirror) run only after the state
      // transition is durably committed, so a discarded attempt on a CAS conflict leaves no phantom
      // usage behind. They are non-authoritative — the run record itself already holds the output —
      // so a failure here must not report an otherwise-successful advance as failed.
      await prepared.commit?.().catch(() => undefined);
      // F4: the most common way a run reaches a learning-relevant terminal state — blocked (almost
      // always the publish-risk-without-approval gate above) or failed — happens right here, not in
      // the no-more-runnable-nodes branch reflection already covers.
      if (saved.status === "blocked" || saved.status === "failed") {
        return await recordTerminationObservations(saved, nodes, store, options);
      }
      return saved;
    } catch (error) {
      if (isConcurrencyConflict(error)) continue;
      throw error;
    }
  }
  return (await store.getRun(runId)) ?? latest!;
}

type PreparedNode = { run: WorkflowExecutionRecord; commit?: () => Promise<void> };

async function executeRunnableNode(initialRun: WorkflowExecutionRecord, nextNode: WorkspaceNode, nodes: WorkspaceNode[], store: ExecutionRepository, options: RunAdvanceOptions, claim = false): Promise<PreparedNode> {
  let run = initialRun;
  let state = stateById(run).get(nextNode.id) as NodeExecutionState;
  const startedAt = now();
  // W-4 (run_1785405350649_9u5mjz): a node that cannot resolve its client must fail by name, never
  // guess. That run — a platform run — had review_aggregator instruct a Dr. Lurie CTA because client
  // identity reached nodes only via contract_intelligence's output, far downstream of the editorial
  // chain, and prompts filled the gap with a remembered client. Same contract as
  // prefetch_object_type_unresolved (contractPrefetch.ts): a distinct code plus prose naming the
  // remedy, instead of a silently wrong default.
  const clientProjectId = typeof run.projectId === "string" ? run.projectId.trim() : "";
  if (!clientProjectId) {
    const completedAt = now();
    const message = `Cannot resolve a client for run ${run.runId}: run.projectId is empty, so node ${nextNode.id} would have to guess which client it is building for. Start runs with an explicit projectId (workflow.start_dry_run requires one) rather than relying on a guess.`;
    state.status = "failed";
    state.startedAt = startedAt;
    state.completedAt = completedAt;
    state.durationMs = duration(startedAt, completedAt);
    state.errors = ["client_project_unresolved", message];
    state.output = { error: { code: "client_project_unresolved", message } };
    run.status = "failed";
    run.currentNodeId = nextNode.id;
    run.errors = [...run.errors, `${nextNode.id}:client_project_unresolved`];
    run.updatedAt = completedAt;
    return { run };
  }
  state.status = "running";
  state.startedAt = startedAt;
  // W-4: clientProjectId travels in EVERY node's input — client identity is run state, delivered by
  // the conductor, not something an editorial prompt may assume or a downstream node must reconstruct.
  state.input = { initialInput: nextNode.dependsOn.length ? undefined : run.initialInput, dependencies: Object.fromEntries(nextNode.dependsOn.map((dependency) => [dependency, run.stageOutputs[dependency]])), clientProjectId };
  run.status = "running";
  run.currentNodeId = nextNode.id;
  run.updatedAt = startedAt;

  // F1 (T-2, run_1785352838155_l544ye): a node whose metadata declares contractPrefetch gets the
  // client's contract fetched and reduced HERE — deterministic conductor code, before the node's own
  // agent loop starts — instead of the node discovering it itself via a tool call that then re-sends
  // the raw contract on every subsequent turn of its own loop (measured at ~60K input tokens/turn).
  // Best-effort: a prefetch failure is handed to the node as `prefetchError` (matching its own
  // "client unreachable" blocker language) rather than failing the dispatch outright, so a transient
  // fetch problem surfaces as the node's own explicit blocker, not an executor crash.
  //
  // G2 (T-2 re-run, run_1785405350649_9u5mjz): a failure here used to be visible ONLY inside the
  // node's own input (prefetchError), which nobody reads unless they already suspect this node —
  // exactly why platform's missing objectDialect went undetected for a full live run's worth of
  // spend. A failed prefetch now also stamps a run-visible warning (workflow.get_run,
  // constellation.get_attention's node-level surface both read state.warnings), named after the
  // failure's own code so "the cost optimization silently degraded" is a run-level fact, not
  // something inferable only after specifically reading this one node's input.
  let deterministicPrefetch: Awaited<ReturnType<typeof getReducedContract>> | undefined;
  // §2.16 — aggression RESOLUTION happens here, the first place both halves exist at once: the
  // placement TARGET (placement_resolver's stage output, refused if it is a mock placeholder) and the
  // client CEILING (the prefetched, reduced contract's aggressionCeiling). resolved =
  // min(ceiling, target) componentwise; an ABSENT or PARTIAL ceiling is a typed BLOCKER, never a
  // default (Wolf's explicit decision, handoff §5) — stamped into this node's input
  // (aggressionBlocker) and as a run-visible warning named after the blocker's own code, the same
  // loud-degradation convention contract_prefetch_failed uses. A successful resolution travels in the
  // node's input as resolvedAggression and is carried onto the deterministic contract_intelligence
  // artifact below so downstream nodes consume the RESOLVED vector, never the raw target.
  let aggressionResolution: ReturnType<typeof resolveAggressionVector> | undefined;
  if (nextNode.metadata?.contractPrefetch === true) {
    try {
      const prefetch = await getReducedContract({ runId: run.runId, projectId: run.projectId }, { projectRepository: repositoryManager.getProjectRepository(), workspaceRepository: options.workspaceRepository ?? repositoryManager.getWorkspaceRepository() });
      deterministicPrefetch = prefetch;
      state.input = { ...(state.input as Record<string, unknown>), ...(prefetch.ok ? { prefetchedContract: prefetch.reduced } : { prefetchError: prefetch.error }) };
      if (!prefetch.ok) state.warnings = [...(state.warnings ?? []), `contract_prefetch_failed:${prefetch.code ?? "unknown"}`];
      const placementTarget = prefetch.ok ? readPlacementTarget(run.stageOutputs.placement_resolver) : undefined;
      if (prefetch.ok && placementTarget) {
        aggressionResolution = resolveAggressionVector(placementTarget, prefetch.reduced);
        if (aggressionResolution.ok) {
          state.input = { ...(state.input as Record<string, unknown>), resolvedAggression: { resolved: aggressionResolution.resolved, ceiling: aggressionResolution.ceiling, target: aggressionResolution.target } };
        } else {
          state.input = { ...(state.input as Record<string, unknown>), aggressionBlocker: aggressionResolution.blocker };
          state.warnings = [...(state.warnings ?? []), aggressionResolution.blocker.code];
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.input = { ...(state.input as Record<string, unknown>), prefetchError: message };
      state.warnings = [...(state.warnings ?? []), "contract_prefetch_failed:threw"];
    }
  }

  // GUI rework Session B: same F1 pattern as the contract prefetch above, for a node whose metadata
  // declares voicePrefetch — the client's editorial voice (voice_<project>) fetched deterministically
  // HERE, once per run (RunScopedCache), and delivered directly in the node's input as
  // `editorialVoice`, never via a tool call the node's own agent loop would re-issue every turn.
  // Unlike contract prefetch, this can never fail the node: getEditorialVoice always resolves to
  // either the live object or (for a project that registers one) a seeded fallback, and a fallback is
  // always accompanied by a run-visible warning named after the reason — the same loud-degradation
  // contract contract_prefetch_failed uses. A project with no voice concept wired at all (no
  // objectDialect.voiceObjectId and no registered fallback) is a clean no-op: nothing injected,
  // nothing warned.
  if (nextNode.metadata?.voicePrefetch === true) {
    try {
      const voiceResult = await getEditorialVoice({ runId: run.runId, projectId: run.projectId }, { projectRepository: repositoryManager.getProjectRepository() });
      if (voiceResult.voice) {
        state.input = { ...(state.input as Record<string, unknown>), editorialVoice: voiceResult.voice, editorialVoiceSource: voiceResult.source };
      }
      if (voiceResult.source !== "live" && voiceResult.warningCode) {
        state.warnings = [...(state.warnings ?? []), `voice_prefetch_fallback:${voiceResult.warningCode}`];
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.warnings = [...(state.warnings ?? []), "voice_prefetch_fallback:threw"];
      state.input = { ...(state.input as Record<string, unknown>), editorialVoiceError: message };
    }
  }

  // Session D (2026-08, improvement phase): once the contract is prefetched and reduced
  // deterministically (above), the node's own remaining job — per its prompt, "a validation and
  // pass-through step, not a discovery one" — is field mapping a program can do exactly as well as a
  // model, for $0 instead of ~$0.134/run. Opt-in per node (metadata.contractIntelligenceDeterministic)
  // so this stays scoped to the one node it was designed for. NOT a replacement for the model path:
  // the mapped output is validated against the node's own outputSchema before use, and any failure —
  // prefetch absent/failed, mapping produces something schema-invalid — falls through to the normal
  // model dispatch below unchanged. A mapping bug therefore degrades to "spend the $0.134", never to a
  // failed run or a malformed artifact reaching a downstream node.
  if (nextNode.metadata?.contractIntelligenceDeterministic === true && deterministicPrefetch?.ok) {
    const built = buildDeterministicContractIntelligence(deterministicPrefetch.reduced, clientProjectId);
    // §2.16 — carry the aggression resolution (computed above from placement_resolver's target and
    // the contract's ceiling) onto the artifact downstream nodes actually consume. A blocker rides in
    // the artifact's own blockers array so the controller's "blockers are blockers" posture sees it.
    const mapped = aggressionResolution === undefined ? built : aggressionResolution.ok
      ? { ...built, resolvedAggression: { resolved: aggressionResolution.resolved, ceiling: aggressionResolution.ceiling, target: aggressionResolution.target } }
      : { ...built, aggressionBlocker: aggressionResolution.blocker, blockers: [...built.blockers, `${aggressionResolution.blocker.code}: ${aggressionResolution.blocker.message}`] };
    const mappedValidation = validateOutput(mapped, nextNode.outputSchema);
    if (mappedValidation.ok) {
      const completedAt = now();
      state.status = "completed";
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      // No dedicated NodeExecutionState field for "how this output was produced"; the fact is already
      // recoverable from the absence of a usage record for this run+node, and from run.warnings if the
      // mapping had instead failed validation (the branch below).
      state.output = mapped;
      run.stageOutputs[nextNode.id] = mapped;
      run.artifacts.push(buildArtifact(nextNode, mapped));
      run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
      run.updatedAt = completedAt;
      run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      // No model call happened, so no usage record is written — that is the entire point, and R-20
      // already established the rule that a $0 event stays $0, not a rounded-up estimate.
      return { run };
    }
    // Deterministic mapping produced something the node's own schema rejects — fall through to the
    // model path below. Surfaced as a run-visible warning (same convention as a prefetch failure) so a
    // systematic mapping defect is a run-level fact, not something only found by reading this node.
    state.warnings = [...(state.warnings ?? []), `contract_intelligence_deterministic_invalid:${mappedValidation.errors[0] ?? "unknown"}`];
  }

  // §2.16 — placement_resolver (metadata.placementResolverDeterministic): the aggression TARGET
  // vector is COMPUTED, never hand-set, so this node's execution path is deterministic engine code
  // (aggressionVector.ts), following the contractIntelligenceDeterministic pattern above with one
  // deliberate inversion: there is NO model fallback. Missing placement signals (trafficSource /
  // awarenessStage, read from the node's dependency outputs and the run's initial input) BLOCK the
  // node on a live run — a model guessing dial values is exactly what the deterministic mapping
  // exists to prevent. A mock run falls through to the MockNodeRunner placeholder instead (same
  // reasoning as the P0 controller-decision guard's mock scope: mock CI traversal has no client reach
  // and its placeholder target is refused by readPlacementTarget's dryRun guard anyway).
  if (nextNode.metadata?.placementResolverDeterministic === true) {
    const signals = extractPlacementSignals(...nextNode.dependsOn.map((dependency) => run.stageOutputs[dependency]), run.initialInput);
    const missingSignals = [...(signals.trafficSource ? [] : ["trafficSource"]), ...(signals.awarenessStage ? [] : ["awarenessStage"])];
    let refusal: { code: string; message: string } | undefined;
    if (missingSignals.length) {
      refusal = {
        code: "aggression_signals_missing",
        message: `placement_resolver cannot compute the aggression target: ${missingSignals.join(" and ")} missing from the request. The target is computed deterministically from (trafficSource, awarenessStage) and is never guessed from content — supply both in the run's input (top level or under contentSource) and retry the node.`
      };
    } else {
      const resolution = buildPlacementResolution(signals.trafficSource!, signals.awarenessStage!);
      const resolutionValidation = validateOutput(resolution, nextNode.outputSchema);
      if (resolutionValidation.ok) {
        const completedAt = now();
        state.status = "completed";
        state.completedAt = completedAt;
        state.durationMs = duration(startedAt, completedAt);
        state.output = resolution;
        run.stageOutputs[nextNode.id] = resolution;
        run.artifacts.push(buildArtifact(nextNode, resolution));
        run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
        run.updatedAt = completedAt;
        run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
        // Deterministic, $0: no model call, no usage record (the R-20 rule).
        return { run };
      }
      // Only reachable when a store-overlaid outputSchema rejects the engine-built resolution — a
      // configuration conflict, not a reason to let a model invent dials.
      refusal = { code: "placement_resolution_invalid", message: `placement_resolver's deterministic resolution does not satisfy the node's current outputSchema (${resolutionValidation.errors[0] ?? "unknown"}); fix the schema/engine mismatch rather than letting a model hand-set dial values.` };
    }
    const liveExecution = ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock";
    if (liveExecution) {
      const completedAt = now();
      state.status = "blocked";
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = { error: { code: refusal.code, message: refusal.message } };
      state.warnings = [...(state.warnings ?? []), refusal.code];
      run.status = "blocked";
      run.updatedAt = completedAt;
      return { run };
    }
    // Mock run: fall through to the MockNodeRunner placeholder below so CI traversal keeps working.
  }

  // P0 §2.1/§2.2 — the deterministic publish refusals, evaluated BEFORE any dispatch so a refused
  // publish-risk node never starts a model turn (and therefore can never fire a client tool):
  //   1. operator veto (§2.2) — run.operatorPublishDecision === "withheld" (set via
  //      workflow.set_operator_publish_decision, read through the ONE reader
  //      isOperatorPublishWithheld shared with publishRun's gate) blocks every publish-risk node
  //      regardless of the approved flag.
  //   2. missing approval — unchanged: a publish-risk node needs options.approved === true.
  //   3. controller decision (§2.1) — a publisher-kind node (publish_executor) additionally requires
  //      an EXPLICIT affirmative publication_controller decision (decision: "go"); silence, hedging,
  //      or a malformed record refuses with the reason recorded. Scoped to live runs: a mock run's
  //      placeholder pipeline has no client reach (MockNodeRunner calls no tools) and a mock decision
  //      is refused by readPublicationDecision anyway (dryRun marker), so mock CI traversal keeps
  //      working while a live publisher node can never dispatch without an explicit go.
  const operatorVeto = isPublishRisk(nextNode) && isOperatorPublishWithheld(run);
  const approvalMissing = isPublishRisk(nextNode) && options.approved !== true;
  const liveRun = ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock";
  const controllerDecision = isPublishExecutorNode(nextNode) && liveRun ? readPublicationDecision(findPublicationDecision(run)) : undefined;
  const publishRefusals: string[] = [
    ...(operatorVeto ? [`operator_publish_withheld: the operator's durable publish decision for this run (run.operatorPublishDecision, set via workflow.set_operator_publish_decision) is "withheld"; node ${nextNode.id} cannot run regardless of approval flags.`] : []),
    ...(approvalMissing ? [`Dry-run stopped before publish-risk node ${nextNode.id}; explicit approval is required before any publishing side effect.`] : []),
    ...(controllerDecision && !controllerDecision.authorized ? [`publication_decision_not_affirmative (${controllerDecision.code}): ${controllerDecision.reason}`] : [])
  ];
  if (publishRefusals.length) {
    const completedAt = now();
    state.status = "blocked";
    state.completedAt = completedAt;
    state.durationMs = duration(startedAt, completedAt);
    state.output = { artifact: nextNode.produces[0] ?? `${nextNode.id}.decision`, dryRun: true, decision: "blocked", approvalRequired: approvalMissing, reason: publishRefusals.join(" ") };
    state.warnings = [
      ...(approvalMissing ? ["approval_required"] : []),
      ...(operatorVeto ? ["operator_publish_withheld"] : []),
      ...(controllerDecision && !controllerDecision.authorized ? ["publication_decision_not_affirmative"] : []),
      "no_publication_performed"
    ];
    run.status = "blocked";
    run.updatedAt = completedAt;
    if (approvalMissing) {
      run.approvalsRequired = [{ nodeId: nextNode.id, type: "approval_required", reason: `Publish-risk node ${nextNode.id} requires explicit approval; dry-run blocked before publishing.`, requestedAt: completedAt }];
    }
    run.stageOutputs[nextNode.id] = state.output;
    run.artifacts.push(buildArtifact(nextNode, state.output));
    return { run, commit: async () => { await recordDryRunNodeUsage(run, nextNode, state.input, state.output); } };
  }

  // W0 (determinism program, 2026-08-12): publish_payload was $2.73 of the last $5.56 live run and its
  // `clientObject` came out byte-identical to `article_body.body` — it paid a model to copy JSON. Opt-in
  // per node (metadata.publishPayloadDeterministic), identical dispatch semantics to
  // contractIntelligenceDeterministic above: build deterministically, validate the result against the
  // node's OWN outputSchema, and on any failure fall through to the model path below unchanged, with a
  // run-visible warning naming the failure. Placed after the publish-refusal block on purpose — this
  // node is riskLevel "write" today, but if it is ever raised to publish-risk the gate must still fire
  // first, and a deterministic path must never be the thing that skips a gate.
  //
  // Scoped to LIVE runs, for the same reason placement_resolver's deterministic path scopes itself: a
  // mock run has no client reach (MockNodeRunner calls no tools), and this path makes a real read-only
  // object_validate call against the client. A mock run's article_body "body" is a placeholder, not a
  // client object, so validating it would be both a real network call and a meaningless verdict. Mock
  // runs fall through to MockNodeRunner exactly as before.
  if (nextNode.metadata?.publishPayloadDeterministic === true && ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock") {
    let built: Awaited<ReturnType<typeof runDeterministicPublishPayload>>;
    try {
      built = await runDeterministicPublishPayload({
        projectId: run.projectId,
        clientProjectId,
        articleBody: run.stageOutputs.article_body,
        artifactPlan: run.stageOutputs.artifact_plan
      }, { projectRepository: repositoryManager.getProjectRepository() });
    } catch (error) {
      built = { ok: false, code: "threw", error: error instanceof Error ? error.message : String(error) };
    }
    const payloadValidation = built.ok ? validateOutput(built.payload, nextNode.outputSchema) : undefined;
    if (built.ok && payloadValidation?.ok) {
      const completedAt = now();
      state.status = "completed";
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = built.payload;
      run.stageOutputs[nextNode.id] = built.payload;
      run.artifacts.push(buildArtifact(nextNode, built.payload));
      run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
      run.updatedAt = completedAt;
      run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      // No model call happened, so no usage record is written (the R-20 rule: a $0 event stays $0).
      return { run };
    }
    // Same loud-degradation convention the prefetch and contract-intelligence paths use: a systematic
    // defect here is a run-level fact, not something only found by reading this one node.
    const reason = built.ok ? (payloadValidation && !payloadValidation.ok ? payloadValidation.errors[0] ?? "schema_invalid" : "schema_invalid") : built.code;
    state.warnings = [...(state.warnings ?? []), `publish_payload_deterministic_unavailable:${reason}`];
  }

  // Dispatch claim (the ~300s silent-death fix): persist "this node is in flight, with this timeout"
  // BEFORE the model loop starts, so the run record can distinguish a live execution from a dead
  // driver at any moment (assessRunStall) and a successor advance can reclaim a stale claim instead
  // of the run sticking at status "running" forever. Skipped for the best-effort termination
  // observation path (claim=false), which restores run status itself and must not publish interim
  // state. A CAS conflict here propagates to advanceRun's retry loop like any other save conflict.
  if (claim) {
    state.dispatch = { dispatchedAt: startedAt, timeoutMs: nodeTimeoutMs(nextNode) };
    run = await store.saveRun(run);
    state = stateById(run).get(nextNode.id) as NodeExecutionState;
  }

  // buildInitialRun stamps every new run, so this fallback only covers a legacy record persisted
  // before that — runModeSummary reports such a record as declared:false rather than passing it off
  // as a deliberate choice.
  const mode = (run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode;
  // Phase 7 (DIRECTION §7): model-ladder enforcement. When IMPROVEMENT_MODEL_LADDER_ENFORCE is on,
  // the cheapest eval-qualified model for this node is applied for THIS run only (a per-run override,
  // never a workspace mutation — see modelLadder.ts). Best-effort: any enforcement error leaves the
  // node on its configured model so a transient eval-repository issue never blocks a run. Default OFF,
  // so nextNode is dispatched unchanged unless an operator opts in.
  let effectiveNode = nextNode;
  if (modelLadderEnforcementEnabled()) {
    try {
      const { modelConfig, enforcement } = await enforceModelLadder(nextNode, repositoryManager.getEvaluationRepository());
      if (enforcement.applied) {
        effectiveNode = { ...nextNode, modelConfig };
        state.warnings = [...(state.warnings ?? []), `model_ladder_enforced:${enforcement.fromModel ?? "default"}->${enforcement.toModel}`];
      }
    } catch { /* enforcement is advisory; never fail a run because the ladder could not be computed */ }
  }
  // Provider-aware dispatch (Phase 6): a node whose modelConfig.provider is "anthropic" runs on the
  // native Anthropic Messages runner; every other provider stays on the OpenAI(-compatible) path.
  const runner = getNodeRunner(mode, effectiveNode.modelConfig as Record<string, unknown> | undefined);
  const result = await runner.run({ node: effectiveNode, input: state.input }, { run, executionRepository: store, workspaceRepository: options.workspaceRepository });
  const completedAt = now();
  delete state.dispatch;
  if (result.toolCalls?.length) state.toolCalls = result.toolCalls;
  state.completedAt = completedAt;
  state.durationMs = duration(startedAt, completedAt);
  if (!result.ok) {
    state.status = result.code === "approval_required" ? "blocked" : result.code === "cancelled" ? "cancelled" : "failed";
    state.errors = [result.code, result.message];
    state.output = { error: { code: result.code, message: result.message, details: result.details } };
    run.status = state.status;
    run.errors = [...run.errors, `${nextNode.id}:${result.code}`];
    run.updatedAt = completedAt;
    return { run };
  }
  let output = result.output;

  // P0 §2.3/§2.27 — an "executed" claim from a publisher-kind node must carry go-live evidence
  // (verification.deployStatus === "ready" AND verification.productionConfirmed === true, plus a
  // result) and an approvalMatched that matches the operator's durable publish decision
  // (run.operatorPublishDecision === "approved"). The node's outputSchema enforces the same shape
  // structurally (if/then on status), but schemas are store-overlayable — this deterministic check
  // holds even when the schema was edited: an unevidenced claim is DOWNGRADED to status "blocked"
  // with the missing evidence recorded in blockers, before validation and before anything downstream
  // can read it as a confirmed go-live.
  if (isPublishExecutorNode(nextNode)) {
    const enforced = enforcePublishExecutionEvidence(output, run);
    if (enforced.downgraded) {
      output = enforced.output;
      state.warnings = [...(state.warnings ?? []), "executed_claim_downgraded_to_blocked", ...enforced.reasons.map((reason) => reason.split(":")[0])];
    }
  }

  // R-16 — a node's output must satisfy the node's OWN output schema before it counts as completed.
  //
  // Nothing checked this. T-2 found `article_body` reporting `completed`, persisting an artifact, and
  // handing downstream nodes a value that failed all six required fields of its schema; the same run
  // also carried a `publish_payload` output missing the `summary` its schema requires. Both passed
  // because the executor took the runner's word for it.
  //
  // The consequence was bigger than the two bad fixtures: a dry run could only ever prove that the
  // graph advanced, never that any node produced what it promised — which is exactly the assurance a
  // dry run exists to give before a live publish. The single-node path (nodeRuntime) already validated;
  // the workflow path did not, so the cheaper check was the stricter one.
  //
  // A violation is a FAILURE, not a warning: the stage output and artifact are not written, so a
  // malformed value cannot reach a downstream node or the artifact ledger. Failing closed here is what
  // makes a green run mean something.
  const outputValidation = validateOutput(output, nextNode.outputSchema);
  if (!outputValidation.ok) {
    state.status = "failed";
    state.errors = ["output_schema_violation", ...outputValidation.errors];
    state.output = {
      error: {
        code: "output_schema_violation",
        message: `${nextNode.id} produced output that does not satisfy its own outputSchema.`,
        details: { issues: outputValidation.errors }
      }
    };
    run.status = "failed";
    run.errors = [...run.errors, `${nextNode.id}:output_schema_violation`];
    run.updatedAt = completedAt;
    return { run };
  }

  state.status = "completed";
  state.output = output;
  run.stageOutputs[nextNode.id] = output;
  run.artifacts.push(buildArtifact(nextNode, output));
  // Defect (T-2, run_1785352838155_l544ye): retryNode resets a node's OWN state (node.errors, output,
  // ...) on retry, but never touched the run-level errors array those failures were appended to (line
  // ~565/598 below), so a node that failed and was later retried successfully left its resolved
  // failure permanently in run.errors — this run ended with ["draft_writer:model_timeout", ...] even
  // though draft_writer had since completed. A completion supersedes every earlier entry for THIS
  // node, retried or not, so triage reflects current status rather than accumulating every attempt.
  run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
  run.updatedAt = completedAt;
  run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
  return {
    run,
    commit: async () => {
      if (mode === "mock") await recordDryRunNodeUsage(run, nextNode, state.input, output);
      if (options.workspaceRepository) await options.workspaceRepository.saveStageOutput(nextNode.id, output, `${run.runId}:${nextNode.id}`);
    }
  };
}

// Update only the run-level status (pause/resume/cancel). Node completion state is never touched —
// resume in particular must not resurrect node output — and the CAS retry keeps it from clobbering a
// concurrent advance.
// F3 (T-2, run_1785352838155_l544ye): the budget gate's own remedy ("Raise budgetUsd and resume")
// was unreachable — workflow.resume_run took only runId, with no way to raise the ceiling that
// blocked the run in the first place. `patch` lets resume also carry a new budgetUsd; every other
// caller (pause_run, cancel_run) passes none, so their behavior is unchanged.
export async function updateRunStatus(runId: string, status: ExecutionStatus, store: ExecutionRepository = repositoryManager.getExecutionRepository(), patch: Partial<Pick<WorkflowExecutionRecord, "budgetUsd">> = {}): Promise<WorkflowExecutionRecord | undefined> {
  return withRunLock(runId, async () => {
    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      const run = await store.getRun(runId);
      if (!run) return undefined;
      try {
        return await store.saveRun({ ...run, status, updatedAt: now(), ...patch });
      } catch (error) {
        if (isConcurrencyConflict(error)) continue;
        throw error;
      }
    }
    return store.getRun(runId);
  });
}

// P0 §2.2 — the ONE setter for the operator's durable publish decision (run.operatorPublishDecision).
// Exposed as the MCP tool workflow.set_operator_publish_decision; read by publishRun's
// operator_not_withheld gate and the executor's publish-risk dispatch guard, both through
// publishDecision.isOperatorPublishWithheld. Same lock + CAS discipline as updateRunStatus so a veto
// can never be lost to a concurrent advance.
export async function setOperatorPublishDecision(runId: string, decision: "approved" | "withheld", store: ExecutionRepository = repositoryManager.getExecutionRepository()): Promise<WorkflowExecutionRecord | undefined> {
  return withRunLock(runId, async () => {
    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      const run = await store.getRun(runId);
      if (!run) return undefined;
      try {
        return await store.saveRun({ ...run, operatorPublishDecision: decision, updatedAt: now() });
      } catch (error) {
        if (isConcurrencyConflict(error)) continue;
        throw error;
      }
    }
    return store.getRun(runId);
  });
}

// Explicitly retry a node: clear its status/output/artifact/stage output back to queued, then advance
// once. This is the only sanctioned way (besides reset) to re-run a node that already completed.
export async function retryNode(runId: string, nodeId: string | undefined, options: RunAdvanceOptions = {}): Promise<WorkflowExecutionRecord | undefined> {
  const store = options.executionRepository ?? repositoryManager.getExecutionRepository();
  return withRunLock(runId, async () => {
    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      const run = await store.getRun(runId);
      if (!run) return undefined;
      const node = run.nodes.find((candidate) => !nodeId || candidate.nodeId === nodeId);
      if (!node) return run;
      node.status = "queued";
      delete node.errors;
      delete node.output;
      delete node.startedAt;
      delete node.completedAt;
      delete node.durationMs;
      delete node.warnings;
      delete run.stageOutputs[node.nodeId];
      run.artifacts = run.artifacts.filter((artifact) => artifact.nodeId !== node.nodeId);
      run.approvalsRequired = run.approvalsRequired.filter((approval) => approval.nodeId !== node.nodeId);
      try {
        await store.saveRun({ ...run, status: "queued", updatedAt: now() });
        break;
      } catch (error) {
        if (isConcurrencyConflict(error)) continue;
        throw error;
      }
    }
    return advanceRun(runId, store, options);
  });
}

export const publishingConductorWorkflowId = WORKFLOW_ID;
export const __test__ = { buildInitialRun, findNextRunnableNode, mockOutputForNode, nodeById, isPublishRisk, nodeSource, overlayStoreNode, resolveConductorNodes };
