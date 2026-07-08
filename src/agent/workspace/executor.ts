import { listWorkspaceNodes } from "./nodes.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import type { ExecutionArtifact, NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";
import { InMemoryExecutionStore, executionStore } from "./executionStore.js";
import type { WorkspaceStore } from "../mcp/workspace/store.js";
import { recordModelUsage } from "../observability/modelUsage.js";

const WORKFLOW_ID = "publishing_conductor";
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

export type StartDryRunInput = { projectId: string; input?: unknown; workflowId?: string };
export type ListRunsInput = { projectId?: string; workflowId?: string };

const buildInitialRun = (data: StartDryRunInput, runId = makeRunId()): WorkflowExecutionRecord => {
  const timestamp = now();
  const nodes = listWorkspaceNodes();
  const firstNode = nodes.find((node) => node.dependsOn.length === 0) ?? nodes[0];
  return {
    runId,
    workflowId: data.workflowId ?? WORKFLOW_ID,
    projectId: data.projectId,
    status: "queued",
    currentNodeId: firstNode?.id,
    startedAt: timestamp,
    updatedAt: timestamp,
    nodes: nodes.map((node) => ({ nodeId: node.id, status: node.id === firstNode?.id ? "queued" : "queued", produces: [...node.produces] })),
    artifacts: [],
    errors: [],
    approvalsRequired: [],
    initialInput: data.input,
    stageOutputs: {},
    dryRun: true
  };
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

export async function startDryRun(data: StartDryRunInput, store: InMemoryExecutionStore = executionStore): Promise<WorkflowExecutionRecord> {
  return store.createRun(buildInitialRun(data));
}

export async function getRun(runId: string, store: InMemoryExecutionStore = executionStore) {
  return store.getRun(runId);
}

export async function listRuns(filters: ListRunsInput = {}, store: InMemoryExecutionStore = executionStore) {
  return store.listRuns(filters);
}

export async function resetRun(runId: string, store: InMemoryExecutionStore = executionStore): Promise<WorkflowExecutionRecord> {
  const existing = await store.getRun(runId);
  if (!existing) throw new Error(`Unknown run: ${runId}`);
  return store.resetRun(runId, buildInitialRun({ projectId: existing.projectId, input: existing.initialInput, workflowId: existing.workflowId }, runId));
}

export async function runNextNode(runId: string, options: { executionStore?: InMemoryExecutionStore; workspaceStore?: WorkspaceStore } = {}): Promise<WorkflowExecutionRecord> {
  const store = options.executionStore ?? executionStore;
  const run = await store.getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (["blocked", "cancelled", "completed", "failed"].includes(run.status)) return run;

  const nodes = listWorkspaceNodes();
  const nextNode = findNextRunnableNode(run, nodes);
  if (!nextNode) return store.saveRun({ ...run, status: "completed", completedAt: now(), updatedAt: now(), currentNodeId: undefined });

  const states = stateById(run);
  const state = states.get(nextNode.id) as NodeExecutionState;
  const startedAt = now();
  state.status = "running";
  state.startedAt = startedAt;
  state.input = { initialInput: nextNode.dependsOn.length ? undefined : run.initialInput, dependencies: Object.fromEntries(nextNode.dependsOn.map((dependency) => [dependency, run.stageOutputs[dependency]])) };
  run.status = "running";
  run.currentNodeId = nextNode.id;
  run.updatedAt = startedAt;

  if (nextNode.id === "publication_controller") {
    const completedAt = now();
    state.status = "blocked";
    state.completedAt = completedAt;
    state.durationMs = duration(startedAt, completedAt);
    state.output = { artifact: "publication_decision.v1", dryRun: true, decision: "blocked", approvalRequired: true, reason: "Dry-run publication controller requires explicit future approval before any publishing side effect." };
    state.warnings = ["approval_required", "no_publication_performed"];
    run.status = "blocked";
    run.updatedAt = completedAt;
    run.approvalsRequired = [{ nodeId: nextNode.id, type: "approval_required", reason: "Publication requires explicit future approval; dry-run blocked before publishing.", requestedAt: completedAt }];
    run.stageOutputs[nextNode.id] = state.output;
    run.artifacts.push(buildArtifact(nextNode, state.output));
    await recordDryRunNodeUsage(run, nextNode, state.input, state.output);
    return store.saveRun(run);
  }

  const output = mockOutputForNode(nextNode, run);
  const completedAt = now();
  state.status = "completed";
  state.completedAt = completedAt;
  state.durationMs = duration(startedAt, completedAt);
  state.output = output;
  run.stageOutputs[nextNode.id] = output;
  run.artifacts.push(buildArtifact(nextNode, output));
  await recordDryRunNodeUsage(run, nextNode, state.input, output);
  run.updatedAt = completedAt;
  run.currentNodeId = findNextRunnableNode(run, nodes)?.id;
  if (options.workspaceStore) await options.workspaceStore.saveStageOutput(nextNode.id, output, `${run.runId}:${nextNode.id}`);
  return store.saveRun(run);
}

export const publishingConductorWorkflowId = WORKFLOW_ID;
export const __test__ = { buildInitialRun, findNextRunnableNode, mockOutputForNode, nodeById };
