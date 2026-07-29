import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import type { ExecutionArtifact, ExecutionStatus, NodeExecutionState, WorkflowEntrypoint, WorkflowExecutionRecord } from "./executionTypes.js";
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
// Statuses from which advanceRun will not proceed. "paused" (R-18) joins them: an operator-paused run
// must stay put for exactly the same reason a blocked one does. Before "paused" existed, pause_run wrote
// "blocked" — which worked only because "blocked" was already in this set, and cost the ability to tell
// an operator pause apart from a publish hold.
const TERMINAL_STATUSES = new Set<ExecutionStatus>(["blocked", "cancelled", "completed", "failed", "paused"]);
const MAX_SAVE_RETRIES = 5;
const now = () => new Date().toISOString();
const makeRunId = () => `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const duration = (startedAt?: string, endedAt = now()) => startedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
const modelForDryRun = () => process.env.OPENAI_AGENT_MODEL?.trim() || "gpt-5.5";
const deterministicTokenCount = (value: unknown, minimum: number) => Math.max(minimum, Math.ceil(JSON.stringify(value ?? "").length / 4));

const recordDryRunNodeUsage = async (run: WorkflowExecutionRecord, node: WorkspaceNode, input: unknown, output: unknown) => recordModelUsage({
  runId: run.runId,
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
export async function resolveConductorNodes(workspaceRepository?: WorkspaceRepository): Promise<WorkspaceNode[]> {
  const canonical = listWorkspaceNodes();
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

const buildInitialRun = (data: StartDryRunInput, nodes: WorkspaceNode[], runId = makeRunId()): WorkflowExecutionRecord => {
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

export async function startDryRun(data: StartDryRunInput, store: ExecutionRepository = repositoryManager.getExecutionRepository(), workspaceRepository?: WorkspaceRepository): Promise<WorkflowExecutionRecord> {
  return store.createRun(buildInitialRun(data, await resolveConductorNodes(workspaceRepository)));
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
    const nodes = await resolveConductorNodes();
    return store.resetRun(runId, buildInitialRun({ projectId: existing.projectId, input: existing.initialInput, workflowId: existing.workflowId, executionMode: existing.executionMode, entrypoint: existing.entrypoint, budgetUsd: existing.budgetUsd }, nodes, runId));
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

async function recordTerminationObservations(run: WorkflowExecutionRecord, nodes: WorkspaceNode[], store: ExecutionRepository, options: RunAdvanceOptions): Promise<WorkflowExecutionRecord> {
  const node = nodes.find(isLearningRecorder);
  if (!node) return run;
  const state = stateById(run).get(node.id);
  // Fire at most once per run: either it already ran the ordinary way (an approved run reaching it
  // through the DAG), or this hook already fired on an earlier terminal transition in this same run.
  if (!state || state.status !== "queued") return run;
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
    if (TERMINAL_STATUSES.has(run.status)) return run;

    const nodes = await resolveConductorNodes(options.workspaceRepository);
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
      // Budget gate (F2): before dispatching the next node, halt the run if its accrued
      // (actual+estimated) model cost has reached the configured per-run ceiling. The pending node
      // stays queued — never partially charged — so raising budgetUsd and resuming continues here.
      // Default OFF: with no budgetUsd configured the gate is skipped entirely (no extra read).
      if (run.budgetUsd !== undefined) {
        const usage = await summarizeModelUsage({ runId });
        const budget = evaluateRunBudget(run.budgetUsd, usage.totalCostUsdEstimate);
        if (budget?.overBudget) {
          const blockedAt = now();
          const blocked = await store.saveRun({
            ...run,
            status: "blocked",
            currentNodeId: nextNode.id,
            updatedAt: blockedAt,
            budgetBlock: {
              blockedAt,
              budgetUsd: budget.budgetUsd,
              spentUsdEstimate: budget.spentUsdEstimate,
              nextNodeId: nextNode.id,
              reason: `Run paused for budget: estimated spend $${budget.spentUsdEstimate} reached the configured ceiling $${budget.budgetUsd}; node ${nextNode.id} was not executed. Raise budgetUsd and resume to continue.`
            }
          });
          return await recordTerminationObservations(blocked, nodes, store, options);
        }
      }
      const prepared = await executeRunnableNode(run, nextNode, nodes, store, options);
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

async function executeRunnableNode(run: WorkflowExecutionRecord, nextNode: WorkspaceNode, nodes: WorkspaceNode[], store: ExecutionRepository, options: RunAdvanceOptions): Promise<PreparedNode> {
  const state = stateById(run).get(nextNode.id) as NodeExecutionState;
  const startedAt = now();
  state.status = "running";
  state.startedAt = startedAt;
  state.input = { initialInput: nextNode.dependsOn.length ? undefined : run.initialInput, dependencies: Object.fromEntries(nextNode.dependsOn.map((dependency) => [dependency, run.stageOutputs[dependency]])) };
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
  if (nextNode.metadata?.contractPrefetch === true) {
    try {
      const prefetch = await getReducedContract({ runId: run.runId, projectId: run.projectId }, { projectRepository: repositoryManager.getProjectRepository() });
      state.input = { ...(state.input as Record<string, unknown>), ...(prefetch.ok ? { prefetchedContract: prefetch.reduced } : { prefetchError: prefetch.error }) };
    } catch (error) {
      state.input = { ...(state.input as Record<string, unknown>), prefetchError: error instanceof Error ? error.message : String(error) };
    }
  }

  if (isPublishRisk(nextNode) && options.approved !== true) {
    const completedAt = now();
    state.status = "blocked";
    state.completedAt = completedAt;
    state.durationMs = duration(startedAt, completedAt);
    state.output = { artifact: nextNode.produces[0] ?? `${nextNode.id}.decision`, dryRun: true, decision: "blocked", approvalRequired: true, reason: `Dry-run stopped before publish-risk node ${nextNode.id}; explicit approval is required before any publishing side effect.` };
    state.warnings = ["approval_required", "no_publication_performed"];
    run.status = "blocked";
    run.updatedAt = completedAt;
    run.approvalsRequired = [{ nodeId: nextNode.id, type: "approval_required", reason: `Publish-risk node ${nextNode.id} requires explicit approval; dry-run blocked before publishing.`, requestedAt: completedAt }];
    run.stageOutputs[nextNode.id] = state.output;
    run.artifacts.push(buildArtifact(nextNode, state.output));
    return { run, commit: async () => { await recordDryRunNodeUsage(run, nextNode, state.input, state.output); } };
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
  const output = result.output;

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
