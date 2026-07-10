import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { getNodeRunner } from "../execution/runnerRegistry.js";
import type { ExecutionMode } from "../execution/executionContext.js";
import { validateOutput } from "../execution/outputValidator.js";
import { recordModelUsage } from "../observability/modelUsage.js";
import { resolveSkillsForNode } from "../skills/skillResolver.js";
import { resolveEffectiveToolsForNode } from "../tools/toolResolver.js";
import type { WorkspaceNode } from "./nodeTypes.js";
import type { ExecutionArtifact, NodeExecutionState, WorkflowExecutionRecord } from "./executionTypes.js";

const now = () => new Date().toISOString();
const makeRunId = () => `node_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const makeExecutionId = () => `node_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const tokenCount = (value: unknown, min = 16) => Math.max(min, Math.ceil(JSON.stringify(value ?? "").length / 4));
const modelName = (node: WorkspaceNode, override?: Record<string, unknown>) => String(override?.model ?? node.modelConfig?.model ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5");
const duration = (startedAt: string, endedAt = now()) => Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

export type NodeValidationResult = { valid: boolean; value?: unknown; issues: string[] };
export type NodeExecutionFilters = { nodeId?: string; runId?: string; executionId?: string; artifactType?: string; from?: string; to?: string };

export const redactSecrets = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, val) => /secret|token|api[_-]?key|authorization|password/i.test(key) ? "[REDACTED]" : val));

export function validateAgainstNodeSchema(value: unknown, schema: unknown): NodeValidationResult {
  const result = validateOutput(value, schema);
  return result.ok ? { valid: true, value: result.value, issues: [] } : { valid: false, issues: result.errors };
}

export async function getNodeDetails(nodeId: string, repos = { workspaceRepository: repositoryManager.getWorkspaceRepository(), executionRepository: repositoryManager.getExecutionRepository() }) {
  const node = await repos.workspaceRepository.getNode(nodeId);
  if (!node) return null;
  const versions = (await repos.workspaceRepository.getVersions())?.filter((version: any) => version.nodes?.some((candidate: WorkspaceNode) => candidate.id === nodeId)) ?? [];
  const latestExecution = (await listNodeExecutions({ nodeId }, repos.executionRepository))[0] ?? null;
  const latestOutput = (await listNodeOutputs({ nodeId }, repos.executionRepository))[0] ?? null;
  return redactSecrets({
    node,
    versions,
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

export async function getEffectivePrompt(nodeId: string, workspaceRepository = repositoryManager.getWorkspaceRepository()) {
  const node = await workspaceRepository.getNode(nodeId);
  if (!node) throw new Error(`Unknown node: ${nodeId}`);
  const skills = await resolveSkillsForNode(node, repositoryManager.getSkillRepository());
  return redactSecrets({ prompt: [node.prompt, skills.instructions].filter(Boolean).join("\n\n"), nodePrompt: node.prompt, skillInstructions: skills.instructions });
}

export async function prepareNodeExecution(data: { nodeId: string; input?: unknown; dependencyOutputs?: Record<string, unknown>; modelConfig?: Record<string, unknown> }, repos = { workspaceRepository: repositoryManager.getWorkspaceRepository() }) {
  const node = await repos.workspaceRepository.getNode(data.nodeId);
  if (!node) throw new Error(`Unknown node: ${data.nodeId}`);
  const dependencyOutputs = Object.fromEntries(await Promise.all(node.dependsOn.map(async (id) => [id, data.dependencyOutputs?.[id] ?? (await repos.workspaceRepository.getStageOutput(id))?.value])));
  const missingInputs = node.dependsOn.filter((id) => dependencyOutputs[id] === undefined);
  const inputValidation = validateAgainstNodeSchema(data.input ?? {}, node.inputSchema);
  const prompt = await getEffectivePrompt(node.id, repos.workspaceRepository);
  const inputTokens = tokenCount({ prompt, input: data.input, dependencyOutputs }, 64);
  const outputTokens = tokenCount(node.outputSchema, 32);
  return redactSecrets({
    resolvedNode: node,
    resolvedPrompt: prompt,
    resolvedSkills: await resolveSkillsForNode(node, repositoryManager.getSkillRepository()),
    resolvedEffectiveTools: await resolveEffectiveToolsForNode(node.id),
    dependencyOutputs,
    missingInputs: [...missingInputs, ...(!inputValidation.valid ? ["input_schema"] : [])],
    estimatedTokenRange: { min: inputTokens, max: inputTokens + outputTokens * 4 },
    estimatedCost: { currency: "USD", min: 0, max: Number(((inputTokens + outputTokens * 4) / 1_000_000 * 15).toFixed(6)) },
    riskLevel: node.riskLevel,
    approvalsRequired: ["publish", "admin"].includes(node.riskLevel) ? ["explicit_approval"] : [],
    readinessStatus: missingInputs.length || !inputValidation.valid ? "missing_inputs" : "ready"
  });
}

export async function executeNode(data: { nodeId: string; input?: unknown; runId?: string; dependencyOutputs?: Record<string, unknown>; executionMode?: ExecutionMode; modelConfig?: Record<string, unknown>; expectedWorkspaceVersion?: number }, repos = { workspaceRepository: repositoryManager.getWorkspaceRepository(), executionRepository: repositoryManager.getExecutionRepository() }) {
  if (data.expectedWorkspaceVersion !== undefined && data.expectedWorkspaceVersion !== await repos.workspaceRepository.getWorkspaceVersion()) throw new Error("stale_workspace_version");
  const node = await repos.workspaceRepository.getNode(data.nodeId);
  if (!node) throw new Error(`Unknown node: ${data.nodeId}`);
  const inputValidation = validateAgainstNodeSchema(data.input ?? {}, node.inputSchema);
  if (!inputValidation.valid) throw new Error(`input_validation_failed: ${inputValidation.issues.join("; ")}`);
  const prep = await prepareNodeExecution(data, repos);
  if (prep.readinessStatus !== "ready") throw new Error(`node_not_ready: ${prep.missingInputs.join(", ")}`);
  const runId = data.runId ?? makeRunId();
  const executionId = makeExecutionId();
  const startedAt = now();
  const state: NodeExecutionState = { nodeId: node.id, status: "running", startedAt, input: { input: data.input, dependencies: prep.dependencyOutputs }, produces: node.produces };
  const run: WorkflowExecutionRecord = { runId, workflowId: "independent_node", projectId: "workspace", status: "running", currentNodeId: node.id, startedAt, updatedAt: startedAt, nodes: [state], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: prep.dependencyOutputs as Record<string, unknown>, dryRun: true, executionMode: data.executionMode ?? "mock" };
  await repos.executionRepository.createRun(run);
  const runner = getNodeRunner(data.executionMode ?? "mock");
  const result = await runner.run({ node: { ...node, modelConfig: { ...node.modelConfig, ...data.modelConfig } }, input: state.input }, { run, executionRepository: repos.executionRepository, workspaceRepository: repos.workspaceRepository, suppliedDependencies: data.dependencyOutputs });
  const endedAt = now();
  state.completedAt = endedAt; state.durationMs = duration(startedAt, endedAt);
  if (!result.ok) { state.status = "failed"; state.errors = [result.code, result.message]; run.status = "failed"; run.errors = state.errors; }
  else {
    const outputValidation = validateAgainstNodeSchema(result.output, node.outputSchema);
    if (!outputValidation.valid) { state.status = "failed"; state.errors = outputValidation.issues; run.status = "failed"; run.errors = outputValidation.issues; }
    else { state.status = "completed"; state.output = outputValidation.value; run.status = "completed"; run.completedAt = endedAt; run.stageOutputs[node.id] = outputValidation.value; const artifact: ExecutionArtifact & { runId: string; executionId: string } = { id: `artifact_${executionId}`, nodeId: node.id, type: node.produces[0] ?? node.id, value: outputValidation.value, createdAt: endedAt, runId, executionId }; run.artifacts.push(artifact); await repos.workspaceRepository.saveStageOutput(node.id, outputValidation.value, `${runId}:${executionId}:${node.id}`); }
  }
  run.updatedAt = endedAt; run.currentNodeId = undefined;
  await recordModelUsage({ runId, workflowId: run.workflowId, projectId: run.projectId, nodeId: node.id, model: modelName(node, data.modelConfig), provider: "openai", inputTokens: tokenCount(state.input, 64), outputTokens: tokenCount(state.output, 32), status: data.executionMode === "openai" ? "actual" : "estimated", metadata: { executionId, independentNode: true } });
  return redactSecrets({ execution: await repos.executionRepository.saveRun(run), executionId });
}

export async function listNodeExecutions(filters: NodeExecutionFilters = {}, executionRepository: ExecutionRepository = repositoryManager.getExecutionRepository()) {
  const runs = await executionRepository.listRuns({});
  return runs.filter((run) => (!filters.runId || run.runId === filters.runId) && (!filters.executionId || run.artifacts.some((a: any) => a.executionId === filters.executionId)) && (!filters.nodeId || run.nodes.some((n) => n.nodeId === filters.nodeId)) && (!filters.from || run.startedAt >= filters.from) && (!filters.to || run.startedAt <= filters.to)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
}

export async function listNodeOutputs(filters: NodeExecutionFilters = {}, executionRepository: ExecutionRepository = repositoryManager.getExecutionRepository()) {
  const runs = await listNodeExecutions(filters, executionRepository);
  return runs.flatMap((run) => run.artifacts.map((artifact: any) => ({ ...artifact, runId: artifact.runId ?? run.runId }))).filter((artifact: any) => (!filters.nodeId || artifact.nodeId === filters.nodeId) && (!filters.artifactType || artifact.type === filters.artifactType) && (!filters.executionId || artifact.executionId === filters.executionId) && (!filters.from || artifact.createdAt >= filters.from) && (!filters.to || artifact.createdAt <= filters.to)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
