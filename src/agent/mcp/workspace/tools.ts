import { z } from "zod";
import { coerceSchemaInput, validateJsonSchema, type WorkspaceMutationMeta } from "./store.js";
import { workspaceRiskLevels, type WorkspaceNode } from "../../workspace/nodeTypes.js";
import { type WorkspaceActor, type WorkspaceChangeSource } from "../../workspace/changeTypes.js";
import { coerceJsonObjectInput, metaJson, mutationMeta, objectSchema, ok, tool, toolError, type JsonSchema, type WorkspaceTool, MissingPatchFieldError } from "./toolKit.js";
export { metaJson, mutationMeta, objectSchema, ok, tool, toolError, workspaceActorSchema } from "./toolKit.js";
export type { JsonSchema, WorkspaceTool } from "./toolKit.js";
import { createChangesTools } from "./changesTools.js";
import { createConstellationTools } from "./constellationTools.js";
import { createImprovementTools } from "./improvementTools.js";
import { createAgentTools } from "./agentTools.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { DEFAULT_EXECUTION_MODE, MAX_LIST_RUNS_LIMIT, assessRunStall, getRun, isApprovalGateOnlyBlock, listRuns, listRunsPage, resetRun, retryNode, runModeSummary, runNextNode, setOperatorPublishDecision, startDryRun, summarizeRunForList, updateRunStatus } from "../../workspace/executor.js";
import { conductorCache, getRunContext, planRun, summarizeRunCost, RUN_CONTEXT_KEY } from "../../workspace/conductor.js";
import { executionStatuses, type WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { WorkspaceToolError } from "../../workspace/workspaceErrors.js";
import { getWorkspaceNode } from "../../workspace/nodes.js";
import { validateOutput } from "../../execution/outputValidator.js";
import { evaluatePublishReadiness, publishRun } from "../../workspace/publisher.js";
import { runDeterministicPublishPayload } from "../../workspace/publishPayload.js";
import { executeNode, getEffectivePrompt, getNodeDetails, listNodeExecutions, listNodeOutputs, prepareNodeExecution, validateAgainstNodeSchema } from "../../workspace/nodeRuntime.js";
import { getBudgetStatus, recordModelUsage, recordModelUsageSchema, summarizeModelUsage, usageFiltersSchema } from "../../observability/modelUsage.js";
import { aggregateNodeTimingsByNode } from "../../workspace/nodeTimings.js";
import { toProjectSummary, validateHandoff } from "../../projects/projectRegistry.js";
import { getProjectHooks } from "../../projects/projectHooks.js";
import { createProject, deleteProject, projectCreateSchema, projectRegistrationContract, projectUpdateSchema, updateProject } from "../../projects/projectAdmin.js";
import { ProjectMcpAdapter, READ_TOOL_ALLOWLIST } from "../../projects/projectMcpAdapter.js";
import { normalizeSkillInput, skillDefinitionSchema, validateSkillDefinition } from "../../skills/skillValidator.js";
import { resolveSkillsForNode } from "../../skills/skillResolver.js";
import { skillStatuses, type SkillDefinition } from "../../skills/skillTypes.js";
import { listTools as listControlledTools, getTool as getControlledTool, resolveEffectiveToolsForNode } from "../../tools/toolResolver.js";
import { executeTool, getToolExecution, listToolExecutions } from "../../tools/toolExecutor.js";
import { createSiteDuplicationTools } from "./siteDuplicationTools.js";
import { createSiteCredentialTools } from "./siteCredentialTools.js";

const emptyInput = z.object({}).strict();

// Run statuses the multi-step loops below must never advance past. One constant, because this list used to
// be written out inline three times with slightly different spellings, and R-18's new "paused" state would
// have been silently missed by every one of them — a paused run would have kept executing nodes.
const HALTED_RUN_STATUSES: string[] = ["completed", "failed", "blocked", "cancelled", "paused"];

// Wall-clock budget for the in-request advance loops (workflow.run_node / run_until / run_all). The
// serverless platform kills a function at ~300s with no goodbye: the loop simply stopped mid-run and
// the record sat at status "running" with nothing in flight and no way to tell stalled from working.
// The loops now stop dispatching BEFORE that ceiling, return the persisted state with an explicit
// driver note, and the caller re-invokes to continue (each node advance is individually persisted, so
// stopping between nodes loses nothing). Long runs belong on the Cloud Run conductor job
// (scripts/run-conductor-job, docs/platform/DIRECTION.md Phase 1), which has no such ceiling.
//
// S1 (chat-path, 2026-08-17): the default was 240s, which is ABOVE the ceiling every real caller of
// this endpoint enforces — the chat client's tool-call timeout and the MCP gateway both cut the
// connection well before that, so the caller saw a transport error while the loop kept driving the
// run server-side, then a second call found a run mid-node with a live claim. The default is now 45s
// and an env override is CLAMPED to that ceiling; a longer window can never be configured back in.
// A caller may pass `budgetMs` (5s..45s) per call to trade throughput for a faster round-trip. Runs
// that need more than one window continue on the scheduled continuation tick (runContinuation.ts),
// which is why run_all now also reports `continued: true` when it hands a live run back.
export const RUN_DRIVER_TIME_BUDGET_CEILING_MS = 45_000;
export const RUN_DRIVER_TIME_BUDGET_FLOOR_MS = 5_000;
export const RUN_DRIVER_TIME_BUDGET_MS = (() => {
  const configured = Number(process.env.RUN_DRIVER_TIME_BUDGET_MS);
  const requested = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : RUN_DRIVER_TIME_BUDGET_CEILING_MS;
  return Math.min(requested, RUN_DRIVER_TIME_BUDGET_CEILING_MS);
})();
const driverBudgetMs = (requested?: number): number => {
  if (requested === undefined || !Number.isFinite(requested)) return RUN_DRIVER_TIME_BUDGET_MS;
  return Math.max(RUN_DRIVER_TIME_BUDGET_FLOOR_MS, Math.min(RUN_DRIVER_TIME_BUDGET_CEILING_MS, Math.floor(requested)));
};
const driverTimeBudgetNote = (budgetMs: number): string => `Driver time budget (${budgetMs}ms) reached before the caller's request ceiling; the run's state is persisted and nothing is in flight. The scheduled continuation tick advances a queued/running run on its own; call the same tool again to drive it sooner, or use the Cloud Run conductor job for runs longer than one request window.`;
const DRIVER_TIME_BUDGET_NOTE = driverTimeBudgetNote(RUN_DRIVER_TIME_BUDGET_MS);

// The compact run view workflow.run_all returns. A full run record (inputs, outputs, stageOutputs,
// artifacts) for a 20-node run is hundreds of KB — far past what a chat tool result can carry, and
// none of it is what the caller needs to decide the next step. workflow.get_run stays full.
export type CompactRunView = {
  runId: string;
  requestId?: string;
  projectId: string;
  status: WorkflowExecutionRecord["status"];
  currentNodeId?: string;
  budget?: { budgetUsd?: number; budgetBlock?: WorkflowExecutionRecord["budgetBlock"] };
  errors: string[];
  approvalsRequired: WorkflowExecutionRecord["approvalsRequired"];
  nodes: Array<{ nodeId: string; status: string; warnings?: string[]; errors?: string[]; durationMs?: number; dispatch?: unknown; lastDispatch?: unknown }>;
};
export const compactRun = (run: WorkflowExecutionRecord): CompactRunView => ({
  runId: run.runId,
  ...(run.requestId !== undefined ? { requestId: run.requestId } : {}),
  projectId: run.projectId,
  status: run.status,
  ...(run.currentNodeId !== undefined ? { currentNodeId: run.currentNodeId } : {}),
  ...(run.budgetUsd !== undefined || run.budgetBlock !== undefined ? { budget: { ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}), ...(run.budgetBlock !== undefined ? { budgetBlock: run.budgetBlock } : {}) } } : {}),
  errors: run.errors,
  approvalsRequired: run.approvalsRequired,
  nodes: run.nodes.map((node) => ({
    nodeId: node.nodeId,
    status: node.status,
    ...(node.warnings !== undefined ? { warnings: node.warnings } : {}),
    ...(node.errors !== undefined ? { errors: node.errors } : {}),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
    ...(node.dispatch !== undefined ? { dispatch: node.dispatch } : {}),
    ...(node.lastDispatch !== undefined ? { lastDispatch: node.lastDispatch } : {})
  }))
});
const RUN_LIVE_STATUSES: string[] = ["queued", "running"];

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
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime()
}).strict();
// R-6 / R-23 (delete half): the payload's articleBody is no longer typed by a workspace-local
// {schema_version, nodes} schema — that monolith is deleted. The wire accepts an opaque object here
// and the execute paths validate it against the article_body node's OWN outputSchema (the same single
// authority the executor, buildInitialRun, and the publisher enforce). Beyond the node's envelope,
// the client's fetched contract governs the body — never a workspace-local copy.
const publishPayloadSchema = z.object({
  articleBody: z.unknown(),
  target: z.enum(["preview", "cms"]),
  dryRun: z.literal(true),
  builtAt: z.string().datetime()
}).strict();
const nodeId = z.object({ id: z.string().min(1) }).strict();
const updatePrompt = z.object({ id: z.string().min(1), prompt: z.string().min(1), ...mutationMeta }).strict();
const updateSchema = z.object({ id: z.string().min(1), schema: z.unknown(), ...mutationMeta }).strict();
const createNodeInput = z.object({ node: z.any(), ...mutationMeta }).strict();
const deleteNodeInput = z.object({ id: z.string().min(1), ...mutationMeta }).strict();
const cloneNodeInput = z.object({ id: z.string().min(1), newId: z.string().min(1), ...mutationMeta }).strict();
const updateNodeInput = z.object({ id: z.string().min(1), patch: z.record(z.string(), z.unknown()), ...mutationMeta }).strict();

// R-1 — data-loss guard for the single-field node writers.
//
// These tools build their store patch as `{ [field]: data.patch[field] }`. When the caller's patch
// omits that field the expression yields `{ allowedTools: undefined }`, and the store's
// `{ ...existing, ...patch }` merge then overwrites the stored array with undefined, which
// normalizeNode quietly rounds down to []. The call returned ok:true while destroying the field —
// reproduced against a live workspace. Refuse instead: a writer asked to write nothing is a caller
// bug, and the only safe answer is to not write.
const requirePatchField = (patch: Record<string, unknown>, field: string, toolName: string): unknown => {
  if (!(field in patch) || patch[field] === undefined) throw new MissingPatchFieldError(toolName, field);
  return patch[field];
};

// W6.4 (docs/plan/WORK-ORDER-2026-08-12-determinism.md): workspace.update_node_model_config used to
// share the map above's handler, building its store patch as `{ modelConfig: data.patch.modelConfig }`.
// requirePatchField stops the undefined-overwrite case, but modelConfig is a settings BAG (maxTurns,
// toolCallLimit, timeout, budgetUsd, maxOutputTokens, ...), not a single opaque value like a prompt
// string — and updateNode's store-level merge (`{ ...existing, ...patch }`, store.ts) is a SHALLOW
// top-level merge. A caller who wants to change only one knob and sends `{ maxTurns: 8 }` had that
// object become the ENTIRE new modelConfig: every other previously-set key was silently dropped. That
// is a real, reproduced data-loss bug, distinct from the allowedTools/assignedSkills/dependsOn case
// above (those are arrays with no keys to preserve — wholesale replace is the correct semantics for
// them). Fixed by giving modelConfig its own handler: the caller's patch.modelConfig is deep-merged
// onto the node's EXISTING stored modelConfig before it ever reaches updateNode, so updateNode's own
// shallow merge sees an object that already carries every key the caller did not mention. Nested plain
// objects merge key-by-key recursively; any other value (including arrays) replaces outright, matching
// ordinary JSON-merge-patch semantics.
const isPlainRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const deepMergeRecords = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainRecord(value) && isPlainRecord(base[key]) ? deepMergeRecords(base[key] as Record<string, unknown>, value) : value;
  }
  return merged;
};
const updateGraphInput = z.object({ create: z.array(z.any()).optional(), update: z.array(z.record(z.string(), z.unknown()).and(z.object({ id: z.string().min(1) }))).optional(), delete: z.array(z.string().min(1)).optional(), dependencies: z.record(z.string(), z.array(z.string().min(1))).optional(), orderedNodeIds: z.array(z.string().min(1)).optional(), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(), allowCanonicalNodeRemoval: z.boolean().optional(), adminApproved: z.boolean().optional(), ...mutationMeta }).strict();
const validateNodeInput = z.object({ node: z.any().optional(), id: z.string().min(1).optional() }).strict();
const importWorkspace = z.object({ nodes: z.array(workspaceNodeImport).optional(), stageOutputs: z.array(stageOutputImport).optional(), learningObservations: z.array(learningObservationImport).optional() }).strict();
const saveOutput = z.object({ id: z.string().min(1).optional(), stage: z.string().min(1), value: z.unknown() }).strict();
const listOutputs = z.object({ stage: z.string().min(1).optional() }).strict();
const recordObservation = z.object({ observation: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional(), runId: z.string().min(1).optional(), nodeId: z.string().min(1).optional() }).strict();
// W0 complement (determinism program, 2026-08-12): this tool used to do exactly one thing — wrap an
// articleBody you already had in a {target, dryRun, builtAt} envelope and refuse it if it did not
// satisfy the article_body node's outputSchema. That is useful for a caller holding a body, and
// useless for the question actually being asked ("what would publish_payload emit for this run?").
// With `runId` it now answers that question directly, off the SAME deterministic engine the executor
// uses (publishPayload.ts), so the projection cannot drift from what the node would really produce.
// Exactly one of articleBody / runId; the articleBody path is byte-identical to its old behavior.
const publishBuild = z.object({ articleBody: z.unknown().optional(), runId: z.string().min(1).optional(), target: z.enum(["preview", "cms"]).default("preview") }).strict()
  .refine((value) => (value.articleBody === undefined) !== (value.runId === undefined), { message: "supply exactly one of `articleBody` (wrap a body you already hold) or `runId` (project what publish_payload would emit for that run)" });
const publishValidate = z.object({ payload: publishPayloadSchema }).strict();
// The one remaining definition of "what an article body is": the article_body node's own outputSchema.
// Returns the error list (empty = valid) so wire tools can refuse or report without re-encoding the shape.
const validateAgainstArticleBodyNode = (articleBody: unknown): string[] => {
  const result = validateOutput(articleBody, getWorkspaceNode("article_body")?.outputSchema);
  return result.ok ? [] : result.errors;
};
// Live execution is the DEFAULT (see DEFAULT_EXECUTION_MODE); "mock" is the explicit opt-in for
// cheap CI/test runs. Stated on the wire so a caller reading only the tool schema knows which of the
// two they are about to get, and what a mock artifact is worth.
const EXECUTION_MODE_DESCRIPTION = "Execution mode. \"openai\" (DEFAULT) calls the configured model provider and produces real node output. \"mock\" produces deterministic placeholder output generated from each node's outputSchema — structurally valid but content-free, for cheap CI/test runs; mock artifacts must never be treated as publishable content. Every run reports its mode back on workflow.get_run / workflow.list_runs as `mode`.";

const startDryRunInput = z.object({ projectId: z.string().min(1), input: z.any(), workflowId: z.string().min(1).optional(), executionMode: z.enum(["mock", "openai"]).default(DEFAULT_EXECUTION_MODE), entrypoint: z.enum(["article_body"]).optional(), articleBody: z.unknown().optional(), budgetUsd: z.number().nonnegative().optional(), requestId: z.string().min(1).optional() }).strict();

// S1 (chat-path) — CALLER-SUPPLIED REQUEST IDS. The knowledge rule every client dialect states is
// that request ids are supplied by the caller and never generated. A project that declares
// objectDialect.requestIdPattern is saying its request-id form is a hard contract: start_dry_run
// therefore REQUIRES `requestId` for such a project (request_id_required, naming the pattern) and
// VALIDATES a supplied one (invalid_request_id, naming the pattern) before a run is minted — the same
// point at which publish_run already rejects a malformed id, moved to the front of the run so a
// twenty-node run cannot be built on an id its publish step will refuse. A project with no pattern
// keeps the auto-minted join key it always had.
//
// A MOCK run is exempt from the REQUIREMENT (a supplied id is still validated): it is a dry-run
// that never reaches the client and mints nothing external, so there is no client request id to
// honour — it keeps the auto-minted join key. Live (openai) runs for a pattern project must supply.
const REQUEST_ID_FORM = "req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case";
async function resolveCallerRequestId(projectId: string, requestId: string | undefined, executionMode: "mock" | "openai"): Promise<string | undefined> {
  const config = await repositoryManager.getProjectRepository().get(projectId);
  const pattern = config?.objectDialect?.requestIdPattern;
  if (!pattern) return requestId;
  if (requestId === undefined) {
    if (executionMode === "mock") return undefined;
    throw new WorkspaceToolError("request_id_required", `Project ${projectId} requires a caller-supplied requestId matching ${pattern} (${REQUEST_ID_FORM}); request ids are never auto-generated for this project.`, { projectId, requestIdPattern: pattern });
  }
  let regex: RegExp;
  try { regex = new RegExp(pattern); } catch { regex = new RegExp("^req_[a-z0-9_]+_\\d{8}_\\d{2}$"); }
  if (!regex.test(requestId)) {
    throw new WorkspaceToolError("invalid_request_id", `requestId "${requestId}" does not match project ${projectId}'s pattern ${pattern} (${REQUEST_ID_FORM}).`, { projectId, requestIdPattern: pattern, requestId });
  }
  return requestId;
}
const runNodeInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1).optional(), approved: z.boolean().optional() }).strict();
const runUntilInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1), approved: z.boolean().optional() }).strict();
const runIdInput = z.object({ runId: z.string().min(1) }).strict();
// F3 (T-2, run_1785352838155_l544ye): budgetUsd is optional so plain resume (no ceiling change)
// keeps working exactly as before; supplying it raises (or sets) the run's ceiling in the same call.
const resumeRunInput = z.object({ runId: z.string().min(1), budgetUsd: z.number().nonnegative().optional() }).strict();
const runNextNodeInput = z.object({ runId: z.string().min(1), approved: z.boolean().optional() }).strict();
// P0 §2.2 — the ONE setter for the operator's durable publish decision (run.operatorPublishDecision).
const operatorPublishDecisionInput = z.object({ runId: z.string().min(1), decision: z.enum(["approved", "withheld"]) }).strict();
const listRunsInput = z.object({
  projectId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  status: z.enum(executionStatuses).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(MAX_LIST_RUNS_LIMIT).optional(),
  cursor: z.string().min(1).optional()
}).strict();
const runContextInput = z.object({ runId: z.string().min(1), projectId: z.string().min(1) }).strict();
const readinessInputSchema = z.object({
  verifiedMediaRefs: z.array(z.string().min(1)).optional(),
  taxonomy: z.object({ tags: z.array(z.string()).optional(), acceptedEmpty: z.boolean().optional() }).strict().optional(),
  approval: z.object({ pinned: z.boolean().optional(), approvedBy: z.string().min(1).optional(), approvedAt: z.string().min(1).optional() }).strict().optional(),
  releaseBehavior: z.string().min(1).optional(),
  hardConstraints: z.object({ contentPath: z.string().min(1).optional(), artifactProtocol: z.string().min(1).optional(), legacyFallbacksUsed: z.boolean().optional() }).strict().optional()
}).strict();
const publishRunInput = z.object({ runId: z.string().min(1), projectId: z.string().min(1).optional(), requestId: z.string().min(1), approved: z.boolean().optional(), live: z.boolean().optional(), publishedTime: z.string().datetime().nullable().optional(), readiness: readinessInputSchema.optional() }).strict();
const publishReadinessInput = z.object({ projectId: z.string().min(1), runId: z.string().min(1).optional(), articleBody: z.unknown().optional(), readiness: readinessInputSchema.optional() }).strict();
const budgetStatusInput = z.object({ projectId: z.string().min(1).optional(), runId: z.string().min(1).optional(), budgetUsd: z.number().nonnegative().optional() }).strict();
const projectIdInput = z.object({ projectId: z.string().min(1) }).strict();
const validateHandoffInput = z.object({ projectId: z.string().min(1), contentSource: z.unknown().optional(), articleBody: z.unknown().optional() }).strict();
const projectCallToolInput = z.object({ projectId: z.string().min(1), tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();
const projectCreateInput = z.object({ project: projectCreateSchema, ...mutationMeta }).strict();
const projectUpdateInput = z.object({ projectId: z.string().min(1), patch: projectUpdateSchema, ...mutationMeta }).strict();
const projectDeleteInput = z.object({ projectId: z.string().min(1), ...mutationMeta }).strict();
const skillIdInput = z.object({ skillId: z.string().min(1) }).strict();
const skillCreateInput = z.object({ skill: z.unknown(), ...mutationMeta }).strict();
const skillUpdateInput = z.object({ skillId: z.string().min(1), patch: z.record(z.string(), z.unknown()), ...mutationMeta }).strict();
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
const nodeToolInput = z.object({ nodeId: z.string().min(1) }).strict();
const nodeValidateInput = z.object({ nodeId: z.string().min(1), value: z.unknown() }).strict();
const nodePrepareInput = z.object({ nodeId: z.string().min(1), input: z.unknown().optional(), dependencyOutputs: z.record(z.string(), z.unknown()).optional(), modelConfig: z.record(z.string(), z.unknown()).optional() }).strict();
const nodeExecuteInput = z.object({ nodeId: z.string().min(1), input: z.unknown().optional(), runId: z.string().min(1).optional(), dependencyOutputs: z.record(z.string(), z.unknown()).optional(), executionMode: z.enum(["mock", "openai"]).default(DEFAULT_EXECUTION_MODE), modelConfig: z.record(z.string(), z.unknown()).optional(), expectedWorkspaceVersion: z.number().int().nonnegative().optional() }).strict();
const nodeQueryInput = z.object({ nodeId: z.string().min(1).optional(), runId: z.string().min(1).optional(), executionId: z.string().min(1).optional(), artifactType: z.string().min(1).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
const nodeRetryInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1).optional(), executionId: z.string().min(1).optional() }).strict();


const emptyJsonSchema = objectSchema();
const nodeIdJsonSchema = objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]);
const updatePromptJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 }, ...metaJson }, ["id", "prompt"]);
// `schema` is advertised as object-or-boolean (the two legal JSON Schema shapes) rather than the
// previous permit-anything `{}`, so a client has the type information it needs not to stringify it.
// coerceSchemaInput still accepts a stringified schema for the clients that do it anyway (R-3).
const updateSchemaJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, schema: { type: ["object", "boolean"] }, ...metaJson }, ["id", "schema"]);
const mutationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, newId: { type: "string", minLength: 1 }, node: {}, patch: { type: "object" }, create: { type: "array" }, update: { type: "array" }, delete: { type: "array", items: { type: "string" } }, dependencies: { type: "object" }, orderedNodeIds: { type: "array", items: { type: "string" } }, positions: { type: "object" }, ...metaJson });
const workspaceNodeJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, prompt: { type: "string" }, schema: {}, updatedAt: { type: "string", format: "date-time" } }, ["id", "name", "prompt", "schema", "updatedAt"]);
const stageOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {}, createdAt: { type: "string", format: "date-time" } }, ["id", "stage", "value", "createdAt"]);
const learningObservationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, observation: { type: "string", minLength: 1 }, metadata: { type: "object" }, createdAt: { type: "string", format: "date-time" } }, ["id", "observation", "createdAt"]);
const importWorkspaceJsonSchema = objectSchema({ nodes: { type: "array", items: workspaceNodeJsonSchema }, stageOutputs: { type: "array", items: stageOutputJsonSchema }, learningObservations: { type: "array", items: learningObservationJsonSchema } });
const saveOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {} }, ["stage", "value"]);
const listOutputsJsonSchema = objectSchema({ stage: { type: "string", minLength: 1 } });
const recordObservationJsonSchema = objectSchema({ observation: { type: "string", minLength: 1 }, metadata: { type: "object" }, runId: { type: "string", minLength: 1, description: "Optional: attribute this observation to the run that produced it, so it can be joined back later." }, nodeId: { type: "string", minLength: 1, description: "Optional: attribute this observation to the node that produced it." } }, ["observation"]);
// 2.8 (handoff 2026-08-10): lifecycle/archival for learning observations. Nothing is ever hard-deleted
// — archive is soft: the record stays, gains status:"archived" plus archivedAt/archivedReason, and
// listObservations excludes it by default (includeArchived:true opts back in). This is what lets
// curation/migration skip a sunset directive's observations (e.g. the "[ALIGN" coordination-board
// records — see scripts/purgeAlignObservations.ts) without needing every reader updated separately.
const listObservationsInput = z.object({ includeArchived: z.boolean().optional() }).strict();
const listObservationsJsonSchema = objectSchema({ includeArchived: { type: "boolean", description: "Include archived (soft-deleted) observations. Default false." } });
const archiveObservationInput = z.object({ id: z.string().min(1), reason: z.string().min(1).optional() }).strict();
const archiveObservationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1, description: "Optional human-readable reason recorded on the archived observation." } }, ["id"]);
// Bulk archive by a text prefix rather than an arbitrary predicate — a predicate function cannot cross
// the MCP wire, and a prefix match is exactly what the sunset "[ALIGN" coordination-board directive
// needs (every one of those 27 records' observation text starts with the same marker).
const archiveObservationsInput = z.object({ textPrefix: z.string().min(1), reason: z.string().min(1).optional(), dryRun: z.boolean().optional() }).strict();
const archiveObservationsJsonSchema = objectSchema({ textPrefix: { type: "string", minLength: 1, description: "Archive every active observation whose `observation` text starts with this prefix." }, reason: { type: "string", minLength: 1 }, dryRun: { type: "boolean", description: "Preview the count/ids without archiving anything. Default false." } }, ["textPrefix"]);
// Advertised as an opaque object: the authority on the body's shape is the article_body node's OWN
// outputSchema (fetch it via node.get_output_schema) and, beyond that envelope, the client's fetched
// contract — never a workspace-local article schema baked into a tool's input schema.
const articleBodyArgJsonSchema = { type: "object", description: "Client-shaped client_object.v1 envelope (formerly article_body.v1) produced by the article_body node. Validated against that node's own outputSchema (see node.get_output_schema), never a workspace-local article schema." };
const publishBuildJsonSchema = objectSchema({ articleBody: articleBodyArgJsonSchema, runId: { type: "string", minLength: 1, description: "Project what publish_payload would emit for this run, built deterministically from the run's own article_body/artifact_plan stage outputs (dry_run_publish_payload.v1). Mutually exclusive with articleBody." }, target: { type: "string", enum: ["preview", "cms"], default: "preview" } }, []);
const publishPayloadJsonSchema = objectSchema({ articleBody: articleBodyArgJsonSchema, target: { type: "string", enum: ["preview", "cms"] }, dryRun: { const: true }, builtAt: { type: "string", format: "date-time" } }, ["articleBody", "target", "dryRun", "builtAt"]);
const publishValidateJsonSchema = objectSchema({ payload: publishPayloadJsonSchema }, ["payload"]);
const startDryRunJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, input: {}, workflowId: { type: "string", minLength: 1 }, executionMode: { type: "string", enum: ["mock", "openai"], default: DEFAULT_EXECUTION_MODE, description: EXECUTION_MODE_DESCRIPTION }, entrypoint: { type: "string", enum: ["article_body"], description: "Late-stage entrypoint. With a supplied valid articleBody the run enters at article_body -> publish_payload -> publication_controller and earlier ideation/research/draft nodes are seeded as completed (not re-run)." }, articleBody: { type: "object", description: "Output to seed as the article_body node's result for a late-stage entrypoint run. Validated against the article_body node's OWN outputSchema (see node.get_output_schema) — not against a workspace-local article shape, which the node rejects. Rejected before the run is created, with the failing fields named." }, budgetUsd: { type: "number", minimum: 0, description: "Optional per-run cost ceiling in USD. Default OFF (omit = no gate). When set, the conductor halts the run (status blocked, paused for budget) before dispatching any node once the run's accrued estimated model cost reaches this ceiling; the pending node is not executed. Inspect via workflow.get_run_cost (ledger.budget)." }, requestId: { type: "string", minLength: 1, description: "Caller-supplied request id for this run. REQUIRED for a live (openai) run when the project declares objectDialect.requestIdPattern (platform, dr-lurie, fernwell: req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case) — the tool refuses with request_id_required/invalid_request_id naming the pattern; request ids are never auto-generated for such a run. Optional (auto-minted) for a mock dry-run or a project without a pattern; a supplied id is always validated." } }, ["projectId", "input"]);
const runIdJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 } }, ["runId"]);
const resumeRunJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, budgetUsd: { type: "number", minimum: 0, description: "Optional: raise (or set) the run's per-run cost ceiling in the same call that resumes it. Omit to resume unchanged — this is what makes the budget gate's own remedy (\"raise budgetUsd and resume\") actually reachable; previously resume_run took only runId and there was no way to raise the ceiling that blocked the run." } }, ["runId"]);
const runNextNodeJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, approved: { type: "boolean" } }, ["runId"]);
const operatorPublishDecisionJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, decision: { type: "string", enum: ["approved", "withheld"], description: "\"withheld\" is a durable operator veto: it blocks workflow.publish_run and every publish-risk node for this run regardless of approved/live flags, until replaced. \"approved\" records explicit, durable operator approval — the record an executed publish_execution.v1's approvalMatched must match." } }, ["runId", "decision"]);

// R-19 — the run-advancing tools used to advertise mutationJsonSchema, the WORKSPACE-mutation shape. That
// schema has no `runId` property, lists nothing as required, and (like every objectSchema) sets
// additionalProperties: false. So the advertised contract simultaneously omitted the one argument these
// tools require and forbade sending it. Any client that validates against tools/list before calling —
// which is every strict client, and is why T6.6 could not be executed — was locked out of run_node,
// run_until, run_all and retry_node. Verified live: the served workflow_run_all schema still shows
// required: [] with no runId. Each tool now advertises exactly its own Zod shape.
const runNodeJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, approved: { type: "boolean" } }, ["runId"]);
const runUntilJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, approved: { type: "boolean" } }, ["runId", "nodeId"]);
const runAllJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, approved: { type: "boolean" }, budgetMs: { type: "number", minimum: RUN_DRIVER_TIME_BUDGET_FLOOR_MS, maximum: RUN_DRIVER_TIME_BUDGET_CEILING_MS, description: `Wall-clock budget for THIS call in ms (${RUN_DRIVER_TIME_BUDGET_FLOOR_MS}..${RUN_DRIVER_TIME_BUDGET_CEILING_MS}); default ${RUN_DRIVER_TIME_BUDGET_MS}. The loop stops dispatching when it is reached and the run continues on the scheduled continuation tick.` } }, ["runId"]);
const runAllInput = z.object({ runId: z.string().min(1), approved: z.boolean().optional(), budgetMs: z.number().min(RUN_DRIVER_TIME_BUDGET_FLOOR_MS).max(RUN_DRIVER_TIME_BUDGET_CEILING_MS).optional() }).strict();

// T5 fix 1 (2026-08-13) — the loops below stop the moment a run reports a halted status, so a run
// sitting at the publish-approval gate could not be re-entered by calling run_all again WITH approval:
// the loop never took its first step and the operator had to run resume_run + retry_node by hand.
// This is the one-step preamble that gets past that guard, and only for the one blocker approval
// answers — isApprovalGateOnlyBlock refuses a budget hold, an operator veto, a non-affirmative
// controller decision and a failed node. The clearing itself lives in advanceRun (executor), under the
// run lock and the compare-and-swap, so the gate is re-evaluated there against fresh state rather than
// trusted from this read. Exactly one attempt: if the run is still blocked after it, the re-dispatch
// refused for a reason approval does not answer, and the loop must not keep paying for that discovery.
const enterApprovedGateBlockedRun = async (
  run: WorkflowExecutionRecord | undefined,
  approved: boolean | undefined,
  advance: () => Promise<WorkflowExecutionRecord>
): Promise<WorkflowExecutionRecord | undefined> => (run && approved === true && isApprovalGateOnlyBlock(run) ? advance() : run);
const runContextJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 } }, ["runId", "projectId"]);
const readinessJsonSchema = objectSchema({
  verifiedMediaRefs: { type: "array", items: { type: "string" }, description: "Artifact refs confirmed pdf-tool materialized for this request (e.g. from list_artifacts_for_request/verify_article_images). A Blob-shaped media src not listed here is treated as unverified." },
  taxonomy: objectSchema({ tags: { type: "array", items: { type: "string" } }, acceptedEmpty: { type: "boolean" } }),
  approval: objectSchema({ pinned: { type: "boolean" }, approvedBy: { type: "string" }, approvedAt: { type: "string" } }),
  releaseBehavior: { type: "string", description: "publish_now | schedule | build_only | unpublish." },
  hardConstraints: objectSchema({ contentPath: { type: "string" }, artifactProtocol: { type: "string" }, legacyFallbacksUsed: { type: "boolean" } })
});
const publishRunJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, requestId: { type: "string", minLength: 1, description: "req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case; you supply it." }, approved: { type: "boolean", description: "Explicit human approval; required (with live) for a real publish." }, live: { type: "boolean", description: "Must be true — with approved:true and operator-enabled publishing — for a real publish; otherwise a dry-run plan is returned and nothing external is called." }, publishedTime: { type: "string", description: "Optional ISO timestamp: omit/past publishes now, future schedules." }, readiness: readinessJsonSchema }, ["runId", "requestId"]);
const publishReadinessJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, articleBody: { ...articleBodyArgJsonSchema, description: "Article body to evaluate; omit to resolve it from the run. Judged by the project's readiness policy against the article_body node's own outputSchema, never a workspace-local article schema." }, readiness: readinessJsonSchema }, ["projectId"]);
const listRunsJsonSchema = objectSchema({
  projectId: { type: "string", minLength: 1 },
  workflowId: { type: "string", minLength: 1 },
  status: { type: "string", enum: [...executionStatuses], description: "Only runs with exactly this status." },
  from: { type: "string", format: "date-time", description: "Only runs with startedAt >= this ISO timestamp." },
  to: { type: "string", format: "date-time", description: "Only runs with startedAt <= this ISO timestamp." },
  limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size; default 20, max 100." },
  cursor: { type: "string", minLength: 1, description: "Opaque nextCursor from the previous page; omit for the first page." }
});
const usageFiltersJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, workflowId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, status: { type: "string", enum: ["estimated", "actual"], description: "Only records of this kind: \"actual\" = measured model usage (the population budgets meter), \"estimated\" = mock/dry-run deterministic estimates (never accrue against budgetUsd)." } });
const usageRecordJsonSchema = objectSchema({ usageId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, workflowId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, agentId: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, provider: { type: "string", minLength: 1 }, inputTokens: { type: "integer", minimum: 0 }, outputTokens: { type: "integer", minimum: 0 }, totalTokens: { type: "integer", minimum: 0 }, reasoningTokens: { type: "integer", minimum: 0 }, cachedInputTokens: { type: "integer", minimum: 0 }, costUsdEstimate: { type: "number", minimum: 0 }, currency: { const: "USD" }, status: { type: "string", enum: ["estimated", "actual"] }, recordedAt: { type: "string", format: "date-time" }, metadata: { type: "object" } }, ["model", "provider", "inputTokens", "outputTokens", "status"]);
const budgetStatusJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, budgetUsd: { type: "number", minimum: 0 } });
const projectIdJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 } }, ["projectId"]);
const validateHandoffJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, contentSource: {}, articleBody: {} }, ["projectId"]);
const projectCallToolJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, tool: { type: "string", minLength: 1 }, arguments: { type: "object", additionalProperties: true } }, ["projectId", "tool", "arguments"]);
// Same shape as project.call_tool — the two differ in what the server permits and enforces
// (READ_TOOL_ALLOWLIST, no approval concept at this wire layer either way), not in their input.
const projectCallReadToolInput = projectCallToolInput;
const projectCallReadToolJsonSchema = projectCallToolJsonSchema;
const projectDefinitionJsonSchema = objectSchema({
  projectId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,62}$", description: "Lowercase kebab-case id, e.g. acme-daily." },
  name: { type: "string", minLength: 1, maxLength: 120 },
  mcpEndpointEnvVar: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$", description: "Environment variable NAME for the MCP endpoint URL — never the URL itself. Required, and it still WINS when populated (the break-glass override), but you no longer have to SET it in the deployment if you pass mcpEndpoint." },
  mcpEndpoint: { type: "string", format: "uri", maxLength: 512, description: "The MCP endpoint URL ITSELF, stored on the registry record — an endpoint is not a secret (the TOKEN is, and stays an env var NAME). https only, no user:password@, no query, no fragment, so a credential cannot be smuggled into the registry. Supplying it means a new tenant needs no <CLIENT>_MCP_ENDPOINT env var on this deployment. Resolution: env var first, this second. On project.update, null clears it." },
  authMode: { type: "string", enum: ["none", "bearer_env"], default: "bearer_env" },
  tokenEnvVar: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$", description: "Environment variable NAME holding the bearer token — never the token itself. Required for bearer_env." },
  allowedTools: { type: "array", items: { type: "string" }, default: [], description: "Legacy allow-list; a listed tool resolves to \"allowed\". toolPolicies/defaultToolPolicy are the richer control." },
  defaultToolPolicy: { type: "string", enum: ["allowed", "needs_approval", "blocked"], description: "Fallback permission for any tool not named in allowedTools/toolPolicies. Absent = blocked (deny-all)." },
  toolPolicies: { type: "object", additionalProperties: { type: "string", enum: ["allowed", "needs_approval", "blocked"] }, description: "Per-tool permission overrides (highest precedence): allowed | needs_approval | blocked." },
  contentContract: { type: "object", additionalProperties: false, properties: { contentContract: { type: "string" } } },
  status: { type: "string", enum: ["active", "disabled"], default: "active" }
}, ["projectId", "name", "mcpEndpointEnvVar"]);
const projectCreateJsonSchema = objectSchema({ project: projectDefinitionJsonSchema, ...metaJson }, ["project"]);
// Patch surface = the definition minus identity (projectId) and policy (publishingPolicy — server-controlled),
// PLUS ONE deliberate exception (T2, 2026-08-13): operatorPublishDefault. publishingPolicy stays
// excluded as a whole — a caller can never patch publishEnabled (the hard kill-switch precondition
// every publish gate checks) or requiresExplicitPublish through this surface — but a project's
// operator publish default (whether a NEW run starts pre-approved, see ProjectPublishingPolicy.
// operatorDefault) is exposed by its own narrow, separately-validated field name instead of by
// opening the nested publishingPolicy object, so accepting it can never smuggle in the rest of the
// policy. See projectAdmin.ts's projectUpdateSchema/updateProject for the enforcement.
const projectPatchJsonSchema = (() => {
  const { projectId: _identity, ...patchable } = projectDefinitionJsonSchema.properties as Record<string, unknown>;
  return objectSchema({
    ...patchable,
    tokenEnvVar: { oneOf: [{ type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, { type: "null" }], description: "Env var NAME for the bearer token; null removes it (only valid when authMode is none)." },
    mcpEndpoint: { oneOf: [{ type: "string", format: "uri", maxLength: 512 }, { type: "null" }], description: "The MCP endpoint URL stored on the record (https, no credentials/query/fragment); null clears it, returning the project to env-var-only endpoint resolution." },
    operatorPublishDefault: { type: "string", enum: ["approved", "require_explicit"], description: "Whether a NEW run for this project starts with the operator's durable publish decision already \"approved\" (publishingPolicy.operatorDefault). \"require_explicit\" (or omitting this field entirely) is today's unchanged behavior: no run starts pre-approved. Never sets \"withheld\" — an operator veto is only ever explicit, via workflow.set_operator_publish_decision, and always overrides this default." }
  });
})();
const projectUpdateJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, patch: projectPatchJsonSchema, ...metaJson }, ["projectId", "patch"]);
const projectDeleteJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, ...metaJson }, ["projectId"]);
const skillIdJsonSchema = objectSchema({ skillId: { type: "string", minLength: 1 } }, ["skillId"]);
const controlledToolIdJsonSchema = objectSchema({ toolId: { type: "string", minLength: 1 } }, ["toolId"]);
const controlledToolTestJsonSchema = objectSchema({ toolId: { type: "string", minLength: 1 }, input: {}, runId: { type: "string" }, nodeId: { type: "string", minLength: 1 }, projectId: { type: "string" }, skillId: { type: "string" }, approvedToolIds: { type: "array", items: { type: "string" } }, runAuthorizedTools: { type: "array", items: { type: "string" } }, platformAllowedTools: { type: "array", items: { type: "string" } }, maxRiskLevel: { type: "string", enum: [...workspaceRiskLevels] } }, ["toolId", "nodeId"]);
const effectiveToolsJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, runId: { type: "string" }, approvedToolIds: { type: "array", items: { type: "string" } }, runAuthorizedTools: { type: "array", items: { type: "string" } }, platformAllowedTools: { type: "array", items: { type: "string" } }, maxRiskLevel: { type: "string", enum: [...workspaceRiskLevels] } }, ["nodeId"]);
// Split schemas (the advertised-vs-actual R-3/R-19 class): tool.get_execution REQUIRES
// toolExecutionId and rejects the filter fields; tool.list_executions takes only the filters. One
// shared schema previously advertised all four fields as optional on both, so a caller following
// the advertisement got validation_error either way.
const getToolExecutionJsonSchema = objectSchema({ toolExecutionId: { type: "string", minLength: 1 } }, ["toolExecutionId"]);
const listToolExecutionsJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, toolId: { type: "string", minLength: 1 } });
const nodeToolJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 } }, ["nodeId"]);
const nodeValidateJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, value: {} }, ["nodeId", "value"]);
// Per-tool node JSON schemas. Each advertises EXACTLY what its Zod schema accepts, so a client is
// never rejected for sending a field the schema advertised. (A single shared broad schema previously
// advertised executionMode/input/modelConfig on the query/prepare/retry tools whose strict Zod
// schemas then rejected them — "advertised but rejected".)
const nodeExecuteJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, input: {}, runId: { type: "string" }, dependencyOutputs: { type: "object" }, executionMode: { type: "string", enum: ["mock", "openai"], default: DEFAULT_EXECUTION_MODE, description: EXECUTION_MODE_DESCRIPTION }, modelConfig: { type: "object" }, expectedWorkspaceVersion: { type: "integer", minimum: 0 } }, ["nodeId"]);
const nodePrepareJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, input: {}, dependencyOutputs: { type: "object" }, modelConfig: { type: "object" } }, ["nodeId"]);
const nodeQueryJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, runId: { type: "string" }, executionId: { type: "string" }, artifactType: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } });
const nodeRetryJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string" }, executionId: { type: "string" } }, ["runId"]);

const skillMutationJsonSchema = objectSchema({ skillId: { type: "string", minLength: 1 }, newSkillId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, versionId: { type: "string", minLength: 1 }, skill: {}, patch: { type: "object" }, workspaceSystemPolicy: { type: "string" }, projectPolicy: { type: "string" }, runInstructions: { type: "string" }, platformTools: { type: "array", items: { type: "string" } }, runAuthorizedTools: { type: "array", items: { type: "string" } }, riskPolicy: { type: "string", enum: [...workspaceRiskLevels] }, ...metaJson });
// skill.create advertises exactly its accept shape: a nested `skill` object requiring only the
// authoring essentials (skillId/name/description/instructions). Everything else is server-defaulted
// (see normalizeSkillInput) and validated by skillDefinitionSchema. Sharing the broad
// skillMutationJsonSchema (above) previously advertised flat fields (newSkillId/runInstructions/…)
// the strict handler rejects — the same "advertised but rejected" trap the node tools already avoid.
const skillDefinitionJsonSchema = objectSchema({
  skillId: { type: "string", minLength: 1, description: "Stable unique skill id, e.g. my_skill." },
  name: { type: "string", minLength: 1 },
  description: { type: "string", minLength: 1 },
  instructions: { type: "string", minLength: 1, description: "What a node does when it runs this skill." },
  version: { type: "string", minLength: 1, description: "Defaults to 1.0.0." },
  status: { type: "string", enum: [...skillStatuses], description: "Defaults to active." },
  riskLevel: { type: "string", enum: [...workspaceRiskLevels], description: "Defaults to read." },
  inputSchema: { description: "JSON Schema for the skill input; defaults to { type: object }." },
  outputSchema: { description: "JSON Schema for the skill output; defaults to { type: object }." },
  allowedTools: { type: "array", items: { type: "string" } },
  requiredArtifacts: { type: "array", items: { type: "string" } },
  producedArtifacts: { type: "array", items: { type: "string" } },
  examples: { type: "array", items: objectSchema({ name: { type: "string", minLength: 1 }, input: {}, output: {}, notes: { type: "string" } }, ["name", "input", "output"]), description: "Recommended; a basic placeholder is generated if omitted." },
  preconditions: { type: "array", items: { type: "string" } },
  completionCriteria: { type: "array", items: { type: "string" } },
  blockerCriteria: { type: "array", items: { type: "string" } },
  memoryPolicy: objectSchema({ namespaces: { type: "array", items: { type: "string" } }, read: { type: "boolean" }, write: { type: "boolean" }, retention: { type: "string" } }),
  toolPolicy: objectSchema({ requestedTools: { type: "array", items: { type: "string" } }, mutatingToolsRequireApproval: { type: "boolean" }, notes: { type: "string" } }),
  metadata: { type: "object" },
  createdAt: { type: "string", format: "date-time", description: "Server-owned; omit and the server stamps it." },
  updatedAt: { type: "string", format: "date-time", description: "Server-owned; omit and the server stamps it." }
}, ["skillId", "name", "description", "instructions"]);
const skillCreateJsonSchema = objectSchema({ skill: skillDefinitionJsonSchema, ...metaJson }, ["skill"]);
// Remote MCP clients (e.g. connectors) serialize object-typed arguments as JSON strings; the `skill`
// field arrives stringified and, left uncoerced, fails skillDefinitionSchema.parse with "expected
// object, received string". Coerce it back exactly as workspace.create_node coerces its `node` arg.
const coerceSkillArg = (input: unknown): unknown => (!!input && typeof input === "object" && !Array.isArray(input)) ? { ...(input as Record<string, unknown>), skill: coerceJsonObjectInput((input as Record<string, unknown>).skill) } : input;


// Request-scoped attribution context. The secure proxy stamps a verified human actor via
// headers; direct MCP callers default to an agent actor. Attribution only — never authorization.
export type WorkspaceToolContext = { actor?: WorkspaceActor; source?: WorkspaceChangeSource; requestId?: string; allowedToolNames?: readonly string[] };

export function createWorkspaceTools(context: WorkspaceToolContext = {}): WorkspaceTool[] {
  const workspaceRepository = repositoryManager.getWorkspaceRepository();
  const changeRepository = repositoryManager.getChangeRepository();
  const meta = <T extends Partial<WorkspaceMutationMeta>>(data: T): T & WorkspaceMutationMeta => ({
    ...data,
    actor: data.actor ?? context.actor ?? { kind: "agent" },
    source: data.source ?? context.source ?? "mcp",
    correlation: data.correlation ?? (context.requestId ? { requestId: context.requestId } : undefined)
  });
  const executionRepository = repositoryManager.getExecutionRepository();
  const usageRepository = repositoryManager.getUsageRepository();
  const nodeTimingRepository = repositoryManager.getNodeTimingRepository();
  const learningRepository = repositoryManager.getLearningRepository();
  const projectRepository = repositoryManager.getProjectRepository();
  const skillRepository = repositoryManager.getSkillRepository();
  const requireProject = async (id: string) => {
    const config = await projectRepository.get(id);
    if (!config) throw new Error(`Unknown projectId: ${id}`);
    return config;
  };
  return [
    // node.list was a duplicate of workspace.get_nodes and is now a deprecated alias (see
    // DEPRECATED_TOOL_ALIASES in server.ts); same for node.get_execution and
    // workspace.update_node_schema below.
    tool({ name: "node.get", description: "Get a safe complete node inspection record with compact summaries of this node's actual revisions; use changes tools for full historical snapshots.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => ok({ node: await getNodeDetails(nodeToolInput.parse(input).nodeId, { workspaceRepository, executionRepository }) }) }),
    tool({ name: "node.get_effective_prompt", description: "Resolve the effective prompt for one node without secrets.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => ok(await getEffectivePrompt(nodeToolInput.parse(input).nodeId, workspaceRepository)) }),
    tool({ name: "node.get_effective_tools", description: "Resolve effective controlled tools for one node.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => ok({ tools: await resolveEffectiveToolsForNode(nodeToolInput.parse(input).nodeId) }) }),
    tool({ name: "node.get_effective_skills", description: "Resolve effective skill policy for one node.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeToolInput.parse(input).nodeId); if (!node) throw new Error("Unknown node"); return ok({ policy: await resolveSkillsForNode(node, skillRepository) }); } }),
    tool({ name: "node.get_input_schema", description: "Get one node input schema.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeToolInput.parse(input).nodeId); return ok({ schema: node?.inputSchema ?? null }); } }),
    tool({ name: "node.get_output_schema", description: "Get one node output schema.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeToolInput.parse(input).nodeId); return ok({ schema: node?.outputSchema ?? null }); } }),
    tool({ name: "node.validate_input", description: "Validate input against a node input schema.", zodSchema: nodeValidateInput, inputSchema: nodeValidateJsonSchema, execute: async (input) => { const data = nodeValidateInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ validation: validateAgainstNodeSchema(data.value, node.inputSchema) }); } }),
    tool({ name: "node.validate_output", description: "Validate output against a node output schema.", zodSchema: nodeValidateInput, inputSchema: nodeValidateJsonSchema, execute: async (input) => { const data = nodeValidateInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ validation: validateAgainstNodeSchema(data.value, node.outputSchema) }); } }),
    tool({ name: "node.prepare_execution", description: "Prepare one node execution without calling the model.", zodSchema: nodePrepareInput, inputSchema: nodePrepareJsonSchema, execute: async (input) => ok({ preparation: await prepareNodeExecution(nodePrepareInput.parse(input), { workspaceRepository }) }) }),
    tool({ name: "node.execute", description: "Execute exactly one node independently from the full workflow.", zodSchema: nodeExecuteInput, inputSchema: nodeExecuteJsonSchema, execute: async (input) => ok(await executeNode(nodeExecuteInput.parse(input), { workspaceRepository, executionRepository })) }),
    tool({ name: "node.list_executions", description: "List node executions with filters (by runId/executionId/nodeId).", zodSchema: nodeQueryInput, inputSchema: nodeQueryJsonSchema, execute: async (input) => ok({ executions: await listNodeExecutions(nodeQueryInput.parse(input), executionRepository) }) }),
    tool({ name: "node.get_latest_output", description: "Get latest node output with filters.", zodSchema: nodeQueryInput, inputSchema: nodeQueryJsonSchema, execute: async (input) => ok({ output: (await listNodeOutputs(nodeQueryInput.parse(input), executionRepository))[0] ?? null }) }),
    tool({ name: "node.list_outputs", description: "List node outputs by node, run, execution, artifact type, or date range.", zodSchema: nodeQueryInput, inputSchema: nodeQueryJsonSchema, execute: async (input) => ok({ outputs: await listNodeOutputs(nodeQueryInput.parse(input), executionRepository) }) }),
    tool({ name: "node.retry", description: "Retry a previous independent node execution.", zodSchema: nodeRetryInput, inputSchema: nodeRetryJsonSchema, execute: async (input) => { const data = nodeRetryInput.parse(input); const run = await executionRepository.getRun(data.runId); const state = run?.nodes.find((node) => !data.nodeId || node.nodeId === data.nodeId); if (!run || !state) return ok({ execution: null }); return ok(await executeNode({ nodeId: state.nodeId, input: (state.input as any)?.input, dependencyOutputs: (state.input as any)?.dependencies, executionMode: run.executionMode ?? DEFAULT_EXECUTION_MODE }, { workspaceRepository, executionRepository })); } }),
    tool({ name: "node.cancel", description: "Cancel an independent node execution record.", zodSchema: nodeRetryInput, inputSchema: nodeRetryJsonSchema, execute: async (input) => { const data = nodeRetryInput.parse(input); const run = await executionRepository.getRun(data.runId); if (!run) return ok({ execution: null }); return ok({ execution: await executionRepository.saveRun({ ...run, status: "cancelled", nodes: run.nodes.map((node) => data.nodeId && node.nodeId !== data.nodeId ? node : { ...node, status: node.status === "completed" ? node.status : "cancelled" }), updatedAt: new Date().toISOString() }) }); } }),

    tool({ name: "tool.list", description: "List controlled tool registry entries.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ tools: listControlledTools().map(({ handler, inputSchema, outputSchema, ...tool }) => tool) }); } }),
    tool({ name: "tool.get", description: "Get one controlled tool definition.", zodSchema: controlledToolIdInput, inputSchema: controlledToolIdJsonSchema, execute: async (input) => { const toolDef = getControlledTool(controlledToolIdInput.parse(input).toolId); if (!toolDef) return ok({ tool: null }); const { handler, inputSchema, outputSchema, ...safe } = toolDef; return ok({ tool: safe }); } }),
    tool({ name: "tool.test", description: "Execute a controlled tool through policy and audit gateway.", zodSchema: controlledToolTestInput, inputSchema: controlledToolTestJsonSchema, execute: async (input) => { const data = controlledToolTestInput.parse(input); return ok(await executeTool(data.toolId, data.input, { runId: data.runId, nodeId: data.nodeId, projectId: data.projectId, skillId: data.skillId, approvedToolIds: data.approvedToolIds, runAuthorizedTools: data.runAuthorizedTools, platformAllowedTools: data.platformAllowedTools, maxRiskLevel: data.maxRiskLevel })); } }),
    tool({ name: "tool.get_effective_for_node", description: "Resolve effective controlled tools for a node.", zodSchema: effectiveToolsInput, inputSchema: effectiveToolsJsonSchema, execute: async (input) => { const data = effectiveToolsInput.parse(input); return ok({ tools: await resolveEffectiveToolsForNode(data.nodeId, data) }); } }),
    // ToolExecutor's full audit records are in-process memory and die with a serverless invocation —
    // which is why these two tools answered [] for every past conductor run (H7's diagnosis path had
    // no data). The runner now persists per-call stubs on each node's execution state
    // (state.toolCalls: toolId, toolExecutionId, status, errorCode, durationMs — metadata only,
    // never payloads), so both tools fall back to the persisted run records: executions are
    // listable by run after the process that made them is long gone.
    tool({ name: "tool.get_execution", description: "Get a controlled tool execution audit record: the full in-process record when this process executed it, else the persisted per-call stub from the run record. Requires toolExecutionId; use tool.list_executions to search by run/node/tool.", zodSchema: toolExecutionInput, inputSchema: getToolExecutionJsonSchema, execute: async (input) => {
      const { toolExecutionId } = toolExecutionInput.parse(input);
      const inProcess = getToolExecution(toolExecutionId);
      if (inProcess) return ok({ execution: inProcess, source: "in_process" });
      for (const run of await listRuns({}, executionRepository)) {
        for (const node of run.nodes) {
          const stub = node.toolCalls?.find((call) => call.toolExecutionId === toolExecutionId);
          if (stub) return ok({ execution: { ...stub, runId: run.runId, nodeId: node.nodeId }, source: "run_record" });
        }
      }
      return ok({ execution: null });
    } }),
    tool({ name: "tool.list_executions", description: "List controlled tool execution audit records by runId/nodeId/toolId — in-process records merged with the per-call stubs persisted on run records, so a past run's tool activity stays listable.", zodSchema: listToolExecutionsInput, inputSchema: listToolExecutionsJsonSchema, execute: async (input) => {
      const filters = listToolExecutionsInput.parse(input);
      const inProcess = listToolExecutions(filters);
      const seen = new Set(inProcess.map((record) => record.toolExecutionId));
      const persisted: unknown[] = [];
      const runs = filters.runId ? [await getRun(filters.runId, executionRepository)].filter((run) => run !== undefined) : await listRuns({}, executionRepository);
      for (const run of runs) {
        for (const node of run!.nodes) {
          if (filters.nodeId && node.nodeId !== filters.nodeId) continue;
          for (const stub of node.toolCalls ?? []) {
            if (filters.toolId && stub.toolId !== filters.toolId) continue;
            if (stub.toolExecutionId && seen.has(stub.toolExecutionId)) continue;
            persisted.push({ ...stub, runId: run!.runId, nodeId: node.nodeId, source: "run_record" });
          }
        }
      }
      return ok({ executions: [...inProcess, ...persisted] });
    } }),
    tool({ name: "skill.list", description: "List reusable workspace skills.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ skills: await skillRepository.list() }); } }),
    tool({ name: "skill.get", description: "Get one reusable workspace skill.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => ok({ skill: await skillRepository.get(skillIdInput.parse(input).skillId) ?? null }) }),
    tool({ name: "skill.create", description: "Create a versioned reusable skill from a nested `skill` object; only skillId/name/description/instructions are required, other fields are defaulted.", zodSchema: skillCreateInput, inputSchema: skillCreateJsonSchema, execute: async (input) => { const data = skillCreateInput.parse(coerceSkillArg(input)); return ok(await skillRepository.create(skillDefinitionSchema.parse(normalizeSkillInput(data.skill)), meta(data))); } }),
    tool({ name: "skill.update", description: "Patch a reusable skill and create a version snapshot.", zodSchema: skillUpdateInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillUpdateInput.parse(input); return ok(await skillRepository.update(data.skillId, data.patch as Partial<SkillDefinition>, meta(data))); } }),
    tool({ name: "skill.delete", description: "Delete a reusable skill definition.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => ok(await skillRepository.delete(skillIdInput.parse(input).skillId)) }),
    tool({ name: "skill.clone", description: "Clone a reusable skill under a new id.", zodSchema: skillCloneInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillCloneInput.parse(input); return ok(await skillRepository.clone(data.skillId, data.newSkillId, meta(data))); } }),
    tool({ name: "skill.assign", description: "Assign a skill id to a node without copying skill text into the node.", zodSchema: skillAssignInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillAssignInput.parse(input); if (!await skillRepository.get(data.skillId)) throw new Error(`Unknown skill: ${data.skillId}`); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); const assignedSkills = [...(node.assignedSkills ?? []), data.skillId].filter((id, index, ids) => ids.indexOf(id) === index); return ok(await workspaceRepository.updateNode(data.nodeId, { assignedSkills }, meta(data), "node.skill_assigned")); } }),
    tool({ name: "skill.unassign", description: "Remove a skill assignment from a node.", zodSchema: skillAssignInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillAssignInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok(await workspaceRepository.updateNode(data.nodeId, { assignedSkills: (node.assignedSkills ?? []).filter((id) => id !== data.skillId) }, meta(data), "node.skill_unassigned")); } }),
    tool({ name: "skill.list_versions", description: "List snapshots for a skill.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => ok({ versions: await skillRepository.listVersions(skillIdInput.parse(input).skillId) }) }),
    tool({ name: "skill.get_version", description: "Get one skill version snapshot.", zodSchema: skillVersionInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillVersionInput.parse(input); return ok({ version: await skillRepository.getVersion(data.skillId, data.versionId) ?? null }); } }),
    tool({ name: "skill.restore_version", description: "Restore a skill from a previous version snapshot.", zodSchema: skillVersionInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillVersionInput.parse(input); return ok(await skillRepository.restoreVersion(data.skillId, data.versionId, meta(data))); } }),
    tool({ name: "skill.validate", description: "Validate skill schema, tool policy, and examples.", zodSchema: skillValidateInput, inputSchema: skillMutationJsonSchema, execute: async (input) => ok({ validation: validateSkillDefinition(skillValidateInput.parse(input).skill) }) }),
    tool({ name: "skill.resolve_for_node", description: "Resolve assigned skills into deterministic instructions, tools, and conflicts for a node.", zodSchema: skillResolveInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillResolveInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ policy: await resolveSkillsForNode(node, skillRepository, { workspaceSystemPolicy: data.workspaceSystemPolicy, projectPolicy: data.projectPolicy, runInstructions: data.runInstructions, platformTools: data.platformTools, runAuthorizedTools: data.runAuthorizedTools, riskPolicy: data.riskPolicy }) }); } }),
    tool({ name: "workspace.get_nodes", description: "List workspace nodes.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ nodes: await workspaceRepository.getNodes() }); } }),
    tool({ name: "workspace.get_graph", description: "Get workflow graph nodes and edges.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const nodes = await workspaceRepository.getNodes(); return ok({ nodes, edges: nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id }))) }); } }),
    tool({ name: "workspace.get_node", description: "Get one workspace node.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ node: await workspaceRepository.getNode(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "workspace.create_node", description: "Create a workspace node.", zodSchema: createNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = createNodeInput.parse(input); return ok(await workspaceRepository.createNode(data.node as WorkspaceNode, meta(data))); } }),
    tool({ name: "workspace.delete_node", description: "Delete an unreferenced workspace node.", zodSchema: deleteNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = deleteNodeInput.parse(input); return ok(await workspaceRepository.deleteNode(data.id, meta(data))); } }),
    tool({ name: "workspace.clone_node", description: "Clone a workspace node.", zodSchema: cloneNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = cloneNodeInput.parse(input); return ok(await workspaceRepository.cloneNode(data.id, data.newId, meta(data))); } }),
    tool({ name: "workspace.update_node", description: "Patch a workspace node.", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, data.patch as Partial<WorkspaceNode>, meta(data))); } }),
    tool({ name: "workspace.update_node_prompt", description: "Update a node prompt.", zodSchema: updatePrompt, inputSchema: updatePromptJsonSchema, execute: async (input) => { const data = updatePrompt.parse(input); return ok(await workspaceRepository.updateNodePrompt(data.id, data.prompt, meta(data))); } }),
    tool({ name: "workspace.update_node_input_schema", description: "Update node input JSON Schema.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const schema = coerceSchemaInput(data.schema); const issues = validateJsonSchema(schema); if (issues.length) throw new Error(issues.join("; ")); return ok(await workspaceRepository.updateNode(data.id, { inputSchema: schema }, meta(data), "node.input_schema_updated")); } }),
    tool({ name: "workspace.update_node_output_schema", description: "Update node output JSON Schema draft 2020-12.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const schema = coerceSchemaInput(data.schema); const issues = validateJsonSchema(schema); if (issues.length) throw new Error(issues.join("; ")); return ok(await workspaceRepository.updateNode(data.id, { outputSchema: schema, schema }, meta(data), "node.output_schema_updated")); } }),
    ...[["workspace.update_node_tools", "allowedTools", "node.tools_updated"], ["workspace.update_node_skills", "assignedSkills", "node.skills_updated"], ["workspace.update_node_dependencies", "dependsOn", "node.dependencies_updated"]].map(([name, field, eventType]) => tool({ name, description: `Update node ${field}.`, zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, { [field]: requirePatchField(data.patch, field, name) } as Partial<WorkspaceNode>, meta(data), eventType)); } })),
    tool({ name: "workspace.update_node_metadata", description: "Update node metadata.", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, { metadata: requirePatchField(data.patch, "metadata", "workspace.update_node_metadata") } as Partial<WorkspaceNode>, meta(data), "node.updated")); } }),
    // See the deepMergeRecords comment above requirePatchField for why this tool does not share the
    // wholesale-replace handler the array-valued node writers use.
    tool({ name: "workspace.update_node_model_config", description: "Update node modelConfig. Recursively MERGES the given keys onto the node's existing modelConfig — keys the patch omits are preserved, not dropped; a key present in the patch overwrites (nested plain objects merge key-by-key, any other value including arrays replaces outright).", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); const incoming = requirePatchField(data.patch, "modelConfig", "workspace.update_node_model_config"); if (!isPlainRecord(incoming)) throw new Error("workspace.update_node_model_config: patch.modelConfig must be an object"); const existingNode = await workspaceRepository.getNode(data.id); if (!existingNode) throw new Error(`Unknown node: ${data.id}`); const merged = deepMergeRecords(existingNode.modelConfig ?? {}, incoming); return ok(await workspaceRepository.updateNode(data.id, { modelConfig: merged } as Partial<WorkspaceNode>, meta(data), "node.model_config_updated")); } }),
    tool({ name: "workspace.reorder_nodes", description: "Reorder nodes without changing dependencies.", zodSchema: updateGraphInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateGraphInput.parse(input); return ok(await workspaceRepository.updateGraph(data, meta(data), "graph.reordered")); } }),
    tool({ name: "workspace.update_graph", description: "Atomically update workflow graph.", zodSchema: updateGraphInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateGraphInput.parse(input); return ok(await workspaceRepository.updateGraph(data, meta(data), "graph.updated")); } }),
    tool({ name: "workspace.validate_graph", description: "Validate workflow graph: ids, statuses, risk levels, missing dependencies, cycles, publish-chain edges, and (R-21) that every conductor-sequence node's dependsOn / requiredInputs entries are actually satisfiable by the conductor sequence.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const { validateWorkspaceGraph } = await import("../../workspace/nodes.js"); const nodes = await workspaceRepository.getNodes(); return ok({ validation: validateWorkspaceGraph(nodes) }); } }),
    tool({ name: "workspace.validate_node", description: "Validate a node or existing node id.", zodSchema: validateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = validateNodeInput.parse(input); const node = data.node ?? (data.id ? await workspaceRepository.getNode(data.id) : undefined); return ok({ valid: !!node && validateJsonSchema((node as WorkspaceNode).inputSchema).length === 0 && validateJsonSchema((node as WorkspaceNode).outputSchema).length === 0 }); } }),
    tool({ name: "workspace.get_node_effective_config", description: "Get safe resolved node execution config without secrets.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeId.parse(input).id); return ok({ config: node ? { prompt: node.prompt, inputSchema: node.inputSchema, outputSchema: node.outputSchema, modelConfig: node.modelConfig ?? {}, assignedSkills: node.assignedSkills ?? [], effectiveTools: node.allowedTools, riskLevel: node.riskLevel, approvalRequirements: node.riskLevel === "publish" || node.riskLevel === "admin" ? ["explicit_approval"] : [] } : null }); } }),
    tool({ name: "workspace.export_workspace", description: "Export workspace data.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok(await workspaceRepository.exportWorkspace()); } }),
    tool({ name: "workspace.import_workspace", description: "Import workspace data.", zodSchema: importWorkspace, inputSchema: importWorkspaceJsonSchema, execute: async (input) => { const data = importWorkspace.parse(input); return ok(await workspaceRepository.importWorkspace({ ...data, nodes: data.nodes as WorkspaceNode[] | undefined })); } }),
    // R-6: article_body.get_schema / article_body.validate are retired. They served the workspace-local
    // {schema_version, nodes} monolith — a drifted local copy the article_body node itself rejects. The
    // node's own outputSchema is served by node.get_output_schema and enforced by node.validate_output;
    // the client's own validator (object_validate via project.call_read_tool) is the authority beyond it.
    tool({ name: "stage.save_output", description: "Save stage output.", zodSchema: saveOutput, inputSchema: saveOutputJsonSchema, execute: async (input) => { const data = saveOutput.parse(input); const output = await workspaceRepository.saveStageOutput(data.stage, data.value, data.id); return ok({ output, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
    tool({ name: "stage.get_output", description: "Get stage output.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ output: await workspaceRepository.getStageOutput(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "stage.list_outputs", description: "List stage outputs.", zodSchema: listOutputs, inputSchema: listOutputsJsonSchema, execute: async (input) => ok({ outputs: await workspaceRepository.listStageOutputs(listOutputs.parse(input).stage) }) }),
    tool({ name: "learning.record_observation", description: "Record a learning observation, optionally stamped with the runId/nodeId it came from.", zodSchema: recordObservation, inputSchema: recordObservationJsonSchema, execute: async (input) => { const data = recordObservation.parse(input); const observation = await learningRepository.recordObservation(data.observation, data.metadata, { runId: data.runId, nodeId: data.nodeId }); return ok({ observation, workspaceVersion: await workspaceRepository.getWorkspaceVersion() }); } }),
    tool({ name: "learning.list_observations", description: "List learning observations. Archived (soft-deleted) observations are excluded by default.", zodSchema: listObservationsInput, inputSchema: listObservationsJsonSchema, execute: async (input) => { const data = listObservationsInput.parse(input); return ok({ observations: await learningRepository.listObservations({ includeArchived: data.includeArchived }) }); } }),
    tool({ name: "learning.archive_observation", description: "Archive (soft-delete) one learning observation by id. The record is never removed — it gains status:\"archived\" plus archivedAt/archivedReason and is excluded from listObservations unless includeArchived is set.", zodSchema: archiveObservationInput, inputSchema: archiveObservationJsonSchema, execute: async (input) => {
      const data = archiveObservationInput.parse(input);
      return ok({ observation: await learningRepository.archiveObservation(data.id, data.reason) });
    } }),
    tool({ name: "learning.archive_observations", description: "Bulk-archive every ACTIVE observation whose text starts with textPrefix (e.g. a sunset coordination-board marker). Set dryRun:true to preview the count/ids without archiving anything.", zodSchema: archiveObservationsInput, inputSchema: archiveObservationsJsonSchema, execute: async (input) => {
      const data = archiveObservationsInput.parse(input);
      if (data.dryRun) {
        const matches = (await learningRepository.listObservations()).filter((observation) => observation.observation.startsWith(data.textPrefix));
        return ok({ archived: 0, ids: [], matched: matches.length, matchedIds: matches.map((observation) => observation.id), dryRun: true });
      }
      const result = await learningRepository.archiveObservationsByPredicate((observation) => observation.observation.startsWith(data.textPrefix), data.reason);
      return ok({ ...result, dryRun: false });
    } }),
    tool({ name: "publish.build_payload", description: "Build a dry-run publish payload without side effects. With `articleBody`: wraps a body you already hold in a {target, dryRun, builtAt} envelope; the body must satisfy the article_body node's own outputSchema (see node.get_output_schema) and an invalid body is refused with the failing fields named. With `runId`: projects the dry_run_publish_payload.v1 that publish_payload would emit for that run, built by the same deterministic engine the executor uses (client object carried by reference from the run's article_body output, one read-only object_validate against the client, blockers = union(upstream) - resolved). Never publishes, patches or releases.", zodSchema: publishBuild, inputSchema: publishBuildJsonSchema, execute: async (input) => {
      const data = publishBuild.parse(input);
      if (data.runId !== undefined) {
        const run = await getRun(data.runId);
        if (!run) throw new Error(`unknown_run: ${data.runId}`);
        const built = await runDeterministicPublishPayload({ projectId: run.projectId, clientProjectId: run.projectId, articleBody: run.stageOutputs.article_body, artifactPlan: run.stageOutputs.artifact_plan }, { projectRepository: repositoryManager.getProjectRepository() });
        if (!built.ok) throw new Error(`cannot_project_publish_payload (${built.code}): ${built.error}`);
        // Validated against the publish_payload node's own outputSchema for the same reason the
        // executor does it: this projection is only worth anything if it is the artifact the node
        // would actually have emitted, and the node's schema is the one authority on that.
        const projectionErrors = validateOutput(built.payload, getWorkspaceNode("publish_payload")?.outputSchema);
        return ok({ runId: data.runId, projection: built.payload, target: data.target, dryRun: true, builtAt: new Date().toISOString(), schemaValid: projectionErrors.ok, ...(projectionErrors.ok ? {} : { schemaErrors: projectionErrors.errors }) });
      }
      const articleBody = coerceJsonObjectInput(data.articleBody);
      const errors = validateAgainstArticleBodyNode(articleBody);
      if (errors.length) throw new Error(`invalid_article_body: does not satisfy the article_body node's outputSchema (${errors.slice(0, 6).join("; ")})`);
      return ok({ payload: { articleBody, target: data.target, dryRun: true, builtAt: new Date().toISOString() } });
    } }),
    tool({ name: "publish.validate_payload", description: "Validate a dry-run publish payload: envelope fields (target, dryRun, builtAt) plus the articleBody against the article_body node's own outputSchema.", zodSchema: publishValidate, inputSchema: publishValidateJsonSchema, execute: async (input) => { const parsed = publishValidate.safeParse(input); const bodyErrors = parsed.success ? validateAgainstArticleBodyNode(coerceJsonObjectInput(parsed.data.payload.articleBody)) : []; const issues = [...(parsed.success ? [] : parsed.error.issues), ...bodyErrors.map((message) => ({ code: "custom", path: ["payload", "articleBody"], message }))]; return ok({ valid: issues.length === 0, issues }); } }),
    tool({ name: "repository.get_health", description: "Return safe repository health metadata.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ health: await repositoryManager.getRepositoryHealth() }); } }),
    tool({ name: "workflow.start_dry_run", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Start a Publishing Conductor dry-run workflow without external MCP calls or publishing side effects. Supply entrypoint 'article_body' with a valid client_object.v1 to enter the run at the publish stages without re-running ideation/research/draft nodes. Live (openai) runs for projects that declare a request-id pattern (platform, dr-lurie, fernwell) REQUIRE a caller-supplied requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>); the tool refuses with request_id_required / invalid_request_id otherwise. Mock dry-runs keep the auto-minted id.", zodSchema: startDryRunInput, inputSchema: startDryRunJsonSchema, execute: async (input) => {
      const data = startDryRunInput.parse(input);
      let entrypoint: { nodeId: string; output: unknown } | undefined;
      if (data.entrypoint === "article_body" || data.articleBody !== undefined) {
        // The supplied body is seeded as the article_body output and consumed by publish_payload onward.
        //
        // It used to be checked against articleBodySchema — the workspace-local {schema_version, nodes}
        // shape. That is the wrong authority twice over: it is a workspace-local schema being treated as
        // authoritative (the precise thing the alignment wave forbade), and it is now provably
        // INCOMPATIBLE with the node it feeds. Confirmed live against the deployed revision:
        // node.validate_output for article_body rejects a {schema_version, nodes} body on all six of its
        // required fields. So the old gate admitted exactly the bodies the node would refuse, and the
        // seeding path then skipped R-16 because a seeded node never executes.
        //
        // buildInitialRun now validates the seeded output against the entry node's OWN outputSchema and
        // throws InvalidEntrypointOutputError before a run is created. This call only coerces and hands
        // it over, so the check stays correct through R-23 renaming the contract — there is no second
        // copy of "what an article body looks like" to drift.
        entrypoint = { nodeId: "article_body", output: coerceJsonObjectInput(data.articleBody) };
      }
      // The `input` envelope gets the same coercion `articleBody` already had. Some MCP clients serialize
      // object-typed arguments as JSON strings (documented in toolKit.ts, observed live with Claude's
      // connector) — and reproduced here: a content_source.v1 envelope passed to start_dry_run was stored
      // in initialInput as a JSON *string*, so input_triage would consume a string where an envelope
      // belongs. That is precisely the input side of the T-3 publish path, where a "successful" run
      // carrying a stringified envelope is worse than a failed one.
      const requestId = await resolveCallerRequestId(data.projectId, data.requestId, data.executionMode);
      return ok({ run: await startDryRun({ projectId: data.projectId, input: coerceJsonObjectInput(data.input), workflowId: data.workflowId, executionMode: data.executionMode, entrypoint, budgetUsd: data.budgetUsd, requestId }, executionRepository) });
    } }),
    // `mode` is deliberately a TOP-LEVEL sibling of the run, not a field buried inside it: a mock run
    // emits schema-shaped placeholder artifacts that look exactly like real output, so what produced
    // them has to be impossible to miss. It also names the node source, since static mode means
    // workspace edits made over MCP were not in this run (see runModeSummary).
    tool({ name: "workflow.get_run", description: "Get dry-run workflow execution state. The `mode` block reports what actually produced this run's outputs: executionMode, live (true only for real model output), and whether node definitions came from the static compile or the workspace store. For a status \"running\" run, `stall` reports whether anything is really in flight (dispatch heartbeat) or the driver died and the run should be advanced again.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => { const run = await getRun(runIdInput.parse(input).runId, executionRepository); return ok({ run: run ?? null, mode: run ? runModeSummary(run) : null, stall: run ? assessRunStall(run) ?? null : null }); } }),
    tool({ name: "workflow.list_runs", description: "List compact dry-run workflow summaries, newest first, paged (default 20 rows, max 100; `page.nextCursor` fetches the next page) with optional status and startedAt time-range filters. Node inputs/outputs, stage outputs, and artifact values are intentionally omitted; call workflow.get_run for one selected run. Each row carries a `mode` block naming what produced it and a `stall` block on status \"running\" rows naming whether the driver is alive.", zodSchema: listRunsInput, inputSchema: listRunsJsonSchema, execute: async (input) => { const { runs, page } = await listRunsPage(listRunsInput.parse(input), executionRepository); return ok({ runs: runs.map((run) => ({ ...summarizeRunForList(run), mode: runModeSummary(run), ...(assessRunStall(run) ? { stall: assessRunStall(run) } : {}) })), page }); } }),
    tool({ name: "workflow.run_next_node", description: "Run exactly one dependency-ready Publishing Conductor node, stopping before publish-risk nodes unless approved is true.", zodSchema: runNextNodeInput, inputSchema: runNextNodeJsonSchema, execute: async (input) => { const data = runNextNodeInput.parse(input); return ok({ run: await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }) }); } }),
    tool({ name: "workflow.run_node", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Run dependency-ready nodes; when nodeId is given, advance the run until that node completes. Stops cleanly with driverNote when the request's time budget runs out; call again to continue, or use the conductor job for long runs.", zodSchema: runNodeInput, inputSchema: runNodeJsonSchema, execute: async (input) => { const data = runNodeInput.parse(input); if (!data.nodeId) return ok({ run: await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }) }); const deadline = Date.now() + RUN_DRIVER_TIME_BUDGET_MS; let timedOut = false; let run = await getRun(data.runId, executionRepository); for (let i = 0; run && i < 100 && !HALTED_RUN_STATUSES.includes(run.status); i++) { if (Date.now() > deadline) { timedOut = true; break; } run = await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }); const state = run.nodes.find((node) => node.nodeId === data.nodeId); if (state && state.status !== "queued" && state.status !== "running") break; } return ok({ run, ...(timedOut ? { driverNote: DRIVER_TIME_BUDGET_NOTE } : {}) }); } }),
    tool({ name: "workflow.run_until", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Run dependency-ready nodes until the named node completes, then stop. Stops cleanly with driverNote when the request's time budget runs out; call again to continue, or use the conductor job for long runs.", zodSchema: runUntilInput, inputSchema: runUntilJsonSchema, execute: async (input) => { const data = runUntilInput.parse(input); const deadline = Date.now() + RUN_DRIVER_TIME_BUDGET_MS; let timedOut = false; let run = await getRun(data.runId, executionRepository); run = await enterApprovedGateBlockedRun(run, data.approved, () => runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved })); for (let i=0; run && i<100 && !HALTED_RUN_STATUSES.includes(run.status) && run.nodes.find((n) => n.nodeId === data.nodeId)?.status !== "completed"; i++) { if (Date.now() > deadline) { timedOut = true; break; } run = await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }); if (run.nodes.find((n) => n.nodeId === data.nodeId)?.status === "completed") break; } return ok({ run, ...(timedOut ? { driverNote: DRIVER_TIME_BUDGET_NOTE } : {}) }); } }),
    tool({ name: "workflow.run_all", description: `Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Run all dependency-ready nodes, stopping before publish-risk nodes unless explicit approval exists. Drives the run for at most budgetMs (default ${RUN_DRIVER_TIME_BUDGET_MS}ms, ceiling ${RUN_DRIVER_TIME_BUDGET_CEILING_MS}ms — always below the caller's request timeout) and returns a COMPACT run view {run:{runId,requestId,projectId,status,currentNodeId,budget,errors,approvalsRequired,nodes:[{nodeId,status,warnings,errors,durationMs,dispatch}]}, driverNote?, continued} — no node inputs/outputs/stageOutputs/artifacts (use workflow.get_run for the full record). continued=true means the run is still queued/running and the scheduled continuation tick will advance it; call again to drive it sooner.`, zodSchema: runAllInput, inputSchema: runAllJsonSchema, execute: async (input) => { const data = runAllInput.parse(input); const budgetMs = driverBudgetMs(data.budgetMs); const deadline = Date.now() + budgetMs; let timedOut = false; let run = await getRun(data.runId, executionRepository); run = await enterApprovedGateBlockedRun(run, data.approved, () => runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_run_all" })); for (let i=0; run && i<100 && !HALTED_RUN_STATUSES.includes(run.status); i++) { if (Date.now() > deadline) { timedOut = true; break; } run = await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_run_all" }); } if (!run) throw new WorkspaceToolError("run_not_found", `Run ${data.runId} was not found.`, { runId: data.runId }); return ok({ run: compactRun(run), ...(timedOut ? { driverNote: driverTimeBudgetNote(budgetMs) } : {}), continued: RUN_LIVE_STATUSES.includes(run.status) }); } }),
    // R-18: pause_run reports "paused", not "blocked". "blocked" already carried two distinct meanings
    // (publish-approval hold and budget hold); overloading it with a third made an operator pause
    // unreadable. "paused" is in the executor's non-advanceable set, so pausing still stops the run.
    ...["pause_run","cancel_run"].map((action) => tool({ name: `workflow.${action}`, description: action === "pause_run" ? "Pause a run: status becomes \"paused\" (distinct from a publish-approval or budget \"blocked\"); node completion state is never mutated." : `${action} updates run status only; node completion state is never mutated.`, zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => { const data = runIdInput.parse(input); const status = action === "cancel_run" ? "cancelled" : "paused"; return ok({ run: await updateRunStatus(data.runId, status, executionRepository) ?? null }); } })),
    // F3 (T-2, run_1785352838155_l544ye): split out of the pause/cancel map above because it alone
    // needs an extra field. budgetUsd is optional — omitted, this behaves exactly as it always has
    // (status -> "queued", nothing else touched); supplied, it raises the run's ceiling in the same
    // call, so "raise budgetUsd and resume" (the budget gate's own reported remedy) is reachable
    // without a second tool. The run's own between-node gate re-evaluates the (now higher) ceiling
    // against accrued spend on the very next advance and clears budgetBlock itself once it passes.
    tool({ name: "workflow.resume_run", description: "Resume a run: status becomes \"queued\". Optionally raise (or set) budgetUsd in the same call — the reachable form of the budget gate's own \"raise budgetUsd and resume\" remedy. Node completion state is never mutated.", zodSchema: resumeRunInput, inputSchema: resumeRunJsonSchema, execute: async (input) => { const data = resumeRunInput.parse(input); return ok({ run: await updateRunStatus(data.runId, "queued", executionRepository, data.budgetUsd !== undefined ? { budgetUsd: data.budgetUsd } : {}) ?? null }); } }),
    tool({ name: "workflow.retry_node", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Reset a completed or failed node back to queued and run the next dependency-ready node.", zodSchema: runNodeInput, inputSchema: runNodeJsonSchema, execute: async (input) => { const data = runNodeInput.parse(input); return ok({ run: await retryNode(data.runId, data.nodeId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_retry_node" }) ?? null }); } }),
    // P0 §2.2 — the operator veto channel: ONE named field (run.operatorPublishDecision), ONE setter
    // (this tool), ONE reader (publishDecision.isOperatorPublishWithheld, consumed by the publish
    // gates and the executor's publish-risk dispatch guard).
    tool({ name: "workflow.set_operator_publish_decision", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Record the operator's durable publish decision for a run (run.operatorPublishDecision). \"withheld\" is the operator VETO: it blocks workflow.publish_run and every publish-risk node for this run regardless of approved/live flags, until the operator replaces it. \"approved\" records explicit durable operator approval — the referent an executed publish_execution.v1's approvalMatched must match. The decision survives workflow.reset_run.", zodSchema: operatorPublishDecisionInput, inputSchema: operatorPublishDecisionJsonSchema, execute: async (input) => { const data = operatorPublishDecisionInput.parse(input); return ok({ run: await setOperatorPublishDecision(data.runId, data.decision, executionRepository) ?? null }); } }),
    tool({ name: "workflow.reset_run", description: "Reset a dry-run workflow execution to its initial queued state.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => ok({ run: await resetRun(runIdInput.parse(input).runId, executionRepository) }) }),
    tool({ name: "workflow.get_run_context", description: "Return the reusable per-run context bundle (project contract, article_body schema, project tool policy, object contracts, node registry), memoized per run so the conductor fetches it once instead of re-reading contracts and the registry at every step.", zodSchema: runContextInput, inputSchema: runContextJsonSchema, execute: async (input) => { const data = runContextInput.parse(input); const cacheHit = conductorCache.has(data.runId, `${RUN_CONTEXT_KEY}:${data.projectId}`); const context = await getRunContext({ runId: data.runId, projectId: data.projectId, projectRepository }); return ok({ context, cacheHit }); } }),
    // T6 (Wave 3, ships dark): plan.nodeTimingAggregates is a READ-ONLY addition — per-nodeId
    // {count, emaDurationMs, p50DurationMs, p95DurationMs} across every run of this run's workflowId,
    // straight from the node timing ledger (nodeTimings.ts). Nothing here or downstream reads it to
    // make a decision yet; see nodeTimings.ts's header for the three follow-ups it is explicitly
    // gating (driver packing, estimator calibration, per-node stall thresholds) on two runs of data.
    // planRun(run) itself is untouched — its own return type and every field it has ever returned are
    // unchanged; the aggregates are spread onto the object AFTER planRun runs, in this tool only.
    tool({ name: "workflow.get_run_cost", description: "Return a per-node cost ledger for a run plus a plan recommending the cheapest way to make progress: poll a terminal run, resume a blocked one, re-enter at the late-stage entrypoint reusing a finished article_body, or run in full. plan.nodeTimingAggregates surfaces measured per-node duration history (EMA/p50/p95/count) for this run's workflow, read-only — no plan field above it is derived from that history yet.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => { const runId = runIdInput.parse(input).runId; const run = await getRun(runId, executionRepository); if (!run) return ok({ ledger: null, plan: null }); const usage = await summarizeModelUsage({ runId }, usageRepository); const timingRecords = await nodeTimingRepository.list({ workflowId: run.workflowId }); return ok({ ledger: summarizeRunCost(run, usage), plan: { ...planRun(run), nodeTimingAggregates: aggregateNodeTimingsByNode(timingRecords) } }); } }),
    tool({ name: "workflow.publish_run", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Explicit PUBLISH gate: publish a run's client_object.v1 to the project's live site via that project's own sanctioned publish dialect (for object-substrate clients: object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin; the exact sequence is reported as plan.toolSequence). Never releases to production — going live is a separate, explicit gate. A real publish requires operator-enabled publishing (a per-project env flag) AND approved:true AND live:true, and the project's publish-readiness policy must be GO. A readiness NO-GO returns mode blocked_for_publish_execution (an expected, resumable safety state); missing gates return a dry-run plan. Text-only bodies only.", zodSchema: publishRunInput, inputSchema: publishRunJsonSchema, execute: async (input) => { const data = publishRunInput.parse(input); return ok({ publish: await publishRun(data, { executionRepository, projectRepository, learningRepository }) }); } }),
    tool({ name: "workflow.publish_readiness", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Evaluate the project's publish-readiness checklist (GO/NO-GO) for a run's client_object.v1 without publishing: client_object.v1 valid, Blob artifacts verified (pdf-tool materialized), taxonomy resolved or accepted-empty, pinned approval present, hard constraints, and release/build behavior selected. Projects without a readiness policy return available:false.", zodSchema: publishReadinessInput, inputSchema: publishReadinessJsonSchema, execute: async (input) => { const data = publishReadinessInput.parse(input); return ok({ readiness: await evaluatePublishReadiness({ projectId: data.projectId, runId: data.runId, articleBody: coerceJsonObjectInput(data.articleBody), readiness: data.readiness }, { executionRepository }) }); } }),
    tool({ name: "usage.record", description: "Record estimated or actual model usage without storing raw prompts or secrets.", zodSchema: recordModelUsageSchema, inputSchema: usageRecordJsonSchema, execute: async (input) => ok({ record: await recordModelUsage(recordModelUsageSchema.parse(input), usageRepository) }) }),
    tool({ name: "usage.list_records", description: "List model usage records with optional filters.", zodSchema: usageFiltersSchema, inputSchema: usageFiltersJsonSchema, execute: async (input) => ok({ records: await usageRepository.list(usageFiltersSchema.parse(input)) }) }),
    tool({ name: "usage.get_summary", description: "Summarize estimated model token and cost usage with optional filters.", zodSchema: usageFiltersSchema, inputSchema: usageFiltersJsonSchema, execute: async (input) => ok({ summary: await summarizeModelUsage(usageFiltersSchema.parse(input), usageRepository) }) }),
    tool({ name: "usage.get_budget_status", description: "Return estimated budget status for a run or project.", zodSchema: budgetStatusInput, inputSchema: budgetStatusJsonSchema, execute: async (input) => ok({ budgetStatus: await getBudgetStatus(budgetStatusInput.parse(input), usageRepository) }) }),
    tool({ name: "project.list", description: "List registered project MCP connections with safe, non-secret metadata.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const projects = await projectRepository.list(); return ok({ projects: projects.map((config) => toProjectSummary(config)) }); } }),
    tool({ name: "project.get", description: "Get one registered project MCP connection with safe, non-secret metadata, plus the project's knowledge rules when a hook module provides them.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => { const projectId = projectIdInput.parse(input).projectId; const config = await projectRepository.get(projectId); return ok({ project: config ? toProjectSummary(config) : null, knowledge: config ? getProjectHooks(projectId)?.knowledge ?? null : null }); } }),
    tool({ name: "project.test_connection", description: "Run a primitive MCP initialize against a project's external server. Read-only; no publishing side effects.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => { const config = await requireProject(projectIdInput.parse(input).projectId); return ok({ connection: await new ProjectMcpAdapter(config).testConnection() }); } }),
    tool({ name: "project.list_tools", description: "List a project's remote MCP tools via tools/list. Returns safe tool names and descriptions only.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => { const config = await requireProject(projectIdInput.parse(input).projectId); return ok(await new ProjectMcpAdapter(config).listTools()); } }),
    tool({ name: "project.call_tool", description: "Call an approved tool on a registered project MCP server. The config permission model plus the project's executable policy apply: legacy artifact fallback tools and fallback artifact-source arguments (remote image URLs, copied artifact refs, repo paths, hand-authored blob keys) are blocked before any transport, even when the config marks the tool allowed.", zodSchema: projectCallToolInput, inputSchema: projectCallToolJsonSchema, execute: async (input) => {
      const data = projectCallToolInput.parse(input);
      const config = await requireProject(data.projectId);
      const adapter = new ProjectMcpAdapter(config);
      // Executable project policy runs before the permission check and any remote transport.
      const policyFindings = getProjectHooks(data.projectId)?.enforceCallToolPolicy?.({ tool: data.tool, arguments: data.arguments }) ?? [];
      const blocking = policyFindings.filter((finding) => finding.severity === "error");
      if (blocking.length) return ok({ call: { ok: false, projectId: data.projectId, connection: adapter.connectionState(), tool: data.tool, permission: "blocked" as const, blockedByPolicy: true, policyFindings: blocking, error: `Blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}` } });
      return ok({ call: await adapter.callTool(data.tool, data.arguments) });
    } }),
    // Read-only split of project.call_tool. project.call_tool covers both read-only contract
    // discovery and external writes, and is approval-gated (node-execution side) because of the
    // write half — correctly. This wire tool gives an operator or script the same read-only
    // affordance directly: permitted operations are the fixed, server-side READ_TOOL_ALLOWLIST
    // (never caller-supplied), refused before any transport when out of bounds. Everything else
    // project.call_tool honors — per-project toolPolicies/defaultToolPolicy, the executable project
    // policy, the connection/auth path — still applies via ProjectMcpAdapter.callReadTool, which
    // delegates straight into the unmodified callTool once the allowlist check passes.
    tool({ name: "project.call_read_tool", description: `Call a read-only tool on a registered project MCP server, without approval. Permitted operations are a fixed, server-side allowlist (${READ_TOOL_ALLOWLIST.join(", ")}) — never caller-supplied; anything else is refused before any transport with code "read_tool_operation_not_permitted". Still honors the project's own toolPolicies/defaultToolPolicy and the executable project policy (legacy artifact fallback blocks) — a project can still block a read op. Use project.call_tool for writes.`, zodSchema: projectCallReadToolInput, inputSchema: projectCallReadToolJsonSchema, execute: async (input) => {
      const data = projectCallReadToolInput.parse(input);
      const config = await requireProject(data.projectId);
      const adapter = new ProjectMcpAdapter(config);
      const policyFindings = getProjectHooks(data.projectId)?.enforceCallToolPolicy?.({ tool: data.tool, arguments: data.arguments }) ?? [];
      const blocking = policyFindings.filter((finding) => finding.severity === "error");
      if (blocking.length) return ok({ call: { ok: false, projectId: data.projectId, connection: adapter.connectionState(), tool: data.tool, permission: "blocked" as const, blockedByPolicy: true, policyFindings: blocking, error: `Blocked by executable project policy: ${blocking.map((finding) => finding.code).join(", ")}` } });
      return ok({ call: await adapter.callReadTool(data.tool, data.arguments) });
    } }),
    tool({ name: "project.validate_handoff", description: "Dry structural validation of a handoff against the project content_source.v1 / client_object.v1 contract. Read-only; no publishing.", zodSchema: validateHandoffInput, inputSchema: validateHandoffJsonSchema, execute: async (input) => { const data = validateHandoffInput.parse(input); const config = await requireProject(data.projectId); return ok({ validation: validateHandoff(config, { contentSource: coerceJsonObjectInput(data.contentSource), articleBody: coerceJsonObjectInput(data.articleBody) }) }); } }),
    tool({ name: "project.get_registration_contract", description: "Machine-readable contract for onboarding a new publishing client: field rules, env-var naming conventions, and the step-by-step registration flow.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ contract: projectRegistrationContract() }); } }),
    tool({ name: "project.create", description: "Register a new external publishing-client MCP connection. The TOKEN is referenced by environment variable NAME only (never a value). The ENDPOINT can be passed directly as mcpEndpoint and is stored on the record — an endpoint URL is not a secret — so registering a tenant needs no new env var on this deployment; <CLIENT>_MCP_ENDPOINT still overrides it when set. Publishing stays governed by server-side policy.", zodSchema: projectCreateInput, inputSchema: projectCreateJsonSchema, execute: async (input) => { const data = projectCreateInput.parse(input); return ok({ project: await createProject(projectRepository, data.project) }); } }),
    tool({ name: "project.update", description: "Patch a registered project's safe fields (name, env var names, the stored mcpEndpoint — null clears it, auth mode, allowed tools, contract, status) plus one policy field: operatorPublishDefault (approved | require_explicit) — whether a NEW run for this project starts pre-approved (publishingPolicy.operatorDefault). Identity and the REST of publishing policy (publishEnabled, requiresExplicitPublish) are not patchable.", zodSchema: projectUpdateInput, inputSchema: projectUpdateJsonSchema, execute: async (input) => { const data = projectUpdateInput.parse(input); return ok({ project: await updateProject(projectRepository, data.projectId, data.patch) }); } }),
    tool({ name: "project.delete", description: "Remove an agent-registered project connection. Code-defined default projects cannot be deleted (set status to disabled instead).", zodSchema: projectDeleteInput, inputSchema: projectDeleteJsonSchema, execute: async (input) => { const data = projectDeleteInput.parse(input); return ok(await deleteProject(projectRepository, data.projectId)); } }),
    // T12.11 — the one-call composite entry point (R-C5): site.duplicate / site.duplicate_status.
    ...createSiteDuplicationTools({ executionRepository, workspaceRepository, projectRepository, usageRepository }),
    // Operator surface over the fleet credential reconciler: plan (read-only), apply (fires the
    // Cloud Run Job), execution_status (poll). apply/execution_status are deliberately absent from
    // SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts) — they are operator-only and must never reach a
    // tenant's scoped chat bearer.
    ...createSiteCredentialTools({ projectRepository }),
    ...createAgentTools({ workspaceRepository, projectRepository, conversationTurnRepository: repositoryManager.getConversationTurnRepository(), usageRepository }),
    ...createChangesTools({ workspaceRepository, changeRepository, meta }),
    ...createConstellationTools({ workspaceRepository, executionRepository, usageRepository, skillRepository, projectRepository }),
    ...createImprovementTools({ workspaceRepository, executionRepository, learningRepository, evaluationRepository: repositoryManager.getEvaluationRepository(), improvementRepository: repositoryManager.getImprovementRepository(), meta })
  ];
}
