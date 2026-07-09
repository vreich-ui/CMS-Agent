import { z, ZodError, type ZodTypeAny } from "zod";
import { articleBodyJsonSchema, articleBodySchema } from "./store.js";
import type { WorkspaceNode } from "../../workspace/nodeTypes.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { getRun, listRuns, resetRun, runNextNode, startDryRun } from "../../workspace/executor.js";
import { getBudgetStatus, recordModelUsage, recordModelUsageSchema, summarizeModelUsage, usageFiltersSchema } from "../../observability/modelUsage.js";

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
const updatePrompt = z.object({ id: z.string().min(1), prompt: z.string().min(1) }).strict();
const updateSchema = z.object({ id: z.string().min(1), schema: z.unknown() }).strict();
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

const objectSchema = (properties: JsonSchema = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const emptyJsonSchema = objectSchema();
const nodeIdJsonSchema = objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]);
const updatePromptJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 } }, ["id", "prompt"]);
const updateSchemaJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, schema: {} }, ["id", "schema"]);
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

const ok = (data: unknown) => ({ ok: true, data });

const tool = (definition: WorkspaceTool) => definition;

export function createWorkspaceTools(): WorkspaceTool[] {
  const workspaceRepository = repositoryManager.getWorkspaceRepository();
  const executionRepository = repositoryManager.getExecutionRepository();
  const usageRepository = repositoryManager.getUsageRepository();
  const learningRepository = repositoryManager.getLearningRepository();
  return [
    tool({ name: "workspace.get_nodes", description: "List workspace nodes.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ nodes: await workspaceRepository.getNodes() }); } }),
    tool({ name: "workspace.get_node", description: "Get one workspace node.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ node: await workspaceRepository.getNode(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "workspace.update_node_prompt", description: "Update a node prompt.", zodSchema: updatePrompt, inputSchema: updatePromptJsonSchema, execute: async (input) => { const data = updatePrompt.parse(input); const node = await workspaceRepository.updateNodePrompt(data.id, data.prompt); return ok({ node, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
    tool({ name: "workspace.update_node_schema", description: "Update a node schema.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const node = await workspaceRepository.updateNodeSchema(data.id, data.schema); return ok({ node, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
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
    tool({ name: "usage.get_budget_status", description: "Return estimated budget status for a run or project.", zodSchema: budgetStatusInput, inputSchema: budgetStatusJsonSchema, execute: async (input) => ok({ budgetStatus: await getBudgetStatus(budgetStatusInput.parse(input), usageRepository) }) })
  ];
}

export const toolError = (error: unknown) => error instanceof ZodError ? { ok: false, error: { code: "validation_error", issues: error.issues } } : { ok: false, error: { code: "tool_error", message: error instanceof Error ? error.message : "Unknown error" } };
