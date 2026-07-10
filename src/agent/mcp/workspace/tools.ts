import { z, ZodError, type ZodTypeAny } from "zod";
import { articleBodyJsonSchema, articleBodySchema, validateJsonSchema } from "./store.js";
import { workspaceRiskLevels, type WorkspaceNode } from "../../workspace/nodeTypes.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { getRun, listRuns, resetRun, runNextNode, startDryRun } from "../../workspace/executor.js";
import { getBudgetStatus, recordModelUsage, recordModelUsageSchema, summarizeModelUsage, usageFiltersSchema } from "../../observability/modelUsage.js";
import { toProjectSummary, validateHandoff } from "../../projects/projectRegistry.js";
import { ProjectMcpAdapter } from "../../projects/drLurie/adapter.js";
import { skillDefinitionSchema, validateSkillDefinition } from "../../skills/skillValidator.js";
import { resolveSkillsForNode } from "../../skills/skillResolver.js";
import type { SkillDefinition } from "../../skills/skillTypes.js";
import { listTools as listControlledTools, getTool as getControlledTool, resolveEffectiveToolsForNode } from "../../tools/toolResolver.js";
import { executeTool, getToolExecution, listToolExecutions } from "../../tools/toolExecutor.js";

export type JsonSchema = Record<string, unknown>;
export type WorkspaceTool = {
  name: string;
  description: string;
  zodSchema: ZodTypeAny;
  inputSchema: JsonSchema;
  execute: (input: unknown) => Promise<unknown>;
};

const emptyInput = z.object({}).strict();

const workspaceNodeImport = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string(),
  schema: z.unknown().optional(),
  updatedAt: z.string().datetime()
}).passthrough();
const stageOutputImport = z.object({
  id: z.string().min(1),
  stage: z.string().min(1),
  value: z.unknown(),
  createdAt: z.string().datetime()
}).strict();
const learningObservationImport = z.object({
  id: z.string().min(1),
  observation: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime()
}).strict();
const publishPayloadSchema = z.object({
  articleBody: articleBodySchema,
  target: z.enum(["preview", "cms"]),
  dryRun: z.literal(true),
  builtAt: z.string().datetime()
}).strict();
const nodeId = z.object({ id: z.string().min(1) }).strict();
const mutationMeta = { expectedWorkspaceVersion: z.number().int().nonnegative().optional(), actor: z.string().min(1).optional(), summary: z.string().min(1).optional() };
const updatePrompt = z.object({ id: z.string().min(1), prompt: z.string().min(1), ...mutationMeta }).strict();
const updateSchema = z.object({ id: z.string().min(1), schema: z.unknown(), ...mutationMeta }).strict();
const createNodeInput = z.object({ node: z.any(), ...mutationMeta }).strict();
const deleteNodeInput = z.object({ id: z.string().min(1), ...mutationMeta }).strict();
const cloneNodeInput = z.object({ id: z.string().min(1), newId: z.string().min(1), ...mutationMeta }).strict();
const updateNodeInput = z.object({ id: z.string().min(1), patch: z.record(z.unknown()), ...mutationMeta }).strict();
const updateGraphInput = z.object({ create: z.array(z.any()).optional(), update: z.array(z.record(z.unknown()).and(z.object({ id: z.string().min(1) }))).optional(), delete: z.array(z.string().min(1)).optional(), dependencies: z.record(z.array(z.string().min(1))).optional(), orderedNodeIds: z.array(z.string().min(1)).optional(), positions: z.record(z.object({ x: z.number(), y: z.number() })).optional(), allowCanonicalNodeRemoval: z.boolean().optional(), adminApproved: z.boolean().optional(), ...mutationMeta }).strict();
const validateNodeInput = z.object({ node: z.any().optional(), id: z.string().min(1).optional() }).strict();
const importWorkspace = z.object({ nodes: z.array(workspaceNodeImport).optional(), stageOutputs: z.array(stageOutputImport).optional(), learningObservations: z.array(learningObservationImport).optional() }).strict();
const saveOutput = z.object({ id: z.string().min(1).optional(), stage: z.string().min(1), value: z.unknown() }).strict();
const listOutputs = z.object({ stage: z.string().min(1).optional() }).strict();
const recordObservation = z.object({ observation: z.string().min(1), metadata: z.record(z.unknown()).optional() }).strict();
const validateArticle = z.object({ articleBody: z.unknown() }).strict();
const publishBuild = z.object({ articleBody: articleBodySchema, target: z.enum(["preview", "cms"]).default("preview") }).strict();
const publishValidate = z.object({ payload: publishPayloadSchema }).strict();
const startDryRunInput = z.object({ projectId: z.string().min(1), input: z.any(), workflowId: z.string().min(1).optional() }).strict();
const runIdInput = z.object({ runId: z.string().min(1) }).strict();
const listRunsInput = z.object({ projectId: z.string().min(1).optional(), workflowId: z.string().min(1).optional() }).strict();
const budgetStatusInput = z.object({ projectId: z.string().min(1).optional(), runId: z.string().min(1).optional(), budgetUsd: z.number().nonnegative().optional() }).strict();
const projectIdInput = z.object({ projectId: z.string().min(1) }).strict();
const validateHandoffInput = z.object({ projectId: z.string().min(1), contentSource: z.unknown().optional(), articleBody: z.unknown().optional() }).strict();
const projectCallToolInput = z.object({ projectId: z.string().min(1), tool: z.string().min(1), arguments: z.record(z.unknown()).default({}) }).strict();
const skillIdInput = z.object({ skillId: z.string().min(1) }).strict();
const skillCreateInput = z.object({ skill: z.unknown(), ...mutationMeta }).strict();
const skillUpdateInput = z.object({ skillId: z.string().min(1), patch: z.record(z.unknown()), ...mutationMeta }).strict();
const skillCloneInput = z.object({ skillId: z.string().min(1), newSkillId: z.string().min(1), ...mutationMeta }).strict();
const skillAssignInput = z.object({ nodeId: z.string().min(1), skillId: z.string().min(1), ...mutationMeta }).strict();
const skillVersionInput = z.object({ skillId: z.string().min(1), versionId: z.string().min(1), ...mutationMeta }).strict();
const skillValidateInput = z.object({ skill: z.unknown() }).strict();
const skillResolveInput = z.object({ nodeId: z.string().min(1), workspaceSystemPolicy: z.string().optional(), projectPolicy: z.string().optional(), runInstructions: z.string().optional(), platformTools: z.array(z.string()).optional(), runAuthorizedTools: z.array(z.string()).optional(), riskPolicy: z.enum(workspaceRiskLevels).optional() }).strict();
const controlledToolIdInput = z.object({ toolId: z.string().min(1) }).strict();
const controlledToolTestInput = z.object({ toolId: z.string().min(1), input: z.unknown().default({}), runId: z.string().min(1).default("mcp-tool-test"), nodeId: z.string().min(1), projectId: z.string().min(1).optional(), skillId: z.string().min(1).optional(), approvedToolIds: z.array(z.string()).optional(), runAuthorizedTools: z.array(z.string()).optional(), platformAllowedTools: z.array(z.string()).optional(), maxRiskLevel: z.enum(workspaceRiskLevels).optional() }).strict();
const effectiveToolsInput = z.object({ nodeId: z.string().min(1), runId: z.string().min(1).optional(), approvedToolIds: z.array(z.string()).optional(), runAuthorizedTools: z.array(z.string()).optional(), platformAllowedTools: z.array(z.string()).optional(), maxRiskLevel: z.enum(workspaceRiskLevels).optional() }).strict();
const toolExecutionInput = z.object({ toolExecutionId: z.string().min(1) }).strict();
const listToolExecutionsInput = z.object({ runId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(), toolId: z.string().min(1).optional() }).strict();

const objectSchema = (properties: JsonSchema = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const emptyJsonSchema = objectSchema();
const nodeIdJsonSchema = objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]);
const metaJson = { expectedWorkspaceVersion: { type: "integer", minimum: 0 }, actor: { type: "string" }, summary: { type: "string" } };
const updatePromptJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 }, ...metaJson }, ["id", "prompt"]);
const updateSchemaJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, schema: {}, ...metaJson }, ["id", "schema"]);
const mutationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, newId: { type: "string", minLength: 1 }, node: {}, patch: { type: "object" }, create: { type: "array" }, update: { type: "array" }, delete: { type: "array", items: { type: "string" } }, dependencies: { type: "object" }, orderedNodeIds: { type: "array", items: { type: "string" } }, positions: { type: "object" }, ...metaJson });
const workspaceNodeJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, prompt: { type: "string" }, schema: {}, updatedAt: { type: "string", format: "date-time" } }, ["id", "name", "prompt", "schema", "updatedAt"]);
const stageOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {}, createdAt: { type: "string", format: "date-time" } }, ["id", "stage", "value", "createdAt"]);
const learningObservationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, observation: { type: "string", minLength: 1 }, metadata: { type: "object" }, createdAt: { type: "string", format: "date-time" } }, ["id", "observation", "createdAt"]);
const importWorkspaceJsonSchema = objectSchema({ nodes: { type: "array", items: workspaceNodeJsonSchema }, stageOutputs: { type: "array", items: stageOutputJsonSchema }, learningObservations: { type: "array", items: learningObservationJsonSchema } });
const saveOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {} }, ["stage", "value"]);
const listOutputsJsonSchema = objectSchema({ stage: { type: "string", minLength: 1 } });
const recordObservationJsonSchema = objectSchema({ observation: { type: "string", minLength: 1 }, metadata: { type: "object" } }, ["observation"]);
const validateArticleJsonSchema = objectSchema({ articleBody: articleBodyJsonSchema }, ["articleBody"]);
const publishBuildJsonSchema = objectSchema({ articleBody: articleBodyJsonSchema, target: { type: "string", enum: ["preview", "cms"], default: "preview" } }, ["articleBody"]);
const publishPayloadJsonSchema = objectSchema({ articleBody: articleBodyJsonSchema, target: { type: "string", enum: ["preview", "cms"] }, dryRun: { const: true }, builtAt: { type: "string", format: "date-time" } }, ["articleBody", "target", "dryRun", "builtAt"]);
const publishValidateJsonSchema = objectSchema({ payload: publishPayloadJsonSchema }, ["payload"]);
const startDryRunJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, input: {}, workflowId: { type: "string", minLength: 1 } }, ["projectId", "input"]);
const runIdJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 } }, ["runId"]);
const listRunsJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, workflowId: { type: "string", minLength: 1 } });
const usageFiltersJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, workflowId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } });
const usageRecordJsonSchema = objectSchema({ usageId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, workflowId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, agentId: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, provider: { type: "string", minLength: 1 }, inputTokens: { type: "integer", minimum: 0 }, outputTokens: { type: "integer", minimum: 0 }, totalTokens: { type: "integer", minimum: 0 }, reasoningTokens: { type: "integer", minimum: 0 }, cachedInputTokens: { type: "integer", minimum: 0 }, costUsdEstimate: { type: "number", minimum: 0 }, currency: { const: "USD" }, status: { type: "string", enum: ["estimated", "actual"] }, recordedAt: { type: "string", format: "date-time" }, metadata: { type: "object" } }, ["model", "provider", "inputTokens", "outputTokens", "status"]);
const budgetStatusJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, budgetUsd: { type: "number", minimum: 0 } });
const projectIdJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 } }, ["projectId"]);
const validateHandoffJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, contentSource: {}, articleBody: {} }, ["projectId"]);
const projectCallToolJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, tool: { type: "string", minLength: 1 }, arguments: { type: "object", additionalProperties: true } }, ["projectId", "tool", "arguments"]);
const skillIdJsonSchema = objectSchema({ skillId: { type: "string", minLength: 1 } }, ["skillId"]);
const controlledToolIdJsonSchema = objectSchema({ toolId: { type: "string", minLength: 1 } }, ["toolId"]);
const controlledToolTestJsonSchema = objectSchema({ toolId: { type: "string", minLength: 1 }, input: {}, runId: { type: "string" }, nodeId: { type: "string", minLength: 1 }, projectId: { type: "string" }, skillId: { type: "string" }, approvedToolIds: { type: "array", items: { type: "string" } }, runAuthorizedTools: { type: "array", items: { type: "string" } }, platformAllowedTools: { type: "array", items: { type: "string" } }, maxRiskLevel: { type: "string", enum: [...workspaceRiskLevels] } }, ["toolId", "nodeId"]);
const effectiveToolsJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, runId: { type: "string" }, approvedToolIds: { type: "array", items: { type: "string" } }, runAuthorizedTools: { type: "array", items: { type: "string" } }, platformAllowedTools: { type: "array", items: { type: "string" } }, maxRiskLevel: { type: "string", enum: [...workspaceRiskLevels] } }, ["nodeId"]);
const toolExecutionJsonSchema = objectSchema({ toolExecutionId: { type: "string", minLength: 1 }, runId: { type: "string" }, nodeId: { type: "string" }, toolId: { type: "string" } });
const skillMutationJsonSchema = objectSchema({ skillId: { type: "string", minLength: 1 }, newSkillId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, versionId: { type: "string", minLength: 1 }, skill: {}, patch: { type: "object" }, workspaceSystemPolicy: { type: "string" }, projectPolicy: { type: "string" }, runInstructions: { type: "string" }, platformTools: { type: "array", items: { type: "string" } }, runAuthorizedTools: { type: "array", items: { type: "string" } }, riskPolicy: { type: "string", enum: [...workspaceRiskLevels] }, ...metaJson });

const ok = (data: unknown) => ({ ok: true, data });

const tool = (definition: WorkspaceTool) => definition;

export function createWorkspaceTools(): WorkspaceTool[] {
  const workspaceRepository = repositoryManager.getWorkspaceRepository();
  const executionRepository = repositoryManager.getExecutionRepository();
  const usageRepository = repositoryManager.getUsageRepository();
  const learningRepository = repositoryManager.getLearningRepository();
  const projectRepository = repositoryManager.getProjectRepository();
  const skillRepository = repositoryManager.getSkillRepository();
  const requireProject = async (id: string) => {
    const config = await projectRepository.get(id);
    if (!config) throw new Error(`Unknown projectId: ${id}`);
    return config;
  };
  return [

    tool({ name: "tool.list", description: "List controlled tool registry entries.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ tools: listControlledTools().map(({ handler, inputSchema, outputSchema, ...tool }) => tool) }); } }),
    tool({ name: "tool.get", description: "Get one controlled tool definition.", zodSchema: controlledToolIdInput, inputSchema: controlledToolIdJsonSchema, execute: async (input) => { const toolDef = getControlledTool(controlledToolIdInput.parse(input).toolId); if (!toolDef) return ok({ tool: null }); const { handler, inputSchema, outputSchema, ...safe } = toolDef; return ok({ tool: safe }); } }),
    tool({ name: "tool.test", description: "Execute a controlled tool through policy and audit gateway.", zodSchema: controlledToolTestInput, inputSchema: controlledToolTestJsonSchema, execute: async (input) => { const data = controlledToolTestInput.parse(input); return ok(await executeTool(data.toolId, data.input, { runId: data.runId, nodeId: data.nodeId, projectId: data.projectId, skillId: data.skillId, approvedToolIds: data.approvedToolIds, runAuthorizedTools: data.runAuthorizedTools, platformAllowedTools: data.platformAllowedTools, maxRiskLevel: data.maxRiskLevel })); } }),
    tool({ name: "tool.get_effective_for_node", description: "Resolve effective controlled tools for a node.", zodSchema: effectiveToolsInput, inputSchema: effectiveToolsJsonSchema, execute: async (input) => { const data = effectiveToolsInput.parse(input); return ok({ tools: await resolveEffectiveToolsForNode(data.nodeId, data) }); } }),
    tool({ name: "tool.get_execution", description: "Get a controlled tool execution audit record.", zodSchema: toolExecutionInput, inputSchema: toolExecutionJsonSchema, execute: async (input) => ok({ execution: getToolExecution(toolExecutionInput.parse(input).toolExecutionId) ?? null }) }),
    tool({ name: "tool.list_executions", description: "List controlled tool execution audit records.", zodSchema: listToolExecutionsInput, inputSchema: toolExecutionJsonSchema, execute: async (input) => ok({ executions: listToolExecutions(listToolExecutionsInput.parse(input)) }) }),
    tool({ name: "skill.list", description: "List reusable workspace skills.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ skills: await skillRepository.list() }); } }),
    tool({ name: "skill.get", description: "Get one reusable workspace skill.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => ok({ skill: await skillRepository.get(skillIdInput.parse(input).skillId) ?? null }) }),
    tool({ name: "skill.create", description: "Create a versioned reusable skill.", zodSchema: skillCreateInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillCreateInput.parse(input); return ok(await skillRepository.create(skillDefinitionSchema.parse(data.skill), data)); } }),
    tool({ name: "skill.update", description: "Patch a reusable skill and create a version snapshot.", zodSchema: skillUpdateInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillUpdateInput.parse(input); return ok(await skillRepository.update(data.skillId, data.patch as Partial<SkillDefinition>, data)); } }),
    tool({ name: "skill.delete", description: "Delete a reusable skill definition.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => ok(await skillRepository.delete(skillIdInput.parse(input).skillId)) }),
    tool({ name: "skill.clone", description: "Clone a reusable skill under a new id.", zodSchema: skillCloneInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillCloneInput.parse(input); return ok(await skillRepository.clone(data.skillId, data.newSkillId, data)); } }),
    tool({ name: "skill.assign", description: "Assign a skill id to a node without copying skill text into the node.", zodSchema: skillAssignInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillAssignInput.parse(input); if (!await skillRepository.get(data.skillId)) throw new Error(`Unknown skill: ${data.skillId}`); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); const assignedSkills = [...(node.assignedSkills ?? []), data.skillId].filter((id, index, ids) => ids.indexOf(id) === index); return ok(await workspaceRepository.updateNode(data.nodeId, { assignedSkills }, data, "node.skill_assigned")); } }),
    tool({ name: "skill.unassign", description: "Remove a skill assignment from a node.", zodSchema: skillAssignInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillAssignInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok(await workspaceRepository.updateNode(data.nodeId, { assignedSkills: (node.assignedSkills ?? []).filter((id) => id !== data.skillId) }, data, "node.skill_unassigned")); } }),
    tool({ name: "skill.list_versions", description: "List snapshots for a skill.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => ok({ versions: await skillRepository.listVersions(skillIdInput.parse(input).skillId) }) }),
    tool({ name: "skill.get_version", description: "Get one skill version snapshot.", zodSchema: skillVersionInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillVersionInput.parse(input); return ok({ version: await skillRepository.getVersion(data.skillId, data.versionId) ?? null }); } }),
    tool({ name: "skill.restore_version", description: "Restore a skill from a previous version snapshot.", zodSchema: skillVersionInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillVersionInput.parse(input); return ok(await skillRepository.restoreVersion(data.skillId, data.versionId, data)); } }),
    tool({ name: "skill.validate", description: "Validate skill schema, tool policy, and examples.", zodSchema: skillValidateInput, inputSchema: skillMutationJsonSchema, execute: async (input) => ok({ validation: validateSkillDefinition(skillValidateInput.parse(input).skill) }) }),
    tool({ name: "skill.resolve_for_node", description: "Resolve assigned skills into deterministic instructions, tools, and conflicts for a node.", zodSchema: skillResolveInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillResolveInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ policy: await resolveSkillsForNode(node, skillRepository, { workspaceSystemPolicy: data.workspaceSystemPolicy, projectPolicy: data.projectPolicy, runInstructions: data.runInstructions, platformTools: data.platformTools, runAuthorizedTools: data.runAuthorizedTools, riskPolicy: data.riskPolicy }) }); } }),
    tool({ name: "workspace.get_nodes", description: "List workspace nodes.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ nodes: await workspaceRepository.getNodes() }); } }),
    tool({ name: "workspace.get_graph", description: "Get workflow graph nodes and edges.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const nodes = await workspaceRepository.getNodes(); return ok({ nodes, edges: nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id }))) }); } }),
    tool({ name: "workspace.get_node", description: "Get one workspace node.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ node: await workspaceRepository.getNode(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "workspace.create_node", description: "Create a workspace node.", zodSchema: createNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = createNodeInput.parse(input); return ok(await workspaceRepository.createNode(data.node as WorkspaceNode, data)); } }),
    tool({ name: "workspace.delete_node", description: "Delete an unreferenced workspace node.", zodSchema: deleteNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = deleteNodeInput.parse(input); return ok(await workspaceRepository.deleteNode(data.id, data)); } }),
    tool({ name: "workspace.clone_node", description: "Clone a workspace node.", zodSchema: cloneNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = cloneNodeInput.parse(input); return ok(await workspaceRepository.cloneNode(data.id, data.newId, data)); } }),
    tool({ name: "workspace.update_node", description: "Patch a workspace node.", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, data.patch as Partial<WorkspaceNode>, data)); } }),
    tool({ name: "workspace.update_node_prompt", description: "Update a node prompt.", zodSchema: updatePrompt, inputSchema: updatePromptJsonSchema, execute: async (input) => { const data = updatePrompt.parse(input); const node = await workspaceRepository.updateNodePrompt(data.id, data.prompt, data); return ok({ node, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
    tool({ name: "workspace.update_node_schema", description: "Update a node output schema (legacy alias; outputSchema is canonical).", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const node = await workspaceRepository.updateNodeSchema(data.id, data.schema, data); return ok({ node, workspaceVersion: await workspaceRepository.getWorkspaceVersion(), canonicalField: "outputSchema" }); } }),
    tool({ name: "workspace.update_node_input_schema", description: "Update node input JSON Schema.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const issues = validateJsonSchema(data.schema); if (issues.length) throw new Error(issues.join("; ")); return ok(await workspaceRepository.updateNode(data.id, { inputSchema: data.schema }, data, "node.input_schema_updated")); } }),
    tool({ name: "workspace.update_node_output_schema", description: "Update node output JSON Schema draft 2020-12.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const issues = validateJsonSchema(data.schema); if (issues.length) throw new Error(issues.join("; ")); return ok(await workspaceRepository.updateNode(data.id, { outputSchema: data.schema, schema: data.schema }, data, "node.output_schema_updated")); } }),
    ...[["workspace.update_node_tools", "allowedTools", "node.tools_updated"], ["workspace.update_node_skills", "assignedSkills", "node.skills_updated"], ["workspace.update_node_dependencies", "dependsOn", "node.dependencies_updated"]].map(([name, field, eventType]) => tool({ name, description: `Update node ${field}.`, zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, { [field]: data.patch[field] } as Partial<WorkspaceNode>, data, eventType)); } })),
    ...[["workspace.update_node_metadata", "metadata"], ["workspace.update_node_model_config", "modelConfig"]].map(([name, field]) => tool({ name, description: `Update node ${field}.`, zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, { [field]: data.patch[field] } as Partial<WorkspaceNode>, data, field === "modelConfig" ? "node.model_config_updated" : "node.updated")); } })),
    tool({ name: "workspace.reorder_nodes", description: "Reorder nodes without changing dependencies.", zodSchema: updateGraphInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateGraphInput.parse(input); return ok(await workspaceRepository.updateGraph(data, data, "graph.reordered")); } }),
    tool({ name: "workspace.update_graph", description: "Atomically update workflow graph.", zodSchema: updateGraphInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateGraphInput.parse(input); return ok(await workspaceRepository.updateGraph(data, data, "graph.updated")); } }),
    tool({ name: "workspace.validate_graph", description: "Validate workflow graph.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const { validateWorkspaceGraph } = await import("../../workspace/nodes.js"); const nodes = await workspaceRepository.getNodes(); return ok({ validation: validateWorkspaceGraph(nodes) }); } }),
    tool({ name: "workspace.validate_node", description: "Validate a node or existing node id.", zodSchema: validateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = validateNodeInput.parse(input); const node = data.node ?? (data.id ? await workspaceRepository.getNode(data.id) : undefined); return ok({ valid: !!node && validateJsonSchema((node as WorkspaceNode).inputSchema).length === 0 && validateJsonSchema((node as WorkspaceNode).outputSchema).length === 0 }); } }),
    tool({ name: "workspace.get_node_effective_config", description: "Get safe resolved node execution config without secrets.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeId.parse(input).id); return ok({ config: node ? { prompt: node.prompt, inputSchema: node.inputSchema, outputSchema: node.outputSchema, modelConfig: node.modelConfig ?? {}, assignedSkills: node.assignedSkills ?? [], effectiveTools: node.allowedTools, riskLevel: node.riskLevel, approvalRequirements: node.riskLevel === "publish" || node.riskLevel === "admin" ? ["explicit_approval"] : [] } : null }); } }),
    tool({ name: "workspace.export_workspace", description: "Export workspace data.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok(await workspaceRepository.exportWorkspace()); } }),
    tool({ name: "workspace.import_workspace", description: "Import workspace data.", zodSchema: importWorkspace, inputSchema: importWorkspaceJsonSchema, execute: async (input) => { const data = importWorkspace.parse(input); return ok(await workspaceRepository.importWorkspace({ ...data, nodes: data.nodes as WorkspaceNode[] | undefined })); } }),
    tool({ name: "article_body.get_schema", description: "Get article body schema.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ schema: articleBodyJsonSchema }); } }),
    tool({ name: "article_body.validate", description: "Validate article body data.", zodSchema: validateArticle, inputSchema: validateArticleJsonSchema, execute: async (input) => { const articleBody = validateArticle.parse(input).articleBody; const parsed = articleBodySchema.safeParse(articleBody); return ok({ valid: parsed.success, articleBody: parsed.success ? parsed.data : undefined, issues: parsed.success ? [] : parsed.error.issues }); } }),
    tool({ name: "stage.save_output", description: "Save stage output.", zodSchema: saveOutput, inputSchema: saveOutputJsonSchema, execute: async (input) => { const data = saveOutput.parse(input); const output = await workspaceRepository.saveStageOutput(data.stage, data.value, data.id); return ok({ output, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
    tool({ name: "stage.get_output", description: "Get stage output.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ output: await workspaceRepository.getStageOutput(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "stage.list_outputs", description: "List stage outputs.", zodSchema: listOutputs, inputSchema: listOutputsJsonSchema, execute: async (input) => ok({ outputs: await workspaceRepository.listStageOutputs(listOutputs.parse(input).stage) }) }),
    tool({ name: "learning.record_observation", description: "Record a learning observation.", zodSchema: recordObservation, inputSchema: recordObservationJsonSchema, execute: async (input) => { const data = recordObservation.parse(input); const observation = await learningRepository.recordObservation(data.observation, data.metadata); return ok({ observation, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
    tool({ name: "learning.list_observations", description: "List learning observations.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ observations: await learningRepository.listObservations() }); } }),
    tool({ name: "publish.build_payload", description: "Build a dry-run publish payload without side effects.", zodSchema: publishBuild, inputSchema: publishBuildJsonSchema, execute: async (input) => { const data = publishBuild.parse(input); return ok({ payload: { articleBody: data.articleBody, target: data.target, dryRun: true, builtAt: new Date().toISOString() } }); } }),
    tool({ name: "publish.validate_payload", description: "Validate a dry-run publish payload.", zodSchema: publishValidate, inputSchema: publishValidateJsonSchema, execute: async (input) => { const parsed = publishValidate.safeParse(input); return ok({ valid: parsed.success, issues: parsed.success ? [] : parsed.error.issues }); } }),
    tool({ name: "repository.get_health", description: "Return safe repository health metadata.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ health: await repositoryManager.getRepositoryHealth() }); } }),
    tool({ name: "workflow.start_dry_run", description: "Start a Publishing Conductor dry-run workflow without external MCP calls or publishing side effects.", zodSchema: startDryRunInput, inputSchema: startDryRunJsonSchema, execute: async (input) => { const data = startDryRunInput.parse(input); return ok({ run: await startDryRun(data, executionRepository) }); } }),
    tool({ name: "workflow.get_run", description: "Get dry-run workflow execution state.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => ok({ run: await getRun(runIdInput.parse(input).runId, executionRepository) ?? null }) }),
    tool({ name: "workflow.list_runs", description: "List dry-run workflow executions.", zodSchema: listRunsInput, inputSchema: listRunsJsonSchema, execute: async (input) => ok({ runs: await listRuns(listRunsInput.parse(input), executionRepository) }) }),
    tool({ name: "workflow.run_next_node", description: "Run the next dependency-ready Publishing Conductor node in dry-run mode only.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => ok({ run: await runNextNode(runIdInput.parse(input).runId, { executionRepository, workspaceRepository }) }) }),
    tool({ name: "workflow.reset_run", description: "Reset a dry-run workflow execution to its initial queued state.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => ok({ run: await resetRun(runIdInput.parse(input).runId, executionRepository) }) }),
    tool({ name: "usage.record", description: "Record estimated or actual model usage without storing raw prompts or secrets.", zodSchema: recordModelUsageSchema, inputSchema: usageRecordJsonSchema, execute: async (input) => ok({ record: await recordModelUsage(recordModelUsageSchema.parse(input), usageRepository) }) }),
    tool({ name: "usage.list_records", description: "List model usage records with optional filters.", zodSchema: usageFiltersSchema, inputSchema: usageFiltersJsonSchema, execute: async (input) => ok({ records: await usageRepository.list(usageFiltersSchema.parse(input)) }) }),
    tool({ name: "usage.get_summary", description: "Summarize estimated model token and cost usage with optional filters.", zodSchema: usageFiltersSchema, inputSchema: usageFiltersJsonSchema, execute: async (input) => ok({ summary: await summarizeModelUsage(usageFiltersSchema.parse(input), usageRepository) }) }),
    tool({ name: "usage.get_budget_status", description: "Return estimated budget status for a run or project.", zodSchema: budgetStatusInput, inputSchema: budgetStatusJsonSchema, execute: async (input) => ok({ budgetStatus: await getBudgetStatus(budgetStatusInput.parse(input), usageRepository) }) }),
    tool({ name: "project.list", description: "List registered project MCP connections with safe, non-secret metadata.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const projects = await projectRepository.list(); return ok({ projects: projects.map((config) => toProjectSummary(config)) }); } }),
    tool({ name: "project.get", description: "Get one registered project MCP connection with safe, non-secret metadata.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => { const config = await projectRepository.get(projectIdInput.parse(input).projectId); return ok({ project: config ? toProjectSummary(config) : null }); } }),
    tool({ name: "project.test_connection", description: "Run a primitive MCP initialize against a project's external server. Read-only; no publishing side effects.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => { const config = await requireProject(projectIdInput.parse(input).projectId); return ok({ connection: await new ProjectMcpAdapter(config).testConnection() }); } }),
    tool({ name: "project.list_tools", description: "List a project's remote MCP tools via tools/list. Returns safe tool names and descriptions only.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => { const config = await requireProject(projectIdInput.parse(input).projectId); return ok(await new ProjectMcpAdapter(config).listTools()); } }),
    tool({ name: "project.call_tool", description: "Call an approved read-only tool on a registered project MCP server. Publishing and mutation tools are blocked by project allowedTools.", zodSchema: projectCallToolInput, inputSchema: projectCallToolJsonSchema, execute: async (input) => { const data = projectCallToolInput.parse(input); const config = await requireProject(data.projectId); return ok({ call: await new ProjectMcpAdapter(config).callTool(data.tool, data.arguments) }); } }),
    tool({ name: "project.validate_handoff", description: "Dry structural validation of a handoff against the project content_source.v1 / article_body.v1 contract. Read-only; no publishing.", zodSchema: validateHandoffInput, inputSchema: validateHandoffJsonSchema, execute: async (input) => { const data = validateHandoffInput.parse(input); const config = await requireProject(data.projectId); return ok({ validation: validateHandoff(config, { contentSource: data.contentSource, articleBody: data.articleBody }) }); } })
  ];
}

export const toolError = (error: unknown) => error instanceof ZodError ? { ok: false, error: { code: "validation_error", issues: error.issues } } : { ok: false, error: { code: "tool_error", message: error instanceof Error ? error.message : "Unknown error" } };
