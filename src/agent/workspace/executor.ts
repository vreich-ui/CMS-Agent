import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import type { ExecutionArtifact, ExecutionStatus, NodeExecutionState, WorkflowEntrypoint, WorkflowExecutionRecord } from "./executionTypes.js";
import { RunConcurrencyError, type ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import { recordModelUsage, summarizeModelUsage, evaluateRunBudget } from "../observability/modelUsage.js";
import { getNodeRunner } from "../execution/runnerRegistry.js";
import { enforceModelLadder, modelLadderEnforcementEnabled } from "../improvement/modelLadder.js";
import { postRunReflectionEnabled, reflectAfterRun } from "../improvement/reflection.js";
import type { OptimizerDeps } from "../improvement/optimizer.js";
import type { ExecutionMode } from "../execution/executionContext.js";

const WORKFLOW_ID = "publishing_conductor";
const TERMINAL_STATUSES = new Set<ExecutionStatus>(["blocked", "cancelled", "completed", "failed"]);
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

// Phase 5 (docs/platform/DIRECTION.md §5): the conductor can resolve node definitions from the
// workspace store so optimizer-promoted prompts — and authoring edits to schemas, tools, skills, and
// model config — reach FULL conductor runs, not just independent node execution and replay. Gated by
// WORKSPACE_NODES_SOURCE and defaulting to the static definitions, so behavior is unchanged until an
// operator flips it after a side-by-side mock run confirms identical topology.
const nodeSource = (): "static" | "store" => (process.env.WORKSPACE_NODES_SOURCE?.trim().toLowerCase() === "store" ? "store" : "static");

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

const buildInitialRun = (data: StartDryRunInput, nodes: WorkspaceNode[], runId = makeRunId()): WorkflowExecutionRecord => {
  const timestamp = now();
  const entrypoint = data.entrypoint;
  if (entrypoint && !nodes.some((node) => node.id === entrypoint.nodeId)) throw new Error(`Unknown entrypoint node: ${entrypoint.nodeId}`);
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
    executionMode: data.executionMode ?? "mock",
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

const mockOutputForNode = (node: WorkspaceNode, run: WorkflowExecutionRecord) => {
  if (node.id === "article_body") return { schema_version: "article_body.v1", nodes: [{ id: "n_dryRunIntro", kind: "content", visibility: "public", public: { title: "Dry-run article", body: "Deterministic mock article body for Publishing Conductor dry-run execution." } }] };
  if (node.id === "publish_payload") return { artifact: "dry_run_publish_payload.v1", dryRun: true, target: "preview", articleBody: run.stageOutputs.article_body, publicationSideEffects: false };
  return { artifact: node.produces[0] ?? `${node.id}.mock.v1`, nodeId: node.id, dryRun: true, summary: `Dry-run mock output for ${node.name}.`, dependencyOutputs: node.dependsOn };
};

const buildArtifact = (node: WorkspaceNode, output: unknown): ExecutionArtifact => ({ id: `artifact_${node.id}_${Date.now()}`, nodeId: node.id, type: node.produces[0] ?? "mock_output", value: output, createdAt: now() });

// Publish-risk nodes (riskLevel publish/admin) must never run without explicit approval — this is
// the "stop before any publishing side effect" boundary, generalized beyond the single
// publication_controller id so any future publish-risk node is gated the same way.
const isPublishRisk = (node: WorkspaceNode): boolean => node.riskLevel === "publish" || node.riskLevel === "admin";
const isConcurrencyConflict = (error: unknown): error is RunConcurrencyError => error instanceof RunConcurrencyError;

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

// Phase 7 (DIRECTION §7): automatic post-run reflection. When IMPROVEMENT_POST_RUN_REFLECT is on, a
// completed run fires GEPA-style reflection (optimizer.propose) for the nodes that executed, so the
// learning loop advances without a human kicking it. PROPOSE-ONLY (nothing is applied) and fully
// best-effort — the flag check short-circuits before any repository access when OFF, and every error
// is swallowed so reflection can never fail or delay-fault an otherwise-successful run. The store node
// source (Phase 5) is honored via options.workspaceRepository so a reflected node's prompt matches
// what actually ran.
async function reflectOnCompletedRun(run: WorkflowExecutionRecord, store: ExecutionRepository, options: RunAdvanceOptions): Promise<void> {
  if (!postRunReflectionEnabled()) return;
  try {
    const deps: OptimizerDeps = {
      workspaceRepository: options.workspaceRepository ?? repositoryManager.getWorkspaceRepository(),
      executionRepository: store,
      improvementRepository: repositoryManager.getImprovementRepository(),
      evaluationRepository: repositoryManager.getEvaluationRepository()
    };
    const result = await reflectAfterRun(run, deps);
    if (result.proposals.length || result.errors.length) {
      console.info("improvement.post_run_reflection", { runId: run.runId, mode: result.mode, candidates: result.candidates, proposals: result.proposals.length, skipped: result.skipped.length, errors: result.errors.length });
    }
  } catch { /* reflection is advisory; a run must never fail because the loop could not reflect */ }
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
        return completed;
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
          return await store.saveRun({
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
        }
      }
      const prepared = await executeRunnableNode(run, nextNode, nodes, store, options);
      // A run that clears the budget gate is no longer paused for budget: drop any stale marker so a
      // resumed-under-ceiling run doesn't keep reporting "paused for budget".
      if (prepared.run.budgetBlock) prepared.run.budgetBlock = undefined;
      const saved = await store.saveRun(prepared.run);
      // Side effects (usage telemetry, workspace stage-output mirror) run only after the state
      // transition is durably committed, so a discarded attempt on a CAS conflict leaves no phantom
      // usage behind. They are non-authoritative — the run record itself already holds the output —
      // so a failure here must not report an otherwise-successful advance as failed.
      await prepared.commit?.().catch(() => undefined);
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

  const mode = (run.executionMode ?? "mock") as ExecutionMode;
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
  const runner = getNodeRunner(mode);
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
export async function updateRunStatus(runId: string, status: ExecutionStatus, store: ExecutionRepository = repositoryManager.getExecutionRepository()): Promise<WorkflowExecutionRecord | undefined> {
  return withRunLock(runId, async () => {
    for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
      const run = await store.getRun(runId);
      if (!run) return undefined;
      try {
        return await store.saveRun({ ...run, status, updatedAt: now() });
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
