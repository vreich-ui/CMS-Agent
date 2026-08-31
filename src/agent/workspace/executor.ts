import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import { HALTED_EXECUTION_STATUSES, type ApprovalRequired, type ExecutionArtifact, type ExecutionStatus, type NodeExecutionState, type PublishingPolicySnapshot, type RunDriver, type WorkflowEntrypoint, type WorkflowExecutionRecord } from "./executionTypes.js";
import { resolveProjectConnection, ProjectMcpAdapter } from "../projects/projectMcpAdapter.js";
import { RunConcurrencyError, type ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { recordModelUsage, summarizeModelUsage, evaluateRunBudget } from "../observability/modelUsage.js";
import { getNodeRunner } from "../execution/runnerRegistry.js";
import { validateOutput } from "../execution/outputValidator.js";
import { mockOutputForNode as mockOutputForNodeShared } from "../execution/runners/MockNodeRunner.js";
import { enforceModelLadder, modelLadderEnforcementEnabled } from "../improvement/modelLadder.js";
import { postRunReflectionEnabled, reflectAfterRun } from "../improvement/reflection.js";
import { autoPromoteEnabled, autoPromoteProposals } from "../improvement/autoPromote.js";
import type { OptimizerDeps } from "../improvement/optimizer.js";
import type { ExecutionMode } from "../execution/executionContext.js";
import { conductorCache } from "./conductor.js";
import { clientAuthFailedError, preflightDriverAuth, resolveProjectCredentialName } from "./driverEnvPreflight.js";
import { mintPublishRequestId } from "./publishRequestId.js";
import { getReducedContract } from "./contractPrefetch.js";
import { getEditorialVoice } from "./voicePrefetch.js";
import { CONTENT_ITEM_SHELL_FAILED_PREFIX, CONTENT_ITEM_SHELL_INPUT_KEY, ensureContentItemShell } from "./contentItemShell.js";
import { buildDeterministicContractIntelligence } from "./deterministicContractIntelligence.js";
import { runDeterministicPublishPayload, validateClientObjectOnce, readTopLevelObjectId } from "./publishPayload.js";
import { ENGINE_VALIDATION_POLICY, MAX_ENGINE_REVALIDATION_CYCLES, ownsValidationLoop, promoteValidationUnavailableToBlocker, runArticleBodyValidationLoop, readBodyForValidation } from "./articleBodyValidation.js";
import { applyRunContextEnvelope, buildRunContext } from "./runContext.js";
import { runDeterministicPublicationController } from "./publicationController.js";
import { readPublishExecutorDeterministicMode, runDeterministicPublishExecutor, runEnginePublishExecution } from "./publishExecution.js";
import { runDeterministicReleaseExecutor } from "./releaseExecution.js";
import { buildLearningObservations } from "./learningRecord.js";
import { AGGRESSION_DIALS, buildPlacementResolution, extractPlacementSignals, readPlacementTarget, resolveAggressionVector, type AggressionVector } from "./aggressionVector.js";
import { articleBodyFingerprint, enforcePublishExecutionEvidence, findArticleBodyEnvelope, findPublicationDecision, isOperatorPublishWithheld, readPublicationDecision, resolvePublishAuthority, PUBLICATION_CONTROLLER_NODE_ID } from "./publishDecision.js";
import { getWorkflowDefinition } from "./workflowRegistry.js";
import { resolvePublishableTypeCharter } from "./publishableTypeCharter.js";
// T12.9 — side-effect import: registers the capture_conductor workflow (§2.23 seam) on every plane
// that drives runs, since they all import this module. See captureConductorWorkflow.ts.
import "./captureConductorWorkflow.js";
import "./cloneConductorWorkflow.js";
import { readCaptureStage, runCaptureStage } from "./captureConductorRoutes.js";
import { readCloneStage, runCloneStage } from "./cloneConductorRoutes.js";
import { resolveGateId } from "./gateRegistry.js";
import { evaluateNodeSkip, renderSkippedDependencyPolicy, type SkippedDependencyEntry } from "./skipPredicates.js";
import { declaresContractPrefetch, declaresVoicePrefetch } from "./nodeGatingSeed.js";
import { ENGINE_RESOLVED_VECTOR_POLICY, applyResolvedVectorClamp, declaresResolvedVector, readResolvedVectorSources } from "./resolvedVectorClamp.js";
import { recordNodeTimingCompletion, type NodeTimingOutcome } from "./nodeTimings.js";
import { buildNodeExecutionProvenance } from "./nodeExecutionProvenance.js";

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
// T7 — bound a string by CODE POINT, never by UTF-16 unit. `"…".slice(0, n)` can cut between the two
// halves of a surrogate pair and emit a lone surrogate, which is not valid UTF-8 and cannot be
// serialized to JSON that a strict reader will accept. That is the prime suspect for the live
// "Anthropic Proxy: Invalid content from server" failure on workflow_list_runs: one emoji or CJK
// extension character landing on the boundary of a truncated error string is enough.
const boundText = (value: string, max: number): string => {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max).join("")}…`;
};
// Per-node errors/warnings were passed through UNBOUNDED while the run-level `errors` above them was
// capped at 10 x 2000 chars. One node with a long stack, or a validation loop that appended a warning
// per attempt, could therefore blow up a whole page of rows.
const boundList = (values: string[] | undefined, maxItems: number, maxChars: number): string[] | undefined =>
  values === undefined ? undefined : values.slice(0, maxItems).map((value) => boundText(value, maxChars));

export const summarizeRunForList = (run: WorkflowExecutionRecord) => ({
  runId: run.runId,
  // The caller's join key. compactRun (workflow.run_all) has always carried it;
  // list_runs did not, so a client holding request ids — Platform's W19
  // editorial-request registry, which mints `req_<flow>_<topic>_<yyyymmdd>_<nn>`
  // and passes it in as `requestId` — could not map a page of runs back to the
  // requests it asked for without opening every run individually. Schema-additive
  // and bounded (one short id), so PR #105's compaction contract is untouched.
  ...(run.requestId !== undefined ? { requestId: run.requestId } : {}),
  workflowId: run.workflowId,
  projectId: run.projectId,
  status: run.status,
  ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  nodes: run.nodes.map(({ input: _input, output: _output, ...state }) => ({
    ...state,
    ...(state.errors !== undefined ? { errors: boundList(state.errors, 5, 1_000) } : {}),
    ...(state.warnings !== undefined ? { warnings: boundList(state.warnings, 5, 1_000) } : {})
  })),
  nodeCount: run.nodes.length,
  artifactCount: run.artifacts.length,
  errors: boundList(run.errors, 10, 2_000) ?? [],
  approvalsRequired: run.approvalsRequired,
  dryRun: run.dryRun,
  executionMode: run.executionMode,
  ...(run.rev !== undefined ? { rev: run.rev } : {}),
  ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}),
  ...(run.budgetBlock ? { budgetBlock: run.budgetBlock } : {}),
  ...(run.operatorPublishDecision ? { operatorPublishDecision: run.operatorPublishDecision, operatorDecisionSource: run.operatorDecisionSource ?? "explicit" } : {})
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
// T3 — the wall-clock the engine-owned VALIDATE phase of the article_body loop can legitimately
// occupy after the model has already returned: one validator call per revalidation cycle plus the
// initial one, at the 15s per-call abort publishPayload.ts applies (OBJECT_VALIDATE_TIMEOUT_MS),
// plus one call's margin for the loop's own bookkeeping. The REVISION phase is a full second model
// dispatch and re-claims with nodeTimeoutMs instead — see reclaimForPhase at the loop.
export const ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS = (MAX_ENGINE_REVALIDATION_CYCLES + 2) * 15_000;
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

export type StartDryRunInput = { projectId: string; input?: unknown; workflowId?: string; executionMode?: ExecutionMode; entrypoint?: WorkflowEntrypoint; budgetUsd?: number; requestId?: string };
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
// W1.5 — the whole page window (status/time filters, decoded cursor, limit) is pushed down into the
// repository, which owns the newest-first + runId-tiebreak ordering (compareRunsNewestFirst in the
// ExecutionRepository contract). That lets the blob backend answer from its per-project run index
// and fetch only the ≤limit run blobs the page will return, instead of fetching the entire fleet
// and windowing here. Cursor ENCODING stays here: the opaque token is a tool-schema concern, and the
// repository only ever sees its decoded sort key.
export async function listRunsPage(filters: ListRunsPageInput = {}, store: ExecutionRepository = repositoryManager.getExecutionRepository()): Promise<ListRunsPage> {
  const limit = Math.max(1, Math.min(MAX_LIST_RUNS_LIMIT, Math.floor(filters.limit ?? DEFAULT_LIST_RUNS_LIMIT)));
  const after = filters.cursor ? decodeRunCursor(filters.cursor) : undefined;
  const { runs, matchedCount, hasMore } = await store.listRunsPage({
    projectId: filters.projectId,
    workflowId: filters.workflowId,
    status: filters.status,
    from: filters.from,
    to: filters.to,
    after,
    limit
  });
  return {
    runs,
    page: { limit, matchedCount, hasMore, ...(hasMore && runs.length ? { nextCursor: encodeRunCursor(runs[runs.length - 1]) } : {}) }
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
  // MERGE, not replace: a store row that sets one metadata key (approvalRequired: false) must not
  // erase the canonical keys it did not mention (voicePrefetch, contractPrefetch, skipWhen). A stored
  // key still wins where both declare it.
  metadata: canonical.metadata === undefined && stored.metadata === undefined ? undefined : { ...(canonical.metadata ?? {}), ...(stored.metadata ?? {}) },
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

// T15.5 (2026-08-25, ADR-2026-08-25-publish-autonomy §2.2/§2.5) — REPLACES T2's
// applyOperatorPublishPolicyDefault (2026-08-13), which is deleted, not kept alongside this. That
// function fabricated an operator record: it stamped run.operatorPublishDecision "approved" from a
// project's policy default, so a receipt could claim a human decided when no human did. This function
// makes the opposite choice, by design (ADR invariant 4): it NEVER touches operatorPublishDecision.
// It only captures the project's CURRENT publishing policy as a read-only snapshot on the run, once,
// at creation — autonomyMode (and publishEnabled, for audit completeness) — so
// publishDecision.resolvePublishAuthority can resolve authority later without a live project read.
// That snapshot is what makes two runs of the same URL resolve identically regardless of a policy
// edit made between them (invariant 7), and it is preserved across workflow.reset_run exactly like
// operatorPublishDecision (see resetRun below) for the same reason: a reset retries the request, it
// does not let a mid-flight policy edit change what an in-flight run resolves to.
// projectRepository.get returning undefined (unknown/deleted project) is not an error here — it is
// handled the same as "no policy" (operator-gated, publishEnabled false), because startDryRun's own
// downstream node dispatch is what surfaces an unknown-project failure, not run creation.
// T15.11 (2026-08-25, #190; ADR §6.3) — publishableTypes is resolved from the run's OWN workflowId
// (buildInitialRun already stamped it before this function runs) via the code-declared charter, and
// captured onto the snapshot in the exact same "once, at creation, never re-read live" shape as
// autonomyMode/publishEnabled above — see publishableTypeCharter.ts's header for why this must never
// become a live read.
async function capturePublishingPolicySnapshot(run: WorkflowExecutionRecord, projectRepository: ProjectRepository): Promise<WorkflowExecutionRecord> {
  const config = await projectRepository.get(run.projectId);
  const snapshot: PublishingPolicySnapshot = {
    autonomyMode: config?.publishingPolicy.autonomyMode ?? "operator-gated",
    publishEnabled: config?.publishingPolicy.publishEnabled ?? false,
    publishableTypes: resolvePublishableTypeCharter(run.workflowId).publishableTypes
  };
  return { ...run, publishingPolicySnapshot: snapshot };
}

const nodeById = (nodes: WorkspaceNode[]) => new Map(nodes.map((node) => [node.id, node]));
const stateById = (run: WorkflowExecutionRecord) => new Map(run.nodes.map((node) => [node.nodeId, node]));

// T6 (Wave 3, ships dark) — every node completion executeRunnableNode reaches lands one
// NodeTimingRecord here: model-dispatched nodes AND every deterministic fast path (skip predicates,
// contractIntelligenceDeterministic/placementResolverDeterministic mapping, the budget/approval
// blocks, output_schema_violation failures) all set a terminal state.status + state.durationMs before
// every one of executeRunnableNode's `return { run, ... }` statements — see nodeTimings.ts's header
// for why a ledger that only saw the model-dispatched paths would be worse than none. Reading
// state.durationMs off the ALREADY-SAVED run (rather than timing this call itself) means the recorded
// duration is the exact figure the run record itself reports, not a second, possibly-drifted clock.
// Best-effort: a timing-repository failure must never fail the run it is merely observing, matching
// the posture prepared.commit's own usage/stage-output side effects already take (both call sites
// wrap this in .catch(() => undefined)).
const TERMINAL_TIMING_OUTCOMES = new Set<ExecutionStatus>(["completed", "failed", "blocked", "cancelled", "skipped"]);
async function recordNodeTiming(run: WorkflowExecutionRecord, nodeId: string): Promise<void> {
  const state = stateById(run).get(nodeId);
  if (!state || state.durationMs === undefined || !TERMINAL_TIMING_OUTCOMES.has(state.status)) return;
  await recordNodeTimingCompletion({
    runId: run.runId,
    workflowId: run.workflowId,
    nodeId,
    durationMs: state.durationMs,
    outcome: state.status as NodeTimingOutcome
  });
}

// W4 — DEPENDENCY SATISFACTION, WITH SKIPS.
//
// A dependency is satisfied when it COMPLETED (it produced its artifact) or when it was SKIPPED (the
// conductor decided, before dispatch, that it had nothing to contribute — skipPredicates.ts). The
// second case is the whole point of node gating: review_aggregator must aggregate over whichever
// reviewers ran, and a deliberately-skipped node must never park the run behind an artifact that is
// never coming. Skipped is satisfied-with-ABSENT, not satisfied-with-empty: the dependant is handed no
// stage output for it, plus an explicit ledger saying which inputs are absent and why (see
// executeRunnableNode). Every OTHER status — queued, running, failed, blocked, cancelled — is
// unsatisfied exactly as before, so a failure still stops the run where it always did.
const isDependencySatisfied = (state: NodeExecutionState | undefined): boolean => state?.status === "completed" || state?.status === "skipped";

// The one runnability predicate, shared by the single-node and the T7 batch selectors below so
// "dependency-ready" cannot come to mean two different things in the same dispatch loop.
const isNodeRunnable = (states: Map<string, NodeExecutionState>, node: WorkspaceNode): boolean => {
  const state = states.get(node.id);
  if (!state || state.status !== "queued") return false;
  return node.dependsOn.every((dependency) => isDependencySatisfied(states.get(dependency)));
};

const findNextRunnableNode = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[]): WorkspaceNode | undefined => {
  const states = stateById(run);
  return nodes.find((node) => isNodeRunnable(states, node));
};

// T7: EVERY dependency-ready queued node, in canonical `nodes` order — findNextRunnableNode's own
// `find` is this list's head, so the serial dispatch order a run has always had is exactly this list
// consumed one element at a time. That identity is what lets the concurrent batch below be defined as
// a PREFIX of it and still leave run.artifacts / run.errors in the order a serial run produced them.
const findRunnableNodes = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[]): WorkspaceNode[] => {
  const states = stateById(run);
  return nodes.filter((node) => isNodeRunnable(states, node));
};

// Kept as a re-export so the existing __test__ surface stays stable. The implementation is shared with
// MockNodeRunner (R-17) — this file used to carry a SECOND hand-written copy of the same fixtures, which
// is precisely how two implementations of "what a mock output looks like" drifted apart unnoticed.
const mockOutputForNode = (node: WorkspaceNode, run: WorkflowExecutionRecord) => mockOutputForNodeShared(node, run);

const buildArtifact = (node: WorkspaceNode, output: unknown): ExecutionArtifact => ({ id: `artifact_${node.id}_${Date.now()}`, nodeId: node.id, type: node.produces[0] ?? "mock_output", value: output, createdAt: now() });

// The transitive dependsOn closure of `nodeId`, returned in canonical `nodes` order (ordering is part
// of determinism — publicationController collects blockers in the order given). This is what
// "upstream" means for a decision node: publication_controller must never read its own successors,
// and on run_1786549907145_hf4wgb the looser `!== self` filter let an early-fired learning_recorder
// (a successor) feed re-prefixed copies of upstream blockers back into the decision it observes.
const upstreamNodeIds = (nodeId: string, nodes: WorkspaceNode[]): string[] => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const upstream = new Set<string>();
  const visit = (id: string): void => {
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (upstream.has(dep)) continue;
      upstream.add(dep);
      visit(dep);
    }
  };
  visit(nodeId);
  return nodes.filter((node) => upstream.has(node.id)).map((node) => node.id);
};

// Publish-risk nodes (riskLevel publish/admin) must never run without explicit approval — this is
// the "stop before any publishing side effect" boundary, generalized beyond the single
// publication_controller id so any future publish-risk node is gated the same way.
const isPublishRisk = (node: WorkspaceNode): boolean => node.riskLevel === "publish" || node.riskLevel === "admin";
// P0 §2.1/§2.3 — the node whose output CLAIMS a publish happened (publish_execution.v1). Matched by
// kind, per the isPublishRisk/isLearningRecorder precedent of a semantic node property rather than a
// hardcoded id, so any future publisher node is guarded identically.
const isPublishExecutorNode = (node: WorkspaceNode): boolean => node.kind === "publisher";
// T15.6 (ADR-2026-08-25-publish-autonomy §4.3) — release_executor, matched by `kind` per the same
// isPublishRisk/isPublishExecutorNode/isLearningRecorder precedent: a semantic node property, never a
// hardcoded id, so any future releaser node is guarded and dispatched identically.
const isReleaserNode = (node: WorkspaceNode): boolean => node.kind === "releaser";
const isConcurrencyConflict = (error: unknown): error is RunConcurrencyError => error instanceof RunConcurrencyError;

// T5 (autonomous-publish) — ONE APPROVAL, NOT TWO.
//
// Publishing was gated twice by two mechanisms that did not know about each other. The DURABLE gate
// is run.operatorPublishDecision — the operator's recorded decision, set explicitly via
// workflow.set_operator_publish_decision or standing from the project's publishingPolicy.
// operatorDefault, and the thing publish evidence is matched against. The DRIVER gate was a per-call
// `approved: true` flag on run_all / retry_node, which no scheduled driver has any way to supply:
// the continuation tick and the Cloud Run conductor job just advance runs.
//
// The result was a run that had been approved — durably, on the record, by a real operator or a
// standing project policy — sitting at the publish gate forever, because the tick that would advance
// it could not re-assert an approval that was already given. Every automatic path stopped there and
// a human had to re-approve something already approved, which is precisely the approval click this
// workstream exists to remove.
//
// So the durable decision satisfies the driver gate. It does NOT satisfy anything else:
//   - "withheld" still blocks every publish-risk node, by its own independent check. The veto is not
//     a value this function can outvote.
//   - No decision and no project default still blocks. Absence never authorizes.
//   - publish_executor still needs an explicit publication_controller "go" ON TOP of this. The
//     two-precondition read (controller go + operator approved) is untouched — this collapses the
//     duplicate operator gate, not the controller's.
// T15.5/T15.7 (ADR-2026-08-25-publish-autonomy §2.4, §7) — publishAdvanceApproved is SUPERSEDED and
// removed. It read `options.approved === true || isOperatorPublishApproved(run)`; both halves are
// gone. `approved` is deprecated as an authority input (invariant 7: authority is a pure function of
// the run's own operator record and policy snapshot), and isOperatorPublishApproved was replaced by
// resolvePublishAuthority, which additionally authorizes an autonomous project carrying NO operator
// record at all. Every former caller now calls resolvePublishAuthority(run) directly. The intent this
// helper was written for — a scheduled driver tick carrying an already-authorized run through the
// gate without re-asserting a flag it cannot supply — is preserved and widened, not lost.

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
//
// T15.7 (ADR-2026-08-25-publish-autonomy §2.4, §7) — the look-ahead now reads resolvePublishAuthority(run)
// instead of a caller-supplied `approved` flag: authority is a pure function of the run's own operator
// record and policy snapshot (invariant 7), so a look-ahead computed on one advance and a gate evaluated
// on the next can never disagree about whether the upcoming node needs a hold. Under `autonomous` policy
// the upcoming node will PROCEED at dispatch (never blocked), so no look-ahead hold is minted for it.
// T5 (2026-08-26) — every approval entry and every publish-refusal receipt carries the STABLE gate id
// for the (workflow, node) pair it belongs to, so an operator can address ONE gate. Spread rather than
// assigned so an undeclared pair (an unregistered workflowId, a legacy record) simply omits the field
// instead of carrying `gateId: undefined` into the persisted record. gateRegistry's conformance test
// is what keeps "undeclared" from happening for any workflow this system actually runs.
const gateIdFields = (run: Pick<WorkflowExecutionRecord, "workflowId">, nodeId: string): { gateId?: string } => {
  const gateId = resolveGateId(run.workflowId, nodeId);
  return gateId ? { gateId } : {};
};

const markPendingPublishApproval = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[]): void => {
  // A stale look-ahead is dropped every advance and re-derived below, so it can never outlive the gate it
  // described. An attempted (non-pending) entry is the authoritative audit record and is never touched.
  run.approvalsRequired = run.approvalsRequired.filter((approval) => approval.pending !== true);
  if (resolvePublishAuthority(run).authorized) return;
  const upcoming = findNextRunnableNode(run, nodes);
  if (!upcoming || !isPublishRisk(upcoming)) return;
  if (run.approvalsRequired.some((approval) => approval.nodeId === upcoming.id)) return;
  run.approvalsRequired = [...run.approvalsRequired, {
    nodeId: upcoming.id,
    type: "approval_required",
    // T5: the addressable gate, alongside the node it sits on — see gateRegistry.ts.
    ...gateIdFields(run, upcoming.id),
    reason: `Next dependency-ready node ${upcoming.id} is publish-risk; the run cannot advance without explicit approval. Nothing has been attempted and no publication has been performed.`,
    requestedAt: now(),
    pending: true
  }];
};

// T5 (Wave 2b, 2026-08-13) — THE APPROVAL-GATE STUB, named.
//
// When the publish gate refuses, executeRunnableNode writes a placeholder output on the node:
// { artifact, dryRun, decision: "blocked", approvalRequired, reason }. It is a REFUSAL RECEIPT, not a
// decision — no readiness checklist was evaluated and no publication_decision.v1 was produced. A real
// deterministic decision (publicationController.buildPublicationDecision) always carries BOTH `state`
// and `blockers`; the stub carries neither and carries `approvalRequired` instead. That field triple
// IS the discriminator: no new marker was added to the record, because a marker today's records carry
// and yesterday's don't would mis-classify every run that blocked before this landed.
const isOutputRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isPublishRefusalStub = (output: unknown): boolean =>
  isOutputRecord(output) && output.decision === "blocked" && "approvalRequired" in output && !("state" in output) && !("blockers" in output);

// The narrow case fix 1 clears: the gate refused for want of approval SPECIFICALLY. A stub minted by
// the operator veto or by a non-affirmative controller decision carries approvalRequired:false and is
// never cleared by an approval flag — different refusals, different remedies.
export const isApprovalGateStub = (output: unknown): boolean =>
  isPublishRefusalStub(output) && (output as Record<string, unknown>).approvalRequired === true;

// Refusal warnings an `approved: true` flag has no authority over. A node carrying one of these
// blocked for a reason approval does not answer, so it stays blocked even when its stub also reports
// approvalRequired:true (both refusals can fire on the same attempt).
const NON_APPROVAL_REFUSAL_WARNINGS = new Set(["operator_publish_withheld", "publication_decision_not_affirmative"]);

// T5 fix 1 — "the run's ONLY blocker is the publish-approval gate", as a predicate rather than a
// vibe. Deliberately conservative: any budget hold, any operator veto, any failed node, or any
// blocked node whose refusal was not purely the approval gate answers false, and the run stays put.
export const approvalGateOnlyBlockedNodes = (run: WorkflowExecutionRecord): NodeExecutionState[] => {
  if (run.status !== "blocked") return [];
  if (run.budgetBlock) return [];                    // budget hold — the remedy is a raised ceiling, not approval
  if (isOperatorPublishWithheld(run)) return [];     // P0 §2.2 — the durable veto outranks every approved flag
  if (run.nodes.some((node) => node.status === "failed")) return [];
  const blocked = run.nodes.filter((node) => node.status === "blocked");
  if (!blocked.length) return [];
  const approvalOnly = blocked.every((node) => isApprovalGateStub(node.output) && !(node.warnings ?? []).some((warning) => NON_APPROVAL_REFUSAL_WARNINGS.has(warning)));
  return approvalOnly ? blocked : [];
};

export const isApprovalGateOnlyBlock = (run: WorkflowExecutionRecord): boolean => approvalGateOnlyBlockedNodes(run).length > 0;

// retryNode's exact reset, applied to a gate-blocked node so the approved advance re-dispatches it.
// Same clearing, one place, so "re-enter with approval" and "operator retried it by hand" cannot
// leave two different shapes of node behind.
const requeueGateBlockedNode = (run: WorkflowExecutionRecord, node: NodeExecutionState): void => {
  node.status = "queued";
  delete node.output;
  delete node.errors;
  delete node.warnings;
  delete node.startedAt;
  delete node.completedAt;
  delete node.durationMs;
  delete node.dispatch;
  delete run.stageOutputs[node.nodeId];
  run.artifacts = run.artifacts.filter((artifact) => artifact.nodeId !== node.nodeId);
  run.approvalsRequired = run.approvalsRequired.filter((approval) => approval.nodeId !== node.nodeId);
};

// T5 fix 2 — nodes still holding a publish-refusal receipt. Scoped to the whole refusal family, not
// just the approval one: a run that reported "completed" while a node's output says the operator's
// veto stopped it would be exactly as false a receipt as the approval case.
const publishRefusalStubNodes = (run: WorkflowExecutionRecord): NodeExecutionState[] =>
  run.nodes.filter((node) => isPublishRefusalStub(node.output));

// Restore the attempted (non-pending) approval entry for a refused node when a re-entry found the run
// with the receipt still on it. A look-ahead entry for the same node is dropped: the attempt happened.
const approvalEntriesForRefusals = (run: WorkflowExecutionRecord, refused: NodeExecutionState[]): ApprovalRequired[] => {
  const refusedIds = new Set(refused.filter((node) => isApprovalGateStub(node.output)).map((node) => node.nodeId));
  const kept = run.approvalsRequired.filter((approval) => !(refusedIds.has(approval.nodeId) && approval.pending === true));
  const missing = [...refusedIds].filter((nodeId) => !kept.some((approval) => approval.nodeId === nodeId));
  return [...kept, ...missing.map((nodeId) => ({
    nodeId,
    type: "approval_required" as const,
    ...gateIdFields(run, nodeId),
    reason: `Publish-risk node ${nodeId} requires explicit approval; its output is still the gate's refusal receipt, so the run is not finished.`,
    requestedAt: now()
  }))];
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

export type RunAdvanceOptions = { executionRepository?: ExecutionRepository; workspaceRepository?: WorkspaceRepository; approved?: boolean; driver?: RunDriver };

// S1 — dispatch provenance. Resolves, for THIS process, whether the run's project MCP endpoint env var
// is set (never its value), so the claim written at dispatch says what the dispatching driver could
// see. Best-effort: an unknown project or a repository error records `false`, never throws — a
// provenance stamp must not be able to fail a dispatch.
async function projectEndpointConfiguredFor(projectId: string): Promise<boolean> {
  try {
    const config = await repositoryManager.getProjectRepository().get(projectId);
    return config ? resolveProjectConnection(config).endpointConfigured : false;
  } catch {
    return false;
  }
}
// S3 item 3: the model's own `resolved` as emitted, or undefined when absent/malformed.
const readEmittedResolvedVector = (output: unknown): AggressionVector | undefined => {
  const candidate = output && typeof output === "object" ? (output as Record<string, unknown>).resolved : undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  if (!AGGRESSION_DIALS.every((dial) => typeof record[dial] === "number" && Number.isFinite(record[dial] as number))) return undefined;
  return Object.fromEntries(AGGRESSION_DIALS.map((dial) => [dial, record[dial] as number])) as AggressionVector;
};

const stampDispatch = (state: NodeExecutionState, dispatchedAt: string, timeoutMs: number, driver: RunDriver, projectEndpointConfigured: boolean): void => {
  state.dispatch = { ...(state.dispatch ?? {}), dispatchedAt, timeoutMs, driver, projectEndpointConfigured };
  state.lastDispatch = { dispatchedAt, driver, projectEndpointConfigured };
};

// The dispatched node's effective execution timeout — the same resolution the runner applies
// (modelConfig/executionConfig.timeout, else the 120s default) — so the dispatch claim written to the
// run record describes exactly how long a live execution could possibly take.
const nodeTimeoutMs = (node: WorkspaceNode): number => {
  const merged = { ...(node.modelConfig ?? {}), ...(node.executionConfig ?? {}) } as Record<string, unknown>;
  const timeout = merged.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) ? timeout : 120_000;
};

// T14.4 — a deterministic capture/clone stage is NOT a fast local computation. capture_emit_live
// probes and ingests every asset on the target site and then walks creates/reuses over the project
// MCP; on zilberman that is 100-200s of real network work. The model default (120_000) would let the
// stall assessor call such a stage dead while it is still working, so the claim these stages publish
// gets a floor. A node that configures a LONGER timeout keeps it.
const DETERMINISTIC_STAGE_MIN_TIMEOUT_MS = 300_000;
const deterministicStageTimeoutMs = (node: WorkspaceNode): number => Math.max(nodeTimeoutMs(node), DETERMINISTIC_STAGE_MIN_TIMEOUT_MS);

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

export async function startDryRun(data: StartDryRunInput, store: ExecutionRepository = repositoryManager.getExecutionRepository(), workspaceRepository?: WorkspaceRepository, projectRepository: ProjectRepository = repositoryManager.getProjectRepository()): Promise<WorkflowExecutionRecord> {
  // S1 — a caller-supplied requestId (validated by the tool layer against the project's pattern)
  // becomes the run's requestId; absent, the auto-minted join key is used as before.
  const initial = buildInitialRun(data, await resolveConductorNodes(workspaceRepository, data.workflowId ?? WORKFLOW_ID), makeRunId(), data.requestId?.trim() || makeRequestId());
  return store.createRun(await capturePublishingPolicySnapshot(initial, projectRepository));
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
    // T3: a reset re-runs the whole workflow, so nothing memoized for this run may survive it. The
    // run-scoped cache holds deterministic client reads (the reduced object contract, the editorial
    // voice, the run context bundle); keeping them across a reset means a reset performed precisely
    // BECAUSE a client read went wrong replays that same read. Dropping them costs one cheap
    // re-fetch per key and is the only thing that makes a reset a real do-over.
    conductorCache.invalidateRun(runId);
    // Rebuild from the run's own starting shape, including a late-stage entrypoint, so reset restores
    // the seeded state it began with rather than a full ideation-to-publish run.
    const nodes = await resolveConductorNodes(undefined, existing.workflowId);
    // requestId travels with the run across a reset — it identifies the same request being retried,
    // not a new one, and a platform-side record correlating against it must still resolve. The
    // operator's durable publish decision (P0 §2.2) survives a reset for the same reason: a reset
    // retries the request, it does not un-say the operator's veto/approval. T15.5 (ADR §2.5) — the
    // run's publishingPolicySnapshot survives a reset for the SAME reason and no other: a reset
    // retries the ORIGINAL request under the ORIGINAL policy it was created under, so a policy edit
    // made after the run started must not change what the reset run resolves to (a fresh capture
    // here would be exactly the staleness bug §2.5 exists to prevent, one layer later).
    const rebuilt = buildInitialRun({ projectId: existing.projectId, input: existing.initialInput, workflowId: existing.workflowId, executionMode: existing.executionMode, entrypoint: existing.entrypoint, budgetUsd: existing.budgetUsd }, nodes, runId, existing.requestId);
    return store.resetRun(runId, {
      ...rebuilt,
      ...(existing.operatorPublishDecision ? { operatorPublishDecision: existing.operatorPublishDecision, operatorDecisionSource: existing.operatorDecisionSource ?? "explicit" } : {}),
      ...(existing.publishingPolicySnapshot ? { publishingPolicySnapshot: existing.publishingPolicySnapshot } : {})
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
  // W4: "did not complete" here means "cannot ever satisfy", so a SKIPPED dependency does not seal —
  // a skip is a satisfied dependency (isDependencySatisfied), and treating it as a seal would report
  // the DAG as refused at a node the conductor deliberately routed around.
  //
  // T15.6 (ADR-2026-08-25-publish-autonomy §4.3): BOUNDED two-level sealing, not open recursion.
  // learning_recorder now depends on release_executor, which itself depends on publish_executor — a
  // chain one hop deeper than plain one-level sealing reaches. A publish gate refusing at
  // publication_controller leaves BOTH publish_executor and release_executor "queued" forever:
  // publish_executor seals at depth 0 (its sole dependency, publication_controller, is literally
  // reached — status "blocked"), but release_executor's own dependency is publish_executor, which is
  // itself only SEALED, not literally reached — so release_executor needs one more hop of sealing to
  // resolve, hence maxDepth 1 below (an id sealed at depth d may treat a dependency as satisfied if
  // that dependency is itself sealed at depth d-1).
  //
  // This must stay BOUNDED, not fully recursive: an earlier version of this function let sealed(id)
  // recurse through sealed(dependency) with no depth limit, which reintroduced exactly the 2.4 bug it
  // was meant to avoid — a run that fails at its very first node (input_triage) leaves every
  // downstream node "queued", and open recursion found that placement_resolver (whose sole dependency,
  // input_triage, is literally reached — status "failed") seals at depth 0, and from there the seal
  // tunnels all the way down the entire graph to publication_controller and beyond, purely because
  // every node in between chains sealed-through-sealed with no distance limit. Bounding the recursion
  // to maxDepth 1 hop is enough for the current tail (release_executor -> publish_executor ->
  // publication_controller, a 2-edge chain) while remaining far too shallow to tunnel across the ~15
  // nodes between input_triage and publication_controller, so the 2.4 regression test (a run dead at
  // input_triage never dispatches learning_recorder) still holds. If a future tail edge needs a third
  // hop, raise maxDepth deliberately — do not restore open recursion.
  const sealed = (id: string, depth: number): boolean => {
    const dependencies = byId.get(id)?.dependsOn ?? [];
    return dependencies.length > 0
      && dependencies.every((dependency) => reached(dependency) || (depth > 0 && sealed(dependency, depth - 1)))
      && dependencies.some((dependency) => !isDependencySatisfied(states.get(dependency)));
  };
  const MAX_SEAL_DEPTH = 1;
  return node.dependsOn.every((dependency) => reached(dependency) || sealed(dependency, MAX_SEAL_DEPTH));
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
    await recordNodeTiming(saved, node.id).catch(() => undefined);
    return saved;
  } catch {
    // Best-effort: recording observations must never fail the run or mask its real terminal status.
    return run;
  }
}

// ── T7 (Wave 3, 2026-08-13) — BOUNDED CONCURRENT DISPATCH ───────────────────────────────────────────────────
//
// Evidence (run_1786557897658_elj34j, verified live 2026-08-12): the review quartet — human_texture,
// trust_factual, emotional_resonance, reader_simulation — ran SERIALLY for ~113 seconds. None of the
// four depends on another and all four feed review_aggregator. The serialization was the DRIVER's, not
// the graph's: findNextRunnableNode returns the canonically-first ready node and advanceRun dispatched
// exactly that one, so four independent nodes cost four advances.
//
// review_aggregator gets NO special case. It waits because isDependencySatisfied reports its four
// dependencies unsatisfied until each completes — the same rule that makes it impossible for a batch to
// contain a node and its own dependency (a node whose dependency has not completed is not runnable, so
// the two can never appear in one ready list). The dependency graph does the barriering, as it always did.
//
// The bound is the QUARTET WIDTH — the four independent reviewers this exists for — and is not a
// throughput tuning knob to be raised casually. Every batch member is a live model dispatch against the
// same client and the same run ceiling, and the budget reservation below can only defend that ceiling
// for members that DECLARE a budgetUsd; raising this raises the worst-case overshoot of an undeclared
// node linearly with it. Four is also the widest independent fan-out this graph has.
export const CONCURRENT_DISPATCH_LIMIT = 4;

// Node metadata that routes a dispatch into a DETERMINISTIC path inside executeRunnableNode. Such a
// node is excluded from the batch, so the batch admits only nodes whose deterministic/skip evaluation
// has ALREADY run (here, before the batch is formed) and came out as ordinary model dispatches. Reasons,
// concretely: those paths are engine code that costs nothing to run serially, so concurrency buys
// nothing; several of them read stage outputs OUTSIDE their own dependsOn (publish_payload reads
// article_body, publication_controller reads its whole upstream closure), which is exactly what an
// interleaved schedule would perturb; and one of them can publish.
const DETERMINISTIC_ROUTE_METADATA_KEYS = [
  "contractIntelligenceDeterministic",
  "placementResolverDeterministic",
  "publishPayloadDeterministic",
  "publicationControllerDeterministic",
  "publishExecutorDeterministic",
  "releaseExecutorDeterministic",
  "learningRecorderDeterministic",
  // T12.9: the capture_conductor stages (captureConductorRoutes.ts). String-valued ("crawl", ...),
  // which declaresDeterministicRoute below already treats as declared.
  "captureStageDeterministic",
  // T13.1: the clone_conductor stages (cloneConductorRoutes.ts). Same string-valued declaration.
  "cloneStageDeterministic"
] as const;
const declaresDeterministicRoute = (node: WorkspaceNode): boolean =>
  DETERMINISTIC_ROUTE_METADATA_KEYS.some((key) => {
    const declared = node.metadata?.[key];
    return declared !== undefined && declared !== false;
  });

// T1 (2026-08-26) — WORKFLOW-OWNED STAGE ROUTES, and why they must outrank the shared tail's own.
//
// THE DEFECT, exactly. `publish_executor`'s STORE row carries `publishExecutorDeterministic:
// "execute"` (set by scripts/reseedStoreFromCanonical.ts --set-publish-executor-mode; deliberately
// NOT in any canonical literal — see that script's header). capture_conductor and clone_conductor
// compose the SHARED publishing tail, so their publish_executor carries the SAME NODE ID, and
// overlayStoreNode MERGES metadata by id — which is the whole point of sharing a tail, and is what
// makes an authoring edit reach every workflow at once. The consequence nobody wired for: a composed
// workflow's publish_executor ends up declaring BOTH its own `captureStageDeterministic`/
// `cloneStageDeterministic` route AND the inherited DTC `publishExecutorDeterministic: "execute"`.
//
// The DTC execute route is evaluated far above the capture/clone stage dispatch in this file, and it
// is — by its own design note — the ONE deterministic route here with no fallback: "Every outcome
// therefore terminates here." So a clone run reached publisher.ts publishRun, which demands an
// operator-supplied requestId and an article_body envelope, and died on `publish_request_id_absent` /
// `no_valid_article_body` — for a workflow (the structure studio) that composes the PUBLISH segment
// only, emits `clientObjectType: "clone_structure_batch"`, and has no article body and never will.
// Live evidence: run_1787748666186_ammpuv and run_1787748899372_lbvqdz on zilberman, both 16/18 nodes
// green with every gate passed (approvalMatched:true, controller "go", 2 objects cleared) and then
// ZERO client calls.
//
// WHY THIS AND NOT A CLONE BRANCH INSIDE publisher.ts. clone_conductor already HAS a complete,
// correct, clone-aware publish path — cloneConductorRoutes.ts's "publish_executor" case, which builds
// an object publish plan from recipe_mint/theme_bind/layout_restamp's own reports and drives
// checkout -> object_publish -> checkin per object (objectPublishExecution.ts). It was never missing;
// it was never REACHED. Teaching publisher.ts to recognise a clone envelope would build a SECOND
// clone publish path alongside the working one, and the two would drift.
//
// THE RULE, stated once: a node that declares a workflow-OWNED stage route is dispatched by that
// route, and the shared tail's DTC routes do not fire for it. The workflow's own composition is the
// more specific authority — it is per-workflow code (captureConductorNodes.ts /
// cloneConductorNodes.ts) that deliberately tagged this node, whereas the DTC flag arrived by
// id-collision on a shared row that publishing_conductor set for its OWN article path. Note that
// clone's and capture's compositions ALREADY drop the inherited `publishPayloadDeterministic` flag
// on publish_payload for exactly this reason; that fix simply was not extended to publish_executor,
// and publish_payload's DTC route degrades gracefully where publish_executor's terminates. Fixing it
// HERE rather than by dropping one more key per composition covers every present and future shared
// tail node at once, and cannot be defeated by a store row re-adding the key after composition ran
// (which a drop-at-composition fix cannot say — the overlay runs AFTER the composition).
const WORKFLOW_STAGE_ROUTE_METADATA_KEYS = ["captureStageDeterministic", "cloneStageDeterministic"] as const;
export const declaresWorkflowStageRoute = (node: Pick<WorkspaceNode, "metadata">): boolean =>
  WORKFLOW_STAGE_ROUTE_METADATA_KEYS.some((key) => {
    const declared = node.metadata?.[key];
    return typeof declared === "string" && declared.trim().length > 0;
  });

// The stage outputs the ENGINE reads outside a node's own dependsOn: buildRunContext (runContext.ts)
// lifts requestId from artifact_plan and the client facts from contract_intelligence;
// readResolvedVectorSources (resolvedVectorClamp.ts) reads contract_intelligence and placement_resolver.
// A serial run dispatches in canonical order, so a node canonically AFTER one of these sees its output
// — a batch member would not. The batch therefore ENDS at the first such node (it may still ride with
// earlier-canonical siblings, which would not have seen its output serially either), which is what keeps
// every batch exactly equivalent to the serial prefix it replaces.
const RUN_CONTEXT_SOURCE_NODE_IDS = new Set(["artifact_plan", "contract_intelligence", "placement_resolver"]);

// The skip verdict, READ without recording anything — executeRunnableNode remains the only place that
// writes the skip state and its warnings, and it re-evaluates the same pure predicate moments later. The
// two cannot disagree: batch members are mutually independent, so no sibling writes a stage output
// another sibling's predicate reads, and every member is handed the same pre-batch snapshot.
const wouldSkipBeforeDispatch = (run: WorkflowExecutionRecord, node: WorkspaceNode): boolean => {
  if (stateById(run).get(node.id)?.skipOverride) return false;
  return evaluateNodeSkip(node, { initialInput: run.initialInput, stageOutputs: run.stageOutputs })?.skip === true;
};

// Publish-risk is the hard exclusion: a publish-risk node is NEVER dispatched alongside anything. Its
// gates (operator veto, explicit approval, an affirmative controller decision) exist to STOP the run
// there, and a sibling completing beside it would be work done past a stop.
const isConcurrentDispatchEligible = (run: WorkflowExecutionRecord, node: WorkspaceNode): boolean =>
  !isPublishRisk(node) && !isPublishExecutorNode(node) && !declaresDeterministicRoute(node) && !wouldSkipBeforeDispatch(run, node);

// THE BATCH: the longest PREFIX of the ready list (canonical order) whose members are all eligible, at
// most CONCURRENT_DISPATCH_LIMIT long, that the run budget can still reserve for. A prefix, never a
// filtered subset — stepping over an ineligible node to reach an eligible one would dispatch out of
// canonical order and leave run.artifacts / run.errors in an order no serial run ever produced. []
// means "use the serial path", and so does a batch of one.
//
// BUDGET: the ceiling is reserved for the WHOLE batch before any of it is dispatched — the same
// reservation the serial gate performs for one node (F2, hardened after run_1785435947311_jl8hl4 landed
// at 138%). A node whose declared budgetUsd no longer fits alongside those already admitted ends the
// batch and is dispatched on a later advance, where the serial gate re-decides it with the batch's
// actual spend accrued. Four concurrent nodes therefore cannot collectively RESERVE past a ceiling one
// serial node would have stopped at. What concurrency does widen is the un-reservable remainder: a node
// that declares no budgetUsd reserves $0, so up to CONCURRENT_DISPATCH_LIMIT of them can be in flight
// when the ceiling is crossed mid-node instead of one — the overshoot is bounded by the batch's own
// actual spend beyond what it reserved, and the run still halts at the next advance.
const selectConcurrentBatch = (run: WorkflowExecutionRecord, nodes: WorkspaceNode[], head: WorkspaceNode, budget: ReturnType<typeof evaluateRunBudget>): WorkspaceNode[] => {
  const ready = findRunnableNodes(run, nodes);
  // The head must be the node the serial path would have dispatched, or this is not a prefix.
  if (ready.length < 2 || ready[0]?.id !== head.id) return [];
  const batch: WorkspaceNode[] = [];
  let reservedUsd = 0;
  for (const node of ready) {
    if (batch.length >= CONCURRENT_DISPATCH_LIMIT) break;
    if (!isConcurrentDispatchEligible(run, node)) break;
    const reserveUsd = nodeBudgetUsdOf(node) ?? 0;
    if (budget && budget.spentUsdEstimate + reservedUsd + reserveUsd > budget.budgetUsd) break;
    reservedUsd += reserveUsd;
    batch.push(node);
    if (RUN_CONTEXT_SOURCE_NODE_IDS.has(node.id)) break;
  }
  return batch.length > 1 ? batch : [];
};

// One batch: one claim save, one reconciliation save.
//
// RUN-RECORD WRITES — per-node save-and-merge is NOT available here, so this is a single post-batch
// reconciliation. executeRunnableNode mutates the run record it is handed and advanceRun persists the
// WHOLE record under a compare-and-swap (ExecutionRepository.saveRun, RunConcurrencyError): four
// dispatches each saving their own copy would either lose three writes or trip the CAS against each
// other on every single batch. Each node therefore executes against its own structuredClone of the
// claimed record, nothing is persisted until every sibling has settled, and the results are merged into
// one record in canonical node order and written once. Two saves per batch — exactly what one serial
// advance costs today.
//
// THE CLAIM SAVE IS NOT OPTIONAL. It is the dispatch heartbeat runContinuation's tick reads through
// assessRunStall: without a persisted "these nodes are in flight, with these timeouts" marker, a tick
// firing mid-batch would see an idle driver and re-enter a run that is genuinely in flight. It is also
// what protects the reconciliation save's CAS — a competing advanceRun that loads the claimed record
// finds an in-flight node inside its window and returns without writing. `claim` is left false on the
// executeRunnableNode calls precisely because this save already made that claim, for all four at once.
async function dispatchConcurrentBatch(run: WorkflowExecutionRecord, batch: WorkspaceNode[], nodes: WorkspaceNode[], store: ExecutionRepository, options: RunAdvanceOptions): Promise<WorkflowExecutionRecord> {
  const dispatchedAt = now();
  const claimStates = stateById(run);
  const driver: RunDriver = options.driver ?? "http_run_all";
  const projectEndpointConfigured = await projectEndpointConfiguredFor(run.projectId);
  for (const node of batch) {
    const state = claimStates.get(node.id) as NodeExecutionState;
    state.status = "running";
    state.startedAt = dispatchedAt;
    stampDispatch(state, dispatchedAt, nodeTimeoutMs(node), driver, projectEndpointConfigured);
  }
  run.status = "running";
  run.currentNodeId = batch[0].id;
  run.updatedAt = dispatchedAt;
  const claimed = await store.saveRun(run);

  // FAILURE ISOLATION: allSettled, never all. One sibling rejecting must not discard the three that
  // returned — their transitions are reconciled and persisted below, and only then is the rejection
  // re-thrown into advanceRun's existing error handling.
  const settled = await Promise.allSettled(batch.map((node) => executeRunnableNode(structuredClone(claimed), node, nodes, store, options)));

  // RECONCILIATION, in CANONICAL node order — never completion order. Everything order-bearing on the
  // record (run.errors, run.artifacts, stageOutputs insertion, the run's own status) is rebuilt by
  // walking `batch`, which is a canonical prefix, so which sibling finished first is not observable in
  // the persisted record. Blocker collection needs nothing here: publicationController is handed
  // `upstreamNodeIds(...).map(id => ({ id, output: run.stageOutputs[id] }))` and collects in the order
  // GIVEN, which is canonical node order keyed by node id — VERIFIED, it never reads dispatch order.
  const reconciled = structuredClone(claimed);
  const claimedArtifactIds = new Set(claimed.artifacts.map((artifact) => artifact.id));
  const commits: Array<() => Promise<void>> = [];
  let halted: { nodeId: string; status: ExecutionStatus } | undefined;
  let rejection: unknown;

  batch.forEach((node, index) => {
    const outcome = settled[index];
    if (outcome.status === "rejected") {
      // executeRunnableNode THREW — not a node that failed (that is a returned record, handled below).
      // The node is left exactly as the claim save wrote it: "running", holding its dispatch claim,
      // which is the state a serial run leaves behind when a dispatch throws and the state the
      // stale-claim reclaim path at the top of advanceRun already knows how to recover. Never marked
      // completed, never assumed to have passed.
      rejection ??= outcome.reason;
      return;
    }
    const produced = outcome.value.run;
    const producedState = stateById(produced).get(node.id) as NodeExecutionState;
    // A node that is no longer running holds no live claim. The model path deletes it itself; the
    // pre-dispatch failure paths return before that line and would otherwise carry the batch's claim
    // into a terminal state, looking in-flight forever to assessRunStall.
    if (producedState.status !== "running") delete producedState.dispatch;
    reconciled.nodes[reconciled.nodes.findIndex((state) => state.nodeId === node.id)] = producedState;
    if (Object.prototype.hasOwnProperty.call(produced.stageOutputs, node.id)) reconciled.stageOutputs[node.id] = produced.stageOutputs[node.id];
    reconciled.artifacts.push(...produced.artifacts.filter((artifact) => !claimedArtifactIds.has(artifact.id)));
    // The same supersede semantics executeRunnableNode applies serially (T-2, run_1785352838155_l544ye):
    // this node's earlier entries are dropped, then whatever THIS attempt recorded is appended — in
    // batch (canonical) order, so a slow sibling's error never sorts ahead of a fast one's.
    reconciled.errors = [...reconciled.errors.filter((entry) => !entry.startsWith(`${node.id}:`)), ...produced.errors.filter((entry) => entry.startsWith(`${node.id}:`))];
    if (!halted && HALTED_EXECUTION_STATUSES.has(produced.status)) halted = { nodeId: node.id, status: produced.status };
    if (outcome.value.commit) commits.push(outcome.value.commit);
  });

  // The FIRST batch member in canonical order that halted decides the run's status and currentNodeId —
  // that is the node a serial run would have stopped at, since serial dispatches in exactly this order.
  // A halt deliberately outranks a sibling left in flight by a rejection: leaving the run "running" with
  // a failed node in it would let the next advance walk past the failure and eventually stamp
  // "completed" on a run that failed, which is the most expensive lie the record can tell (T5 fix 2).
  reconciled.status = halted ? halted.status : "running";
  reconciled.currentNodeId = halted ? halted.nodeId : findNextRunnableNode(reconciled, nodes)?.id;
  if (reconciled.budgetBlock) reconciled.budgetBlock = undefined;
  markPendingPublishApproval(reconciled, nodes);
  reconciled.updatedAt = now();
  const saved = await store.saveRun(reconciled);
  // Side effects after the durable commit, in canonical order, non-authoritative — same posture and same
  // sequence the serial path uses: usage/stage-output mirror first, then T6's timing ledger, which lands
  // exactly one record per node completion because it reads the terminal state off the SAVED record.
  for (const commit of commits) await commit().catch(() => undefined);
  for (const node of batch) await recordNodeTiming(saved, node.id).catch(() => undefined);
  if (rejection !== undefined) throw rejection;
  return saved;
}

async function advanceRun(runId: string, store: ExecutionRepository, options: RunAdvanceOptions): Promise<WorkflowExecutionRecord> {
  let latest: WorkflowExecutionRecord | undefined;
  for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    latest = run;
    // T5 fix 1 (2026-08-13) — an advance re-enters a run whose ONLY blocker is the publish-approval
    // gate. Until now that took workflow.resume_run + workflow.retry_node by hand, because resume_run
    // re-queues the RUN while the executor schedules only queued NODES: the gate-blocked node stayed
    // "blocked", nothing was runnable, and the run fell straight into the completed branch below (which
    // is T5 fix 2's defect). Every other halt returns untouched below: budget, operator veto, a
    // non-affirmative controller decision, a failed node, an operator pause or cancel.
    //
    // T15.7 (ADR-2026-08-25-publish-autonomy §2.4, §7) — the trigger is resolvePublishAuthority(run),
    // not a caller-supplied `approved` flag: `approved` is deprecated as an authority input everywhere
    // (invariant 7 — authority is a pure function of the run's own operator record and policy snapshot),
    // so a caller no longer has to re-assert approval in lockstep with the durable decision. The run
    // becomes self-healing — the NEXT advance of any kind, with or without any flag, clears the gate the
    // moment workflow.set_operator_publish_decision("approved") lands on the record, exactly as it
    // already does the moment an autonomous run's policy snapshot would have let the node proceed in the
    // first place. The requeue happens before the halted-status return so one workflow.run_all call
    // carries the run through the gate instead of stopping at it.
    if (resolvePublishAuthority(run).authorized && isApprovalGateOnlyBlock(run)) {
      for (const blockedNode of approvalGateOnlyBlockedNodes(run)) requeueGateBlockedNode(run, blockedNode);
      run.status = "queued";
      run.updatedAt = now();
    } else if (HALTED_EXECUTION_STATUSES.has(run.status)) return run;

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
        // T5 fix 2 (2026-08-13, run_1786557897658_elj34j) — a run must NOT report "completed" while a
        // node's output is still the publish gate's refusal receipt. The path is exactly the one
        // runConductorJob warns about in prose: resume_run re-queues the RUN but not the blocked NODE,
        // the executor schedules only queued nodes, so the next advance finds nothing runnable and
        // stamps "completed" over a run that refused to publish and whose decision node holds a stub
        // saying so. "completed" is the one status downstream readers (attention feed, learning
        // corpus, publish_run's own preconditions) trust without re-reading the nodes, so a false one
        // is the most expensive lie the record can tell. The honest state is the blocked one the gate
        // already produced, restored with its approval entry.
        //
        // The stub is told from a REAL deterministic decision by its fields, never by node id: the
        // stub has approvalRequired and no state/blockers; publication_decision.v1 always carries both
        // (isPublishRefusalStub). A run that legitimately completed a decision node therefore reaches
        // "completed" exactly as before.
        //
        // No termination observation is recorded here: this path is only reachable by re-entering a
        // run the gate already refused, and that refusal was already observed when it happened —
        // re-recording would bill a second learning_recorder dispatch for one event.
        const refused = publishRefusalStubNodes(run);
        if (refused.length) {
          return await store.saveRun({
            ...run,
            status: "blocked",
            currentNodeId: refused[0].nodeId,
            updatedAt: now(),
            approvalsRequired: approvalEntriesForRefusals(run, refused)
          });
        }
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
      // T7: hoisted out of the block below so the concurrent batch can reserve against the SAME budget
      // view the serial gate just used — one evaluation per advance, never a second, possibly-drifted read.
      let budget: ReturnType<typeof evaluateRunBudget> = undefined;
      if (run.budgetUsd !== undefined) {
        // R-20: gate on actualCostUsdEstimate, never total — a mock run's deterministic estimates
        // (status:"estimated") must not consume the ceiling (T-2 F-5).
        const usage = await summarizeModelUsage({ runId });
        budget = evaluateRunBudget(run.budgetUsd, usage.actualCostUsdEstimate);
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
      // T7: the concurrent path, taken ONLY when the batch is a canonical prefix of two or more
      // eligible nodes (selectConcurrentBatch). Everything else — a single ready node, a publish-risk
      // head, a deterministic route, a node about to be skipped — falls through to the serial dispatch
      // below, byte-for-byte as before, and the same terminal-observation hook fires on either path.
      const batch = selectConcurrentBatch(run, nodes, nextNode, budget);
      if (batch.length > 1) {
        const batched = await dispatchConcurrentBatch(run, batch, nodes, store, options);
        if (batched.status === "blocked" || batched.status === "failed") {
          return await recordTerminationObservations(batched, nodes, store, options);
        }
        return batched;
      }
      const prepared = await executeRunnableNode(run, nextNode, nodes, store, options, true);
      // A run that clears the budget gate is no longer paused for budget: drop any stale marker so a
      // resumed-under-ceiling run doesn't keep reporting "paused for budget".
      if (prepared.run.budgetBlock) prepared.run.budgetBlock = undefined;
      // R-18: record (or clear) a look-ahead publish-approval hold before the state is committed, so the
      // hold is durable and visible on the very next read rather than only after another advance attempt.
      markPendingPublishApproval(prepared.run, nodes);
      const saved = await store.saveRun(prepared.run);
      // Side effects (usage telemetry, workspace stage-output mirror) run only after the state
      // transition is durably committed, so a discarded attempt on a CAS conflict leaves no phantom
      // usage behind. They are non-authoritative — the run record itself already holds the output —
      // so a failure here must not report an otherwise-successful advance as failed.
      await prepared.commit?.().catch(() => undefined);
      // T6 (Wave 3, ships dark): the node timing ledger's one hook into the main dispatch loop. Same
      // non-authoritative posture as the line above — recordNodeTiming is itself best-effort internally
      // and this call is not awaited-and-thrown on failure either.
      await recordNodeTiming(saved, nextNode.id).catch(() => undefined);
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

// T2 — ABORT THE RUN, DO NOT DEGRADE IT.
//
// The conductor is built to degrade gracefully: a deterministic read that fails hands the node a
// named `prefetchError`, the node writes its own blocker, the artifact stays schema-valid and the run
// carries on. That is right for a transient outage and catastrophically wrong for an auth failure,
// which is exactly what run_1787658091131_cv41es demonstrated three times at ~$1.45 apiece: the very
// first client call was refused, every later node dutifully produced an empty-but-schema-valid
// artifact carrying blockers[], the run reported `completed`, and nothing about it could ever be
// published. Graceful degradation converted an unrecoverable, instantly-diagnosable configuration
// error into a full-price run whose failure was only legible by reading blockers[] on an artifact
// nobody had reason to open.
//
// So a client-auth failure ends the run at the node that found it: node `failed`, run `failed`, the
// error named on both, and nothing downstream dispatched. Callers pass the node's own startedAt so
// the record shows the real duration rather than a zero-length event.
const failNodeOnClientAuth = (run: WorkflowExecutionRecord, state: NodeExecutionState, nodeId: string, startedAt: string, code: string, message: string): WorkflowExecutionRecord => {
  const completedAt = now();
  state.status = "failed";
  state.startedAt = state.startedAt ?? startedAt;
  state.completedAt = completedAt;
  state.durationMs = duration(state.startedAt ?? startedAt, completedAt);
  state.errors = [code, message];
  state.output = { error: { code, message } };
  delete state.dispatch;
  run.status = "failed";
  run.currentNodeId = nodeId;
  run.errors = [...run.errors, `${nodeId}:${code}`];
  run.updatedAt = completedAt;
  return run;
};

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
  // W4 — SKIP PREDICATES, EVALUATED PRE-DISPATCH.
  //
  // This is the earliest point at which the run holds everything a predicate reads and nothing has
  // been spent: the node is dependency-ready, its upstream outputs are in run.stageOutputs, and no
  // prefetch, no runner and no model call has happened yet. A predicate that fired AFTER the dispatch
  // would be a refund request, not a gate.
  //
  // The decision is a real state transition — status "skipped", with the predicate that fired and the
  // facts it fired on recorded on the node — never a quiet no-op. No stage output and no artifact are
  // written (a skipped node asserted nothing), no usage is recorded (nothing was charged), and the
  // dependants treat the node as satisfied-with-absent (isDependencySatisfied).
  //
  // An operator's explicit retry of a skipped node sets skipOverride, which bypasses this: a retry is
  // the operator saying "run this one", and re-deciding it against them would be an infinite loop.
  if (!state.skipOverride) {
    const verdict = evaluateNodeSkip(nextNode, { initialInput: run.initialInput, stageOutputs: run.stageOutputs });
    if (verdict?.warnings.length) state.warnings = [...(state.warnings ?? []), ...verdict.warnings];
    if (verdict?.skip) {
      const completedAt = now();
      state.status = "skipped";
      state.startedAt = startedAt;
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.skip = { reason: verdict.reason, predicate: verdict.predicate as Record<string, unknown> | undefined, basis: verdict.basis, evaluatedAt: completedAt };
      // A run-visible warning as well as the record: `workflow.get_run` readers and the attention feed
      // both read state.warnings, so a gated run is legible without opening each node.
      state.warnings = [...(state.warnings ?? []), `node_skipped:${verdict.predicate?.when ?? "predicate"}`];
      delete state.dispatch;
      // T4 — AUTHOR THE PUBLISH ID AT THE MOMENT THE RUN LOSES ITS ONLY SOURCE FOR ONE.
      //
      // artifact_plan is the sole author of the publish request id, and a skipped node writes no
      // stage output. So the instant this predicate fires on a text-only run, the run becomes
      // structurally incapable of publishing — and says nothing about it until publish_executor
      // refuses with publish_request_id_absent, after a passed controller, a recorded approval and
      // five green publisher gates. Authoring here closes that gap at its source rather than
      // teaching the publisher to invent one.
      //
      // Narrow on purpose: only artifact_plan, only the no_media_slots predicate (a node skipped for
      // any other reason is not the publish id's author), and only when the run has no id already —
      // an operator-supplied one is never overwritten, and an artifact_plan that really ran still
      // outranks this via buildRunContext's precedence, which is untouched.
      if (nextNode.id === "artifact_plan" && verdict.predicate?.when === "no_media_slots" && !(typeof run.publishRequestId === "string" && run.publishRequestId.trim())) {
        const config = await repositoryManager.getProjectRepository().get(run.projectId).catch(() => undefined);
        const minted = mintPublishRequestId({ runId: run.runId, initialInput: run.initialInput, config });
        if (minted.ok) {
          run.publishRequestId = minted.requestId;
          state.warnings = [...(state.warnings ?? []), `publish_request_id_authored:${minted.requestId}`];
        } else {
          // No id rather than a wrong one: publish_request_id_absent remains the correct outcome for
          // a project whose declared pattern this cannot satisfy, and now it is visible here instead
          // of only at the very end of the run.
          state.warnings = [...(state.warnings ?? []), `publish_request_id_not_authored:${minted.reason}`];
        }
      }
      run.status = "running";
      run.updatedAt = completedAt;
      run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      return { run };
    }
  }

  state.status = "running";
  state.startedAt = startedAt;
  // W4 — the ledger of dependencies this run deliberately skipped, delivered in the dependant's own
  // input. Without it a skipped dependency is an unexplained hole: review_aggregator would see three
  // reviewer outputs where its prompt names four and could reasonably conclude one failed, wait for
  // it, or invent it. With it, absence arrives with the reason attached and is aggregatable.
  const skippedDependencies: SkippedDependencyEntry[] = nextNode.dependsOn
    .map((dependency) => ({ dependency, dependencyState: stateById(run).get(dependency) }))
    .filter((entry) => entry.dependencyState?.status === "skipped")
    .map((entry) => ({ nodeId: entry.dependency, reason: entry.dependencyState?.skip?.reason ?? "skipped by the conductor before dispatch", predicate: entry.dependencyState?.skip?.predicate as SkippedDependencyEntry["predicate"] }));
  // W-4: clientProjectId travels in EVERY node's input — client identity is run state, delivered by
  // the conductor, not something an editorial prompt may assume or a downstream node must reconstruct.
  state.input = { initialInput: nextNode.dependsOn.length ? undefined : run.initialInput, dependencies: Object.fromEntries(nextNode.dependsOn.map((dependency) => [dependency, run.stageOutputs[dependency]])), clientProjectId, ...(skippedDependencies.length ? { skippedDependencies } : {}) };
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
  // W6.3: read through the gating seed (nodeGatingSeed.ts) so brief_architect's prefetch — the
  // declaration that puts the client ceiling in the run BEFORE the brief is written — is honoured
  // whether it arrives from the node's own stored metadata or from the code seed.
  if (declaresContractPrefetch(nextNode)) {
    try {
      const prefetch = await getReducedContract({ runId: run.runId, projectId: run.projectId }, { projectRepository: repositoryManager.getProjectRepository(), workspaceRepository: options.workspaceRepository ?? repositoryManager.getWorkspaceRepository() });
      deterministicPrefetch = prefetch;
      state.input = { ...(state.input as Record<string, unknown>), ...(prefetch.ok ? { prefetchedContract: prefetch.reduced } : { prefetchError: prefetch.error }) };
      if (!prefetch.ok) state.warnings = [...(state.warnings ?? []), `contract_prefetch_failed:${prefetch.code ?? "unknown"}`];
      // T2: the ONE prefetch failure that is not a degradation. Every other cause leaves the node
      // able to do something useful with `prefetchError`; a refused credential leaves it able to
      // produce only expensive emptiness, and leaves every node after it the same way. Live runs
      // only — a mock run reaches no client and its placeholders are the point.
      if (!prefetch.ok && prefetch.authFailed && ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock") {
        const credential = await resolveProjectCredentialName(run.projectId, repositoryManager.getProjectRepository());
        const code = clientAuthFailedError(credential);
        return { run: failNodeOnClientAuth(run, state, nextNode.id, startedAt, code, `Project "${run.projectId}" refused this driver's credential with HTTP ${prefetch.httpStatus ?? "401/403"} while fetching its object contract, so ${nextNode.id} could not read the client and no node after it could either. The run is stopped here rather than continuing to produce artifacts nothing can publish. Sync ${credential} for this plane and retry the run. Underlying error: ${prefetch.error}`) };
      }
      const placementTarget = prefetch.ok ? readPlacementTarget(run.stageOutputs.placement_resolver) : undefined;
      if (prefetch.ok && placementTarget) {
        aggressionResolution = resolveAggressionVector(placementTarget, prefetch.reduced);
        if (aggressionResolution.ok) {
          // S3 item 3: the engine-owned resolution travels under BOTH names — `resolvedAggression`
          // (the carrier contract_intelligence's deterministic artifact already reads) and
          // `aggressionResolution` (the shape brief_architect's prompt names: resolved + the prose
          // basis + where the ceiling came from), so the model copies a value instead of inventing one.
          const engineBasis = `resolved = min(ceiling, target) componentwise; ceiling from this dispatch's contract prefetch, target from placement_resolver (this run).`;
          state.input = {
            ...(state.input as Record<string, unknown>),
            resolvedAggression: { resolved: aggressionResolution.resolved, ceiling: aggressionResolution.ceiling, target: aggressionResolution.target },
            aggressionResolution: { resolved: aggressionResolution.resolved, resolvedBasis: engineBasis, ceilingSource: "contract_prefetch" }
          };
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
  if (declaresVoicePrefetch(nextNode)) {
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

  // S3 item 8 — the content-item shell. On an object-substrate client the artifact bridge indexes
  // media against the owning object, so artifact_plan's generation must find a content_item under the
  // run's request id ALREADY THERE. One idempotent object_create here, right before artifact_plan
  // dispatches, recorded in its input as `contentItemShell` (the publisher later patches that object
  // instead of creating a second one). Best-effort: every failure is the named warning
  // `content_item_shell_failed:<code>` on this node — never a throw, never a failed node.
  if (nextNode.id === "artifact_plan" && (run.executionMode ?? DEFAULT_EXECUTION_MODE) !== "mock") {
    try {
      const shell = await ensureContentItemShell(
        { run, prefetchedContract: run.stageOutputs.contract_intelligence && typeof run.stageOutputs.contract_intelligence === "object" ? { clientObjectType: (run.stageOutputs.contract_intelligence as Record<string, unknown>).clientObjectType } : undefined },
        { projectRepository: repositoryManager.getProjectRepository() }
      );
      if (shell.ok) state.input = { ...(state.input as Record<string, unknown>), [CONTENT_ITEM_SHELL_INPUT_KEY]: shell.shell };
      else if (!shell.skipped) state.warnings = [...(state.warnings ?? []), `${CONTENT_ITEM_SHELL_FAILED_PREFIX}${shell.code}`];
    } catch (error) {
      state.warnings = [...(state.warnings ?? []), `${CONTENT_ITEM_SHELL_FAILED_PREFIX}threw:${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`];
    }
  }

  // W3 part 3 (determinism program, 2026-08-12): the run's client facts — clientProjectId,
  // clientObjectType, contractSource, requestId — assembled ONCE here and delivered to EVERY node,
  // in its input as `runContext` and (via the runners) as a compact block in its instructions.
  // Six nodes previously reconstructed these by echo: contract_intelligence, article_body,
  // artifact_plan, publish_payload and publish_executor name all three in prompt AND output schema,
  // and publication_controller reads contractSource in its prompt. Echo is a chance to differ; a run
  // fact delivered by the conductor is not. Sourced from THIS dispatch's prefetch when the node
  // declared one, otherwise from the deterministic contract_intelligence artifact (itself built from
  // that same prefetch) — never from an arbitrary node's retyping, and never invented: a fact the run
  // does not yet hold is simply absent. Schemas keep declaring these fields for now (removing them is
  // a re-seed topology change); what changes is that the ENGINE fills them, below.
  // W6.3 — the vectors the engine will clamp this node's `resolved` against, read from this
  // dispatch's own resolution first and from the run's earlier deterministic artifacts otherwise.
  const resolvedVectorSources = readResolvedVectorSources({
    resolution: aggressionResolution?.ok ? aggressionResolution : undefined,
    reducedCeiling: deterministicPrefetch?.ok ? deterministicPrefetch.reduced.aggressionCeiling : undefined,
    stageOutputs: run.stageOutputs
  });
  const runContext = buildRunContext({
    clientProjectId,
    reducedContract: deterministicPrefetch?.ok ? deterministicPrefetch.reduced : undefined,
    stageOutputs: run.stageOutputs,
    // T2 (run_1786557897658_elj34j) — the fix: echo the run's own operator publish decision into
    // every node's run context. Before this, only the executor's own pre-dispatch guard and
    // publisher.ts read run.operatorPublishDecision directly; a node's model dispatch had no way to
    // see it at all.
    operatorPublishDecision: run.operatorPublishDecision,
    operatorDecisionSource: run.operatorDecisionSource,
    // S3 (run_1787656120374_18bobg) — the operator's publish request id, supplied at
    // workflow.start_dry_run and stored on the run. buildRunContext uses it ONLY where artifact_plan
    // authored none, which on a late-stage entrypoint run is always: artifact_plan is seeded as
    // skipped and has no stage output. Passing it here is what makes such a run publishable at all,
    // and it reaches publish_payload and publish_executor through the same runContext.requestId
    // channel an authored id has always travelled on — so there is nothing seam-specific downstream.
    publishRequestId: run.publishRequestId,
    // W3 part 1's prompt-side half: the node whose validator loop the engine has taken over is told
    // so HERE, in the same dispatch that takes it over, instead of in a seeded prompt the live
    // (store-sourced) workspace would not see until a re-seed. W4 and W6.3 add their own halves on
    // the same channel and for the same reason: the code that changes the behaviour is the code that
    // states it, so prompt and behaviour cannot drift apart between re-seeds.
    enginePolicies: [
      ...(ownsValidationLoop(nextNode) ? [ENGINE_VALIDATION_POLICY] : []),
      ...(declaresResolvedVector(undefined, nextNode.outputSchema) ? [ENGINE_RESOLVED_VECTOR_POLICY] : []),
      ...(renderSkippedDependencyPolicy(skippedDependencies) ? [renderSkippedDependencyPolicy(skippedDependencies)!] : [])
    ]
  });
  state.input = { ...(state.input as Record<string, unknown>), runContext };

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

  // P0 §2.1/§2.2, rewired by T15.7 (ADR-2026-08-25-publish-autonomy §2.4, §5, §7) — the deterministic
  // publish refusals, evaluated BEFORE any dispatch so a refused publish-risk node never starts a
  // model turn (and therefore can never fire a client tool):
  //   1/2. authority (§2.4) — a publish-risk node needs resolvePublishAuthority(run).authorized: an
  //      operator's own explicit "approved" is sufficient in every mode; absent a decision, the run's
  //      OWN snapshotted autonomyMode decides ("autonomous" proceeds, "operator-gated" blocks); an
  //      explicit "withheld" always halts, ahead of everything else, in every mode. A caller-supplied
  //      `options.approved` flag no longer contributes to this decision (§7 — deprecated as an
  //      authority input everywhere, not only on workflow.publish_run): the run's own operator record
  //      and policy snapshot are the ONLY authority, so two calls against the same run state resolve
  //      identically regardless of what flag either caller happened to pass (invariant 7).
  //   3. controller decision (§2.1) — unchanged.
  const authority = isPublishRisk(nextNode) ? resolvePublishAuthority(run) : undefined;
  // operator_withheld is ALSO !authority.authorized, so this stays a NAMED subset of approvalMissing
  // below (both fire together on a veto, exactly as before) rather than a separate condition — the
  // veto is not a different authority question, it is authority's own row 1 (§2.4), given its own
  // warning because NON_APPROVAL_REFUSAL_WARNINGS (below) must keep telling a veto apart from a plain
  // "no decision yet" hold: only the latter is something a later approval can clear.
  const operatorVeto = authority !== undefined && !authority.authorized && authority.code === "operator_withheld";
  const approvalMissing = authority !== undefined && !authority.authorized;
  const liveRun = ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock";
  const controllerDecision = isPublishExecutorNode(nextNode) && liveRun
    ? readPublicationDecision(findPublicationDecision(run), { bodyFingerprint: articleBodyFingerprint(findArticleBodyEnvelope(run)) })
    : undefined;
  // A STALE decision is not a refusal — it is an out-of-date answer, and blocking the run on it is
  // what left run_1787919896283_yybhg0 unpublishable with a fully green checklist. The body changed
  // after the controller last spoke (an upstream node was fixed and re-run), so the honest move is to
  // ask it again: reset publication_controller to queued and let the very next dispatch decide on the
  // body that actually exists. This is self-clearing by construction — the re-decision is computed
  // from current readiness, so it either authorizes or refuses with reasons an operator can act on,
  // and it needs no surface to offer a "re-run this step" button that none of them has.
  const staleRequeueWarning = "decision_stale_requeued";
  if (controllerDecision && !controllerDecision.authorized && controllerDecision.stale) {
    const controllerState = run.nodes.find((node) => node.nodeId === PUBLICATION_CONTROLLER_NODE_ID);
    // BOUNDED TO ONCE PER RUN. A re-decision computes its fingerprint from the same body this gate
    // reads, so the second read matches — unless something upstream declines to record one at all, and
    // an unbounded rule would then requeue forever, burning the tick on a run that can never move.
    // Once is enough to clear the real case; a decision still stale afterwards blocks with the reason
    // named, which is a state an operator can see and act on.
    if (controllerState && !(controllerState.warnings ?? []).includes(staleRequeueWarning)) {
      const requeuedAt = now();
      controllerState.status = "queued";
      controllerState.output = undefined;
      controllerState.startedAt = undefined;
      controllerState.completedAt = undefined;
      controllerState.durationMs = undefined;
      controllerState.warnings = [...new Set([...(controllerState.warnings ?? []), staleRequeueWarning])];
      delete run.stageOutputs[PUBLICATION_CONTROLLER_NODE_ID];
      state.status = "queued";
      run.status = "running";
      run.updatedAt = requeuedAt;
      return { run, commit: async () => {} };
    }
  }
  const publishRefusals: string[] = [
    ...(approvalMissing ? [`${authority!.code}: ${authority!.reason}`] : []),
    ...(controllerDecision && !controllerDecision.authorized ? [`publication_decision_not_affirmative (${controllerDecision.code}): ${controllerDecision.reason}`] : [])
  ];
  if (publishRefusals.length) {
    const completedAt = now();
    state.status = "blocked";
    state.completedAt = completedAt;
    state.durationMs = duration(startedAt, completedAt);
    // T5: the node's OWN blocked output names the gate too, not only the run-level approvalsRequired
    // entry — an operator reading the node that stopped should not have to correlate it back to the
    // run record to learn what to address.
    state.output = { artifact: nextNode.produces[0] ?? `${nextNode.id}.decision`, dryRun: true, decision: "blocked", approvalRequired: approvalMissing, ...gateIdFields(run, nextNode.id), reason: publishRefusals.join(" ") };
    state.warnings = [
      ...(approvalMissing ? ["approval_required"] : []),
      ...(operatorVeto ? ["operator_publish_withheld"] : []),
      ...(controllerDecision && !controllerDecision.authorized ? ["publication_decision_not_affirmative"] : []),
      "no_publication_performed"
    ];
    run.status = "blocked";
    run.updatedAt = completedAt;
    if (approvalMissing) {
      run.approvalsRequired = [{ nodeId: nextNode.id, type: "approval_required", ...gateIdFields(run, nextNode.id), reason: authority!.reason, requestedAt: completedAt }];
    }
    run.stageOutputs[nextNode.id] = state.output;
    run.artifacts.push(buildArtifact(nextNode, state.output));
    return { run, commit: async () => { await recordDryRunNodeUsage(run, nextNode, state.input, state.output); } };
  }
  // ADR §5 — an autonomous publish must be exactly as visible as a gated one. The gate above just let
  // this node through on `policy_autonomous` authority (no human spoke), so it proceeds — but records a
  // NON-PENDING, ADVISORY approvalsRequired entry naming the authority that let it through, so the
  // attention feed and every publish-risk accounting reader sees this pass exactly as they would see a
  // gated approval. A stale entry for this node (from an earlier authority state) is replaced, never
  // duplicated; an operator's own explicit approval needs no such entry — it is already visible on
  // run.operatorPublishDecision itself, and duplicating it here would be noise, not visibility.
  if (authority?.authorized && authority.source === "policy_autonomous") {
    const advisedAt = now();
    run.approvalsRequired = [
      ...run.approvalsRequired.filter((approval) => approval.nodeId !== nextNode.id),
      {
        nodeId: nextNode.id,
        type: "approval_required",
        ...gateIdFields(run, nextNode.id),
        reason: `Publish-risk node ${nextNode.id} proceeded under this project's autonomous publishing policy (autonomyMode: "autonomous"); no operator acted. Advisory only — nothing is held.`,
        requestedAt: advisedAt,
        source: "policy_autonomous"
      }
    ];
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
  // T1: same precedence rule as publish_executor below — a composed workflow's OWN stage route wins
  // over the shared tail's DTC route. This is what the capture/clone compositions already try to say
  // by deleting the inherited flag at composition time, except that deletion is undone a moment later
  // by overlayStoreNode merging the STORE's publishing_conductor row for the same node id back on top.
  if (nextNode.metadata?.publishPayloadDeterministic === true && !declaresWorkflowStageRoute(nextNode) && ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock") {
    let built: Awaited<ReturnType<typeof runDeterministicPublishPayload>>;
    try {
      built = await runDeterministicPublishPayload({
        projectId: run.projectId,
        clientProjectId,
        articleBody: run.stageOutputs.article_body,
        artifactPlan: run.stageOutputs.artifact_plan,
        // W3 part 2: the publish request id travels as run context (engine-echoed), so this node no
        // longer depends on it being present in the exact upstream output it happens to read.
        requestId: runContext.requestId
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

  // W1 + W6.1 (determinism program, 2026-08-12): publication_controller reads a checklist and states a
  // decision — and the checklist is computed by the project's OWN readiness policy
  // (evaluatePublishReadiness, the function workflow.publish_readiness wraps), called here engine-side,
  // never over MCP. Opt-in per node (metadata.publicationControllerDeterministic), same dispatch
  // semantics as every deterministic path above: build, validate against the node's OWN outputSchema,
  // fall through to the model path on any failure with a run-visible warning naming it.
  //
  // W6.1 rides in the same block because it is the same decision: every upstream stage output's
  // blockers[] is collected in canonical node order and carried INTO the decision, so a "go" can never
  // be emitted while an unwaived blocker exists (the live defect on run_1786468126136_ev9goe was
  // exactly that: decision "go" alongside aggression_ceiling_missing and an EV-floor block). The one
  // exemption — own-property content is exempt from EV-floor and aggression-ceiling blockers by
  // standing operator rule — is AUDITED, not silent: every waived blocker is listed in the decision's
  // waivedBlockers[] with the rule that waived it and the node that raised it.
  //
  // Scoped to LIVE runs for the same reason the other publish-path deterministic routes are: a mock
  // run's article_body is a placeholder, so a readiness verdict over it is meaningless, and mock
  // traversal keeps working through MockNodeRunner unchanged. Placed AFTER the publish-refusal block
  // (this node is riskLevel "publish") because a deterministic path must never be the thing that
  // skips a gate.
  // T1: same precedence rule as publish_executor below — a composed workflow's OWN stage route wins
  // over the shared tail's DTC route. This is what the capture/clone compositions already try to say
  // by deleting the inherited flag at composition time, except that deletion is undone a moment later
  // by overlayStoreNode merging the STORE's publishing_conductor row for the same node id back on top.
  if (nextNode.metadata?.publicationControllerDeterministic === true && !declaresWorkflowStageRoute(nextNode) && ((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock") {
    let decided: Awaited<ReturnType<typeof runDeterministicPublicationController>>;
    try {
      decided = await runDeterministicPublicationController({
        projectId: run.projectId,
        clientProjectId,
        articleBody: run.stageOutputs.article_body,
        // Canonical node order, upstream of this node only: a decision never reads its own successors,
        // and ordering is part of determinism. "Upstream" is now ENFORCED as the transitive dependsOn
        // closure, not merely stated: on run_1786549907145_hf4wgb the old `!== nextNode.id` filter let
        // learning_recorder — a SUCCESSOR that fires early on gate-blocked runs — feed its echoed,
        // "node: "-prefixed copies of upstream blockers back into this decision, inflating 7 real
        // blockers to 19.
        stageOutputs: upstreamNodeIds(nextNode.id, nodes).map((nodeId) => ({ nodeId, output: run.stageOutputs[nodeId] })),
        // Most authoritative carrier first: the run's own initial input, then input_triage's echoed
        // envelope. The content class is an EXPLICIT run-level field (see publicationController.ts) —
        // a waiver that switches itself on from an inferred signal is a waiver nobody authorized.
        contentClassCarriers: [run.initialInput, run.stageOutputs.input_triage]
      });
    } catch (error) {
      decided = { ok: false, code: "threw", error: error instanceof Error ? error.message : String(error) };
    }
    const decisionValidation = decided.ok ? validateOutput(decided.decision, nextNode.outputSchema) : undefined;
    if (decided.ok && decisionValidation?.ok) {
      const completedAt = now();
      state.status = "completed";
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = decided.decision;
      run.stageOutputs[nextNode.id] = decided.decision;
      run.artifacts.push(buildArtifact(nextNode, decided.decision));
      run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
      run.updatedAt = completedAt;
      run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      // No model call happened, so no usage record is written (the R-20 rule: a $0 event stays $0).
      return { run };
    }
    const reason = decided.ok ? (decisionValidation && !decisionValidation.ok ? decisionValidation.errors[0] ?? "schema_invalid" : "schema_invalid") : decided.code;
    state.warnings = [...(state.warnings ?? []), `publication_controller_deterministic_unavailable:${reason}`];
  }

  // W2a (determinism program, 2026-08-12): the publish gate is two exact comparisons the engine
  // already owns (publishDecision.ts) — an explicit publication_controller decision:"go" AND
  // run.operatorPublishDecision === "approved" — and this is the ONE node that can mutate a live site,
  // so its refusal path is the last place a model turn belongs. Opt-in per node
  // (metadata.publishExecutorDeterministic).
  //
  // FAIL-CLOSED HALF ONLY, deliberately: when the gate does NOT pass, the blocked publish_execution.v1
  // record is emitted here with ZERO client calls (bit-for-bit the outcome verified live on
  // run_1786468126136_ev9goe, where the model spent a turn to reach the same refusal). When the gate
  // DOES pass, runDeterministicPublishExecutor returns {ok:false, gate_passed_execution_not_deterministic}
  // and execution falls through to the model path unchanged — engine-side publish EXECUTION would need
  // a release + go-live verification tail that publisher.ts structurally does not have (board decision
  // B2: publishRun never releases), and an "executed" claim without that evidence is downgraded to
  // "blocked" by enforcePublishExecutionEvidence anyway. That tail is its own change, not a rider on a
  // refusal path.
  //
  // T4 (Wave 2a, 2026-08-13) — the flag is now TRI-state and the EXECUTE half lands below: "gate"
  // (metadata.publishExecutorDeterministic === true) is the refusal-only behaviour described above,
  // unchanged; "execute" (=== "execute") additionally has the ENGINE perform the publish on a passing
  // gate, by calling publisher.ts publishRun directly. Absent/unrecognised is "off" — the model path,
  // exactly as before this landed. Scoped to LIVE runs and to the publisher node for the same reasons
  // the sibling routes are.
  // T1: a workflow-owned stage route (capture/clone) outranks the shared tail's inherited DTC route —
  // see declaresWorkflowStageRoute's header. Resolving to "off" here means BOTH halves of the flag
  // (the "gate" refusal half and the "execute" half) stand down for such a node, which is correct:
  // the workflow's own route below performs the same publish-authority read (resolvePublishAuthority)
  // and the executor's publish-risk gate has ALREADY refused the dispatch before either can run.
  const publishExecutorMode = isPublishExecutorNode(nextNode) && liveRun && !declaresWorkflowStageRoute(nextNode) ? readPublishExecutorDeterministicMode(nextNode.metadata) : "off";
  // Envelope facts taken verbatim from upstream, nearest-to-this-node first; never invented.
  const publishEnvelopeCarriers = [run.stageOutputs.publication_controller, run.stageOutputs.publish_payload, run.stageOutputs.article_body];

  // T4's execute half. The one deterministic route in this file with NO model fallback, deliberately:
  // once this path has entered publishRun's sequence a client object may already exist, and handing
  // that state to a model dispatch that cannot see what was written is how a run half-publishes twice
  // (run_1786557897658_elj34j's second failure was a model reading another run's publish state). Every
  // outcome therefore terminates here — a passing gate + committed publish COMPLETES the node with the
  // receipts, and anything else BLOCKS it with a typed blocker naming the failing step.
  if (publishExecutorMode === "execute") {
    let engine: Awaited<ReturnType<typeof runEnginePublishExecution>>;
    try {
      engine = await runEnginePublishExecution({
        run,
        clientProjectId,
        envelopeCarriers: publishEnvelopeCarriers,
        // W3 part 2's channel: the publish request id travels as run context (lifted once from
        // artifact_plan), with the upstream outputs as the fallback carriers. Never minted here.
        requestId: runContext.requestId,
        // The run store this dispatch is driving — publishRun re-reads the PERSISTED run to evaluate
        // its own gates, and must not read a different repository than the one the executor saved to.
        deps: { executionRepository: store, projectRepository: repositoryManager.getProjectRepository() }
      });
    } catch (error) {
      engine = { ok: false, code: "threw", error: error instanceof Error ? error.message : String(error) };
    }
    const engineValidation = engine.ok ? validateOutput(engine.output, nextNode.outputSchema) : undefined;
    if (engine.ok && engineValidation?.ok) {
      const completedAt = now();
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = engine.output;
      state.warnings = [...(state.warnings ?? []), ...engine.warnings];
      run.stageOutputs[nextNode.id] = engine.output;
      run.artifacts.push(buildArtifact(nextNode, engine.output));
      run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
      run.updatedAt = completedAt;
      if (engine.nodeBlocked) {
        // A failed sequence leaves the NODE blocked (and the run with it): the artifact records what
        // ran, and nothing downstream should proceed as if a publish had happened.
        state.status = "blocked";
        run.status = "blocked";
      } else {
        // Gate refusal or a committed publish: the node produced its artifact either way, and the
        // record's own status/publishCommitted fields say which.
        state.status = "completed";
        run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      }
      // No model call happened, so no usage record is written (the R-20 rule: a $0 event stays $0).
      return { run };
    }
    // Unusable result (no envelope to record against, or a store-overlaid schema that rejects the
    // engine's own record). Blocked, never dispatched: the sibling routes' "fall through to the model"
    // degradation is safe for a node that computes a value and unsafe for the one node that mutates a
    // live site.
    const completedAt = now();
    const invalid = engineValidation && !engineValidation.ok ? engineValidation.errors : undefined;
    const reason = engine.ok ? (invalid?.[0] ?? "schema_invalid") : engine.code;
    state.status = "blocked";
    state.completedAt = completedAt;
    state.durationMs = duration(startedAt, completedAt);
    state.warnings = [...(state.warnings ?? []), `publish_executor_engine_execution_unavailable:${reason}`];
    state.output = {
      error: {
        code: "publish_executor_engine_execution_unavailable",
        message: `The engine publish path could not produce a usable publish_execution.v1 record (${reason}); the node is blocked rather than handed to a model dispatch that cannot see what the sequence did.`,
        details: engine.ok ? { record: engine.output, issues: invalid ?? [] } : { code: engine.code, error: engine.error }
      }
    };
    run.status = "blocked";
    run.updatedAt = completedAt;
    return { run };
  }

  if (publishExecutorMode === "gate") {
    const executed = runDeterministicPublishExecutor({
      run,
      clientProjectId,
      envelopeCarriers: publishEnvelopeCarriers
    });
    const executionValidation = executed.ok ? validateOutput(executed.output, nextNode.outputSchema) : undefined;
    if (executed.ok && executionValidation?.ok) {
      const completedAt = now();
      // The node COMPLETED (it produced its artifact); the PUBLISH is what is blocked, and the record
      // says so in its own status field. This is exactly what the live run recorded, so learning_recorder
      // and every downstream reader see the same shape they saw then.
      state.status = "completed";
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = executed.output;
      state.warnings = [...(state.warnings ?? []), "no_publication_performed"];
      run.stageOutputs[nextNode.id] = executed.output;
      run.artifacts.push(buildArtifact(nextNode, executed.output));
      run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
      run.updatedAt = completedAt;
      run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      // No model call happened, so no usage record is written (the R-20 rule: a $0 event stays $0).
      return { run };
    }
    const reason = executed.ok ? (executionValidation && !executionValidation.ok ? executionValidation.errors[0] ?? "schema_invalid" : "schema_invalid") : executed.code;
    state.warnings = [...(state.warnings ?? []), `publish_executor_deterministic_unavailable:${reason}`];
  }

  // T15.6 (ADR-2026-08-25-publish-autonomy §4.3) — release_executor: DETERMINISTIC, no model turn,
  // idempotent keyed on (runId, requestId) via run.releaseLedger. Positioned after publish_executor,
  // before learning_recorder. Reads publish_executor's own record; calls release_to_production AT MOST
  // ONCE for this run; polls deploy_status once per dispatch (create-or-poll, the same idiom
  // captureStage's pdf-tool jobs use — never a wait loop inside one call); skips honestly when nothing
  // was published. Scoped to LIVE runs and to the releaser node, same reasons the sibling publish-path
  // routes are: a mock run has no client reach.
  if (isReleaserNode(nextNode) && liveRun && nextNode.metadata?.releaseExecutorDeterministic === true) {
    const projectConfig = await repositoryManager.getProjectRepository().get(run.projectId);
    const releaseCallTool = projectConfig ? (tool: string, args: Record<string, unknown>) => new ProjectMcpAdapter(projectConfig).callTool(tool, args) : undefined;
    let released: Awaited<ReturnType<typeof runDeterministicReleaseExecutor>>;
    try {
      released = await runDeterministicReleaseExecutor({
        run,
        requestId: runContext.requestId,
        deps: { callTool: releaseCallTool }
      });
    } catch (error) {
      released = { ok: false, code: "threw", error: error instanceof Error ? error.message : String(error) };
    }
    if (released.ok && released.kind === "pending") {
      // A release genuinely in flight: release_to_production already succeeded (or was already
      // ledgered), deploy_status is not yet "ready". Re-queue for one more poll on the next dispatch —
      // release_to_production is never reachable again for this key.
      run.releaseLedger = { ...(run.releaseLedger ?? {}), [released.ledgerKey]: released.ledgerEntry };
      state.status = "queued";
      delete state.startedAt;
      delete state.dispatch;
      state.warnings = [...(state.warnings ?? []), ...released.warnings];
      run.status = "running";
      run.currentNodeId = nextNode.id;
      run.updatedAt = now();
      return { run };
    }
    if (released.ok && released.kind === "completed") {
      // Same fail-closed evidence check publish_executor's model/engine outputs get (publishDecision.ts
      // enforcePublishExecutionEvidence): an "executed" claim without deployStatus "ready" AND
      // productionConfirmed true is downgraded to "blocked" before it is validated or persisted — this
      // module only ever produces a genuinely-evidenced "executed" claim itself, so this is defense in
      // depth, not the primary control.
      const enforced = enforcePublishExecutionEvidence(released.output, run);
      const output = enforced.output;
      const releaseValidation = validateOutput(output, nextNode.outputSchema);
      if (releaseValidation.ok) {
        const completedAt = now();
        state.status = "completed";
        state.completedAt = completedAt;
        state.durationMs = duration(startedAt, completedAt);
        state.output = output;
        state.warnings = [...(state.warnings ?? []), ...released.warnings, ...(enforced.downgraded ? ["executed_claim_downgraded_to_blocked", ...enforced.reasons.map((reason) => reason.split(":")[0])] : [])];
        run.stageOutputs[nextNode.id] = output;
        run.artifacts.push(buildArtifact(nextNode, output));
        run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
        // Only a TERMINAL outcome may be ledgered terminal. `ledger: "none"` is the recoverable case
        // (release_to_production never confirmed it landed) and must leave the ledger untouched so the
        // next dispatch can call it again; `ledger: "pending"` keeps release_to_production unreachable
        // while leaving deploy_status re-pollable. Writing every completed outcome terminal here is
        // what made a released-but-504'd run replay its own 504 forever (2026-08-29).
        if (released.ledger === "terminal") {
          run.releaseLedger = { ...(run.releaseLedger ?? {}), [released.ledgerKey]: { status: "terminal", requestId: released.ledgerEntry.requestId, performedAt: released.ledgerEntry.status === "terminal" ? released.ledgerEntry.performedAt : now(), output: output as Record<string, unknown> } };
        } else if (released.ledger === "pending") {
          run.releaseLedger = { ...(run.releaseLedger ?? {}), [released.ledgerKey]: released.ledgerEntry };
        }
        run.updatedAt = completedAt;
        run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
        // No model call happened, so no usage record is written (the R-20 rule: a $0 event stays $0).
        return { run };
      }
      state.warnings = [...(state.warnings ?? []), `release_executor_deterministic_unavailable:${releaseValidation.errors[0] ?? "schema_invalid"}`];
    } else if (!released.ok) {
      state.warnings = [...(state.warnings ?? []), `release_executor_deterministic_unavailable:${released.code}`];
    }
  }

  // W2b (determinism program, 2026-08-12): learning_recorder writes down what the run DID — which
  // nodes ran, which were blocked, what the gates decided, what it cost. Every one of those is a
  // structured fact on the run record or the usage ledger, so the record is TEMPLATED (learningRecord.ts),
  // with no model call and no free-text generation at all. Opt-in per node
  // (metadata.learningRecorderDeterministic). Unlike the publish-path routes this one is NOT scoped to
  // live runs: it reads run facts rather than client state, so a mock run gets an equally true record.
  if (nextNode.metadata?.learningRecorderDeterministic === true) {
    let usage: Awaited<ReturnType<typeof summarizeModelUsage>> | undefined;
    let usageError: string | undefined;
    try {
      usage = await summarizeModelUsage({ runId: run.runId });
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
    }
    const observations = buildLearningObservations({ run, usage, usageError });
    const observationsValidation = validateOutput(observations, nextNode.outputSchema);
    if (observationsValidation.ok) {
      const completedAt = now();
      state.status = "completed";
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = observations;
      run.stageOutputs[nextNode.id] = observations;
      run.artifacts.push(buildArtifact(nextNode, observations));
      run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
      run.updatedAt = completedAt;
      run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
      // No model call happened, so no usage record is written (the R-20 rule: a $0 event stays $0).
      return { run };
    }
    state.warnings = [...(state.warnings ?? []), `learning_recorder_deterministic_unavailable:${observationsValidation.errors[0] ?? "schema_invalid"}`];
  }

  // T14.4 — DISPATCH CLAIM FOR THE LONG DETERMINISTIC STAGES.
  //
  // The model path's claim (further down, "the ~300s silent-death fix") sits AFTER the two branches
  // below, so it never protected them. A capture/clone stage is deterministic but not quick, and while
  // it runs the record shows the node "running" with NO dispatch — which assessRunStall reads as an
  // idle driver, so runContinuation re-enters the SAME node while the first pass is still in flight.
  // The two passes then collide on the TARGET's locks: pass A holds an object_checkout lease, pass B
  // asks for the same object and gets HTTP 423, surfacing as capture_emission_refused while pass A
  // quietly finishes its writes. That is exactly run_1787655233171_y4w8z5 — capture_emit_live recorded
  // "blocked ... 423" at 10:57:27, and zilberman's four pages carry updated_at 10:58:18-10:58:46, from
  // the pass that was still running after the run had been declared blocked.
  //
  // So the claim is stamped BEFORE the stage runs, for exactly the stages that reach the network.
  // state.status/startedAt are already "running" by this point, which is what assessRunStall matches
  // on together with the dispatch stamp. Every terminal path out of both branches deletes it again
  // (the capture "pending" re-queue already did), so no branch can leave a lease-shaped ghost behind.
  if (claim && (readCaptureStage(nextNode) !== undefined || readCloneStage(nextNode) !== undefined)) {
    stampDispatch(state, startedAt, deterministicStageTimeoutMs(nextNode), options.driver ?? "http_run_all", await projectEndpointConfiguredFor(run.projectId));
    run = await store.saveRun(run);
    state = stateById(run).get(nextNode.id) as NodeExecutionState;
  }

  // T12.9 — the capture_conductor deterministic stages (metadata.captureStageDeterministic; R-C3 v2:
  // build in code, validate against the node's OWN outputSchema, complete with no model call — the
  // R-20 $0 rule applies, so no usage record is written on the deterministic path). Three outcomes:
  //   completed — the ordinary deterministic completion the sibling routes above use.
  //   pending   — capture_crawl's pdf-tool job (T12.8) is not terminal. The node is RE-QUEUED with
  //               its job bookkeeping persisted in stageOutputs, so completion is awaited by the
  //               LONG-RUN PLANES (the conductor job's advance loop / the run-continuation tick)
  //               re-driving this node until a poll is terminal — one create-or-poll per dispatch,
  //               never a wait loop inside one 30s project-call window.
  //   refused   — typed refusal. A LIVE run BLOCKS (a model must never fabricate a crawl, mapping,
  //               theme, emission, or score — the placement_resolver "no model fallback" precedent);
  //               a MOCK run falls through to MockNodeRunner with a run-visible warning so CI graph
  //               traversal keeps working. Both carry the refusal code as a run-visible warning.
  const captureStage = readCaptureStage(nextNode);
  if (captureStage) {
    const staged = await runCaptureStage({ run, node: nextNode, stage: captureStage });
    if (staged.kind === "pending") {
      const pendingAt = now();
      state.status = "queued";
      delete state.startedAt;
      delete state.dispatch;
      state.warnings = [...(state.warnings ?? []), staged.warning];
      run.stageOutputs[staged.jobStateKey] = staged.jobState;
      run.status = "running";
      run.currentNodeId = nextNode.id;
      run.updatedAt = pendingAt;
      return { run };
    }
    let refusal: { code: string; message: string } | undefined;
    if (staged.kind === "completed") {
      const stagedValidation = validateOutput(staged.output, nextNode.outputSchema);
      if (stagedValidation.ok) {
        const completedAt = now();
        state.status = "completed";
        delete state.dispatch;  // T14.4: terminal — the claim this stage published goes with it.
        state.completedAt = completedAt;
        state.durationMs = duration(startedAt, completedAt);
        state.output = staged.output;
        run.stageOutputs[nextNode.id] = staged.output;
        run.artifacts.push(buildArtifact(nextNode, staged.output));
        run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
        run.updatedAt = completedAt;
        run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
        // No model call happened, so no usage record is written (the R-20 rule).
        return { run };
      }
      refusal = { code: "output_schema_invalid", message: `capture stage "${captureStage}" produced an envelope its own node schema rejects: ${stagedValidation.errors[0] ?? "schema_invalid"}` };
    } else {
      refusal = { code: staged.code, message: staged.message };
    }
    state.warnings = [...(state.warnings ?? []), `capture_stage_deterministic_unavailable:${refusal.code}`];
    if (((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock") {
      const completedAt = now();
      state.status = "blocked";
      delete state.dispatch;  // T14.4: terminal — the claim this stage published goes with it.
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = { error: { code: refusal.code, message: refusal.message } };
      run.status = "blocked";
      run.currentNodeId = nextNode.id;
      run.updatedAt = completedAt;
      return { run };
    }
    // Mock run: fall through to the MockNodeRunner placeholder below so CI traversal keeps working.
  }

  // T13.1 — the clone_conductor deterministic stages (metadata.cloneStageDeterministic;
  // cloneConductorRoutes.ts). Same R-C3 v2 shape as the capture block just above, minus a "pending"
  // outcome — clone never polls an external job plane, so only "completed" and "refused" exist.
  //   completed — the ordinary deterministic completion the sibling routes above use.
  //   refused   — typed refusal. A LIVE run BLOCKS (a model must never fabricate a mint, a theme
  //               apply, or a restamp); a MOCK run falls through to MockNodeRunner with a run-visible
  //               warning so CI graph traversal keeps working.
  const cloneStage = readCloneStage(nextNode);
  if (cloneStage) {
    const staged = await runCloneStage({ run, node: nextNode, stage: cloneStage });
    let refusal: { code: string; message: string } | undefined;
    if (staged.kind === "completed") {
      const stagedValidation = validateOutput(staged.output, nextNode.outputSchema);
      if (stagedValidation.ok) {
        const completedAt = now();
        state.status = "completed";
        delete state.dispatch;  // T14.4: terminal — the claim this stage published goes with it.
        state.completedAt = completedAt;
        state.durationMs = duration(startedAt, completedAt);
        state.output = staged.output;
        run.stageOutputs[nextNode.id] = staged.output;
        run.artifacts.push(buildArtifact(nextNode, staged.output));
        run.errors = run.errors.filter((entry) => !entry.startsWith(`${nextNode.id}:`));
        run.updatedAt = completedAt;
        run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
        // No model call happened, so no usage record is written (the R-20 rule).
        return { run };
      }
      refusal = { code: "output_schema_invalid", message: `clone stage "${cloneStage}" produced an envelope its own node schema rejects: ${stagedValidation.errors[0] ?? "schema_invalid"}` };
    } else {
      refusal = { code: staged.code, message: staged.message };
    }
    state.warnings = [...(state.warnings ?? []), `clone_stage_deterministic_unavailable:${refusal.code}`];
    if (((run.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode) !== "mock") {
      const completedAt = now();
      state.status = "blocked";
      delete state.dispatch;  // T14.4: terminal — the claim this stage published goes with it.
      state.completedAt = completedAt;
      state.durationMs = duration(startedAt, completedAt);
      state.output = { error: { code: refusal.code, message: refusal.message } };
      run.status = "blocked";
      run.currentNodeId = nextNode.id;
      run.updatedAt = completedAt;
      return { run };
    }
    // Mock run: fall through to the MockNodeRunner placeholder below so CI traversal keeps working.
  }

  // T1 — AUTHENTICATED PREFLIGHT, IMMEDIATELY BEFORE THE FIRST PAID DISPATCH.
  //
  // Everything above this line is free: deterministic stages, skip predicates, prefetches. Everything
  // below it costs money. This is therefore the one place where "can this driver actually read the
  // client?" can be asked with a definite answer and nothing yet spent — and it is placed in the
  // executor rather than in each driver's own entry so all four planes (run_all, retry, continuation
  // tick, Cloud Run conductor job) are gated by one check instead of three-and-a-half.
  //
  // The endpoint-only preflight the background drivers already run cannot answer it: an endpoint that
  // resolves plus a token that is stale, absent, or unreadable by THIS plane looks identical to a
  // healthy driver until the first client call, several paid nodes later. That is precisely how three
  // runs each burned ~$1.45 producing artifacts no one could publish.
  //
  // Refusal is a FAILED run naming the credential — not a warning, not a degraded continue. A wrong
  // credential does not heal on the next tick, and a run that continues past it can only manufacture
  // expensive emptiness. Non-credential failures (unreachable, slow, policy-blocked) are explicitly
  // NOT refused here; see preflightDriverAuth.
  if (claim) {
    const authPreflight = await preflightDriverAuth(run, repositoryManager.getProjectRepository());
    if (!authPreflight.ok) {
      const completedAt = now();
      state.status = "failed";
      state.startedAt = state.startedAt ?? startedAt;
      state.completedAt = completedAt;
      state.durationMs = duration(state.startedAt ?? startedAt, completedAt);
      state.errors = [authPreflight.error, authPreflight.detail];
      state.output = { error: { code: authPreflight.error, message: authPreflight.detail } };
      delete state.dispatch;
      run.status = "failed";
      run.currentNodeId = nextNode.id;
      run.errors = [...run.errors, `${nextNode.id}:${authPreflight.error}`];
      run.updatedAt = completedAt;
      // No usage record: no model call happened, so the R-20 $0 rule applies.
      return { run };
    }
  }

  // Dispatch claim (the ~300s silent-death fix): persist "this node is in flight, with this timeout"
  // BEFORE the model loop starts, so the run record can distinguish a live execution from a dead
  // driver at any moment (assessRunStall) and a successor advance can reclaim a stale claim instead
  // of the run sticking at status "running" forever. Skipped for the best-effort termination
  // observation path (claim=false), which restores run status itself and must not publish interim
  // state. A CAS conflict here propagates to advanceRun's retry loop like any other save conflict.
  if (claim) {
    stampDispatch(state, startedAt, nodeTimeoutMs(nextNode), options.driver ?? "http_run_all", await projectEndpointConfiguredFor(run.projectId));
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
    // Provider-error-details: providerStatus/providerMessage/operatorAction ride along on the
    // persisted error so every reader of this node's output (workflow_get_run, node_get_latest_output,
    // planRun's failure reason) sees WHY a provider call failed, not just that it did. Absent on any
    // runner result that never set them (undefined keys serialize away, matching the pre-existing shape).
    state.output = { error: { code: result.code, message: result.message, details: result.details, providerStatus: result.providerStatus, providerMessage: result.providerMessage, operatorAction: result.operatorAction } };
    run.status = state.status;
    run.errors = [...run.errors, `${nextNode.id}:${result.code}`];
    run.updatedAt = completedAt;
    return { run };
  }
  let output = result.output;

  // W3 part 1 (determinism program, 2026-08-12) — the ENGINE-owned validate→fix→revalidate loop for
  // article_body, seamed HERE: after the node's own agent loop has returned an envelope and before
  // anything (R-16, the artifact ledger, a downstream node) can read it.
  //
  // This seam is the point of the workstream. article_body's model previously ran this loop INSIDE its
  // own agent loop, where each validator call spends a tool call: on run_1786468126136_ev9goe it
  // exhausted toolCallLimit:3 mid-validation and deferred with
  // `final_revalidation_not_completed_tool_call_limit_exceeded`, so the verdict downstream needed was
  // never earned and publish_payload paid 5× to earn it again. Running the loop out here means the
  // validator calls are conductor calls (like contractPrefetch's), the ONE permitted revision turn is
  // a fresh runner dispatch with its own full tool budget rather than a turn stolen from the node's,
  // and the verdict is recorded structurally for publish_payload to reuse (readRecordedValidation).
  //
  // Scoped to the node that declares it produces the client object (ownsValidationLoop — metadata
  // `articleBodyValidationLoop` remains an explicit override either way) and to LIVE runs only, for
  // the same reason every other deterministic path scopes itself: MockNodeRunner calls no tools and a
  // mock body is a placeholder, so validating it would be a real network call for a meaningless
  // verdict. Keyed on the node's own declared product rather than on a seed-only flag because the
  // live workspace is store-sourced: a flag added to nodes.ts alone would leave the defect running in
  // production until the next re-seed, which is precisely how long this defect has already lasted.
  // Wholly best-effort — any failure leaves `output` exactly as the model produced it, with a
  // run-visible warning, so this can cost the old price but never a run.
  // T3 — THE CLAIM WINDOW. The dispatch claim above was stamped ONCE, with nodeTimeoutMs, BEFORE the
  // model loop. Everything below runs AFTER the model returned but INSIDE that same claim: up to
  // three validator calls at 15s each plus one full second model dispatch of up to nodeTimeoutMs. On
  // article_body that is ~645s of legitimate work under a claim that goes stale at
  // nodeTimeoutMs + STALL_MARGIN_MS (390s), so the 60s continuation tick read a live node as a dead
  // driver and RE-DISPATCHED it — the same double-dispatch loop already documented for
  // gap_adjudicator. Extending the initial claim to cover the worst case would instead hide a
  // genuinely dead driver for eleven minutes; re-stamping PER PHASE keeps stall detection honest at
  // the granularity of the work actually in flight, which is why it is the shape chosen here.
  const reclaimForPhase = async (timeoutMs: number): Promise<void> => {
    if (!claim) return;
    try {
      stampDispatch(state, now(), timeoutMs, options.driver ?? "http_run_all", state.dispatch?.projectEndpointConfigured ?? false);
      run = await store.saveRun(run);
      state = stateById(run).get(nextNode.id) as NodeExecutionState;
    } catch (error) {
      // A save conflict here means another driver already moved this run. The phase's own result is
      // still worth having, so it proceeds under the previous claim and the failure is named rather
      // than silently widening or silently losing the window.
      state.warnings = [...(state.warnings ?? []), `article_body_claim_reclaim_failed:${error instanceof Error ? error.message : String(error)}`];
    }
  };

  if (ownsValidationLoop(nextNode) && mode !== "mock" && readBodyForValidation(output)) {
    await reclaimForPhase(ARTICLE_BODY_VALIDATION_PHASE_TIMEOUT_MS);
    try {
      const loop = await runArticleBodyValidationLoop(output as Record<string, unknown>, {
        // objectType threaded from the envelope the model just emitted (its schema requires
        // clientObjectType): the client's validate request schema REQUIRES object_type, and omitting
        // it was the run_1786549907145_hf4wgb regression — every loop validation 400'd on the request
        // shape before the body was judged.
        validate: (body) => validateClientObjectOnce({ projectId: run.projectId, body, objectId: readTopLevelObjectId(body), objectType: typeof (output as Record<string, unknown>).clientObjectType === "string" ? ((output as Record<string, unknown>).clientObjectType as string) : undefined }, { projectRepository: repositoryManager.getProjectRepository() }),
        // ONE bounded revision turn, engine-driven: the model is handed the client's own errors and
        // its own previous envelope and asked for a corrected one. A fresh dispatch, so the node's
        // toolCallLimit is not what runs out; the runner records its own usage, so the turn is paid
        // for visibly rather than hidden inside another node's bill.
        revise: async ({ issues, output: previous, attempt }) => {
          // A revision is a FULL second model dispatch — the phase claim must widen back out to a
          // model timeout for its duration, or the continuation tick reclaims mid-dispatch exactly
          // as it did before this fix.
          await reclaimForPhase(nodeTimeoutMs(nextNode));
          const revision = await runner.run({
            node: effectiveNode,
            input: {
              ...(state.input as Record<string, unknown>),
              validationFeedback: {
                source: "client_object_validate",
                attempt,
                issues,
                previousOutput: previous,
                instruction: "The client's own validator REJECTED the body you emitted, for the issues listed here. Emit the SAME output envelope again with only the changes those issues require: fix the rejected fields, change nothing else, invent no new content, and do not call the validator yourself — the engine validates for you and will report the result."
              }
            }
          }, { run, executionRepository: store, workspaceRepository: options.workspaceRepository });
          if (revision.toolCalls?.length) state.toolCalls = [...(state.toolCalls ?? []), ...revision.toolCalls];
          return revision.ok ? { ok: true as const, output: revision.output } : { ok: false as const, code: revision.code, message: revision.message };
        }
      });
      if (loop) {
        output = loop.output;
        if (loop.warnings.length) state.warnings = [...(state.warnings ?? []), ...loop.warnings];
        // T2: the client refused this driver's credential rather than the body. Promoting that to a
        // blocker (below) would leave the node `completed` carrying an unjudged body — the precise
        // shape that made the doomed runs look successful. Nothing downstream can validate, patch or
        // publish against a client that will not authenticate us, so the run stops here instead.
        if (loop.authFailure) {
          const credential = await resolveProjectCredentialName(run.projectId, repositoryManager.getProjectRepository());
          const code = clientAuthFailedError(credential);
          return { run: failNodeOnClientAuth(run, state, nextNode.id, startedAt, code, `Project "${run.projectId}" refused this driver's credential with HTTP ${loop.authFailure.httpStatus ?? "401/403"} when ${nextNode.id} asked it to validate the body, so the body was never judged and nothing downstream could publish it. The run is stopped rather than completing with an unjudged artifact. Sync ${credential} for this plane and retry the run. Underlying error: ${loop.authFailure.error}`) };
        }
        // S3 item 9: "the client's validator could not be reached / refused the request" is not a
        // warning a publish gate may read past — it is a BLOCKER on article_body's own output, which
        // readiness (article_body_blockers) then refuses. Warning stays for the run log; the blocker is
        // what stops an unjudged body from being published as if it had been judged.
        output = promoteValidationUnavailableToBlocker(output, loop.warnings);
      }
    } catch (error) {
      state.warnings = [...(state.warnings ?? []), `article_body_validation_loop_failed:${error instanceof Error ? error.message : String(error)}`];
    }
  }

  // W3 part 3 — engine echo of the run's client facts onto this node's output, where the node's OWN
  // schema declares them. The five nodes whose schemas name clientProjectId/clientObjectType/
  // contractSource no longer depend on a model retyping values the conductor already holds exactly; a
  // model that emitted something DIFFERENT is overwritten and the disagreement is named as a run-level
  // warning, because a retyped envelope diverging from the fetched contract is precisely the class of
  // defect this replaces. Never fabricates: a fact the run does not hold is left as the model left it,
  // so a schema that requires it still fails R-16 below rather than passing on an invented value.
  if (mode !== "mock") {
    const echoed = applyRunContextEnvelope(output, runContext, nextNode.outputSchema);
    output = echoed.output;
    if (echoed.corrected.length) state.warnings = [...(state.warnings ?? []), `run_context_envelope_corrected:${echoed.corrected.join(",")}`];
  }

  // W6 item 3 — the RESOLVED aggression vector is engine-computed, never model-emitted.
  //
  // Same seam, same reason as the envelope echo above: `resolved = min(ceiling, target)` is
  // arithmetic the engine owns, and the live run proved what asking a model for it costs — the
  // contract prefetch runs after brief_architect, so the brief's required `resolved` was filled from
  // the only vector in sight (the unclamped target) and the ceiling blocker surfaced after the draft
  // was already written against it. Whatever the model emitted is overwritten with the computed
  // vector and `resolvedBasis` is rewritten to state what it was computed from; a disagreement is
  // named as a run warning, and a run with no ceiling to clamp against is warned about LOUDLY rather
  // than passing quietly (resolvedVectorClamp.ts explains why the value is left alone in that case).
  if (mode !== "mock" && declaresResolvedVector(output, nextNode.outputSchema)) {
    const emittedResolved = readEmittedResolvedVector(output);
    const modelLeftItBlank = emittedResolved === undefined || AGGRESSION_DIALS.every((dial) => emittedResolved[dial] === 0);
    const clamp = applyResolvedVectorClamp(output, resolvedVectorSources, nextNode.outputSchema);
    output = clamp.output;
    if (clamp.warnings.length) state.warnings = [...(state.warnings ?? []), ...clamp.warnings];
    if (clamp.clampedDials.length) state.warnings = [...(state.warnings ?? []), `resolved_vector_clamped:${clamp.clampedDials.join(",")}`];
    // S3 item 3: a model that emitted no `resolved` (or an all-zero placeholder) never gets to ship
    // that. With a ceiling the clamp above already wrote the engine value; without one the engine
    // still owns the field and writes the placement TARGET (the only vector the run holds), naming
    // the takeover so the run shows the model did not resolve it. Wolf's ruling stands: no ceiling is
    // still a blocker upstream (aggression_ceiling_missing) — this only stops an empty carrier from
    // reaching draft_writer.
    if (modelLeftItBlank) {
      const engineValue = clamp.resolved ?? resolvedVectorSources.target;
      if (engineValue) {
        if (!clamp.resolved) {
          output = { ...(output as Record<string, unknown>), resolved: engineValue, resolvedBasis: `engine-owned: no client ceiling was available in this run, so resolved = placement target (${resolvedVectorSources.targetSource ?? "placement_resolver"}) unclamped; the model emitted ${emittedResolved ? "an all-zero" : "no"} vector.` };
        }
        state.warnings = [...(state.warnings ?? []), "resolved_vector_engine_owned"];
      }
    }
  }

  // P0 §2.3/§2.27 — an "executed" claim from a publisher-kind node must carry go-live evidence
  // (verification.deployStatus === "ready" AND verification.productionConfirmed === true, plus a
  // result) and an approvalMatched that matches the operator's durable publish decision
  // (run.operatorPublishDecision === "approved"). The node's outputSchema enforces the same shape
  // structurally (if/then on status), but schemas are store-overlayable — this deterministic check
  // holds even when the schema was edited: an unevidenced claim is DOWNGRADED to status "blocked"
  // with the missing evidence recorded in blockers, before validation and before anything downstream
  // can read it as a confirmed go-live.
  if (isPublishExecutorNode(nextNode) || isReleaserNode(nextNode)) {
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
  const provenance = buildNodeExecutionProvenance(effectiveNode, result.model, completedAt);
  if (provenance) state.provenance = provenance;
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
// T2 — this call is, BY DEFINITION, the operator's own explicit act (it is the ONE thing a human or
// an MCP caller invokes on purpose), so it always stamps operatorDecisionSource "explicit" — even
// when it is overwriting a project-policy-default "approved" set at run creation. That overwrite is
// exactly how "withheld" always wins over a policy default: this is the only path that can ever set
// "withheld", and it always does so explicitly.
export async function setOperatorPublishDecision(runId: string, decision: "approved" | "withheld", store: ExecutionRepository = repositoryManager.getExecutionRepository()): Promise<WorkflowExecutionRecord | undefined> {
  return withRunLock(runId, async () => {
    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      const run = await store.getRun(runId);
      if (!run) return undefined;
      try {
        return await store.saveRun({ ...run, operatorPublishDecision: decision, operatorDecisionSource: "explicit", updatedAt: now() });
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
    // T3: an operator retries a node to make a DIFFERENT attempt happen — most often after fixing
    // the very thing the node tripped over (a rotated client token, a restored endpoint, a project
    // policy). Run-scoped memoization is per (runId, key) and would otherwise hand the retry the
    // same stored read the first attempt used, making the control silently inert. Dropped here
    // rather than in the MCP tool so every driver that retries — the HTTP tool, the Cloud Run
    // conductor job's gate-clearing retry — gets the same do-over.
    conductorCache.invalidateRun(runId);
    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      const run = await store.getRun(runId);
      if (!run) return undefined;
      const node = run.nodes.find((candidate) => !nodeId || candidate.nodeId === nodeId);
      if (!node) return run;
      // W4: retrying a SKIPPED node is the operator overriding the gate — "run this one". Without the
      // durable override the next advance would re-evaluate the same predicate against the same facts
      // and skip it again, so the retry control would silently do nothing. The skip record is cleared
      // (the node is about to have a real execution record) but the override survives it.
      if (node.status === "skipped") node.skipOverride = true;
      delete node.skip;
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
export const __test__ = { buildInitialRun, findNextRunnableNode, findRunnableNodes, mockOutputForNode, nodeById, isPublishRisk, nodeSource, overlayStoreNode, resolveConductorNodes, selectConcurrentBatch };
