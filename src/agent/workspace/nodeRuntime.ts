import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { getNodeRunner } from "../execution/runnerRegistry.js";
import type { ExecutionMode } from "../execution/executionContext.js";
import { validateOutput } from "../execution/outputValidator.js";
import { recordModelUsage } from "../observability/modelUsage.js";
import { recordNodeTimingCompletion, type NodeTimingOutcome } from "./nodeTimings.js";
import { resolveSkillsForNode } from "../skills/skillResolver.js";
import { resolveEffectiveToolsForNode } from "../tools/toolResolver.js";
import { DEFAULT_EXECUTION_MODE } from "./executor.js";
import type { WorkspaceNode } from "./nodeTypes.js";
// T12.15: these three entry points (node.get_effective_prompt, node.prepare_execution, node.execute)
// resolved nodes from the workspace store alone and threw `Unknown node: <id>` on a miss, which made
// capture_conductor's three code-defined, deliberately-unseeded AI nodes unreachable. resolveNodeForExecution
// keeps the store as the winner wherever it holds a record and falls back to the registered workflow's
// canonical definition only when it does not — see nodeResolution.ts for the full rationale.
import { resolveNodeForExecution } from "./nodeResolution.js";
import type { ExecutionArtifact, ExecutionStatus, NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";
import type { UsageRepository } from "../repository/interfaces/UsageRepository.js";

const now = () => new Date().toISOString();
const makeRunId = () => `node_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const makeExecutionId = () => `node_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tokenCount = (value: unknown, min = 16) => Math.max(min, Math.ceil(JSON.stringify(value ?? "").length / 4));
const modelName = (node: WorkspaceNode, override?: Record<string, unknown>) => String(override?.model ?? node.modelConfig?.model ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5");
const duration = (startedAt: string, endedAt = now()) => Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

export type NodeValidationResult = { valid: boolean; value?: unknown; issues: string[] };
export type NodeExecutionFilters = { nodeId?: string; runId?: string; executionId?: string; artifactType?: string; from?: string; to?: string };

type NodeVersionSummary = {
  workspaceVersion: number;
  createdAt: string;
  summary?: string;
  updatedAt: string;
  changedFields: string[];
};

export { redactSensitiveKeys as redactSecrets } from "../observability/redaction.js";
import { redactSensitiveKeys as redactSecrets } from "../observability/redaction.js";

export function validateAgainstNodeSchema(value: unknown, schema: unknown): NodeValidationResult {
  const result = validateOutput(value, schema);
  return result.ok ? { valid: true, value: result.value, issues: [] } : { valid: false, issues: result.errors };
}

// Workspace revisions store a complete node graph so restoration can remain lossless. Returning
// those snapshots from node.get multiplied one node inspection by every node in every revision (a
// live request exceeded four million response tokens). node.get only needs to describe THIS node's
// history; exact revision payloads remain available through the changes tools.
export function summarizeNodeVersions(nodeId: string, versions: Array<{ workspaceVersion: number; createdAt: string; summary?: string; nodes?: WorkspaceNode[] }>): NodeVersionSummary[] {
  const summaries: NodeVersionSummary[] = [];
  let previous: WorkspaceNode | undefined;
  for (const version of [...versions].sort((a, b) => a.workspaceVersion - b.workspaceVersion)) {
    const current = version.nodes?.find((candidate) => candidate.id === nodeId);
    if (!current) continue;
    const fields = new Set([...Object.keys(previous ?? {}), ...Object.keys(current)]);
    const changedFields = [...fields].filter((field) => JSON.stringify(previous?.[field as keyof WorkspaceNode]) !== JSON.stringify(current[field as keyof WorkspaceNode])).sort();
    if (previous && changedFields.length === 0) continue;
    summaries.push({ workspaceVersion: version.workspaceVersion, createdAt: version.createdAt, ...(version.summary ? { summary: version.summary } : {}), updatedAt: current.updatedAt, changedFields });
    previous = current;
  }
  return summaries;
}

export function summarizeNodeExecution(run: WorkflowExecutionRecord, nodeId: string) {
  const state = (run.nodes ?? []).find((candidate) => candidate.nodeId === nodeId);
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    projectId: run.projectId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    executionMode: run.executionMode,
    node: state ? (({ input: _input, output: _output, ...summary }) => summary)(state) : null,
    artifactCount: (run.artifacts ?? []).filter((artifact) => artifact.nodeId === nodeId).length,
    errors: (run.errors ?? []).slice(0, 10).map((error) => error.slice(0, 2_000))
  };
}

// B2 (Pass 2): node.list_executions now returns compact NodeExecutionEntry objects, not full run
// records, so node.get (getNodeDetails, below) needs its own "which runs touched this node" read —
// it still wants the FULL run record (summarizeNodeExecution reads run.status/completedAt/etc.,
// none of which the compact shape carries).
const runsTouchingNode = (runs: WorkflowExecutionRecord[], nodeId: string): WorkflowExecutionRecord[] =>
  runs
    .filter((run) => (run.nodes ?? []).some((state) => state.nodeId === nodeId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

export async function getNodeDetails(nodeId: string, repos = { workspaceRepository: repositoryManager.getWorkspaceRepository(), executionRepository: repositoryManager.getExecutionRepository() }) {
  const node = await repos.workspaceRepository.getNode(nodeId);
  if (!node) return null;
  const versions = summarizeNodeVersions(nodeId, await repos.workspaceRepository.getVersions());
  // Read runs once; both the latest-execution summary and the latest-output lookup derive from it.
  const runs = runsTouchingNode(await repos.executionRepository.listRuns({}), nodeId);
  const latestRun = runs[0] ?? null;
  const latestExecution = latestRun ? summarizeNodeExecution(latestRun, nodeId) : null;
  const latestOutput = runs
    .flatMap((run) => (run.artifacts ?? []).map((artifact: any) => ({ ...artifact, runId: artifact.runId ?? run.runId })))
    .filter((artifact: any) => artifact.nodeId === nodeId)
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return redactSecrets({
    node,
    versions,
    versionCount: versions.length,
    dependencies: node.dependsOn,
    assignedSkills: node.assignedSkills ?? [],
    allowedTools: node.allowedTools,
    effectiveTools: await resolveEffectiveToolsForNode(node.id),
    schemas: { input: node.inputSchema, output: node.outputSchema },
    modelConfiguration: node.modelConfig ?? {},
    latestExecution,
    latestOutputSummary: latestOutput ? { id: latestOutput.id, type: latestOutput.type, createdAt: latestOutput.createdAt, runId: latestOutput.runId, executionId: latestOutput.executionId } : null
  });
}

// preloadedNode lets executeNode (below), which already loaded the node itself, skip this function's
// own getNode round-trip. Every other caller (node.get_effective_prompt) passes only nodeId and is
// unaffected.
export async function getEffectivePrompt(nodeId: string, workspaceRepository = repositoryManager.getWorkspaceRepository(), preloadedNode?: WorkspaceNode) {
  const node = preloadedNode ?? await resolveNodeForExecution(nodeId, workspaceRepository);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const skills = await resolveSkillsForNode(node, repositoryManager.getSkillRepository());
  return redactSecrets({ prompt: [node.prompt, skills.instructions].filter(Boolean).join("\n\n"), nodePrompt: node.prompt, skillInstructions: skills.instructions });
}

// preloadedNode (same contract as getEffectivePrompt's above) lets executeNode pass down the node it
// already loaded, instead of prepareNodeExecution loading it again itself AND getEffectivePrompt AND
// resolveEffectiveToolsForNode each loading it a THIRD and FOURTH time for the very same dispatch —
// four getNode calls for one node execution, three of them redundant. node.prepare_execution (the only
// other caller) passes only data.nodeId and is unaffected: it still fetches exactly as before.
export async function prepareNodeExecution(data: { nodeId: string; input?: unknown; dependencyOutputs?: Record<string, unknown>; modelConfig?: Record<string, unknown> }, repos = { workspaceRepository: repositoryManager.getWorkspaceRepository() }, preloadedNode?: WorkspaceNode) {
  const node = preloadedNode ?? await resolveNodeForExecution(data.nodeId, repos.workspaceRepository);
  if (!node) throw new Error(`Unknown node: ${data.nodeId}`);
  const dependencyOutputs = Object.fromEntries(await Promise.all(node.dependsOn.map(async (id) => [id, data.dependencyOutputs?.[id] ?? (await repos.workspaceRepository.getStageOutput(id))?.value])));
  const missingInputs = node.dependsOn.filter((id) => dependencyOutputs[id] === undefined);
  const inputValidation = validateAgainstNodeSchema(data.input ?? {}, node.inputSchema);
  const prompt = await getEffectivePrompt(node.id, repos.workspaceRepository, node);
  const inputTokens = tokenCount({ prompt, input: data.input, dependencyOutputs }, 64);
  const outputTokens = tokenCount(node.outputSchema, 32);
  return redactSecrets({
    resolvedNode: node,
    resolvedPrompt: prompt,
    resolvedSkills: await resolveSkillsForNode(node, repositoryManager.getSkillRepository()),
    resolvedEffectiveTools: await resolveEffectiveToolsForNode(node.id, {}, node),
    dependencyOutputs,
    missingInputs: [...missingInputs, ...(!inputValidation.valid ? ["input_schema"] : [])],
    estimatedTokenRange: { min: inputTokens, max: inputTokens + outputTokens * 4 },
    estimatedCost: { currency: "USD", min: 0, max: Number(((inputTokens + outputTokens * 4) / 1_000_000 * 15).toFixed(6)) },
    riskLevel: node.riskLevel,
    approvalsRequired: ["publish", "admin"].includes(node.riskLevel) ? ["explicit_approval"] : [],
    readinessStatus: missingInputs.length || !inputValidation.valid ? "missing_inputs" : "ready"
  });
}

export async function executeNode(data: { nodeId: string; input?: unknown; runId?: string; dependencyOutputs?: Record<string, unknown>; executionMode?: ExecutionMode; modelConfig?: Record<string, unknown>; promptOverride?: string; expectedWorkspaceVersion?: number }, repos = { workspaceRepository: repositoryManager.getWorkspaceRepository(), executionRepository: repositoryManager.getExecutionRepository() }) {
  if (data.expectedWorkspaceVersion !== undefined && data.expectedWorkspaceVersion !== await repos.workspaceRepository.getWorkspaceVersion()) throw new Error("stale_workspace_version");
  const node = await resolveNodeForExecution(data.nodeId, repos.workspaceRepository);
  if (!node) throw new Error(`Unknown node: ${data.nodeId}`);
  const inputValidation = validateAgainstNodeSchema(data.input ?? {}, node.inputSchema);
  if (!inputValidation.valid) throw new Error(`input_validation_failed: ${inputValidation.issues.join("; ")}`);
  // Threads the node loaded above through prepareNodeExecution (which threads it further, into
  // getEffectivePrompt and resolveEffectiveToolsForNode) so this dispatch loads it once, not four times.
  const prep = await prepareNodeExecution(data, repos, node);
  if (prep.readinessStatus !== "ready") throw new Error(`node_not_ready: ${prep.missingInputs.join(", ")}`);
  const runId = data.runId ?? makeRunId();
  const executionId = makeExecutionId();
  const startedAt = now();
  const state: NodeExecutionState = { nodeId: node.id, status: "running", startedAt, input: { input: data.input, dependencies: prep.dependencyOutputs }, produces: node.produces };
  const run: WorkflowExecutionRecord = { runId, workflowId: "independent_node", projectId: "workspace", status: "running", currentNodeId: node.id, startedAt, updatedAt: startedAt, nodes: [state], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: prep.dependencyOutputs as Record<string, unknown>, dryRun: true, executionMode: data.executionMode ?? DEFAULT_EXECUTION_MODE };
  await repos.executionRepository.createRun(run);
  // Live by default, mock only when a caller asks for it — the same deliberate choice the workflow
  // entry points make (see DEFAULT_EXECUTION_MODE), so node.execute cannot quietly hand back a
  // schema-shaped placeholder to someone who believed they were exercising the real node.
  const runner = getNodeRunner(data.executionMode ?? DEFAULT_EXECUTION_MODE);
  // promptOverride is an internal replay lever (improvement trials run prompt variants against
  // frozen inputs); it is deliberately NOT exposed on the public node.execute MCP tool — the
  // sanctioned public mutation path stays workspace.update_node_prompt.
  const result = await runner.run({ node: { ...node, prompt: data.promptOverride ?? node.prompt, modelConfig: { ...node.modelConfig, ...data.modelConfig } }, input: state.input }, { run, executionRepository: repos.executionRepository, workspaceRepository: repos.workspaceRepository, suppliedDependencies: data.dependencyOutputs });
  const endedAt = now();
  state.completedAt = endedAt; state.durationMs = duration(startedAt, endedAt);
  if (result.toolCalls?.length) state.toolCalls = result.toolCalls;
  if (!result.ok) { state.status = "failed"; state.errors = [result.code, result.message]; run.status = "failed"; run.errors = state.errors; }
  else {
    const outputValidation = validateAgainstNodeSchema(result.output, node.outputSchema);
    if (!outputValidation.valid) { state.status = "failed"; state.errors = outputValidation.issues; run.status = "failed"; run.errors = outputValidation.issues; }
    else { state.status = "completed"; state.output = outputValidation.value; run.status = "completed"; run.completedAt = endedAt; run.stageOutputs[node.id] = outputValidation.value; const artifact: ExecutionArtifact & { runId: string; executionId: string } = { id: `artifact_${executionId}`, nodeId: node.id, type: node.produces[0] ?? node.id, value: outputValidation.value, createdAt: endedAt, runId, executionId }; run.artifacts.push(artifact); await repos.workspaceRepository.saveStageOutput(node.id, outputValidation.value, `${runId}:${executionId}:${node.id}`); }
  }
  run.updatedAt = endedAt; run.currentNodeId = undefined;
  // In openai mode the runner records real usage itself (OpenAINodeRunner); recording here too
  // double-counted every independent execution with fabricated token counts marked "actual".
  if (data.executionMode !== "openai") await recordModelUsage({ runId, requestId: run.requestId, workflowId: run.workflowId, projectId: run.projectId, nodeId: node.id, model: modelName(node, data.modelConfig), provider: "openai", inputTokens: tokenCount(state.input, 64), outputTokens: tokenCount(state.output, 32), status: "estimated", metadata: { executionId, independentNode: true } });
  // T6 (Wave 3, ships dark) — node.execute is the SECOND node-completion path (executor.ts's
  // executeRunnableNode is the first); a ledger that only saw conductor-dispatched nodes would miss
  // every independent single-node execution entirely. Best-effort, same posture as executor.ts's own
  // hook: a timing-repository failure must never fail an otherwise-successful node.execute call.
  await recordNodeTimingCompletion({ runId, workflowId: run.workflowId, nodeId: node.id, durationMs: state.durationMs ?? 0, outcome: state.status as NodeTimingOutcome }).catch(() => undefined);
  return redactSecrets({ execution: await repos.executionRepository.saveRun(run), executionId });
}

// B2 (Pass 2, WP-00 finding #2) — node.list_executions used to hand back the WHOLE run record
// (structurally identical to workflow_get_run's `data.run`) wrapped in a 1-element array, rather
// than a per-node execution list, and any call naming `nodeId` crashed the JSON-RPC transport
// entirely because the old predicate below evaluated `run.nodes.some(...)` unguarded — a run
// record without a populated `.nodes` array (e.g. a partial/legacy record) threw a bare TypeError
// that this layer never expected to see (see B4). This rewrite returns one compact entry per
// node-execution, joined from data that already exists — never fabricated:
//   - status/timing (startedAt/completedAt/durationMs) come straight from
//     WorkflowExecutionRecord.nodes[] (the exact fields workflow_get_run.data.run.nodes[] exposes).
//   - cost/token figures come from usage records already persisted for that run+node
//     (recordModelUsage's ModelUsageRecord), summed when a node produced more than one record.
// `attempt` is deliberately omitted: this data model persists one state per node per run (a retry
// creates a NEW run via node.execute, not a second entry on the same run), so there is no existing
// per-run attempt counter to report without inventing one.
export type NodeExecutionEntry = {
  runId: string;
  nodeId: string;
  status: ExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
};

const filterRunsForNodeQuery = (runs: WorkflowExecutionRecord[], filters: NodeExecutionFilters): WorkflowExecutionRecord[] =>
  runs.filter((run) =>
    (!filters.runId || run.runId === filters.runId) &&
    (!filters.from || run.startedAt >= filters.from) &&
    (!filters.to || run.startedAt <= filters.to)
  );

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export async function listNodeExecutions(
  filters: NodeExecutionFilters = {},
  executionRepository: ExecutionRepository = repositoryManager.getExecutionRepository(),
  usageRepository: UsageRepository = repositoryManager.getUsageRepository()
): Promise<NodeExecutionEntry[]> {
  const runs = filterRunsForNodeQuery(await executionRepository.listRuns({}), filters);
  // One usage read for the whole call, scoped by whatever of runId/nodeId the caller supplied — the
  // per-entry cost/token join below is then an in-memory match, not N repository round-trips.
  const usageRecords = await usageRepository.list({ runId: filters.runId, nodeId: filters.nodeId });

  const entries: NodeExecutionEntry[] = [];
  for (const run of runs) {
    for (const state of run.nodes ?? []) {
      if (filters.nodeId && state.nodeId !== filters.nodeId) continue;
      if (filters.executionId && !(run.artifacts ?? []).some((artifact) => artifact.nodeId === state.nodeId && (artifact as unknown as { executionId?: string }).executionId === filters.executionId)) continue;

      const usage = usageRecords.filter((record) => record.runId === run.runId && record.nodeId === state.nodeId);
      const costUsd = usage.length ? round6(usage.reduce((sum, record) => sum + record.costUsdEstimate, 0)) : undefined;
      const tokensIn = usage.length ? usage.reduce((sum, record) => sum + record.inputTokens, 0) : undefined;
      const tokensOut = usage.length ? usage.reduce((sum, record) => sum + record.outputTokens, 0) : undefined;

      entries.push({
        runId: run.runId,
        nodeId: state.nodeId,
        status: state.status,
        ...(state.startedAt ? { startedAt: state.startedAt } : {}),
        ...(state.completedAt ? { completedAt: state.completedAt } : {}),
        ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
        ...(state.errors?.length ? { error: state.errors.join("; ") } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {})
      });
    }
  }
  return entries.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.runId.localeCompare(a.runId));
}

export async function listNodeOutputs(filters: NodeExecutionFilters = {}, executionRepository: ExecutionRepository = repositoryManager.getExecutionRepository()) {
  // Deliberately independent of listNodeExecutions (which now returns compact status entries, not
  // full run records) — outputs are artifacts, joined from the run list directly, with the same
  // `?? []` defensiveness so a run missing `.artifacts` can never crash this read.
  const runs = filterRunsForNodeQuery(await executionRepository.listRuns({}), filters);
  return runs
    .flatMap((run) => (run.artifacts ?? []).map((artifact: any) => ({ ...artifact, runId: artifact.runId ?? run.runId })))
    .filter((artifact: any) => (!filters.nodeId || artifact.nodeId === filters.nodeId) && (!filters.artifactType || artifact.type === filters.artifactType) && (!filters.executionId || artifact.executionId === filters.executionId) && (!filters.from || artifact.createdAt >= filters.from) && (!filters.to || artifact.createdAt <= filters.to))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
