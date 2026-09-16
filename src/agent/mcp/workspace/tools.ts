import { z } from "zod";
import { coerceSchemaInput, validateJsonSchema, type WorkspaceMutationMeta } from "./store.js";
// B1 — advisory only. A root-level combinator is legal here and is enforced in full post-turn by
// outputValidator; it is simply not enforceable by OpenAI response_format, which strips it. Warn,
// never block (platform rule): rejecting the write would delete the invariant to please the API.
import { openAiResponseSchemaLint } from "../../execution/openaiResponseSchema.js";
import { workspaceRiskLevels, type WorkspaceNode } from "../../workspace/nodeTypes.js";
import { type WorkspaceActor, type WorkspaceChangeSource } from "../../workspace/changeTypes.js";
import { coerceJsonObjectInput, metaJson, mutationMeta, objectSchema, ok, tool, toolError, type JsonSchema, type WorkspaceTool, MissingPatchFieldError } from "./toolKit.js";
export { metaJson, mutationMeta, objectSchema, ok, tool, toolError, workspaceActorSchema } from "./toolKit.js";
export type { JsonSchema, WorkspaceTool } from "./toolKit.js";
import { assertNoCanonicalOwnedFieldWrite, assertNoExecutionFieldWrite, CANONICAL_OWNED_WRITE_REFUSED_FIELDS } from "./canonicalNodeFieldGuard.js";
import { createChangesTools } from "./changesTools.js";
import { createConstellationTools } from "./constellationTools.js";
import { createImprovementTools } from "./improvementTools.js";
import { createAgentTools } from "./agentTools.js";
import { repositoryManager } from "../../runtime/repositories.js";
import { collectRunBlockages, type Blockage } from "../../execution/blockage.js";
import { DEFAULT_EXECUTION_MODE, DISPATCH_DEADLINE_MARGIN_MS, type DispatchClaimKind, MAX_LIST_RUNS_LIMIT, assessRunStall, assessRunStallFrom, type RunStallTimingContext, getRun, isApprovalGateOnlyBlock, listRuns, listRunsPage, listRunSummariesPage, nextDispatchPlan, overrideRunNodeOutput, pushNodeThroughWithDefault, resetRun, retryNode, resolveConductorNodes, runModeSummary, runNextNode, setNodeBudgetOverride, setOperatorPublishDecision, startDryRun, summarizeRunForList, updateRunStatus } from "../../workspace/executor.js";
import { DETERMINISTIC_STAGE_MIN_TIMEOUT_MS, STALL_MARGIN_MS } from "../../workspace/routeRegistry.js";
import { listRegisteredWorkflowIds } from "../../workspace/workflowRegistry.js";
import { resolvePublishAuthority } from "../../workspace/publishDecision.js";
import { conductorCache, getRunContext, planRun, summarizeRunCost, RUN_CONTEXT_KEY } from "../../workspace/conductor.js";
import { executionStatuses, type WorkflowExecutionRecord } from "../../workspace/executionTypes.js";
import { WorkspaceToolError } from "../../workspace/workspaceErrors.js";
import { getWorkspaceNode } from "../../workspace/nodes.js";
import { validateOutput } from "../../execution/outputValidator.js";
import { buildNodeDefaultOutput, RUN_OUTPUT_MODES } from "../../workspace/defaultOutput.js";
import type { NodeDefaultOutputAuthor } from "../../workspace/nodeTypes.js";
import { compileRequestIdPattern, evaluatePublishReadiness, publishRun } from "../../workspace/publisher.js";
import { runDeterministicPublishPayload } from "../../workspace/publishPayload.js";
import { executeNode, getEffectivePrompt, getNodeDetails, listNodeExecutions, listNodeOutputs, prepareNodeExecution, validateAgainstNodeSchema } from "../../workspace/nodeRuntime.js";
import { getBudgetStatus, recordModelUsage, recordModelUsageSchema, summarizeModelUsage, usageFiltersSchema } from "../../observability/modelUsage.js";
import { aggregateNodeTimingsByNode, aggregateNodeTimingsByEra } from "../../workspace/nodeTimings.js";
import { auditNodeCapabilities, summarizeCapabilityAudit, type ProjectPolicyView } from "../../workspace/nodeCapabilityAudit.js";
import { toProjectSummary, validateHandoff } from "../../projects/projectRegistry.js";
import { getProjectHooks } from "../../projects/projectHooks.js";
import { bearerEnvClientSiteBindingAdvisory, createProject, deleteProject, projectCreateSchema, projectRegistrationContract, projectUpdateSchema, updateProject } from "../../projects/projectAdmin.js";
import { ProjectMcpAdapter, READ_TOOL_ALLOWLIST } from "../../projects/projectMcpAdapter.js";
import { normalizeSkillInput, skillDefinitionSchema, validateSkillDefinition } from "../../skills/skillValidator.js";
import { resolveSkillsForNode } from "../../skills/skillResolver.js";
import { selectedSkillsFor } from "../../skills/runSkillSelection.js";
import { skillStatuses, type SkillDefinition } from "../../skills/skillTypes.js";
import { listTools as listControlledTools, getTool as getControlledTool, resolveEffectiveToolsForNode } from "../../tools/toolResolver.js";
import { resolveNodeForExecution } from "../../workspace/nodeResolution.js";
import { executeTool, getToolExecution, listToolExecutions } from "../../tools/toolExecutor.js";
import { flushToolExecutionLedger } from "../../tools/toolExecutionLedger.js";
import { filterRecordsByProject } from "../../improvement/projectScope.js";
import { createSiteDuplicationTools } from "./siteDuplicationTools.js";
import { createSiteCredentialTools } from "./siteCredentialTools.js";
import { createVisualIdentityTools } from "./visualIdentityTools.js";
import { createOperationTools } from "./operationTools.js";
import { createPlannerTools } from "./plannerTools.js";
import { FORBIDDEN_PROJECT_VERBS } from "../../tools/forbiddenProjectVerbs.js";
import { invokeTenantReadTool, invokeTenantTool } from "../../tools/tenantInvoke.js";
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import { dispatchToolContext } from "../../execution/dispatchAuthorization.js";

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
// D2 — "nothing is in flight" is a claim about the RECORD, so it is read off the record. It was
// printed unconditionally, and on every abandoned dispatch in run_1789303857536_obd2fd it was false:
// a claim was stamped, the node was unreclaimable behind it, and the operator had no reason to look.
const driverTimeBudgetNote = (budgetMs: number, run?: WorkflowExecutionRecord): string => {
  const claimed = run?.nodes.find((node) => node.status === "running" && node.dispatch);
  return claimed
    ? `Driver time budget (${budgetMs}ms) reached before the caller's request ceiling; the run's state is persisted. A dispatch claim for ${claimed.nodeId} IS STILL STAMPED on this run (dispatched ${claimed.dispatch!.dispatchedAt}, ${claimed.dispatch!.timeoutMs}ms window) — something is in flight, or was: no driver may dispatch that node until it reports or its claim is reclaimed. workflow.get_run's stall block says which. The scheduled continuation tick advances a queued/running run on its own; call the same tool again to drive it sooner, or use the Cloud Run conductor job for runs longer than one request window.`
    : `Driver time budget (${budgetMs}ms) reached before the caller's request ceiling; the run's state is persisted and no dispatch claim is stamped. The scheduled continuation tick advances a queued/running run on its own; call the same tool again to drive it sooner, or use the Cloud Run conductor job for runs longer than one request window.`;
};

// The compact run view workflow.run_all returns, and (T7) the DEFAULT shape of workflow.get_run.
// A full run record (inputs, outputs, stageOutputs, artifacts) for a 20-node run is hundreds of KB —
// far past what a chat tool result can carry, and none of it is what the caller needs to decide the
// next step. get_run's `detail:"full"` still returns the whole record for when the payloads are the
// point.
//
// Because this is now what a plain get_run answers with, it also carries the short scalar facts an
// operator checks by name: the publish request id (distinct from requestId, and a null one is its own
// failure mode) and the durable operator publish decision. Both are a few bytes and their absence
// would have sent every caller straight back to detail:"full".
export type CompactRunView = {
  runId: string;
  requestId?: string;
  publishRequestId?: string;
  workflowId?: string;
  projectId: string;
  status: WorkflowExecutionRecord["status"];
  currentNodeId?: string;
  executionMode?: WorkflowExecutionRecord["executionMode"];
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  budget?: { budgetUsd?: number; budgetBlock?: WorkflowExecutionRecord["budgetBlock"] };
  errors: string[];
  approvalsRequired: WorkflowExecutionRecord["approvalsRequired"];
  operatorPublishDecision?: WorkflowExecutionRecord["operatorPublishDecision"];
  operatorDecisionSource?: WorkflowExecutionRecord["operatorDecisionSource"];
  artifactCount?: number;
  // blockage.v1 — EVERY pending, human-resolvable wall on this run, minted by the engine with the
  // remedies that would clear each one (execution/blockage.ts). Collected here rather than left for
  // each caller to re-derive from nodes[].blockage + budgetBlock + approvalsRequired, because three
  // callers re-deriving it is exactly how the three surfaces drifted apart in the first place.
  // Empty array on a healthy run — never omitted, so a caller can trust `blockages.length === 0`.
  blockages: Blockage[];
  nodes: Array<{ nodeId: string; status: string; warnings?: string[]; errors?: string[]; durationMs?: number; dispatch?: unknown; lastDispatch?: unknown; blockage?: Blockage }>;
};
export const compactRun = (run: WorkflowExecutionRecord): CompactRunView => ({
  runId: run.runId,
  ...(run.requestId !== undefined ? { requestId: run.requestId } : {}),
  ...(run.publishRequestId !== undefined && run.publishRequestId !== null ? { publishRequestId: run.publishRequestId } : {}),
  ...(run.workflowId !== undefined ? { workflowId: run.workflowId } : {}),
  projectId: run.projectId,
  status: run.status,
  ...(run.currentNodeId !== undefined ? { currentNodeId: run.currentNodeId } : {}),
  ...(run.executionMode !== undefined ? { executionMode: run.executionMode } : {}),
  ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
  ...(run.updatedAt !== undefined ? { updatedAt: run.updatedAt } : {}),
  ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
  ...(run.operatorPublishDecision ? { operatorPublishDecision: run.operatorPublishDecision, operatorDecisionSource: run.operatorDecisionSource ?? "explicit" } : {}),
  ...(Array.isArray(run.artifacts) ? { artifactCount: run.artifacts.length } : {}),
  ...(run.budgetUsd !== undefined || run.budgetBlock !== undefined ? { budget: { ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}), ...(run.budgetBlock !== undefined ? { budgetBlock: run.budgetBlock } : {}) } } : {}),
  errors: run.errors,
  approvalsRequired: run.approvalsRequired,
  blockages: collectRunBlockages(run),
  nodes: run.nodes.map((node) => ({
    nodeId: node.nodeId,
    status: node.status,
    // Guarded by status for the same reason collectRunBlockages is: a node put
    // back to queued (or since completed) is not stopped, and a card rendered
    // from a stale wall spends money on a node that no longer needs it. The
    // requeue paths clear it too — this is the second lock on the same door.
    ...(node.blockage !== undefined && (node.status === "failed" || node.status === "blocked" || node.status === "cancelled")
      ? { blockage: node.blockage }
      : {}),
    ...(node.warnings !== undefined ? { warnings: node.warnings } : {}),
    ...(node.errors !== undefined ? { errors: node.errors } : {}),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
    ...(node.dispatch !== undefined ? { dispatch: node.dispatch } : {}),
    ...(node.lastDispatch !== undefined ? { lastDispatch: node.lastDispatch } : {}),
    // node-default-output follow-up (2026-09-15) — THE FIELD THAT MAKES THE MARKERS REAL.
    //
    // #351 taught the Workbench to read a node's supplied-output provenance from the run record, and
    // to fall back to a per-node node_list_outputs query only when the record carries none for that
    // node. It never added the field to THIS projection — and workflow.get_run's compact view is the
    // default, and the one the rail binds to. So `outputProvenance` was absent for every node of
    // every run: the fallback fired unconditionally, the rail issued one node_list_outputs per
    // COMPLETED node (25 on a publishing run) on every paint to answer a question the run record
    // already knew, and the markers themselves never rendered. One missing line, two defects.
    //
    // Cheap enough to carry on every node of every compact read: a three-field object, present only
    // on a node whose output was supplied — which is none of them on an ordinary run.
    ...(node.outputProvenance !== undefined ? { outputProvenance: node.outputProvenance } : {})
  })),
  // Run-level companions, same reasoning: the Workbench reads both and could otherwise learn them
  // only from a `detail: "full"` read of the whole record.
  ...((run.defaultedNodeIds ?? []).length ? { defaultedNodeIds: [...(run.defaultedNodeIds ?? [])] } : {}),
  ...(run.outputMode !== undefined ? { outputMode: run.outputMode } : {})
});
const RUN_LIVE_STATUSES: string[] = ["queued", "running"];

// D9 — THE CLAIM CEILING, and why a wider claim window is the one fix that is not allowed here.
//
// A single workflow.run_next_node / run_node / run_until / run_all call blocks synchronously on
// advanceRun -> executeRunnableNode for the WHOLE of whatever node it dispatches. The driver's own
// time budget above is checked only BETWEEN advances, never during one, and there is no
// AbortController on the outer HTTP call — so a node that claims 300s is 300s of one MCP request. The
// calling client's request timeout (~180s, client-side and outside this repo) reaches that first: it
// kills the driver mid-node, the node keeps its dispatch claim for its full timeout plus
// STALL_MARGIN_MS (390s for a deterministic stage) with nothing behind it, and the run is stranded
// until the claim expires. Observed twice in one incident on capture_emit_live; "advance the run
// manually" is the advice that walks an operator straight into it.
//
// Widening the claim is a REJECTED fix — it moves the cliff, it does not remove it. What removes it is
// refusing the dispatch: this driver does not start a node whose claim it cannot own, and says which
// driver can (the scheduled continuation tick holds a whole Cloud Run task window, not a request).
//
// THE CEILING IS NOT A NEW NUMBER. It is DETERMINISTIC_STAGE_MIN_TIMEOUT_MS — the floor routeRegistry
// gives the stages that reach the network and may spend 100-200s of real external work. The fit test
// is the one runContinuation's deadline guard already uses (`fitsAFreshTask`), with the driver's
// window in place of the task's.
//
// THE CEILING IS A NUMBER, AND A NUMBER ALONE IS NOT THE TEST. The first cut of this guard compared
// only the milliseconds and refused `article_body` — a plain model node whose own modelConfig.timeout
// is 300000, numerically identical to a capture stage's claim. The two are not the same kind of claim
// and only one of them strands a run (executor.DispatchClaimKind):
//   - a MODEL claim is a bound. OpenAINodeRunner races the provider call against that exact timeout,
//     so the node ends, the driver regains control, and the result is persisted. Owning it in a
//     request is what this surface has always done and what the run-driving tests assert.
//   - a DETERMINISTIC-STAGE claim is a floor, not a bound. Nothing races those routes — the executor
//     awaits them bare — so the window describes work that runs as long as it runs. That is the claim
//     an MCP request cannot own, and it is exactly the claim capture_emit_live was orphaned holding.
// So the refusal is `claimKind === "deterministic_stage"` AND the window does not fit. Every model
// dispatch on every conductor, including the 300000ms ones, is dispatched exactly as before.
export const RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS = DETERMINISTIC_STAGE_MIN_TIMEOUT_MS;

// A NORMAL, NAMED, NON-ADVANCING OUTCOME — the same shape the time-budget stop already returns (the
// run as persisted, plus a driverNote), not an error. The run is healthy, nothing is in flight and
// nothing failed; an error would throw the run view away and read to every client as "retry me", which
// is the one thing a caller must not do here.
type DispatchClaimRefusal = {
  code: "dispatch_claim_exceeds_driver_ceiling";
  nodeId: string;
  nodeIds: string[];
  claimKind: DispatchClaimKind;
  plannedClaimMs: number;
  ceilingMs: number;
  driverBudgetMs: number;
  unreclaimableForMs: number;
};

const dispatchClaimRefusalNote = (refusal: DispatchClaimRefusal, namedNodeId?: string): string =>
  `${namedNodeId === refusal.nodeId ? `Node ${refusal.nodeId} is the node you named, and naming it does not shorten its claim: it` : `The next runnable node (${refusal.nodeId})`} plans a ${refusal.plannedClaimMs}ms deterministic-stage dispatch claim — a stall-detection floor over work nothing races, not a bound like a model node's own timeout — past the ${refusal.ceilingMs}ms ceiling this driver may own in one request (its own time budget between advances is ${RUN_DRIVER_TIME_BUDGET_MS}ms, set below every real caller's request timeout). It was NOT dispatched and nothing is in flight: driving it here would have the caller's request timeout kill this driver mid-node and leave the node claimed — unreclaimable for ${refusal.unreclaimableForMs}ms — with nobody behind it. The run's state is persisted and this is not a failure. The scheduled continuation tick advances this node on its own (it holds a whole task window rather than a request), or run the Cloud Run conductor job (scripts/run-conductor-job) for the rest of the run; calling this tool again returns this same refusal.`;

// Priced BEFORE the dispatch, from the claim the executor will actually stamp (executor.nextDispatchPlan
// -> plannedNodeTimeoutMs). Fail-open exactly as the continuation tick's resolver does: a pricing read
// that throws must never be the reason a run stops advancing.
const dispatchClaimRefusalFor = (plan: NonNullable<Awaited<ReturnType<typeof nextDispatchPlan>>>): DispatchClaimRefusal | undefined => {
  if (plan.claimKind !== "deterministic_stage") return undefined;
  const fitsOneDriverCall = plan.plannedTimeoutMs + DISPATCH_DEADLINE_MARGIN_MS <= RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS;
  if (fitsOneDriverCall) return undefined;
  return {
    code: "dispatch_claim_exceeds_driver_ceiling",
    nodeId: plan.nodeId,
    nodeIds: plan.nodeIds,
    claimKind: plan.claimKind,
    plannedClaimMs: plan.plannedTimeoutMs,
    ceilingMs: RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS,
    driverBudgetMs: RUN_DRIVER_TIME_BUDGET_MS,
    unreclaimableForMs: plan.plannedTimeoutMs + STALL_MARGIN_MS
  };
};

// D2 (2026-09-14) — A DRIVER NEVER STARTS A NODE IT CANNOT STAY FOR.
//
// D9's ceiling above answers "is this claim the KIND a request may own". It deliberately exempted
// model nodes on the theory that a model dispatch is bounded — OpenAINodeRunner races the provider
// call against the node's own timeout, so the driver always gets control back. That theory is about
// the NODE. It says nothing about the DRIVER, and the driver is the thing that ran out first:
// run_1789303857536_obd2fd's reader_insight was dispatched by http_run_all with ~32s of a 45s budget
// left, against a node whose claim window is 90s. The loop's deadline check happens BETWEEN advances,
// never during one, so the budget did not stop it — it just meant the call returned with a claim
// stamped and nobody behind it.
//
// So the second half of the question: does the next dispatch fit in the time THIS DRIVER HAS LEFT?
//
// PRICED ON MEASURED HISTORY, NOT ON THE TIMEOUT. A node's timeout is a ceiling nobody expects to
// reach — reader_insight's is 90s and it completes in 18. Pricing every dispatch at its timeout would
// have run_all refuse the entire conductor and hand every run to the tick, turning a 45-second call
// into a 2-minute-per-node crawl. The run's own measured p95 for that node (nodeTimingAggregates,
// scoped to this tenant) is the honest expectation; the timeout is the fallback for a node with no
// history, and refusing there is the right call precisely because nothing is known about it.
//
// REFUSING IS NOT FAILING. Same shape as every other driver stop: the persisted run, a named
// driverRefusal, a driverNote, and `continued: true`. The tick holds a 240s task window and takes it.
const DISPATCH_BUDGET_REFUSAL_CODE = "dispatch_exceeds_remaining_driver_budget" as const;
type DispatchBudgetRefusal = {
  code: typeof DISPATCH_BUDGET_REFUSAL_CODE;
  nodeId: string;
  nodeIds: string[];
  claimKind: DispatchClaimKind;
  expectedMs: number;
  expectedSource: "measured_p95" | "node_timeout";
  plannedClaimMs: number;
  remainingDriverMs: number;
  marginMs: number;
  unreclaimableForMs: number;
};

const dispatchBudgetRefusalNote = (refusal: DispatchBudgetRefusal): string =>
  `The next runnable node (${refusal.nodeId}) is expected to take ${refusal.expectedMs}ms (${refusal.expectedSource === "measured_p95" ? "this tenant's measured p95 for that node" : "no measured history, so its own " + refusal.plannedClaimMs + "ms timeout"}), and this driver has ${refusal.remainingDriverMs}ms of its request budget left. It was NOT dispatched. Starting it would have this request end with the node's ${refusal.plannedClaimMs}ms claim stamped and no driver behind it — unreclaimable for up to ${refusal.unreclaimableForMs}ms — which is the abandoned-dispatch failure this refusal exists to prevent. The run's state is persisted, nothing is in flight, and this is not a failure: the scheduled continuation tick (a 240s task window, not a request) advances it, or call this tool again for a fresh budget.`;

// Priced from executor.nextDispatchPlan — the claim the executor will actually stamp — against the
// caller's own remaining wall clock. Fail-open like every other pricing read here: a resolution that
// throws must never be the reason a run stops advancing.
const dispatchBudgetRefusalFor = (
  run: WorkflowExecutionRecord,
  plan: NonNullable<Awaited<ReturnType<typeof nextDispatchPlan>>>,
  remainingDriverMs: number,
  timing: RunStallTimingContext | undefined
): DispatchBudgetRefusal | undefined => {
  // A MOCK run makes no model call at all (MockNodeRunner returns synchronously), so its dispatches
  // take milliseconds whatever the node's timeout says. Pricing them at a model timeout would refuse
  // every node of every CI and smoke run for a cost that is not there.
  if ((run.executionMode ?? DEFAULT_EXECUTION_MODE) === "mock") return undefined;
  // A deterministic stage's window is a FLOOR over work nothing races, so a measured p95 is not a
  // bound on it and must never be used to let one through. D9's own refusal covers those.
  const measuredP95 = plan.claimKind === "deterministic_stage" ? undefined : timing?.p95DurationMsByNode?.[plan.nodeId];
  const measured = typeof measuredP95 === "number" && measuredP95 > 0 ? Math.ceil(measuredP95) : undefined;
  const expectedMs = measured ?? plan.plannedTimeoutMs;
  if (expectedMs + DISPATCH_DEADLINE_MARGIN_MS <= remainingDriverMs) return undefined;
  return {
    code: DISPATCH_BUDGET_REFUSAL_CODE,
    nodeId: plan.nodeId,
    nodeIds: plan.nodeIds,
    claimKind: plan.claimKind,
    expectedMs,
    expectedSource: measured === undefined ? "node_timeout" : "measured_p95",
    plannedClaimMs: plan.plannedTimeoutMs,
    remainingDriverMs: Math.max(0, Math.floor(remainingDriverMs)),
    marginMs: DISPATCH_DEADLINE_MARGIN_MS,
    unreclaimableForMs: plan.plannedTimeoutMs + STALL_MARGIN_MS
  };
};

// ONE graph resolution per advance, two questions asked of it. Both refusals price the SAME planned
// dispatch (executor.nextDispatchPlan reads the workspace node store), and resolving it twice per
// loop iteration would double that read for no new information.
type DriverRefusal = DispatchClaimRefusal | DispatchBudgetRefusal;
const resolveDriverRefusal = async (
  run: WorkflowExecutionRecord | undefined,
  workspaceRepository: Parameters<typeof nextDispatchPlan>[1],
  remainingDriverMs: number,
  timing: RunStallTimingContext | undefined,
  namedNodeId?: string
): Promise<{ refusal: DriverRefusal; note: string } | undefined> => {
  if (!run || HALTED_RUN_STATUSES.includes(run.status)) return undefined;
  const plan = await nextDispatchPlan(run, workspaceRepository).catch(() => undefined);
  if (!plan || plan.willSkipBeforeDispatch) return undefined;
  const claim = dispatchClaimRefusalFor(plan);
  if (claim) return { refusal: claim, note: dispatchClaimRefusalNote(claim, namedNodeId) };
  const budget = dispatchBudgetRefusalFor(run, plan, remainingDriverMs, timing);
  if (budget) return { refusal: budget, note: dispatchBudgetRefusalNote(budget) };
  return undefined;
};

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
// W3.1 — workspace.audit_capabilities takes an OPTIONAL id: with one it reports that node, without
// one it summarizes the whole graph. Its own schema rather than reusing nodeId, which requires the id.
const optionalNodeId = z.object({ id: z.string().min(1).optional(), projectId: z.string().min(1).optional() }).strict();
const optionalNodeIdJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1, description: "Check route requiredTools against THIS project's tool policy only. Omit for every registered active project." } }, []);
// T15.16 (#195) — workspace.get_graph's optional workflowId. Omitted, it keeps returning the flat
// store's own nodes/edges (now inclusive of capture_conductor's and clone_conductor's own nodes once
// ensureWorkspaceNodeSeeds has run — see that tool below); a real registered workflowId instead
// returns the topology that workflow ACTUALLY runs (resolveConductorNodes: canonical topology
// per workflow, store-overlaid prompt/schema/tools/metadata), so a capture/clone-bound edge like
// capture_emit_live -> publish_payload — invisible in the flat store view, since the tail's stored
// row carries publishing_conductor's own dependsOn — is visible when asked for by workflow.
const graphInput = z.object({ workflowId: z.string().min(1).optional() }).strict();
const updatePrompt = z.object({ id: z.string().min(1), prompt: z.string().min(1), ...mutationMeta }).strict();
const updateSchema = z.object({ id: z.string().min(1), schema: z.unknown(), ...mutationMeta }).strict();
// node-default-output (2026-09-15). `value: null` CLEARS the default; any other value sets it. The
// two are one verb rather than set/clear pair because a UI's Save and Clear are the same control with
// the same optimistic-concurrency story, and splitting them invites a clear that races a set.
// `force` is the operator's override of a schema failure, and it is deliberately NOT a softened
// "warn-only" flag: without it an invalid default is REFUSED, with it the default is stored with
// schemaValidAt: null so the record says it was saved over a failure.
const updateNodeDefaultOutputInput = z.object({ nodeId: z.string().min(1), value: z.unknown(), note: z.string().max(2000).optional(), force: z.boolean().optional(), ...mutationMeta }).strict();
const adoptOutputAsDefaultInput = z.object({ nodeId: z.string().min(1), runId: z.string().min(1).optional(), executionId: z.string().min(1).optional(), note: z.string().max(2000).optional(), force: z.boolean().optional(), ...mutationMeta }).strict();
const createNodeInput = z.object({ node: z.any(), ...mutationMeta }).strict();
const deleteNodeInput = z.object({ id: z.string().min(1), ...mutationMeta }).strict();
const cloneNodeInput = z.object({ id: z.string().min(1), newId: z.string().min(1), ...mutationMeta }).strict();
const updateNodeInput = z.object({ id: z.string().min(1), patch: z.record(z.string(), z.unknown()), ...mutationMeta }).strict();
// K-A9 — workspace.update_node_execution. Flat rather than patch-shaped on purpose: this verb has
// exactly two fields and a patch envelope would let a caller send `{}` and mean nothing.
const updateNodeExecutionInput = z.object({ id: z.string().min(1), executionKind: z.enum(["model", "deterministic"]), route: z.object({ id: z.string().min(1), mode: z.string().min(1).optional() }).strict().optional(), ...mutationMeta }).strict();

// R-1 — data-loss guard for the single-field node writers. Runs BEFORE T5's canonical-ownership
// refusal, so all five writers keep one uniform contract for a malformed patch and the ownership
// refusal is reserved for a well-formed write.
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
// T5 — the graph surface's half of the canonical-owned-field refusal (see canonicalNodeFieldGuard.ts).
//
// update_graph reaches a canonical-owned field THREE ways, all checked here:
//   * a free-form `update[]` patch — an entry's `id` is its ADDRESS, not a written field, so it is
//     excluded from the key check;
//   * the `dependencies` map;
//   * `create`, which is the one that is easy to miss. updateGraph (store.ts) applies `delete` before
//     `create` inside ONE mutate(), and the canonical-presence rule in assertGraphValid only runs at
//     the end — so `{ delete: ["artifact_plan"], create: [{ id: "artifact_plan", dependsOn: [...] }] }`
//     re-creates a canonical row with arbitrary topology and passes every other check. Refusing a
//     create addressed to an id canonical defines closes that: the canonical row always exists (the
//     store is seeded and additively topped up from the canonical arrays), so such a create is either
//     a duplicate-id error or exactly this bypass. Never a legitimate act.
//
// `positions` and `orderedNodeIds` are NOT checked — position is the one deliberate exemption, being
// the design canvas's persisted layout with no run semantics.
const assertGraphUpdateKeepsCanonicalTopology = (toolName: string, update: { create?: unknown[]; update?: Array<Record<string, unknown> & { id: string }>; dependencies?: Record<string, string[]> }): void => {
  for (const raw of update.create ?? []) {
    const id = isPlainRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
    if (id) assertNoCanonicalOwnedFieldWrite(toolName, id, CANONICAL_OWNED_WRITE_REFUSED_FIELDS);
  }
  for (const patch of update.update ?? []) {
    assertNoCanonicalOwnedFieldWrite(toolName, patch.id, Object.keys(patch).filter((key) => key !== "id"));
    // K-A9 — a graph update is still a node patch, and the route must not be reachable through it.
    assertNoExecutionFieldWrite(toolName, Object.keys(patch));
  }
  for (const nodeId of Object.keys(update.dependencies ?? {})) assertNoCanonicalOwnedFieldWrite(toolName, nodeId, ["dependsOn"]);
};

const updateGraphInput = z.object({ create: z.array(z.any()).optional(), update: z.array(z.record(z.string(), z.unknown()).and(z.object({ id: z.string().min(1) }))).optional(), delete: z.array(z.string().min(1)).optional(), dependencies: z.record(z.string(), z.array(z.string().min(1))).optional(), orderedNodeIds: z.array(z.string().min(1)).optional(), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(), allowCanonicalNodeRemoval: z.boolean().optional(), adminApproved: z.boolean().optional(), ...mutationMeta }).strict();
// W5 T2 — `projectId` narrows the project-policy check to ONE tenant. Omitted, every registered
// ACTIVE project is checked, because "which of my four tenants can actually run this node" is the
// question an operator has, and asking it four times is not an answer.
const validateNodeInput = z.object({ node: z.any().optional(), id: z.string().min(1).optional(), projectId: z.string().min(1).optional() }).strict();
const importWorkspace = z.object({ nodes: z.array(workspaceNodeImport).optional(), stageOutputs: z.array(stageOutputImport).optional(), learningObservations: z.array(learningObservationImport).optional() }).strict();
// W3 (node-default-output, 2026-09-15) — TWO FORMS, ONE VERB, because the Workbench's override modal
// has been sending the second one since it shipped and the server rejected it as unrecognised keys.
//
//   WORKSPACE FORM  { stage, value, id? }             — the original. Appends to the workspace's own
//     stageOutputs collection. Nothing in a WORKFLOW RUN has ever read that collection (the only
//     consumer is nodeRuntime's standalone node_execute path), which is exactly why the override modal
//     appeared to work and changed nothing: a run reads run.stageOutputs, and this wrote elsewhere.
//   RUN-SCOPED FORM { runId, nodeId, value, note? }   — writes run.stageOutputs[nodeId] on THAT run,
//     completes the node, and stamps outputProvenance source "operator_override". This is what the
//     modal meant, and it is the same single writer every supplied output goes through
//     (applyRunOutputFromDefault), so an override and a default are recorded identically and the
//     publishing tail refuses both.
//
// Exactly one form per call: mixing them is a caller that does not know which surface it is writing to.
const saveOutput = z.object({ id: z.string().min(1).optional(), stage: z.string().min(1).optional(), value: z.unknown(), runId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(), note: z.string().max(2000).optional() }).strict()
  .refine((value) => (value.stage !== undefined) !== (value.runId !== undefined && value.nodeId !== undefined), { message: "supply either `stage` (the workspace stage-output collection) or BOTH `runId` and `nodeId` (an operator override on one run) — not both forms, and not half of the run-scoped one." });
const listOutputs = z.object({ stage: z.string().min(1).optional() }).strict();
const recordObservation = z.object({ observation: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional(), runId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(), projectId: z.string().min(1).optional() }).strict();
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

const startDryRunInput = z.object({ projectId: z.string().min(1), input: z.any(), workflowId: z.string().min(1).optional(), executionMode: z.enum(["mock", "openai"]).default(DEFAULT_EXECUTION_MODE), entrypoint: z.enum(["article_body"]).optional(), articleBody: z.unknown().optional(), budgetUsd: z.number().nonnegative().optional(), requestId: z.string().min(1).optional(), publishRequestId: z.string().min(1).optional(), outputMode: z.enum(RUN_OUTPUT_MODES).optional(), objective: z.string().min(1).optional() }).strict();

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

// S3 (2026-08-25, run_1787656120374_18bobg) — THE PUBLISH REQUEST ID, which is NOT the run's join key.
//
// The publish contract id (req_<flow>_<topic>_<yyyymmdd>_<nn>) is authored by exactly one node,
// artifact_plan, and lifted from its stage output into run context (buildRunContext, runContext.ts).
// A late-stage entrypoint run seeds artifact_plan as completed-and-skipped — it authors nothing, and
// leaves no stage output — so such a run held no publish id at all and could never publish: on
// run_1787656120374_18bobg (dr-lurie) the controller said "go", the operator said "approved", all five
// publisher gates passed, and publish_executor still refused with
//
//   publish_request_id_absent at request_id: no upstream output and no run context carries a publish
//   requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>). The id is operator-supplied by contract and is
//   never minted here, so dr-lurie is not published; supply it on artifact_plan/publish_payload and
//   retry.
//
// This is the supply channel that refusal asks for, moved to the front of the run: the operator names
// the id when they enter late, it is stored on the run as its OWN field
// (WorkflowExecutionRecord.publishRequestId), and buildRunContext uses it as the FALLBACK behind
// artifact_plan's authored id — so a run that really authored one always wins, and every downstream
// consumer (publish_payload's deterministic builder, publish_executor's engine path) reads it off
// runContext.requestId exactly as it always read an authored id.
//
// TWO RULES THIS DELIBERATELY KEEPS. (1) It is never `requestId`. That field is the platform/workspace
// join key (executionTypes.ts says so in as many words); falling back to it would put the wrong
// identifier on a live client object, which is worse than not publishing. (2) It is never minted. The
// argument is OPTIONAL for every project and every mode — omit it and the run has no publish id and
// publish_executor refuses exactly as it does today. Nothing here generates, defaults, or infers one.
//
// A SUPPLIED id is always validated, before the run is created, the same way `articleBody` is: against
// the project's declared objectDialect.requestIdPattern where it has one (platform, dr-lurie, fernwell
// all declare req_<flow>_<topic>_<yyyymmdd>_<nn>), and against the publisher's shared contract default
// otherwise — via the publisher's OWN compiler, so the id that passes here is the id that passes there.
// A twenty-node run must not be built on a publish id its publish step will reject.
async function resolvePublishRequestId(projectId: string, publishRequestId: string | undefined): Promise<string | undefined> {
  if (publishRequestId === undefined) return undefined;
  const config = await repositoryManager.getProjectRepository().get(projectId);
  const pattern = compileRequestIdPattern(config?.objectDialect?.requestIdPattern);
  if (!pattern.test(publishRequestId)) {
    throw new WorkspaceToolError("invalid_publish_request_id", `publishRequestId "${publishRequestId}" does not match ${pattern.source} (${REQUEST_ID_FORM}); publish request ids are operator-supplied by contract and are never generated.`, { projectId, requestIdPattern: pattern.source, publishRequestId });
  }
  return publishRequestId;
}
// R2 — retryJustification is read ONLY by workflow.retry_node (below); workflow.run_node accepts and
// ignores it (shared schema) because it never re-dispatches a "failed" node in the first place
// (findRunnableNodes only ever selects queued/dependency-ready nodes) — see executor.ts's
// RunAdvanceOptions doc comment for what supplying it does and does not do.
const runNodeInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1).optional(), approved: z.boolean().optional(), retryJustification: z.string().min(1).optional(), useDefaultOutput: z.boolean().optional(), defaultOutputNote: z.string().max(2000).optional() }).strict();
const runUntilInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1), approved: z.boolean().optional() }).strict();
const runIdInput = z.object({ runId: z.string().min(1) }).strict();
// T7: get_run defaults to the compact view; "full" is the old raw-record behaviour, opted into.
const getRunInput = z.object({ runId: z.string().min(1), detail: z.enum(["compact", "full"]).default("compact") }).strict();
// F3 (T-2, run_1785352838155_l544ye): budgetUsd is optional so plain resume (no ceiling change)
// keeps working exactly as before; supplying it raises (or sets) the run's ceiling in the same call.
const resumeRunInput = z.object({ runId: z.string().min(1), budgetUsd: z.number().nonnegative().optional() }).strict();
const runNextNodeInput = z.object({ runId: z.string().min(1), approved: z.boolean().optional() }).strict();
// P0 §2.2 — the ONE setter for the operator's durable publish decision (run.operatorPublishDecision).
const operatorPublishDecisionInput = z.object({ runId: z.string().min(1), decision: z.enum(["approved", "withheld"]) }).strict();
// budget-override-and-ui-save — the ONE setter for run.nodeBudgetOverrides (executor.setNodeBudgetOverride).
const setNodeBudgetOverrideInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1), budgetUsd: z.number().positive() }).strict();
const listRunsInput = z.object({
  projectId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  status: z.union([z.enum(executionStatuses), z.array(z.enum(executionStatuses)).min(1)]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(MAX_LIST_RUNS_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
  detail: z.enum(["summary", "full"]).optional()
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
// W3.2.2/W4.1 — `runId` on tool.get_execution is a HINT, not a filter: with it the durable ledger
// answers in one key read, without it that lookup would be a scan of every run and is skipped.
const toolExecutionInput = z.object({ toolExecutionId: z.string().min(1), runId: z.string().min(1).optional() }).strict();
// W4.1 — caller/routeId. An engine-invoked tenant verb was unfindable before the choke point existed;
// these are the two filters that make "what did this route actually call" answerable.
const listToolExecutionsInput = z.object({ runId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(), toolId: z.string().min(1).optional(), caller: z.enum(["model", "engine", "operator"]).optional(), routeId: z.string().min(1).optional(), projectId: z.string().min(1).optional() }).strict();
// W3.3 — node.get_effective_tools takes an optional runId so it can answer against the SAME
// authorization the dispatch would run under (dispatchToolContext). Without one it keeps its old
// context-free answer, which is the honest reply to "what does this node declare" as distinct from
// "what would this run let it do".
// W4.1 — how many of a tenant's most recent ledger rows project.get.usedBy summarizes. A cap rather
// than everything: this is an operator's "who would I break" glance, and tool.list_executions with a
// projectId filter is the unbounded view.
export const PROJECT_USED_BY_SAMPLE = 500;
const nodeToolInput = z.object({ nodeId: z.string().min(1), runId: z.string().min(1).optional() }).strict();
const nodeValidateInput = z.object({ nodeId: z.string().min(1), value: z.unknown() }).strict();
const nodePrepareInput = z.object({ nodeId: z.string().min(1), input: z.unknown().optional(), dependencyOutputs: z.record(z.string(), z.unknown()).optional(), modelConfig: z.record(z.string(), z.unknown()).optional() }).strict();
const nodeExecuteInput = z.object({ nodeId: z.string().min(1), input: z.unknown().optional(), runId: z.string().min(1).optional(), dependencyOutputs: z.record(z.string(), z.unknown()).optional(), executionMode: z.enum(["mock", "openai"]).default(DEFAULT_EXECUTION_MODE), modelConfig: z.record(z.string(), z.unknown()).optional(), expectedWorkspaceVersion: z.number().int().nonnegative().optional() }).strict();
const nodeQueryInput = z.object({ nodeId: z.string().min(1).optional(), runId: z.string().min(1).optional(), executionId: z.string().min(1).optional(), artifactType: z.string().min(1).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
const nodeRetryInput = z.object({ runId: z.string().min(1), nodeId: z.string().min(1).optional(), executionId: z.string().min(1).optional() }).strict();


const emptyJsonSchema = objectSchema();
const nodeIdJsonSchema = objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]);
const graphJsonSchema = objectSchema({ workflowId: { type: "string", minLength: 1, description: "Optional. A registered workflow id (\"publishing_conductor\", \"capture_conductor\", \"clone_conductor\") to get that workflow's ACTUAL run topology (canonical dependsOn, store-overlaid prompt/schema/tools) instead of the flat store view. Omit for the flat store view of every governance-visible node." } });
const updatePromptJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 }, ...metaJson }, ["id", "prompt"]);
// `schema` is advertised as object-or-boolean (the two legal JSON Schema shapes) rather than the
// previous permit-anything `{}`, so a client has the type information it needs not to stringify it.
// coerceSchemaInput still accepts a stringified schema for the clients that do it anyway (R-3).
const updateSchemaJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, schema: { type: ["object", "boolean"] }, ...metaJson }, ["id", "schema"]);
const updateNodeExecutionJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, executionKind: { type: "string", enum: ["model", "deterministic"], description: "model = a model dispatch; deterministic = engine code runs it with zero model calls." }, route: { type: "object", description: "Required when executionKind is \"deterministic\". `id` is the declaring route key (e.g. \"releaseExecutorDeterministic\", \"captureStageDeterministic\"); `mode` is the stage of a staged route (e.g. \"crawl\").", properties: { id: { type: "string", minLength: 1 }, mode: { type: "string", minLength: 1 } }, required: ["id"] }, ...metaJson }, ["id", "executionKind"]);
const updateNodeDefaultOutputJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, value: { description: "The standing output for this node, in the shape its outputSchema declares. `null` CLEARS the default." }, note: { type: "string", maxLength: 2000, description: "Why this default exists — shown next to it in the Workbench." }, force: { type: "boolean", description: "Store the value even though it fails the node's outputSchema. The operator is the authority and a schema can be wrong; the stored default is then stamped schemaValidAt: null." }, ...metaJson }, ["nodeId", "value"]);
const adoptOutputAsDefaultJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1, description: "Adopt the output this node produced in THIS run. Omit for the node's most recent output across all runs." }, executionId: { type: "string", minLength: 1 }, note: { type: "string", maxLength: 2000 }, force: { type: "boolean" }, ...metaJson }, ["nodeId"]);
const mutationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, newId: { type: "string", minLength: 1 }, node: {}, patch: { type: "object" }, create: { type: "array" }, update: { type: "array" }, delete: { type: "array", items: { type: "string" } }, dependencies: { type: "object" }, orderedNodeIds: { type: "array", items: { type: "string" } }, positions: { type: "object" }, ...metaJson });
const workspaceNodeJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, prompt: { type: "string" }, schema: {}, updatedAt: { type: "string", format: "date-time" } }, ["id", "name", "prompt", "schema", "updatedAt"]);
const stageOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1 }, value: {}, createdAt: { type: "string", format: "date-time" } }, ["id", "stage", "value", "createdAt"]);
const learningObservationJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, observation: { type: "string", minLength: 1 }, metadata: { type: "object" }, createdAt: { type: "string", format: "date-time" } }, ["id", "observation", "createdAt"]);
const importWorkspaceJsonSchema = objectSchema({ nodes: { type: "array", items: workspaceNodeJsonSchema }, stageOutputs: { type: "array", items: stageOutputJsonSchema }, learningObservations: { type: "array", items: learningObservationJsonSchema } });
const saveOutputJsonSchema = objectSchema({ id: { type: "string", minLength: 1 }, stage: { type: "string", minLength: 1, description: "WORKSPACE FORM: the stage key to save under, in the workspace's own stageOutputs collection. No workflow run reads this collection — use the run-scoped form to change what a run's downstream nodes see." }, value: {}, runId: { type: "string", minLength: 1, description: "RUN-SCOPED FORM (with nodeId): overwrite this node's output on THIS run. Every downstream node then reads your value, the node is recorded as completed with provenance source \"operator_override\", and the run can no longer publish live (gate.publishing.defaulted_upstream)." }, nodeId: { type: "string", minLength: 1, description: "RUN-SCOPED FORM (with runId): the node whose output to replace." }, note: { type: "string", maxLength: 2000, description: "RUN-SCOPED FORM: why the override was made; recorded on the run's provenance stamp." } }, ["value"]);
const listOutputsJsonSchema = objectSchema({ stage: { type: "string", minLength: 1 } });
const recordObservationJsonSchema = objectSchema({ observation: { type: "string", minLength: 1 }, metadata: { type: "object" }, runId: { type: "string", minLength: 1, description: "Optional: attribute this observation to the run that produced it, so it can be joined back later." }, nodeId: { type: "string", minLength: 1, description: "Optional: attribute this observation to the node that produced it." }, projectId: { type: "string", minLength: 1, description: "Optional: the CMS-Agent project id this observation belongs to (e.g. \"dr-lurie\"), so a project-scoped learning.list_observations finds it. NOT the tracking sink's partition id." } }, ["observation"]);
// 2.8 (handoff 2026-08-10): lifecycle/archival for learning observations. Nothing is ever hard-deleted
// — archive is soft: the record stays, gains status:"archived" plus archivedAt/archivedReason, and
// listObservations excludes it by default (includeArchived:true opts back in). This is what lets
// curation/migration skip a sunset directive's observations (e.g. the "[ALIGN" coordination-board
// records — see scripts/purgeAlignObservations.ts) without needing every reader updated separately.
const listObservationsInput = z.object({ includeArchived: z.boolean().optional(), projectId: z.string().min(1).optional() }).strict();
const listObservationsJsonSchema = objectSchema({ includeArchived: { type: "boolean", description: "Include archived (soft-deleted) observations. Default false." }, projectId: { type: "string", minLength: 1, description: "CMS-Agent project id (e.g. \"dr-lurie\") to narrow to. NOT the tracking sink's partition id." } });
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
const startDryRunJsonSchema = objectSchema({ projectId: { type: "string", minLength: 1 }, input: {}, workflowId: { type: "string", minLength: 1 }, executionMode: { type: "string", enum: ["mock", "openai"], default: DEFAULT_EXECUTION_MODE, description: EXECUTION_MODE_DESCRIPTION }, entrypoint: { type: "string", enum: ["article_body"], description: "Late-stage entrypoint. With a supplied valid articleBody the run enters at article_body -> publish_payload -> publication_controller and earlier ideation/research/draft nodes are seeded as completed (not re-run)." }, articleBody: { type: "object", description: "Output to seed as the article_body node's result for a late-stage entrypoint run. Validated against the article_body node's OWN outputSchema (see node.get_output_schema) — not against a workspace-local article shape, which the node rejects. Rejected before the run is created, with the failing fields named." }, budgetUsd: { type: "number", minimum: 0, description: "Optional per-run cost ceiling in USD. Default OFF (omit = no gate). When set, the conductor halts the run (status blocked, paused for budget) before dispatching any node once the run's accrued estimated model cost reaches this ceiling; the pending node is not executed. Inspect via workflow.get_run_cost (ledger.budget)." }, requestId: { type: "string", minLength: 1, description: "Caller-supplied request id for this run. REQUIRED for a live (openai) run when the project declares objectDialect.requestIdPattern (platform, dr-lurie, fernwell: req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case) — the tool refuses with request_id_required/invalid_request_id naming the pattern; request ids are never auto-generated for such a run. Optional (auto-minted) for a mock dry-run or a project without a pattern; a supplied id is always validated." }, publishRequestId: { type: "string", minLength: 1, description: "Operator-supplied PUBLISH request id (req_<flow>_<topic>_<yyyymmdd>_<nn>, lowercase snake_case), stored on the run and lifted into every node's run context. A DIFFERENT identifier from `requestId`, which is the platform/workspace join key — neither ever substitutes for the other. This id is normally authored by the artifact_plan node; supply it here for a late-stage entrypoint run, whose artifact_plan is seeded as skipped and therefore authors none (without it such a run reaches the publish gate and is refused with publish_request_id_absent). Always OPTIONAL and never generated: omit it and the run simply has no publish id and that refusal stands. A supplied id is validated before the run is created against the project's objectDialect.requestIdPattern where declared (platform, dr-lurie, fernwell), otherwise the publisher's shared contract pattern, refusing with invalid_publish_request_id. An id authored by a real artifact_plan run always takes precedence over this one. Survives workflow.reset_run." }, objective: { type: "string", minLength: 1, description: "Optional NAMED GOAL for this run (scope vocabulary dimension `objective`; see skill.scope). Stored on the run, carried across workflow.reset_run, and used to select objective-scoped skills and playbooks. Never derived from the topic or the request id — a run that does not name one is in no objective, and objective-scoped policy does not apply to it." }, outputMode: { type: "string", enum: [...RUN_OUTPUT_MODES], default: "live", description: "TEST MODE for this run, chosen once at start and honoured by every advance including the scheduled continuation tick. \"live\" (default): today's behaviour — every node runs. \"defaults_where_set\": any node carrying a DEFAULT OUTPUT is passed through for free (durationMs 0, no model turn); the rest run live. \"defaults_only\": defaults are used where present and a node WITHOUT one FAILS with default_output_missing — one run exercises a whole conductor's topology and contracts in seconds and names every gap. Any run that used a default is refused at its publishing tail (gate.publishing.defaulted_upstream) unless it is a mock run: fixture content never publishes." } }, ["projectId", "input"]);
const runIdJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 } }, ["runId"]);
const getRunJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, detail: { type: "string", enum: ["compact", "full"], default: "compact", description: "compact (default): the compact run view. full: the complete record including node inputs/outputs, stageOutputs and artifacts." } }, ["runId"]);
const resumeRunJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, budgetUsd: { type: "number", minimum: 0, description: "Optional: raise (or set) the run's per-run cost ceiling in the same call that resumes it. Omit to resume unchanged — this is what makes the budget gate's own remedy (\"raise budgetUsd and resume\") actually reachable; previously resume_run took only runId and there was no way to raise the ceiling that blocked the run." } }, ["runId"]);
const runNextNodeJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, approved: { type: "boolean" } }, ["runId"]);
const operatorPublishDecisionJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, decision: { type: "string", enum: ["approved", "withheld"], description: "\"withheld\" is a durable operator veto: it blocks workflow.publish_run and every publish-risk node for this run regardless of approved/live flags, until replaced. \"approved\" records explicit, durable operator approval — the record an executed publish_execution.v1's approvalMatched must match." } }, ["runId", "decision"]);
const setNodeBudgetOverrideJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, budgetUsd: { type: "number", exclusiveMinimum: 0, description: "The node's new per-run budget ceiling in USD, in place of its own modelConfig.budgetUsd for THIS run only — see a budget_exceeded error's own details.suggestedBudgetUsd for a computed raise. The node's stored modelConfig is never touched (every other run keeps its normal ceiling), and this does NOT retry the node — call workflow.retry_node separately once the override is set." } }, ["runId", "nodeId", "budgetUsd"]);

// R-19 — the run-advancing tools used to advertise mutationJsonSchema, the WORKSPACE-mutation shape. That
// schema has no `runId` property, lists nothing as required, and (like every objectSchema) sets
// additionalProperties: false. So the advertised contract simultaneously omitted the one argument these
// tools require and forbade sending it. Any client that validates against tools/list before calling —
// which is every strict client, and is why T6.6 could not be executed — was locked out of run_node,
// run_until, run_all and retry_node. Verified live: the served workflow_run_all schema still shows
// required: [] with no runId. Each tool now advertises exactly its own Zod shape.
const runNodeJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, approved: { type: "boolean" }, useDefaultOutput: { type: "boolean", description: "Push the named node through from its DEFAULT OUTPUT instead of running it: the node completes with the stored value, durationMs 0, no model turn and no cost. Requires nodeId. Refused with default_output_missing when the node has no default, and refused on a live run's publishing tail (gate.publishing.defaulted_upstream) — fixture content never publishes." }, defaultOutputNote: { type: "string", maxLength: 2000, description: "Optional note recorded on this run's provenance stamp for the pushed-through node; falls back to the default's own note." }, retryJustification: { type: "string", minLength: 1, description: "workflow.retry_node only. Required to retry a node the no-progress gate has refused (unchanged input/node-definition/capability-state since its last terminal failure — see the node's own blockage/noProgress fields on workflow.get_run). Recorded verbatim for audit; never verified against anything real." } }, ["runId"]);
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
// T15.7 (ADR-2026-08-25-publish-autonomy §7) — this preamble used to trust the caller's raw `approved`
// flag as its own signal for whether the one-step unstick is worth attempting. `approved` is
// deprecated as an authority input everywhere (invariant 7: authority is a pure function of the run's
// own operator record and policy snapshot, not a caller flag) — advanceRun (executor.ts) already
// re-validates via resolvePublishAuthority before it actually clears the gate, so trusting the SAME
// resolver here (rather than a caller flag advanceRun no longer honors) is what keeps this preamble
// from silently no-op'ing the moment an operator's workflow.set_operator_publish_decision("approved")
// lands without the caller ALSO re-passing a flag nothing downstream reads any more.
const enterApprovedGateBlockedRun = async (
  run: WorkflowExecutionRecord | undefined,
  _approved: boolean | undefined,
  advance: () => Promise<WorkflowExecutionRecord>
): Promise<WorkflowExecutionRecord | undefined> => (run && isApprovalGateOnlyBlock(run) && resolvePublishAuthority(run).authorized ? advance() : run);
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
  status: { anyOf: [{ type: "string", enum: [...executionStatuses] }, { type: "array", minItems: 1, items: { type: "string", enum: [...executionStatuses] } }], description: "Only runs with exactly this status — or, given an array, any of these. `page.matchedCount` then counts every run in that set, so \"how many runs need attention\" is one limit:1 call rather than one per status." },
  from: { type: "string", format: "date-time", description: "Only runs with startedAt >= this ISO timestamp." },
  to: { type: "string", format: "date-time", description: "Only runs with startedAt <= this ISO timestamp." },
  limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size; default 20, max 100." },
  cursor: { type: "string", minLength: 1, description: "Opaque nextCursor from the previous page; omit for the first page." },
  detail: { type: "string", enum: ["summary", "full"], default: "summary", description: "\"summary\" (DEFAULT) returns compact rows read straight from the run index — no run record is opened, so a page costs the same whether it holds 1 row or 100. Carries per-node COUNTS (nodeCount/completedCount/failedCount) rather than a nodes[] array, and errorCount rather than the run-level errors[] strings; every other field of the \"full\" row — including approvalsRequired, budgetBlock and operatorPublishDecision — is present unchanged. \"full\" returns the previous shape, including nodes[] with each node's status, timings, bounded errors/warnings and attempt history — one run-record read per row, so ask for it only when you need per-node detail for a whole page (for ONE run, workflow.get_run is the cheaper read)." }
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
  tokenSecretRef: { type: "string", pattern: "^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/secrets/[A-Za-z0-9_-]{1,255}/versions/(?:latest|[1-9][0-9]{0,18})$", maxLength: 512, description: "Secret Manager VERSION RESOURCE NAME holding the bearer token — a pointer, never the value (e.g. projects/my-project/secrets/tenant-acme-mcp-token/versions/latest). PREFERRED over tokenEnvVar: resolution is env var first, this second, and a plane that carries no tenant environment at all (the continuation-tick Cloud Run job) still resolves it with its own service-account identity, so a new tenant needs no deployment change on any plane. Dereferencing requires roles/secretmanager.secretAccessor on each executing plane's identity. On project.update, null clears it." },
  allowedTools: { type: "array", items: { type: "string" }, default: [], description: "Legacy allow-list; a listed tool resolves to \"allowed\". toolPolicies/defaultToolPolicy are the richer control." },
  defaultToolPolicy: { type: "string", enum: ["allowed", "needs_approval", "blocked"], description: "Fallback permission for any tool not named in allowedTools/toolPolicies. Absent = blocked (deny-all)." },
  toolPolicies: { type: "object", additionalProperties: { type: "string", enum: ["allowed", "needs_approval", "blocked"] }, description: "Per-tool permission overrides (highest precedence): allowed | needs_approval | blocked." },
  contentContract: { type: "object", additionalProperties: false, properties: { contentContract: { type: "string" } } },
  // W21 (Wolf, 2026-09-14) — the capture bounds, finally reachable over the wire.
  //
  // projectAdmin.ts has validated and merged this field on BOTH create and update since capture
  // shipped; only this JSON schema omitted it, and objectSchema sets additionalProperties:false, so
  // every attempt to set a tenant's crawl scope through MCP was rejected at the wire and the policy
  // could be changed only by editing a project definition and redeploying. That is why three
  // projects still carry a crawl origin copied from one 2026-08 clone job.
  //
  // Exposing it widens nothing on its own: capture bounds are enforced on three sides (this
  // registry, the tenant's Platform bridge, pdf-tool's worker), each of which may only narrow what
  // it is handed — maxPages is clamped to the plane's hard ceiling of 50, sameOriginOnly /
  // respectRobots / authenticatedAccess:"prohibited" are refused rather than relayed if weakened,
  // and the tenant's own `siteCapture` guardrail can narrow further still. What it buys is that
  // scoping a crawl to the job that needs it is now a call, so the conservative choice stops being
  // the expensive one.
  capturePolicy: {
    type: "object",
    additionalProperties: false,
    description: "Per-project crawl bounds (ProjectCapturePolicy), replaced whole. The project's OWN origin is seeded automatically by the resolver and need not be listed; name an origin here only to authorize crawling SOMEBODY ELSE'S site, and pair it with the rights you have actually cleared for that origin. maxPages 0 with an empty allowedCrawlOrigins is the deny-all floor for third parties.",
    properties: {
      maxPages: { type: "integer", minimum: 0, description: "Per-project page ceiling for one crawl. Clamped to the capture plane's hard maximum of 50 on both the bridge and pdf-tool's worker." },
      allowedCrawlOrigins: { type: "array", maxItems: 32, items: { type: "string", format: "uri" }, description: "HTTPS origins, no path/query/fragment. THIRD-PARTY origins only need listing; the project's own origin is layered on by resolveProjectCapturePolicy." },
      allowedPathPrefixes: { type: "array", maxItems: 128, items: { type: "string" }, description: "Absolute path prefixes without query or fragment, e.g. \"/\"." },
      sameOriginOnly: { type: "boolean", description: "Must be true — the capture plane refuses anything else." },
      respectRobots: { type: "boolean", description: "Must be true — the capture plane refuses anything else." },
      concurrency: { type: "integer", minimum: 1, maximum: 32 },
      delayMs: { type: "integer", minimum: 0, maximum: 86400000 },
      authenticatedAccess: { const: "prohibited", description: "The only accepted value; the plane never crawls behind a login." },
      rights: { type: "object", additionalProperties: false, properties: { content: { type: "string", enum: ["prohibited", "retain_allowed_origin_content"] }, media: { type: "string", enum: ["prohibited", "retain_referenced_allowed_origin_media"] } }, required: ["content", "media"], description: "What may be RETAINED from the allowed origins. Policy-wide, not per-origin: raising it raises it for every origin listed, so add a third-party origin and its rights in the same considered call." },
      designReferences: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, properties: { origin: { type: "string", format: "uri" }, purpose: { const: "design_inspiration_only" }, crawlAllowed: { const: false }, contentReuse: { const: "prohibited" }, mediaReuse: { const: "prohibited" } }, required: ["origin", "purpose", "crawlAllowed", "contentReuse", "mediaReuse"] }, description: "Origins looked at for design inspiration but never crawled or reused." },
      fidelity: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["source_faithful", "design_inspired"] }, sourceDesignTreatment: { type: "string", enum: ["source_content_and_design", "source_content_with_design_inspiration_only"] }, coverageRubricOverride: { type: "object", additionalProperties: false, properties: { minimumMappedBlockCoverage: { type: "number", minimum: 0, maximum: 1 }, requireCompleteTokens: { type: "boolean" }, requireEnumeratedGaps: { type: "boolean" } }, required: ["minimumMappedBlockCoverage", "requireCompleteTokens", "requireEnumeratedGaps"] } }, required: ["mode", "sourceDesignTreatment"] }
    },
    required: ["maxPages", "allowedCrawlOrigins", "allowedPathPrefixes", "sameOriginOnly", "respectRobots", "concurrency", "delayMs", "authenticatedAccess", "rights", "designReferences", "fidelity"]
  },
  status: { type: "string", enum: ["active", "disabled"], default: "active" }
}, ["projectId", "name", "mcpEndpointEnvVar"]);
const projectCreateJsonSchema = objectSchema({ project: projectDefinitionJsonSchema, ...metaJson }, ["project"]);
// Patch surface = the definition minus identity (projectId) and policy (publishingPolicy — server-controlled),
// PLUS ONE deliberate exception (T15.5, 2026-08-25, ADR-2026-08-25-publish-autonomy §2.2): autonomyMode,
// SUBSUMING T2's (2026-08-13) operatorPublishDefault, which is removed, not kept alongside this.
// publishingPolicy stays excluded as a whole — a caller can never patch publishEnabled (the hard
// kill-switch precondition every publish gate checks) or requiresExplicitPublish through this surface —
// but a project's autonomy policy (whether a run with no operator decision proceeds under policy
// authority, see ProjectPublishingPolicy.autonomyMode) is exposed by its own narrow,
// separately-validated field name instead of by opening the nested publishingPolicy object, so
// accepting it can never smuggle in the rest of the policy. See projectAdmin.ts's
// projectUpdateSchema/updateProject for the enforcement.
const projectPatchJsonSchema = (() => {
  const { projectId: _identity, ...patchable } = projectDefinitionJsonSchema.properties as Record<string, unknown>;
  return objectSchema({
    ...patchable,
    tokenEnvVar: { oneOf: [{ type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, { type: "null" }], description: "Env var NAME for the bearer token; null removes it (only valid when authMode is none)." },
    tokenSecretRef: { oneOf: [{ type: "string", pattern: "^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/secrets/[A-Za-z0-9_-]{1,255}/versions/(?:latest|[1-9][0-9]{0,18})$", maxLength: 512 }, { type: "null" }], description: "Secret Manager VERSION RESOURCE NAME for the bearer token (a pointer, never the value); null clears it, returning the project to env-var-only token resolution. Backfilling this on an existing project is what lets an executor plane with no tenant environment resolve its token." },
    mcpEndpoint: { oneOf: [{ type: "string", format: "uri", maxLength: 512 }, { type: "null" }], description: "The MCP endpoint URL stored on the record (https, no credentials/query/fragment); null clears it, returning the project to env-var-only endpoint resolution." },
    // T15.6 (2026-09-04): safe to expose here where publishingPolicy is not — this is a non-secret
    // Netlify site name/id, the fleet credential reconciler already writes it unprompted onto any
    // project it successfully applies a credential to, and site genesis already sets it at birth
    // for every generated tenant. This lets an operator backfill it by hand for a tenant that
    // predates genesis (dr-lurie, platform) instead of an env var + redeploy.
    clientSiteBinding: { oneOf: [{ type: "object", additionalProperties: false, properties: { netlifySiteName: { type: "string", minLength: 1, maxLength: 256 }, netlifySiteId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["netlifySiteName"] }, { type: "null" }], description: "Durable, non-secret client-site identity (Netlify site name, and optionally its site id) that makes this project eligible for the fleet Client Manager credential reconciler. null clears it. Set this on a legacy client-site project the reconciler otherwise cannot see at all." },
    // W4 (2026-09-09, Wolf): the two record fields the by-record strategy loop reads, exposed for the
    // same reason clientSiteBinding is and with the same limits — non-secret addressing configuration,
    // already stamped at birth by site genesis, and needed here as the BACKFILL path for the tenants
    // that predate genesis. Neither can widen anything: a partition names which sink rows are read,
    // and a dialect names where a tenant's own objects live. Both have a working convention behind
    // them (projectTypes.conventionalTenantSlug / conventionalStrategyObjectId), so patching either
    // overrides a derivation rather than deciding whether a tenant is served at all.
    tracking: { oneOf: [{ type: "object", additionalProperties: false, properties: { projectId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,62}$" } }, required: ["projectId"] }, { type: "null" }], description: "The tracking sink PARTITION this tenant's events land in — the BARE slug (\"drlurie\"), the same value site genesis writes onto the site as TRACKING_PROJECT_ID. Not the kebab-case CMS-Agent project id (\"dr-lurie\") and not the trk_<slug> tracking_config OBJECT id, which is not a partition at all. Omit it and the partition is derived by stripping non-alphanumerics from the project id; set it only when this tenant genuinely reads a different partition. null clears it." },
    objectDialect: { oneOf: [{ type: "object", additionalProperties: false, properties: { siteObjectId: { type: "string" }, taxonomyRegistryObjectId: { type: "string" }, objectIdSource: { type: "string", enum: ["server_minted", "request_id"] }, requestIdPattern: { oneOf: [{ type: "string" }, { type: "null" }] }, defaultObjectType: { oneOf: [{ type: "string" }, { type: "null" }] }, voiceObjectId: { oneOf: [{ type: "string" }, { type: "null" }] }, strategyObjectId: { oneOf: [{ type: "string" }, { type: "null" }] } } }, { type: "null" }], description: "Per-site parameters of the object-native publish dialect, merged field-by-field onto whatever the project already carries (so one pointer can be moved without restating the rest); null on a field clears it, null on the whole object removes the dialect. voiceObjectId and strategyObjectId address this tenant's governed editorial_voice / editorial_strategy singletons; both default by convention (voice_<slug>, strat_<slug>), so setting them is an override for a tenant whose object is not at the conventional id. A patch that would leave the dialect missing siteObjectId, taxonomyRegistryObjectId or objectIdSource is refused (object_dialect_incomplete) rather than persisted." },
    autonomyMode: { type: "string", enum: ["autonomous", "operator-gated"], description: "Whether a NEW run for this project proceeds under policy authority when no operator decision is recorded (publishingPolicy.autonomyMode). \"operator-gated\" (or omitting this field entirely) is today's unchanged behavior: no run publishes without an explicit operator approval. \"autonomous\" never stamps run.operatorPublishDecision — authority is resolved at gate-evaluation time (publishDecision.resolvePublishAuthority) — and an explicit \"withheld\", set via workflow.set_operator_publish_decision, always overrides it." }
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
const getToolExecutionJsonSchema = objectSchema({ toolExecutionId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 } }, ["toolExecutionId"]);
const listToolExecutionsJsonSchema = objectSchema({ runId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, toolId: { type: "string", minLength: 1 }, caller: { type: "string", enum: ["model", "engine", "operator"] }, routeId: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 } });
const nodeToolJsonSchema = objectSchema({ nodeId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 } }, ["nodeId"]);
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
  scope: { ...objectSchema({ site: { type: "string", minLength: 1, description: "A projectId. The skill applies only on that tenant." }, task: { type: "string", minLength: 1, description: "A nodeId (or agent id). The skill applies only to that unit of work." }, objective: { type: "string", minLength: 1, description: "A run's declared objective (workflow.start_dry_run `objective`). The skill applies only to runs started under it." } }), description: "C2 — WHAT THIS SKILL APPLIES TO. Omit for a fleet skill, which applies wherever it is assigned (the behaviour of every skill before this field existed). A named dimension is a REQUIREMENT: a dispatch that cannot state that dimension does not match it. Scope NARROWS an assignment and never creates one — a node must still assign the skill." },
  family: { type: "string", minLength: 1, description: "C2 — mutual-exclusion group. Two skills in one family are two cuts of the same job (e.g. the DTC and foundation versions); of the members that apply to a dispatch, the NARROWEST-scoped one is used and the wider ones are dropped as superseded. Two equally-scoped members that both apply are a configuration error and block the node, naming both." },
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
  // W0 T0.4 — the measured p95 per node for a workflow, handed to assessRunStall so it can say
  // "overdue" with a scale instead of only "not touched for 90 seconds". Best-effort: a timing store
  // that cannot be read leaves the stall block exactly as it was before this wave.
  // W0.1 — scoped to the run's own tenant. Four tenants share every workflowId, so the p95 this used
  // to hand assessRunStall was an average of four sites' node durations; a slow tenant's run looked
  // healthy against a fast tenant's history and vice versa. Records that predate projectId cannot be
  // attributed and are excluded by the filter, which thins the aggregate rather than corrupting it —
  // and a thin aggregate simply leaves the overdue flag unreported, exactly as an empty ledger does.
  const runStallTiming = async (workflowId: string, projectId?: string): Promise<RunStallTimingContext> => {
    try {
      const aggregates = aggregateNodeTimingsByNode(await nodeTimingRepository.list({ workflowId, ...(projectId ? { projectId } : {}) }));
      return { p95DurationMsByNode: Object.fromEntries(Object.values(aggregates).map((aggregate) => [aggregate.nodeId, aggregate.p95DurationMs])) };
    } catch {
      return {};
    }
  };

  const workspaceRepository = repositoryManager.getWorkspaceRepository();
  const changeRepository = repositoryManager.getChangeRepository();
  const meta = <T extends Partial<WorkspaceMutationMeta>>(data: T): T & WorkspaceMutationMeta => ({
    ...data,
    actor: data.actor ?? context.actor ?? { kind: "agent" },
    source: data.source ?? context.source ?? "mcp",
    correlation: data.correlation ?? (context.requestId ? { requestId: context.requestId } : undefined)
  });
  // node-default-output — `actor` is a union (a bare label string, or a structured actor); a default's
  // updatedBy records the KIND only. An unstructured string actor is attributed "agent", which is what
  // the store's own default-per-entry-path stamping already does for a direct MCP caller.
  const actorKind = (actor: WorkspaceMutationMeta["actor"]): NodeDefaultOutputAuthor =>
    (typeof actor === "object" && actor?.kind ? actor.kind : "agent");
  const executionRepository = repositoryManager.getExecutionRepository();
  const usageRepository = repositoryManager.getUsageRepository();
  const nodeTimingRepository = repositoryManager.getNodeTimingRepository();
  // W0 T0.2/T0.3 — the tick ledger / per-tenant background-dispatch stamp, read by project.get,
  // project.list and the run stall block.
  const driverHealthRepository = repositoryManager.getDriverHealthRepository();
  const learningRepository = repositoryManager.getLearningRepository();
  const projectRepository = repositoryManager.getProjectRepository();

  // W5 T2 — the tenant policies the capability audit checks route requiredTools against. Disabled
  // projects are excluded: a route that cannot run on a tenant nobody runs is not drift. A repository
  // read failure yields NO policies rather than an error, which is the fail-open direction — the
  // audit's other findings must not disappear because the project store was briefly unreadable.
  const projectPolicyViews = async (projectId?: string): Promise<ProjectPolicyView[]> => {
    try {
      const configs = projectId ? [await projectRepository.get(projectId)].filter(Boolean) as ProjectConnectionConfig[] : (await projectRepository.list()).filter((project) => project.status !== "disabled");
      return configs.map((project) => ({ projectId: project.projectId, allowedTools: project.allowedTools, defaultToolPolicy: project.defaultToolPolicy, toolPolicies: project.toolPolicies }));
    } catch {
      return [];
    }
  };
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
    tool({ name: "node.get_effective_prompt", description: "Resolve the effective prompt for one node without secrets.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => { await skillRepository.ensureSkillSeeds(); return ok(await getEffectivePrompt(nodeToolInput.parse(input).nodeId, workspaceRepository)); } }),
    tool({ name: "node.get_effective_tools", description: "Resolve what a node can actually do, in BOTH senses: `tools` are the controlled registry tools a model turn may call, and `engine` are the tenant MCP verbs the node's own deterministic route calls directly — which pass no grant and no risk check, and which no grant list has ever shown. With `runId`, resolves against the SAME authorization that run's dispatch uses (the node's risk cap, the run's authorized tools, the platform's allowed tools) — so the answer is what dispatch would actually allow, not a context-free reading of the node's grant list. Without `runId`, reports the node's own declaration.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => {
      const data = nodeToolInput.parse(input);
      const run = data.runId ? await getRun(data.runId, executionRepository) : undefined;
      const node = await resolveNodeForExecution(data.nodeId, undefined, run?.workflowId);
      // W4.1 — `engine` is the OTHER half of what a node can do, and the half no grant list has ever
      // shown: the tenant verbs its route calls directly through ProjectMcpAdapter. Those pass no node
      // grant and no risk check (they pass the choke point's own rule as of W3.2.1), so reporting only
      // `tools` here answers "what may this node call" with half the truth. Empty for a model
      // dispatch, which reaches the tenant only through a granted tool.
      // The audit is computed once and reported whole: executionKind is what decides whether the
      // `tools` list above can fire at all (a deterministic node returns before a model runner is
      // built), so returning the grants without it invites the reader to believe the grants.
      const audit = node ? auditNodeCapabilities(node) : undefined;
      const capability = audit
        ? { executionKind: audit.executionKind, ...(audit.routeId ? { routeId: audit.routeId } : {}), deadGrants: audit.deadGrants, findings: audit.findings }
        : null;
      const engine = audit?.engineRequiredTools ?? [];
      if (!run || !node) return ok({ tools: await resolveEffectiveToolsForNode(data.nodeId), engine, capability, resolvedAgainst: "node_declaration" });
      return ok({ tools: await resolveEffectiveToolsForNode(data.nodeId, dispatchToolContext({ run, node })), engine, capability, resolvedAgainst: "run_dispatch" });
    } }),
    // C2 — WITH a runId this answers "what did that run dispatch this node with"; WITHOUT one it
    // answers "what would this node dispatch with if it ran now". Those are different questions and
    // used to share one answer: every caller got the live assignment, and a finished run's inspection
    // presented it as the run's own. `source` says which question was answered, so no surface can
    // render a current preview as an execution record by accident (W2's requirement that a preview be
    // visibly different from a historical snapshot, and that unavailable evidence be labelled).
    tool({ name: "node.get_effective_skills", description: "Resolve effective skill policy for one node. Pass runId to get the selection that run PINNED for this node at its dispatch (source: run_selection, with the versions it dispatched at and a warning per skill edited since). Without runId — or for a node that run never dispatched — the live assignment is resolved instead and reported as source: current_preview, which is what the node WOULD use now, not what any run used.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => {
      const data = nodeToolInput.parse(input);
      await skillRepository.ensureSkillSeeds();
      const node = await workspaceRepository.getNode(data.nodeId);
      if (!node) throw new Error("Unknown node");
      const run = data.runId ? await getRun(data.runId, executionRepository) : undefined;
      const selection = run ? selectedSkillsFor(run, data.nodeId) : undefined;
      if (selection) {
        return ok({
          policy: await resolveSkillsForNode(node, skillRepository, { pinnedSkillIds: selection.skillIds, pinnedVersions: selection.versions }),
          source: "run_selection", runId: data.runId, selectedAt: selection.selectedAt, pinnedVersions: selection.versions
        });
      }
      return ok({
        policy: await resolveSkillsForNode(node, skillRepository),
        source: "current_preview",
        // Naming WHY there is no pinned answer beats returning the preview silently: "that run never
        // dispatched this node" and "you did not ask about a run" send a reader to different places.
        ...(data.runId ? { runId: data.runId, previewReason: run ? "this run has no pinned skill selection for this node — it never dispatched it, or it predates run-pinned selection" : `unknown run: ${data.runId}` } : {})
      });
    } }),
    tool({ name: "node.get_input_schema", description: "Get one node input schema.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeToolInput.parse(input).nodeId); return ok({ schema: node?.inputSchema ?? null }); } }),
    tool({ name: "node.get_output_schema", description: "Get one node output schema.", zodSchema: nodeToolInput, inputSchema: nodeToolJsonSchema, execute: async (input) => { const node = await workspaceRepository.getNode(nodeToolInput.parse(input).nodeId); return ok({ schema: node?.outputSchema ?? null }); } }),
    tool({ name: "node.validate_input", description: "Validate input against a node input schema.", zodSchema: nodeValidateInput, inputSchema: nodeValidateJsonSchema, execute: async (input) => { const data = nodeValidateInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ validation: validateAgainstNodeSchema(data.value, node.inputSchema) }); } }),
    tool({ name: "node.validate_output", description: "Validate output against a node output schema.", zodSchema: nodeValidateInput, inputSchema: nodeValidateJsonSchema, execute: async (input) => { const data = nodeValidateInput.parse(input); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ validation: validateAgainstNodeSchema(data.value, node.outputSchema) }); } }),
    tool({ name: "node.prepare_execution", description: "Prepare one node execution without calling the model.", zodSchema: nodePrepareInput, inputSchema: nodePrepareJsonSchema, execute: async (input) => ok({ preparation: await prepareNodeExecution(nodePrepareInput.parse(input), { workspaceRepository }) }) }),
    tool({ name: "node.execute", description: "Execute exactly one node independently from the full workflow.", zodSchema: nodeExecuteInput, inputSchema: nodeExecuteJsonSchema, execute: async (input) => ok(await executeNode(nodeExecuteInput.parse(input), { workspaceRepository, executionRepository })) }),
    tool({ name: "node.list_executions", description: "List per-node execution records (status, timing, cost/tokens) by runId/nodeId/executionId — nodeId alone spans recent runs, runId alone lists every node in that run, both narrows to one.", zodSchema: nodeQueryInput, inputSchema: nodeQueryJsonSchema, execute: async (input) => ok({ executions: await listNodeExecutions(nodeQueryInput.parse(input), executionRepository, usageRepository) }) }),
    tool({ name: "node.get_latest_output", description: "Get latest node output with filters.", zodSchema: nodeQueryInput, inputSchema: nodeQueryJsonSchema, execute: async (input) => ok({ output: (await listNodeOutputs(nodeQueryInput.parse(input), executionRepository))[0] ?? null }) }),
    tool({ name: "node.list_outputs", description: "List node outputs by node, run, execution, artifact type, or date range.", zodSchema: nodeQueryInput, inputSchema: nodeQueryJsonSchema, execute: async (input) => ok({ outputs: await listNodeOutputs(nodeQueryInput.parse(input), executionRepository) }) }),
    tool({ name: "node.retry", description: "Retry a previous independent node execution.", zodSchema: nodeRetryInput, inputSchema: nodeRetryJsonSchema, execute: async (input) => { const data = nodeRetryInput.parse(input); const run = await executionRepository.getRun(data.runId); const state = run?.nodes.find((node) => !data.nodeId || node.nodeId === data.nodeId); if (!run || !state) return ok({ execution: null }); return ok(await executeNode({ nodeId: state.nodeId, input: (state.input as any)?.input, dependencyOutputs: (state.input as any)?.dependencies, executionMode: run.executionMode ?? DEFAULT_EXECUTION_MODE }, { workspaceRepository, executionRepository })); } }),
    tool({ name: "node.cancel", description: "Cancel an independent node execution record.", zodSchema: nodeRetryInput, inputSchema: nodeRetryJsonSchema, execute: async (input) => { const data = nodeRetryInput.parse(input); const run = await executionRepository.getRun(data.runId); if (!run) return ok({ execution: null }); return ok({ execution: await executionRepository.saveRun({ ...run, status: "cancelled", nodes: run.nodes.map((node) => data.nodeId && node.nodeId !== data.nodeId ? node : { ...node, status: node.status === "completed" ? node.status : "cancelled" }), updatedAt: new Date().toISOString() }) }); } }),

    tool({ name: "tool.list", description: "List controlled tool registry entries, each with its REACHABILITY: which resolved nodes grant it, and which of those grants can actually fire. A grant on a node that terminates in a deterministic route can never be called through the tool executor — the node returns before a model runner is ever built — so `grantedBy` and `reachableFrom` are different lists and a tool with grants but no reachable ones is reported `dead: true`. Read-only.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => {
      emptyInput.parse(input);
      await workspaceRepository.ensureWorkspaceNodeSeeds();
      // W4.1 — reachability is computed from the RESOLVED node set, not from the registry, because
      // the registry knows nothing about who holds a grant. Two lists, deliberately not one:
      //   grantedBy      every node whose allowedTools names the tool — what an operator edited.
      //   reachableFrom  the subset that is model-dispatched — what can actually happen.
      // W3.1's audit is what makes the second computable; before it, "23 nodes carry grants that can
      // never fire" was a sentence in a brief rather than something a tool could answer.
      const nodes = await workspaceRepository.getNodes();
      const audits = nodes.map((node) => auditNodeCapabilities(node));
      const grantedBy = new Map<string, string[]>();
      const reachableFrom = new Map<string, string[]>();
      for (const audit of audits) {
        for (const toolId of [...audit.modelGrants, ...audit.deadGrants]) grantedBy.set(toolId, [...(grantedBy.get(toolId) ?? []), audit.nodeId]);
        for (const toolId of audit.modelGrants) reachableFrom.set(toolId, [...(reachableFrom.get(toolId) ?? []), audit.nodeId]);
      }
      return ok({ tools: listControlledTools().map(({ handler, inputSchema, outputSchema, ...tool }) => {
        const granted = (grantedBy.get(tool.toolId) ?? []).sort();
        const reachable = (reachableFrom.get(tool.toolId) ?? []).sort();
        return {
          ...tool,
          reachability: {
            grantedBy: granted,
            reachableFrom: reachable,
            // "dead" means granted and unreachable — a grant that reads as a capability and is not
            // one. A tool nobody grants is NOT dead: it is legitimately reachable from surfaces other
            // than the conductor (the improvement judge, admin chat) and from tool.test.
            dead: granted.length > 0 && reachable.length === 0
          }
        };
      }) });
    } }),
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
      const { toolExecutionId, runId } = toolExecutionInput.parse(input);
      const inProcess = getToolExecution(toolExecutionId);
      if (inProcess) return ok({ execution: inProcess, source: "in_process" });
      // W3.2.1 — the durable ledger, before the run-record stubs: it holds the FULL record (caller,
      // routeId, project, summaries) where a stub holds five metadata fields, and it is the only
      // place an engine-invoked tenant verb has ever been written.
      // W4-followup: ledger writes are started off the caller's clock, so a reader flushes first.
      await flushToolExecutionLedger();
      const durable = await repositoryManager.getToolExecutionRepository().get(toolExecutionId, runId);
      if (durable) return ok({ execution: durable, source: "tool_execution_ledger" });
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
      // Three sources, narrowest first, deduplicated by toolExecutionId:
      //   in_process            — this process's own records, the freshest answer.
      //   tool_execution_ledger — W3.2.1's durable store. The ONLY source that can show an
      //                           engine-invoked tenant verb (a publish, a release, a theme apply).
      //   run_record            — the per-call stubs the runner persists on the run. Kept because
      //                           they still answer for every run made before the ledger existed.
      const inProcess = listToolExecutions(filters).filter((record) =>
        (!filters.caller || record.caller === filters.caller)
        && (!filters.routeId || record.routeId === filters.routeId)
        && (!filters.projectId || record.projectId === filters.projectId));
      const seen = new Set(inProcess.map((record) => record.toolExecutionId));
      await flushToolExecutionLedger();
      const ledger = (await repositoryManager.getToolExecutionRepository().list(filters)).filter((record) => !seen.has(record.toolExecutionId));
      for (const record of ledger) seen.add(record.toolExecutionId);
      const persisted: unknown[] = [];
      // A caller/routeId/projectId filter is a question only the ledger can answer, so the stub
      // fallback is skipped rather than returning stubs that cannot satisfy it.
      if (!filters.caller && !filters.routeId && !filters.projectId) {
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
      }
      return ok({ executions: [...inProcess, ...ledger.map((record) => ({ ...record, source: "tool_execution_ledger" })), ...persisted] });
    } }),
    tool({ name: "skill.list", description: "List reusable workspace skills.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); await skillRepository.ensureSkillSeeds(); return ok({ skills: await skillRepository.list() }); } }),
    tool({ name: "skill.get", description: "Get one reusable workspace skill.", zodSchema: skillIdInput, inputSchema: skillIdJsonSchema, execute: async (input) => { await skillRepository.ensureSkillSeeds(); return ok({ skill: await skillRepository.get(skillIdInput.parse(input).skillId) ?? null }); } }),
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
    tool({ name: "skill.resolve_for_node", description: "Resolve assigned skills into deterministic instructions, tools, and conflicts for a node.", zodSchema: skillResolveInput, inputSchema: skillMutationJsonSchema, execute: async (input) => { const data = skillResolveInput.parse(input); await skillRepository.ensureSkillSeeds(); const node = await workspaceRepository.getNode(data.nodeId); if (!node) throw new Error(`Unknown node: ${data.nodeId}`); return ok({ policy: await resolveSkillsForNode(node, skillRepository, { workspaceSystemPolicy: data.workspaceSystemPolicy, projectPolicy: data.projectPolicy, runInstructions: data.runInstructions, platformTools: data.platformTools, runAuthorizedTools: data.runAuthorizedTools, riskPolicy: data.riskPolicy }) }); } }),
    // T15.16 (#195) — the four reads below ensureWorkspaceNodeSeeds() first: a workspace document
    // created before capture_conductor/clone_conductor joined the governance-visible seed set
    // (workspaceStoreNodes.ts) is additively topped up with their missing rows on first read, the same
    // pattern agent.list/agent.get use for ensureConversationalAgentSeeds. A fresh document already
    // carries every row (store.ts's defaultWorkspaceNodes), so this is a no-op there.
    // B1 (Pass 2, WP-00 finding #1) — the live capture found workspace.get_nodes genuinely could not
    // filter by conductor (its schema took no arguments at all, so a caller wanting just one
    // workflow's node set had to pull all 48 governance-visible nodes and filter client-side).
    // workspace.get_graph already resolved a workflowId to that conductor's real run topology
    // (canonical dependsOn overlaid with store edits, via resolveConductorNodes); this reuses the
    // exact same optional filter and resolution path so the two tools stay consistent — omit
    // workflowId for the unchanged flat store view, pass one of the registered workflow ids
    // ("publishing_conductor", "capture_conductor", "clone_conductor") to scope to that conductor.
    tool({ name: "workspace.get_nodes", description: "List workspace nodes. Omit workflowId for every governance-visible node across every registered workflow (publishing_conductor, capture_conductor, clone_conductor); pass a registered workflowId to scope to that ONE conductor's actual node set instead (same resolution as workspace.get_graph's workflowId — canonical dependsOn overlaid with store-edited prompt/schema/tools).", zodSchema: graphInput, inputSchema: graphJsonSchema, execute: async (input) => { const data = graphInput.parse(input); if (data.workflowId) return ok({ nodes: await resolveConductorNodes(workspaceRepository, data.workflowId) }); await workspaceRepository.ensureWorkspaceNodeSeeds(); return ok({ nodes: await workspaceRepository.getNodes() }); } }),
    tool({ name: "workspace.get_graph", description: "Get workflow graph nodes and edges. Omit workflowId for the flat store view of every registered workflow's nodes merged together (publishing_conductor, capture_conductor, clone_conductor); pass a registered workflowId to get that ONE workflow's actual run topology instead (canonical dependsOn — e.g. capture_conductor's publish_payload bound to capture_emit_live/capture_score — overlaid with store-edited prompt/schema/tools, exactly what resolveConductorNodes hands the executor).", zodSchema: graphInput, inputSchema: graphJsonSchema, execute: async (input) => { const data = graphInput.parse(input); const nodes = data.workflowId ? await resolveConductorNodes(workspaceRepository, data.workflowId) : await (async () => { await workspaceRepository.ensureWorkspaceNodeSeeds(); return workspaceRepository.getNodes(); })(); return ok({ nodes, edges: nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id }))), workflowId: data.workflowId, registeredWorkflowIds: listRegisteredWorkflowIds() }); } }),
    tool({ name: "workspace.get_node", description: "Get one workspace node.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => { await workspaceRepository.ensureWorkspaceNodeSeeds(); return ok({ node: await workspaceRepository.getNode(nodeId.parse(input).id) ?? null }); } }),
    tool({ name: "workspace.create_node", description: "Create a workspace node. An id canonical defines is refused — that row is code-owned and is re-seeded automatically.", zodSchema: createNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = createNodeInput.parse(input); const node = data.node as WorkspaceNode; if (isPlainRecord(node) && typeof node.id === "string") assertNoCanonicalOwnedFieldWrite("workspace.create_node", node.id, CANONICAL_OWNED_WRITE_REFUSED_FIELDS); return ok(await workspaceRepository.createNode(node, meta(data))); } }),
    tool({ name: "workspace.delete_node", description: "Delete an unreferenced workspace node.", zodSchema: deleteNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = deleteNodeInput.parse(input); return ok(await workspaceRepository.deleteNode(data.id, meta(data))); } }),
    tool({ name: "workspace.clone_node", description: "Clone a workspace node.", zodSchema: cloneNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = cloneNodeInput.parse(input); return ok(await workspaceRepository.cloneNode(data.id, data.newId, meta(data))); } }),
    tool({ name: "workspace.update_node", description: "Patch a workspace node. Store-owned fields only: a patch touching a canonical-owned field (id, kind, dependsOn, requiredInputs, produces, riskLevel, status) on a node canonical defines is refused — those reach a run only via nodes.ts + redeploy. A patch naming executionKind or route is also refused: how a node runs is changed through workspace.update_node_execution (K-A9).", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); assertNoCanonicalOwnedFieldWrite("workspace.update_node", data.id, Object.keys(data.patch)); assertNoExecutionFieldWrite("workspace.update_node", Object.keys(data.patch)); return ok(await workspaceRepository.updateNode(data.id, data.patch as Partial<WorkspaceNode>, meta(data))); } }),
    tool({ name: "workspace.update_node_prompt", description: "Update a node prompt.", zodSchema: updatePrompt, inputSchema: updatePromptJsonSchema, execute: async (input) => { const data = updatePrompt.parse(input); return ok(await workspaceRepository.updateNodePrompt(data.id, data.prompt, meta(data))); } }),
    tool({ name: "workspace.update_node_input_schema", description: "Update node input JSON Schema.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const schema = coerceSchemaInput(data.schema); const issues = validateJsonSchema(schema); if (issues.length) throw new Error(issues.join("; ")); return ok(await workspaceRepository.updateNode(data.id, { inputSchema: schema }, meta(data), "node.input_schema_updated")); } }),
    // node-default-output (2026-09-15) — SET or CLEAR a node's standing output. Store-owned, exactly
    // like the prompt and schema verbs above: no `npm run nodes:update`, no re-seed, and invisible to
    // #348's canonical-drift gate, because `defaultOutput` is not a CANONICAL_OWNED_FIELD and never
    // will be. A default is one operator's fixture for one workspace, not a property of the composition.
    tool({ name: "workspace.update_node_default_output", description: "Set (or clear) a node's DEFAULT OUTPUT: a standing value the engine writes into a run as though the node produced it — no model turn, no cost, durationMs 0. Pass `value: null` to clear it. The value is validated against the node's own outputSchema; an invalid value is REFUSED unless you pass force:true, in which case it is stored and stamped schemaValidAt:null so the record shows it was saved over a failure. Applying a default to a run is a separate act (workflow.run_node useDefaultOutput, or a run started in an outputMode that uses defaults). Nothing defaulted can reach a live publish — the publishing tail refuses such a run at gate.publishing.defaulted_upstream.", zodSchema: updateNodeDefaultOutputInput, inputSchema: updateNodeDefaultOutputJsonSchema, execute: async (input) => {
      const data = updateNodeDefaultOutputInput.parse(input);
      await workspaceRepository.ensureWorkspaceNodeSeeds();
      const node = await workspaceRepository.getNode(data.nodeId);
      if (!node) throw new WorkspaceToolError("unknown_node", `No workspace node with id "${data.nodeId}".`, { nodeId: data.nodeId });
      if (data.value === null) return ok({ ...(await workspaceRepository.updateNodeDefaultOutput(data.nodeId, null, meta(data))), cleared: true });
      const defaultOutput = buildNodeDefaultOutput({ node, value: data.value, note: data.note, force: data.force, updatedBy: actorKind(meta(data).actor) });
      const result = await workspaceRepository.updateNodeDefaultOutput(data.nodeId, defaultOutput, meta(data));
      return ok({ ...result, cleared: false, ...(defaultOutput.schemaValidAt === null ? { warnings: [`default_output_schema_invalid_forced:${data.nodeId}`] } : {}) });
    } }),
    // The convenience half of the same contract, chosen over a `saveAsDefault` flag on
    // node.get_latest_output: a READ verb that also writes is the shape nobody expects and every
    // audit trail then has to explain. This is a mutation, it reads like one, and it is the one an
    // operator reaches for after a node produced exactly the output they want to keep.
    tool({ name: "workspace.adopt_output_as_default", description: "Adopt a node's last good output as its DEFAULT OUTPUT. Scope it to one run with runId (or one execution with executionId); omit both for the node's most recent output across all runs. Same validation and `force` contract as workspace.update_node_default_output.", zodSchema: adoptOutputAsDefaultInput, inputSchema: adoptOutputAsDefaultJsonSchema, execute: async (input) => {
      const data = adoptOutputAsDefaultInput.parse(input);
      await workspaceRepository.ensureWorkspaceNodeSeeds();
      const node = await workspaceRepository.getNode(data.nodeId);
      if (!node) throw new WorkspaceToolError("unknown_node", `No workspace node with id "${data.nodeId}".`, { nodeId: data.nodeId });
      const latest = (await listNodeOutputs({ nodeId: data.nodeId, runId: data.runId, executionId: data.executionId }, executionRepository))[0];
      if (!latest || latest.output === undefined) {
        throw new WorkspaceToolError("node_output_unavailable", `Node ${data.nodeId} has no recorded output${data.runId ? ` in run ${data.runId}` : ""} to adopt. Run it once, or supply the value directly with workspace.update_node_default_output.`, { nodeId: data.nodeId, runId: data.runId, executionId: data.executionId });
      }
      const defaultOutput = buildNodeDefaultOutput({ node, value: latest.output, note: data.note, force: data.force, updatedBy: actorKind(meta(data).actor) });
      const result = await workspaceRepository.updateNodeDefaultOutput(data.nodeId, defaultOutput, meta(data));
      return ok({ ...result, adoptedFrom: { runId: latest.runId ?? null, executionId: latest.executionId ?? null }, ...(defaultOutput.schemaValidAt === null ? { warnings: [`default_output_schema_invalid_forced:${data.nodeId}`] } : {}) });
    } }),
    tool({ name: "workspace.update_node_output_schema", description: "Update node output JSON Schema draft 2020-12.", zodSchema: updateSchema, inputSchema: updateSchemaJsonSchema, execute: async (input) => { const data = updateSchema.parse(input); const schema = coerceSchemaInput(data.schema); const issues = validateJsonSchema(schema); if (issues.length) throw new Error(issues.join("; ")); const lint = openAiResponseSchemaLint(schema); const result = await workspaceRepository.updateNode(data.id, { outputSchema: schema, schema }, meta(data), "node.output_schema_updated"); return ok(lint ? { ...result, warnings: [lint] } : result); } }),
    ...[["workspace.update_node_tools", "allowedTools", "node.tools_updated"], ["workspace.update_node_skills", "assignedSkills", "node.skills_updated"], ["workspace.update_node_dependencies", "dependsOn", "node.dependencies_updated"]].map(([name, field, eventType]) => tool({ name, description: `Update node ${field}.${field === "dependsOn" ? " Refused on a node canonical defines: overlayStoreNode pins dependsOn to nodes.ts, so the write cannot rewire the graph." : ""}`, zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); const value = requirePatchField(data.patch, field, name); assertNoCanonicalOwnedFieldWrite(name, data.id, [field]); return ok(await workspaceRepository.updateNode(data.id, { [field]: value } as Partial<WorkspaceNode>, meta(data), eventType)); } })),
    tool({ name: "workspace.update_node_metadata", description: "Update node metadata.", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); return ok(await workspaceRepository.updateNode(data.id, { metadata: requirePatchField(data.patch, "metadata", "workspace.update_node_metadata") } as Partial<WorkspaceNode>, meta(data), "node.updated")); } }),
    // K-A9 (2026-09-16) — THE ONE VERB THAT CHANGES HOW A NODE RUNS.
    //
    // Before this, the answer lived in `metadata` and every metadata write was a chance to lose it by
    // omission. `executionKind`/`route` are fields now, and this is the only door to them: a write
    // here is a named, reasoned, change-history-visible act, which is exactly what flipping the
    // release step between an idempotency-ledgered engine call and a free model turn should be.
    //
    // `executionKind: "model"` CLEARS the route and suppresses any route metadata the row still
    // carries — the operator asked for a model turn and gets one, rather than a field and a flag
    // disagreeing. `executionKind: "deterministic"` requires a route, because "deterministic, but we
    // will not say which program" is not a thing the executor can dispatch.
    tool({ name: "workspace.update_node_execution", description: "Set HOW a node runs: executionKind (model | deterministic) and, for a deterministic node, its route {id, mode?} — where `id` is the declaring route key (\"releaseExecutorDeterministic\", \"captureStageDeterministic\") and `mode` the stage of a staged route (\"crawl\"). This is the ONLY verb that changes a node's route: workspace.update_node and workspace.update_node_metadata both refuse it, so a metadata write can no longer flip a tail node off its deterministic route by omission (docs/KNOWN_ISSUES.md K-A9/K-A1). Setting executionKind \"model\" clears the route and overrides any legacy route flag still in the node's metadata.", zodSchema: updateNodeExecutionInput, inputSchema: updateNodeExecutionJsonSchema, execute: async (input) => {
      const data = updateNodeExecutionInput.parse(input);
      if (data.executionKind === "deterministic" && !data.route) throw new Error("workspace.update_node_execution: executionKind \"deterministic\" requires a route {id, mode?} — the executor dispatches a named program, not an unnamed one.");
      const existing = await workspaceRepository.getNode(data.id);
      if (!existing) throw new Error(`Unknown node: ${data.id}`);
      const patch: Partial<WorkspaceNode> = data.executionKind === "model"
        // `route: undefined` rather than a delete: updateNode patches by spread, and an undefined
        // value is dropped by the document serializer, so the field does not survive the write.
        ? { executionKind: "model", route: undefined }
        : { executionKind: "deterministic", route: data.route };
      return ok(await workspaceRepository.updateNode(data.id, patch, meta(data), "node.execution_updated"));
    } }),
    // See the deepMergeRecords comment above requirePatchField for why this tool does not share the
    // wholesale-replace handler the array-valued node writers use.
    tool({ name: "workspace.update_node_model_config", description: "Update node modelConfig. Recursively MERGES the given keys onto the node's existing modelConfig — keys the patch omits are preserved, not dropped; a key present in the patch overwrites (nested plain objects merge key-by-key, any other value including arrays replaces outright).", zodSchema: updateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateNodeInput.parse(input); const incoming = requirePatchField(data.patch, "modelConfig", "workspace.update_node_model_config"); if (!isPlainRecord(incoming)) throw new Error("workspace.update_node_model_config: patch.modelConfig must be an object"); const existingNode = await workspaceRepository.getNode(data.id); if (!existingNode) throw new Error(`Unknown node: ${data.id}`); const merged = deepMergeRecords(existingNode.modelConfig ?? {}, incoming); return ok(await workspaceRepository.updateNode(data.id, { modelConfig: merged } as Partial<WorkspaceNode>, meta(data), "node.model_config_updated")); } }),
    tool({ name: "workspace.reorder_nodes", description: "Reorder nodes without changing dependencies.", zodSchema: updateGraphInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateGraphInput.parse(input); assertGraphUpdateKeepsCanonicalTopology("workspace.reorder_nodes", data); return ok(await workspaceRepository.updateGraph(data, meta(data), "graph.reordered")); } }),
    tool({ name: "workspace.update_graph", description: "Atomically update workflow graph. A dependsOn edit on a node canonical defines is refused — overlayStoreNode pins it to nodes.ts; positions, creates and deletes are unaffected.", zodSchema: updateGraphInput, inputSchema: mutationJsonSchema, execute: async (input) => { const data = updateGraphInput.parse(input); assertGraphUpdateKeepsCanonicalTopology("workspace.update_graph", data); return ok(await workspaceRepository.updateGraph(data, meta(data), "graph.updated")); } }),
    tool({ name: "workspace.validate_graph", description: "Validate workflow graph: ids, statuses, risk levels, missing dependencies, cycles, publish-chain edges, and (R-21) that every conductor-sequence node's dependsOn / requiredInputs entries are actually satisfiable by the conductor sequence.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const { validateWorkspaceGraph } = await import("../../workspace/nodes.js"); const nodes = await workspaceRepository.getNodes(); return ok({ validation: validateWorkspaceGraph(nodes) }); } }),
    // W3.1 — `capabilities` is a READ-ONLY addition beside the existing `valid` boolean, which is
    // unchanged. It answers "what can this node actually do", which the grant list alone does not: a
    // deterministic node's allowedTools can never fire, and its route reaches the tenant through
    // ProjectMcpAdapter with no grant, no risk check and no ledger entry. See nodeCapabilityAudit.ts.
    // F3 — `valid` covers ONLY schema validity (input/output JSON Schema well-formedness), unchanged
    // by this addition. `readiness` is the separate, honest answer to "can this node actually
    // dispatch right now": it folds in resolveSkillsForNode's blockers/warnings against the node's
    // CURRENTLY ASSIGNED skills, something `valid` never captured — a node could read `valid: true`
    // while a missing or inactive assigned skill would refuse it at dispatch (invalid_node_configuration).
    // A deterministic node is never blocked BY a skill conflict: it completes with zero model calls,
    // so a skill problem is surfaced as a warning, not a `runnable: false` — resolveSkillsForNode's
    // instructions are simply never read for such a node's own dispatch.
    tool({ name: "workspace.validate_node", description: "Validate a node or existing node id. `valid` covers JSON-Schema validity of the node's input/output schemas ONLY. `capabilities` additionally reports what the node can ACTUALLY do: its executionKind (model | deterministic), the grants that can fire, the grants that can never fire because the node terminates in a deterministic route, and the tenant MCP verbs that route calls directly — which pass no node grant, no risk check and no tool execution ledger. `readiness` is the separate, honest answer to whether the node can actually DISPATCH: its blockers/warnings from resolving the node's assigned skills, and `runnable`, which is false only when a blocker would actually stop dispatch — for a deterministic node a skill blocker is reported as a warning instead, since such a node completes with zero model calls and is never blocked by one. Read-only: nothing here blocks or reroutes a call.", zodSchema: validateNodeInput, inputSchema: mutationJsonSchema, execute: async (input) => {
      const data = validateNodeInput.parse(input);
      await skillRepository.ensureSkillSeeds();
      const node = data.node ?? (data.id ? await workspaceRepository.getNode(data.id) : undefined);
      const valid = !!node && validateJsonSchema((node as WorkspaceNode).inputSchema).length === 0 && validateJsonSchema((node as WorkspaceNode).outputSchema).length === 0;
      const capabilities = node ? auditNodeCapabilities(node as WorkspaceNode, await projectPolicyViews(data.projectId)) : null;
      const readiness = node
        ? await (async () => {
          const policy = await resolveSkillsForNode(node as WorkspaceNode, skillRepository);
          const isDeterministic = capabilities?.executionKind === "deterministic";
          // A deterministic node never reads resolveSkillsForNode's instructions at dispatch, so a
          // skill blocker can never stop IT specifically — demoted to a warning and said so, rather
          // than reporting runnable:false for a node that will in fact run.
          const blockers = policy.conflicts.filter((conflict) => conflict.severity === "blocker" && !isDeterministic);
          const warnings = policy.conflicts.filter((conflict) => conflict.severity === "warning" || (conflict.severity === "blocker" && isDeterministic));
          return {
            runnable: blockers.length === 0,
            executionKind: capabilities?.executionKind ?? "model",
            blockers,
            warnings,
            ...(isDeterministic && policy.conflicts.some((conflict) => conflict.severity === "blocker") ? { note: "This node is deterministic: it completes with zero model calls and is never blocked by an assigned-skill conflict, so blockers above are reported as warnings here." } : {})
          };
        })()
        : null;
      return ok({ valid, capabilities, readiness });
    } }),
    tool({ name: "workspace.audit_capabilities", description: "Whole-graph capability audit: how many nodes are model-dispatched vs deterministic, how many carry grants that can never fire, which nodes reach publish- or admin-risk tenant verbs from engine code rather than through a granted tool, and (W5 T2) which route requiredTools a registered tenant's own toolPolicies/defaultToolPolicy blocks or holds — reported as summary.routeToolsBlockedByPolicy, one `route_tool_blocked_by_policy:<project>:<verb>` issue per pair. Read-only. Pass `id` for one node's detail, `projectId` to check one tenant instead of every registered active one; omit both for the summary across every resolved node.", zodSchema: optionalNodeId, inputSchema: optionalNodeIdJsonSchema, execute: async (input) => { const data = optionalNodeId.parse(input); await workspaceRepository.ensureWorkspaceNodeSeeds(); const nodes = await workspaceRepository.getNodes(); const policies = await projectPolicyViews(data.projectId); if (data.id) { const node = nodes.find((candidate) => candidate.id === data.id); return ok({ capabilities: node ? auditNodeCapabilities(node, policies) : null }); } return ok({ summary: summarizeCapabilityAudit(nodes, policies), nodes: nodes.map((node) => auditNodeCapabilities(node, policies)).filter((audit) => audit.findings.length > 0) }); } }),
    // F3 — `assignedSkills` was raw ids only: an operator could not tell from this tool alone whether
    // an assigned id actually resolves, to which version, or whether it is active — exactly the gap
    // that let a node read fine here while blocking at dispatch. `effectiveSkills`/`skillConflicts`
    // are resolved through the SAME resolveSkillsForNode() every other surface (node.get_effective_skills,
    // the chat path via resolveConversationSkills) reads, so a version reported here can never drift
    // from what a node dispatch or a chat turn actually applies.
    tool({ name: "workspace.get_node_effective_config", description: "Get safe resolved node execution config without secrets. Resolves for capture_conductor's and clone_conductor's own nodes as well as publishing_conductor's. `effectiveSkills` reports each assigned skill actually resolved (id, version, status) and `skillConflicts` any blocker/warning from resolving them — the same resolution node.get_effective_skills and workspace.validate_node's readiness use, so the reported version can never disagree with what a dispatch would apply.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => {
      await workspaceRepository.ensureWorkspaceNodeSeeds();
      await skillRepository.ensureSkillSeeds();
      const node = await workspaceRepository.getNode(nodeId.parse(input).id);
      if (!node) return ok({ config: null });
      const policy = await resolveSkillsForNode(node, skillRepository);
      const assigned = policy.skillIds.length ? await skillRepository.list({ skillIds: policy.skillIds }) : [];
      const byId = new Map(assigned.map((skill) => [skill.skillId, skill]));
      const effectiveSkills = policy.skillIds.map((skillId) => {
        const skill = byId.get(skillId);
        return { skillId, version: skill?.version ?? null, status: skill?.status ?? null };
      });
      // node-default-output — reported here as well as on workspace.get_node, because "what would this
      // node do if I advanced the run" is exactly the question this verb answers, and a standing
      // default changes the answer to "nothing, it hands back this value". `null` rather than omitted
      // so a reader can tell "no default" from "this build predates defaults".
      return ok({ config: { prompt: node.prompt, inputSchema: node.inputSchema, outputSchema: node.outputSchema, modelConfig: node.modelConfig ?? {}, assignedSkills: node.assignedSkills ?? [], effectiveSkills, skillConflicts: policy.conflicts, effectiveTools: node.allowedTools, riskLevel: node.riskLevel, defaultOutput: node.defaultOutput ?? null, approvalRequirements: node.riskLevel === "publish" || node.riskLevel === "admin" ? ["explicit_approval"] : [] } });
    } }),
    tool({ name: "workspace.export_workspace", description: "Export workspace data.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok(await workspaceRepository.exportWorkspace()); } }),
    tool({ name: "workspace.import_workspace", description: "Import workspace data.", zodSchema: importWorkspace, inputSchema: importWorkspaceJsonSchema, execute: async (input) => { const data = importWorkspace.parse(input); return ok(await workspaceRepository.importWorkspace({ ...data, nodes: data.nodes as WorkspaceNode[] | undefined })); } }),
    // R-6: article_body.get_schema / article_body.validate are retired. They served the workspace-local
    // {schema_version, nodes} monolith — a drifted local copy the article_body node itself rejects. The
    // node's own outputSchema is served by node.get_output_schema and enforced by node.validate_output;
    // the client's own validator (object_validate via project.call_read_tool) is the authority beyond it.
    tool({ name: "stage.save_output", description: "Save an output. TWO FORMS. Workspace form {stage, value, id?}: append to the workspace's own stageOutputs collection — note that no workflow run reads that collection. Run-scoped form {runId, nodeId, value, note?}: replace ONE node's output on ONE run — every downstream node in that run then reads your value, the node is recorded completed with durationMs 0 and provenance source \"operator_override\", and the run is refused at its publishing tail (gate.publishing.defaulted_upstream) because content nobody produced never publishes. Retry the node without useDefaultOutput to undo the override and make the run publishable again.", zodSchema: saveOutput, inputSchema: saveOutputJsonSchema, execute: async (input) => {
      const data = saveOutput.parse(input);
      if (data.runId && data.nodeId) return ok(await overrideRunNodeOutput(data.runId, data.nodeId, data.value, { executionRepository, workspaceRepository, note: data.note }));
      const output = await workspaceRepository.saveStageOutput(data.stage!, data.value, data.id);
      return ok({ output, workspaceVersion: await workspaceRepository.getWorkspaceVersion() });
    } }),
    tool({ name: "stage.get_output", description: "Get stage output.", zodSchema: nodeId, inputSchema: nodeIdJsonSchema, execute: async (input) => ok({ output: await workspaceRepository.getStageOutput(nodeId.parse(input).id) ?? null }) }),
    tool({ name: "stage.list_outputs", description: "List stage outputs.", zodSchema: listOutputs, inputSchema: listOutputsJsonSchema, execute: async (input) => ok({ outputs: await workspaceRepository.listStageOutputs(listOutputs.parse(input).stage) }) }),
    // node-default-output — REFUSED, not silently dropped, for a node whose output was supplied. An
    // observation stamped to a defaulted node would enter the corpus as evidence about a node that
    // never ran (see learningRecord.ts's own header for why that is the most expensive lie here). The
    // refusal is a normal outcome with `recorded: false`, not an error: a caller sweeping a run's nodes
    // should skip this one and carry on, not abort the sweep.
    tool({ name: "learning.record_observation", description: "Record a learning observation, optionally stamped with the runId/nodeId it came from and the CMS-Agent projectId it belongs to. An observation stamped to a node whose output on that run was SUPPLIED rather than produced (a default output or an operator override) is NOT recorded — the response returns {recorded:false, skipped:\"supplied_output\"} naming the source, because such a node is evidence of an operator's choice, not of what the engine did.", zodSchema: recordObservation, inputSchema: recordObservationJsonSchema, execute: async (input) => {
      const data = recordObservation.parse(input);
      if (data.runId && data.nodeId) {
        const run = await getRun(data.runId, executionRepository);
        const source = run?.nodes.find((node) => node.nodeId === data.nodeId)?.outputProvenance?.source;
        if (source) return ok({ observation: null, recorded: false, skipped: "supplied_output", source, runId: data.runId, nodeId: data.nodeId, workspaceVersion: await workspaceRepository.getWorkspaceVersion() });
      }
      const observation = await learningRepository.recordObservation(data.observation, data.metadata, { runId: data.runId, nodeId: data.nodeId, projectId: data.projectId });
      return ok({ observation, recorded: true, workspaceVersion: await workspaceRepository.getWorkspaceVersion() });
    } }),
    // S-07: the project filter lives here, not in LearningRepository.listObservations, because matching
    // an UNSTAMPED legacy observation needs a run lookup and the learning repository has no execution
    // repository. improvement/projectScope.ts owns the match rule and the fail-closed decision.
    tool({ name: "learning.list_observations", description: "List learning observations. Archived (soft-deleted) observations are excluded by default. Pass projectId (the CMS-Agent project id) to see only that project's observations: one matches when it is stamped with that project, or is unstamped and its runId belongs to a run of that project. Observations whose project cannot be established are omitted from a filtered list.", zodSchema: listObservationsInput, inputSchema: listObservationsJsonSchema, execute: async (input) => { const data = listObservationsInput.parse(input); return ok({ observations: await filterRecordsByProject(await learningRepository.listObservations({ includeArchived: data.includeArchived }), data.projectId, executionRepository) }); } }),
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
        const built = await runDeterministicPublishPayload({ projectId: run.projectId, clientProjectId: run.projectId, articleBody: run.stageOutputs.article_body, artifactPlan: run.stageOutputs.artifact_plan, runId: run.runId }, { projectRepository: repositoryManager.getProjectRepository() });
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
    tool({ name: "workflow.start_dry_run", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Start a Publishing Conductor dry-run workflow without external MCP calls or publishing side effects. Supply entrypoint 'article_body' with a valid client_object.v1 to enter the run at the publish stages without re-running ideation/research/draft nodes. Live (openai) runs for projects that declare a request-id pattern (platform, dr-lurie, fernwell) REQUIRE a caller-supplied requestId (req_<flow>_<topic>_<yyyymmdd>_<nn>); the tool refuses with request_id_required / invalid_request_id otherwise. Mock dry-runs keep the auto-minted id. Supply `publishRequestId` (a DIFFERENT id: the operator-authored publish contract id normally written by artifact_plan) to let a late-stage entrypoint run reach the publish gate — without it such a run is refused with publish_request_id_absent, and no publish id is ever generated.", zodSchema: startDryRunInput, inputSchema: startDryRunJsonSchema, execute: async (input) => {
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
      // S3 — the PUBLISH id, resolved and validated SEPARATELY from the join key above, and refused
      // here (before any run exists) exactly as a malformed `articleBody` is.
      const publishRequestId = await resolvePublishRequestId(data.projectId, data.publishRequestId);
      const run = await startDryRun({ projectId: data.projectId, input: coerceJsonObjectInput(data.input), workflowId: data.workflowId, executionMode: data.executionMode, entrypoint, budgetUsd: data.budgetUsd, requestId, outputMode: data.outputMode, objective: data.objective }, executionRepository);
      // Stamped onto the created run as its OWN field, never onto `requestId`. Written here rather
      // than threaded through startDryRun because this tool is the ONLY writer of the field (see
      // WorkflowExecutionRecord.publishRequestId): one writer, one validation point, and the run the
      // caller gets back is the same record the conductor will later build run context from.
      return ok({ run: publishRequestId ? await executionRepository.saveRun({ ...run, publishRequestId }) : run });
    } }),
    // `mode` is deliberately a TOP-LEVEL sibling of the run, not a field buried inside it: a mock run
    // emits schema-shaped placeholder artifacts that look exactly like real output, so what produced
    // them has to be impossible to miss. It also names the node source, since static mode means
    // workspace edits made over MCP were not in this run (see runModeSummary).
    // T7 — get_run returned the RAW record: 110KB on a live run, because that record carries every
    // node's input and output plus stageOutputs and artifacts. `detail:"compact"` (the default) reuses
    // the compactRun view run_all has always returned; `detail:"full"` is the old behaviour, unchanged,
    // for when the node payloads are what you actually came for.
    tool({ name: "workflow.get_run", description: "Get dry-run workflow execution state. detail:\"compact\" (default) returns the compact run view {runId,requestId,projectId,status,currentNodeId,budget,errors,approvalsRequired,blockages,nodes:[{nodeId,status,warnings,errors,durationMs,dispatch,blockage}]}. `blockages` is every recorded pending wall on the run in blockage.v1 form: budget, publication approval, tenant-policy hold, configuration/scope, authentication, validation/limit, or an explicitly unknown legacy cause. Each carries the remedies actually supported for that cause; status=blocked alone never fabricates an approval. The array is always present and empty on a healthy run. detail:\"full\" returns the complete record including every node input/output, stageOutputs and artifacts (large — 100KB+ on a real run). The `mode` block reports what actually produced this run's outputs: executionMode, live (true only for real model output), and whether node definitions came from the static compile or the workspace store. For a status \"running\" run, `stall` reports whether anything is really in flight (dispatch heartbeat) or the driver died and the run should be advanced again.", zodSchema: getRunInput, inputSchema: getRunJsonSchema, execute: async (input) => { const data = getRunInput.parse(input); const run = await getRun(data.runId, executionRepository); const timing = run ? await runStallTiming(run.workflowId, run.projectId) : undefined; return ok({ run: run ? (data.detail === "full" ? run : compactRun(run)) : null, detail: data.detail, mode: run ? runModeSummary(run) : null, stall: run ? assessRunStall(run, new Date(), timing) ?? null : null }); } }),
    tool({ name: "workflow.list_runs", description: "List compact dry-run workflow summaries, newest first, paged (default 20 rows, max 100; `page.nextCursor` fetches the next page) with optional status (one value, or an array to match any of several) and startedAt time-range filters. `detail` chooses the row shape: \"summary\" (DEFAULT) is read straight from the run index and opens no run records at all — a row carries the run's identity, status, currentNodeId, timings, per-node COUNTS (nodeCount/completedCount/failedCount/errorCount/artifactCount/approvalsRequiredCount), the `approvalsRequired` entries themselves, and `budgetBlock`/`operatorPublishDecision`/`operatorDecisionSource`. The only thing \"summary\" omits that \"full\" carries is `nodes[]` and the run-level `errors[]` strings (counted instead); \"full\" adds the nodes[] array (per-node status, timings, bounded errors/warnings, recent attempts) at the cost of one run-record read per row. Node inputs/outputs, stage outputs and artifact values are omitted from both; call workflow.get_run for one selected run. Every row carries the caller-supplied `requestId` it was started with (when it has one), so a page of runs can be joined back to the requests that asked for them, plus a `mode` block naming what produced it and, on status \"running\" rows, a `stall` block naming whether the driver is alive. `page.matchedCount` counts every run matching the filters, not the rows returned, so a windowed page still knows the true fleet size.", zodSchema: listRunsInput, inputSchema: listRunsJsonSchema, execute: async (input) => {
      const args = listRunsInput.parse(input);
      // W4 — the default is the cheap read. A list row used to cost a blob GET and still carry
      // nodes[] for a caller that was scanning identities and statuses: ~28KB per row, ~8s for
      // twenty rows scoped to one project and 16s unscoped, measured live 2026-09-14. The
      // per-node detail is still one argument away, and for a single run workflow.get_run was
      // always the right read.
      const detail = args.detail ?? "summary";
      // Per-workflow p95 timings, fetched once per distinct (workflow, project) on the page
      // rather than per row — the same amortisation both detail modes have always had.
      const timingFor = async (keys: Set<string>) => {
        const timingByWorkflow = new Map<string, RunStallTimingContext>();
        for (const key of keys) {
          const [workflowId, projectId] = key.split("::");
          timingByWorkflow.set(key, await runStallTiming(workflowId, projectId || undefined));
        }
        return timingByWorkflow;
      };
      const at = new Date();

      if (detail === "summary") {
        const { rows, page } = await listRunSummariesPage(args, executionRepository);
        const timingByWorkflow = await timingFor(new Set(rows.map((row) => `${row.workflowId}::${row.projectId ?? ""}`)));
        return ok({
          runs: rows.map(({ stallFacts, ...row }) => {
            // A summary row assesses stall from the SAME projection a full record would
            // (runStallFacts), so the two detail modes can never disagree about whether a run
            // is stuck — only about how much per-node detail they show.
            const stall = stallFacts ? assessRunStallFrom(stallFacts, at, timingByWorkflow.get(`${row.workflowId}::${row.projectId ?? ""}`)) : undefined;
            return { ...row, mode: runModeSummary(row), ...(stall ? { stall } : {}) };
          }),
          page,
          detail
        });
      }

      const { runs, page } = await listRunsPage(args, executionRepository);
      const timingByWorkflow = await timingFor(new Set(runs.map((run) => `${run.workflowId}::${run.projectId ?? ""}`)));
      return ok({
        runs: runs.map((run) => {
          const stall = assessRunStall(run, at, timingByWorkflow.get(`${run.workflowId}::${run.projectId ?? ""}`));
          return { ...summarizeRunForList(run), mode: runModeSummary(run), ...(stall ? { stall } : {}) };
        }),
        page,
        detail
      });
    } }),
    tool({ name: "workflow.run_next_node", description: `Run exactly one dependency-ready Publishing Conductor node, stopping before publish-risk nodes unless approved is true. REFUSES to dispatch a node whose planned dispatch claim exceeds ${RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS}ms — the ceiling an in-request driver may own — returning the persisted run plus {driverRefusal:{code:"dispatch_claim_exceeds_driver_ceiling",nodeId,plannedClaimMs,ceilingMs},driverNote}. That is a normal outcome, not an error, and retrying returns it again: such a node is advanced by the scheduled continuation tick or the Cloud Run conductor job, which hold a task window rather than a request. A node the driver does not expect to finish inside the time THIS CALL has left (priced on the tenant's measured p95 for that node, falling back to the node's own timeout) is likewise REFUSED, with {driverRefusal:{code:"dispatch_exceeds_remaining_driver_budget",nodeId,expectedMs,expectedSource,remainingDriverMs},driverNote} and continued:true - also a normal outcome, never an error to retry in a loop: the scheduled continuation tick holds a task window and advances it.`, zodSchema: runNextNodeInput, inputSchema: runNextNodeJsonSchema, execute: async (input) => {
      const data = runNextNodeInput.parse(input);
      const current = await getRun(data.runId, executionRepository);
      // D2 — one step is still one request, and a node this driver cannot stay for is a node it must
      // not start. Priced against the same window the looping drivers use.
      const stop = await resolveDriverRefusal(current, workspaceRepository, RUN_DRIVER_TIME_BUDGET_MS, current ? await runStallTiming(current.workflowId, current.projectId) : undefined);
      if (current && stop) return ok({ run: current, driverRefusal: stop.refusal, driverNote: stop.note, continued: RUN_LIVE_STATUSES.includes(current.status) });
      return ok({ run: await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }) });
    } }),
    tool({ name: "workflow.run_node", description: `Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Run dependency-ready nodes; when nodeId is given, advance the run until that node completes. Stops cleanly with driverNote when the request's time budget runs out; call again to continue, or use the conductor job for long runs. A node whose planned dispatch claim exceeds the driver's per-request claim ceiling (${RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS}ms) is REFUSED rather than driven: the call returns the persisted run with {driverRefusal:{code:"dispatch_claim_exceeds_driver_ceiling",nodeId,plannedClaimMs,ceilingMs},driverNote} and dispatches nothing - a normal outcome, not an error. Driving it here would have the caller's request timeout kill this driver mid-node and leave the node claimed with no driver behind it; the scheduled continuation tick or the Cloud Run conductor job advances such a node instead. Naming a node explicitly does not lift the ceiling - it shortens no claim - so the refusal applies to nodeId calls too. A node the driver does not expect to finish inside the time THIS CALL has left (priced on the tenant's measured p95 for that node, falling back to the node's own timeout) is likewise REFUSED, with {driverRefusal:{code:"dispatch_exceeds_remaining_driver_budget",nodeId,expectedMs,expectedSource,remainingDriverMs},driverNote} and continued:true - also a normal outcome, never an error to retry in a loop: the scheduled continuation tick holds a task window and advances it.`, zodSchema: runNodeInput, inputSchema: runNodeJsonSchema, execute: async (input) => {
      const data = runNodeInput.parse(input);
      // node-default-output — a push-through names ONE node and writes it directly; it is not an
      // advance that might or might not reach the node the operator meant. nodeId is therefore
      // required here, and the refusal says so rather than silently advancing the run instead.
      if (data.useDefaultOutput) {
        if (!data.nodeId) throw new WorkspaceToolError("node_id_required", "useDefaultOutput pushes ONE named node through from its default; pass nodeId.", { runId: data.runId });
        return ok({ run: await pushNodeThroughWithDefault(data.runId, data.nodeId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_run_all", note: data.defaultOutputNote }) });
      }
      let run = await getRun(data.runId, executionRepository);
      // D9 — an operator naming a node directly states a different INTENT, not a different claim: the
      // node still owns its window for its full timeout and this call is still one request. The
      // refusal is therefore the same refusal, worded for the named node when it is the one refused.
      const deadline = Date.now() + RUN_DRIVER_TIME_BUDGET_MS;
      const timing = run ? await runStallTiming(run.workflowId, run.projectId) : undefined;
      let stop = await resolveDriverRefusal(run, workspaceRepository, deadline - Date.now(), timing, data.nodeId);
      if (!data.nodeId) {
        if (run && stop) return ok({ run, driverRefusal: stop.refusal, driverNote: stop.note });
        return ok({ run: await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }) });
      }
      let timedOut = false;
      for (let i = 0; run && !stop && i < 100 && !HALTED_RUN_STATUSES.includes(run.status); i++) {
        if (Date.now() > deadline) { timedOut = true; break; }
        run = await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved });
        const state = run.nodes.find((node) => node.nodeId === data.nodeId);
        if (state && state.status !== "queued" && state.status !== "running") break;
        stop = await resolveDriverRefusal(run, workspaceRepository, deadline - Date.now(), timing, data.nodeId);
      }
      return ok({ run, ...(stop ? { driverRefusal: stop.refusal, driverNote: stop.note } : timedOut ? { driverNote: driverTimeBudgetNote(RUN_DRIVER_TIME_BUDGET_MS, run) } : {}) });
    } }),
    tool({ name: "workflow.run_until", description: `Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Run dependency-ready nodes until the named node completes, then stop. Stops cleanly with driverNote when the request's time budget runs out; call again to continue, or use the conductor job for long runs. A node whose planned dispatch claim exceeds the driver's per-request claim ceiling (${RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS}ms) is REFUSED rather than driven: the call returns the persisted run with {driverRefusal:{code:"dispatch_claim_exceeds_driver_ceiling",nodeId,plannedClaimMs,ceilingMs},driverNote} and dispatches nothing - a normal outcome, not an error. Driving it here would have the caller's request timeout kill this driver mid-node and leave the node claimed with no driver behind it; the scheduled continuation tick or the Cloud Run conductor job advances such a node instead. A node the driver does not expect to finish inside the time THIS CALL has left (priced on the tenant's measured p95 for that node, falling back to the node's own timeout) is likewise REFUSED, with {driverRefusal:{code:"dispatch_exceeds_remaining_driver_budget",nodeId,expectedMs,expectedSource,remainingDriverMs},driverNote} and continued:true - also a normal outcome, never an error to retry in a loop: the scheduled continuation tick holds a task window and advances it.`, zodSchema: runUntilInput, inputSchema: runUntilJsonSchema, execute: async (input) => {
      const data = runUntilInput.parse(input);
      const deadline = Date.now() + RUN_DRIVER_TIME_BUDGET_MS;
      let timedOut = false;
      let run = await getRun(data.runId, executionRepository);
      run = await enterApprovedGateBlockedRun(run, data.approved, () => runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved }));
      const timing = run ? await runStallTiming(run.workflowId, run.projectId) : undefined;
      let stop = await resolveDriverRefusal(run, workspaceRepository, deadline - Date.now(), timing, data.nodeId);
      for (let i=0; run && !stop && i<100 && !HALTED_RUN_STATUSES.includes(run.status) && run.nodes.find((n) => n.nodeId === data.nodeId)?.status !== "completed"; i++) {
        if (Date.now() > deadline) { timedOut = true; break; }
        run = await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved });
        if (run.nodes.find((n) => n.nodeId === data.nodeId)?.status === "completed") break;
        stop = await resolveDriverRefusal(run, workspaceRepository, deadline - Date.now(), timing, data.nodeId);
      }
      return ok({ run, ...(stop ? { driverRefusal: stop.refusal, driverNote: stop.note } : timedOut ? { driverNote: driverTimeBudgetNote(RUN_DRIVER_TIME_BUDGET_MS, run) } : {}) });
    } }),
    tool({ name: "workflow.run_all", description: `Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Run all dependency-ready nodes, stopping before publish-risk nodes unless explicit approval exists. Drives the run for at most budgetMs (default ${RUN_DRIVER_TIME_BUDGET_MS}ms, ceiling ${RUN_DRIVER_TIME_BUDGET_CEILING_MS}ms — always below the caller's request timeout) and returns a COMPACT run view {run:{runId,requestId,projectId,status,currentNodeId,budget,errors,approvalsRequired,nodes:[{nodeId,status,warnings,errors,durationMs,dispatch}]}, driverNote?, continued} — no node inputs/outputs/stageOutputs/artifacts (use workflow.get_run for the full record). continued=true means the run is still queued/running and the scheduled continuation tick will advance it; call again to drive it sooner. A node whose planned dispatch claim exceeds the driver's per-request claim ceiling (${RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS}ms) is REFUSED rather than driven: the call returns the persisted run with {driverRefusal:{code:"dispatch_claim_exceeds_driver_ceiling",nodeId,plannedClaimMs,ceilingMs},driverNote} and dispatches nothing - a normal outcome, not an error. Driving it here would have the caller's request timeout kill this driver mid-node and leave the node claimed with no driver behind it; the scheduled continuation tick or the Cloud Run conductor job advances such a node instead. A node the driver does not expect to finish inside the time THIS CALL has left (priced on the tenant's measured p95 for that node, falling back to the node's own timeout) is likewise REFUSED, with {driverRefusal:{code:"dispatch_exceeds_remaining_driver_budget",nodeId,expectedMs,expectedSource,remainingDriverMs},driverNote} and continued:true - also a normal outcome, never an error to retry in a loop: the scheduled continuation tick holds a task window and advances it.`, zodSchema: runAllInput, inputSchema: runAllJsonSchema, execute: async (input) => {
      const data = runAllInput.parse(input);
      const budgetMs = driverBudgetMs(data.budgetMs);
      const deadline = Date.now() + budgetMs;
      let timedOut = false;
      let run = await getRun(data.runId, executionRepository);
      run = await enterApprovedGateBlockedRun(run, data.approved, () => runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_run_all" }));
      // D9 — the same claim ceiling the single-step drivers apply. run_all is the loop this surface's
      // callers actually use, so leaving it out would have made the refusal a fiction: one run_all
      // call would go on owning the 300s claim the other three now decline.
      // D9 + D2, from ONE graph resolution: is this claim the right KIND for a request to own, and
      // does the dispatch fit the time THIS CALL has left (priced on the tenant's measured p95 for
      // that node, falling back to its own timeout)?
      const timing = run ? await runStallTiming(run.workflowId, run.projectId) : undefined;
      let stop = await resolveDriverRefusal(run, workspaceRepository, deadline - Date.now(), timing);
      for (let i=0; run && !stop && i<100 && !HALTED_RUN_STATUSES.includes(run.status); i++) {
        if (Date.now() > deadline) { timedOut = true; break; }
        run = await runNextNode(data.runId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_run_all" });
        stop = await resolveDriverRefusal(run, workspaceRepository, deadline - Date.now(), timing);
      }
      if (!run) throw new WorkspaceToolError("run_not_found", `Run ${data.runId} was not found.`, { runId: data.runId });
      return ok({ run: compactRun(run), ...(stop ? { driverRefusal: stop.refusal, driverNote: stop.note } : timedOut ? { driverNote: driverTimeBudgetNote(budgetMs, run) } : {}), continued: RUN_LIVE_STATUSES.includes(run.status) });
    } }),
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
    tool({ name: "workflow.retry_node", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Reset a completed or failed node back to queued and run the next dependency-ready node. A failed node whose input, node definition and derived capability state are UNCHANGED since its last terminal failure is refused (no_progress) rather than re-dispatched — pass retryJustification to override, asserting a real fix this engine cannot see for itself. Pass useDefaultOutput:true to retry the node from its DEFAULT OUTPUT instead of dispatching it — same contract as workflow.run_node's own flag. A retry WITHOUT that flag un-defaults the node: its supplied-output stamp and its entry on run.defaultedNodeIds are cleared, so a run whose defaulted nodes have all been re-run for real can publish again.", zodSchema: runNodeInput, inputSchema: runNodeJsonSchema, execute: async (input) => {
      const data = runNodeInput.parse(input);
      if (data.useDefaultOutput) {
        if (!data.nodeId) throw new WorkspaceToolError("node_id_required", "useDefaultOutput pushes ONE named node through from its default; pass nodeId.", { runId: data.runId });
        return ok({ run: await pushNodeThroughWithDefault(data.runId, data.nodeId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_retry_node", note: data.defaultOutputNote }) });
      }
      return ok({ run: await retryNode(data.runId, data.nodeId, { executionRepository, workspaceRepository, approved: data.approved, driver: "http_retry_node", retryJustification: data.retryJustification }) ?? null });
    } }),
    // P0 §2.2 — the operator veto channel: ONE named field (run.operatorPublishDecision), ONE setter
    // (this tool), ONE reader (publishDecision.isOperatorPublishWithheld, consumed by the publish
    // gates and the executor's publish-risk dispatch guard).
    tool({ name: "workflow.set_operator_publish_decision", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Record the operator's durable publish decision for a run (run.operatorPublishDecision) — the ONLY thing that ever writes this field, in every project autonomy mode. \"withheld\" is the operator VETO: it blocks workflow.publish_run and every publish-risk node for this run regardless of approved/live flags or the project's autonomyMode policy, until the operator replaces it. \"approved\" records explicit durable operator approval — the referent an executed publish_execution.v1's approvalMatched must match. The decision survives workflow.reset_run.", zodSchema: operatorPublishDecisionInput, inputSchema: operatorPublishDecisionJsonSchema, execute: async (input) => { const data = operatorPublishDecisionInput.parse(input); return ok({ run: await setOperatorPublishDecision(data.runId, data.decision, executionRepository) ?? null }); } }),
    // budget-override-and-ui-save — the ONE setter for run.nodeBudgetOverrides (executor.setNodeBudgetOverride),
    // same one-field/one-setter shape as the operator publish decision tool just above. A budget_exceeded
    // error's own details.suggestedBudgetUsd names the raise this tool is FOR; this tool only records the
    // raise — it never retries the node itself (call workflow.retry_node separately once the override is
    // set, exactly like raising a run's budgetUsd via workflow.resume_run does not itself advance the run).
    // Deliberately absent from siteGenesis.ts's SITE_CLIENT_MANAGER_TOOLS allowlist, same as
    // workflow.retry_node/reset_run/set_operator_publish_decision above — a scoped client_manager
    // credential can drive a run but cannot rewrite what it costs to.
    tool({ name: "workflow.set_node_budget_override", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Set a per-run override for one node's budget ceiling (run.nodeBudgetOverrides[nodeId]) — read by the budget guard in PREFERENCE to the node's own modelConfig.budgetUsd, for THIS run only; the node's stored modelConfig is never touched, so every other run keeps the node's normal ceiling. Use a budget_exceeded error's own details.suggestedBudgetUsd as the figure. Does NOT retry the node — call workflow.retry_node afterward to actually re-run it under the new ceiling.", zodSchema: setNodeBudgetOverrideInput, inputSchema: setNodeBudgetOverrideJsonSchema, execute: async (input) => { const data = setNodeBudgetOverrideInput.parse(input); return ok({ run: await setNodeBudgetOverride(data.runId, data.nodeId, data.budgetUsd, executionRepository) ?? null }); } }),
    // S3 — the operator's publish id survives a reset, for the same reason requestId and the operator's
    // durable publish decision do: a reset RETRIES the same publish request, it does not become a new
    // one. Re-stamped here (rather than inside resetRun's rebuild) because this tool is the field's one
    // writer; without it a reset would silently put a seeded late-stage run back into the
    // publish_request_id_absent state the operator supplied the id to leave.
    tool({ name: "workflow.reset_run", description: "Reset a dry-run workflow execution to its initial queued state. The run's requestId, the operator's durable publish decision, and its operator-supplied publishRequestId all survive the reset — a reset retries the same request rather than starting a new one.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => {
      const runId = runIdInput.parse(input).runId;
      const publishRequestId = (await getRun(runId, executionRepository))?.publishRequestId;
      const reset = await resetRun(runId, executionRepository);
      return ok({ run: publishRequestId ? await executionRepository.saveRun({ ...reset, publishRequestId }) : reset });
    } }),
    tool({ name: "workflow.get_run_context", description: "Return the reusable per-run context bundle (project contract, article_body schema, project tool policy, object contracts, node registry), memoized per run so the conductor fetches it once instead of re-reading contracts and the registry at every step.", zodSchema: runContextInput, inputSchema: runContextJsonSchema, execute: async (input) => { const data = runContextInput.parse(input); const cacheHit = conductorCache.has(data.runId, `${RUN_CONTEXT_KEY}:${data.projectId}`); const context = await getRunContext({ runId: data.runId, projectId: data.projectId, projectRepository }); return ok({ context, cacheHit }); } }),
    // T6 (Wave 3, ships dark): plan.nodeTimingAggregates is a READ-ONLY addition — per-nodeId
    // {count, emaDurationMs, p50DurationMs, p95DurationMs} across every run of this run's workflowId,
    // straight from the node timing ledger (nodeTimings.ts). Nothing here or downstream reads it to
    // make a decision yet; see nodeTimings.ts's header for the three follow-ups it is explicitly
    // gating (driver packing, estimator calibration, per-node stall thresholds) on two runs of data.
    // planRun(run) itself is untouched — its own return type and every field it has ever returned are
    // unchanged; the aggregates are spread onto the object AFTER planRun runs, in this tool only.
    tool({ name: "workflow.get_run_cost", description: "Return a per-node cost ledger plus the cheapest honest recovery plan. Completed stages remain reusable; queued, failed, and blocked stages remain in remainingStages. plan.blocker is the primary recorded blockage.v1 cause and remedies, so a missing scope recommends repair+retry, a tenant-policy hold shows that no transport occurred, a budget hold recommends a raise before resume, and only a real publication gate recommends approval. plan.nodeTimingAggregates surfaces measured per-node duration history (EMA/p50/p95/count) for this run's workflow, read-only.", zodSchema: runIdInput, inputSchema: runIdJsonSchema, execute: async (input) => { const runId = runIdInput.parse(input).runId; const run = await getRun(runId, executionRepository); if (!run) return ok({ ledger: null, plan: null }); const usage = await summarizeModelUsage({ runId }, usageRepository); const timingRecords = await nodeTimingRepository.list({ workflowId: run.workflowId }); return ok({ ledger: summarizeRunCost(run, usage), plan: { ...planRun(run), nodeTimingAggregates: aggregateNodeTimingsByNode(timingRecords, run.projectId ? { projectId: run.projectId } : {}), nodeTimingAggregatesPooled: aggregateNodeTimingsByNode(timingRecords), nodeTimingAggregatesByEra: aggregateNodeTimingsByEra(timingRecords) } }); } }),
    tool({ name: "workflow.publish_run", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only, and is not the way autonomy is exercised. Explicit PUBLISH gate: publish a run's client_object.v1 to the project's live site via that project's own sanctioned publish dialect (for object-substrate clients: object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin; the exact sequence is reported as plan.toolSequence). Never releases to production — going live is a separate, explicit gate. A real publish requires operator-enabled publishing (a per-project env flag), live:true, the run's publish authority resolved AUTHORIZED (an explicit operator approval via workflow.set_operator_publish_decision, or the project's autonomyMode policy — see publishDecision.resolvePublishAuthority), and the project's publish-readiness policy must be GO. approved is DEPRECATED as an authority input (accepted for compatibility, no longer consulted) and can never override an operator's \"withheld\". A readiness NO-GO returns mode blocked_for_publish_execution (an expected, resumable safety state); missing gates return a dry-run plan. Text-only bodies only.", zodSchema: publishRunInput, inputSchema: publishRunJsonSchema, execute: async (input) => { const data = publishRunInput.parse(input); return ok({ publish: await publishRun(data, { executionRepository, projectRepository, learningRepository }) }); } }),
    tool({ name: "workflow.publish_readiness", description: "Wrong-path notice: content is normally driven from the site admin chat; direct use is operator/test only. Evaluate the project's publish-readiness checklist (GO/NO-GO) for a run's client_object.v1 without publishing: client_object.v1 valid, Blob artifacts verified (pdf-tool materialized), taxonomy resolved or accepted-empty, pinned approval present, hard constraints, and release/build behavior selected. Projects without a readiness policy return available:false.", zodSchema: publishReadinessInput, inputSchema: publishReadinessJsonSchema, execute: async (input) => { const data = publishReadinessInput.parse(input); return ok({ readiness: await evaluatePublishReadiness({ projectId: data.projectId, runId: data.runId, articleBody: coerceJsonObjectInput(data.articleBody), readiness: data.readiness }, { executionRepository }) }); } }),
    tool({ name: "usage.record", description: "Record estimated or actual model usage without storing raw prompts or secrets.", zodSchema: recordModelUsageSchema, inputSchema: usageRecordJsonSchema, execute: async (input) => ok({ record: await recordModelUsage(recordModelUsageSchema.parse(input), usageRepository) }) }),
    tool({ name: "usage.list_records", description: "List model usage records with optional filters.", zodSchema: usageFiltersSchema, inputSchema: usageFiltersJsonSchema, execute: async (input) => ok({ records: await usageRepository.list(usageFiltersSchema.parse(input)) }) }),
    tool({ name: "usage.get_summary", description: "Summarize estimated model token and cost usage with optional filters.", zodSchema: usageFiltersSchema, inputSchema: usageFiltersJsonSchema, execute: async (input) => ok({ summary: await summarizeModelUsage(usageFiltersSchema.parse(input), usageRepository) }) }),
    tool({ name: "usage.get_budget_status", description: "Return estimated budget status for a run or project.", zodSchema: budgetStatusInput, inputSchema: budgetStatusJsonSchema, execute: async (input) => ok({ budgetStatus: await getBudgetStatus(budgetStatusInput.parse(input), usageRepository) }) }),
    tool({ name: "project.list", description: "List registered project MCP connections with safe, non-secret metadata.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); const projects = await projectRepository.list(); const health = await driverHealthRepository.listTenantHealth().catch(() => []); const byProject = new Map(health.map((record) => [record.projectId, record])); return ok({ projects: projects.map((config) => ({ ...toProjectSummary(config), driverHealth: byProject.get(config.projectId) ?? null })) }); } }),
    tool({ name: "project.get", description: "Get one registered project MCP connection with safe, non-secret metadata, the project's knowledge rules when a hook module provides them, and `usedBy` — who has actually reached this tenant, read from the tool execution ledger: the nodes that called it, the routes they called it under, the verbs they spoke and whether each call came from a model turn or from engine code. Empty for a tenant nothing has called since the ledger began; never a claim about intent, only about calls that happened.", zodSchema: projectIdInput, inputSchema: projectIdJsonSchema, execute: async (input) => {
      const projectId = projectIdInput.parse(input).projectId;
      const config = await projectRepository.get(projectId);
      if (!config) return ok({ project: null, knowledge: null, usedBy: null });
      // W4.1 — the Access page's "used by" question, answerable for the first time because W3.2.1's
      // choke point writes an engine-invoked tenant call down. Before it, the only honest answer for
      // a publish, a release or a theme apply was "we cannot tell you".
      //
      // Bounded on purpose: this is a summary for an operator deciding whether a tool policy change
      // is safe, not an audit export — tool.list_executions with a projectId filter is that.
      await flushToolExecutionLedger();
      const records = await repositoryManager.getToolExecutionRepository().list({ projectId, limit: PROJECT_USED_BY_SAMPLE });
      const byNode = new Map<string, { nodeId: string; callers: Set<string>; routeIds: Set<string>; verbs: Set<string>; calls: number; lastAt?: string }>();
      for (const record of records) {
        const entry = byNode.get(record.nodeId) ?? { nodeId: record.nodeId, callers: new Set<string>(), routeIds: new Set<string>(), verbs: new Set<string>(), calls: 0 };
        if (record.caller) entry.callers.add(record.caller);
        if (record.routeId) entry.routeIds.add(record.routeId);
        entry.verbs.add(record.toolId);
        entry.calls += 1;
        if (!entry.lastAt || record.startedAt > entry.lastAt) entry.lastAt = record.startedAt;
        byNode.set(record.nodeId, entry);
      }
      const usedBy = {
        sampledCalls: records.length,
        sampleLimit: PROJECT_USED_BY_SAMPLE,
        nodes: [...byNode.values()]
          .map((entry) => ({ nodeId: entry.nodeId, calls: entry.calls, callers: [...entry.callers].sort(), routeIds: [...entry.routeIds].sort(), verbs: [...entry.verbs].sort(), lastAt: entry.lastAt ?? null }))
          .sort((a, b) => b.calls - a.calls)
      };
      return ok({ project: { ...toProjectSummary(config), driverHealth: (await driverHealthRepository.getTenantHealth(projectId).catch(() => undefined)) ?? null }, knowledge: getProjectHooks(projectId)?.knowledge ?? null, usedBy });
    } }),
    // W5 T3 — project.test_connection / project.list_tools stay on the plain adapter and are NOT
    // ledgered: neither calls a tenant verb (one is an MCP `initialize` handshake, the other a
    // tools/list), so there is no verb, no arguments and no outcome for a ledger row to be about.
    // The same line toolRegistry.ts already draws on the model path.
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
      // W3.2.3 — THE LAST UNGATED DOOR TO A PUBLISH VERB, closed.
      //
      // AGENTS.md invariant 4 has named this hole in prose since it was written: the publish gates
      // cover publishRun and the dispatch of publish-risk nodes; `project_call_tool` on the wire
      // reaches release_to_production "with no gate at all". FORBIDDEN_PROJECT_VERBS has guarded the
      // model path since K-A10 and now guards the engine path too (W3.2.1) — this surface was the one
      // caller still outside it.
      //
      // There is no node here to exempt, and that is the point rather than a limitation: the two
      // exempt ids are DISPATCHED nodes inside a run, which have already passed the publish-risk gate,
      // the controller decision and the operator decision. A hand-made wire call has passed none of
      // them, so no caller on this surface is exempt — not an operator, not a test. The sanctioned
      // route to a publish is workflow_publish_run (gates + operator decision) or a run whose
      // publish_executor / release_executor dispatch reaches it.
      //
      // Refused in the SHAPE this surface already refuses things, not by throwing: a caller that
      // handles the executable-policy block above handles this identically.
      if (FORBIDDEN_PROJECT_VERBS.has(data.tool)) {
        return ok({ call: { ok: false, projectId: data.projectId, connection: adapter.connectionState(), tool: data.tool, permission: "blocked" as const, blockedByPolicy: true, error: `publish_verb_not_permitted: "${data.tool}" may not be called through project_call_tool. This surface has no run, no publish gate and no operator decision behind it. Publish through workflow_publish_run, or through a run whose publish_executor/release_executor dispatch reaches the verb.` } });
      }
      // W5 T3 (2026-09-16) — THE WIRE SURFACE JOINS THE LEDGER.
      //
      // W3.2.1 put every model-invoked and engine-invoked tenant call through invokeTenantTool; this
      // surface — an operator or a script calling the tenant by hand with a full bearer — was the one
      // caller still outside it, so `tool.list_executions` could show what the engine did and what a
      // model did and nothing at all about what a person did. It now records under
      // `caller: "operator"`, which is a THIRD value rather than a relabelling of either of the other
      // two: "a human did this, outside any run" is the distinction an operator reading the ledger
      // after an incident most needs.
      //
      // Behaviour is unchanged. The denylist above still refuses before this line; the choke point's
      // own forbidden-verb rule only fires when the call states a nodeId, and this surface has no
      // node — which is correct here, because the refusal that matters on this surface is the
      // stronger, exemption-free one immediately above.
      return ok({ call: await invokeTenantTool({ projectId: data.projectId, project: config, toolId: data.tool, args: data.arguments ?? {}, caller: "operator" }) });
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
      // W5 T3 — same as project.call_tool above. The adapter's fixed READ_TOOL_ALLOWLIST still decides
      // what qualifies, and invokeTenantReadTool deliberately does not apply the forbidden-verb rule
      // (the allowlist is strictly narrower and contains none of those verbs — see tenantInvoke.ts).
      return ok({ call: await invokeTenantReadTool({ projectId: data.projectId, project: config, toolId: data.tool, args: data.arguments ?? {}, caller: "operator" }) });
    } }),
    tool({ name: "project.validate_handoff", description: "Dry structural validation of a handoff against the project content_source.v1 / client_object.v1 contract. Read-only; no publishing.", zodSchema: validateHandoffInput, inputSchema: validateHandoffJsonSchema, execute: async (input) => { const data = validateHandoffInput.parse(input); const config = await requireProject(data.projectId); return ok({ validation: validateHandoff(config, { contentSource: coerceJsonObjectInput(data.contentSource), articleBody: coerceJsonObjectInput(data.articleBody) }) }); } }),
    tool({ name: "project.get_registration_contract", description: "Machine-readable contract for onboarding a new publishing client: field rules, env-var naming conventions, and the step-by-step registration flow.", zodSchema: emptyInput, inputSchema: emptyJsonSchema, execute: async (input) => { emptyInput.parse(input); return ok({ contract: projectRegistrationContract() }); } }),
    tool({ name: "project.create", description: "Register a new external publishing-client MCP connection. The TOKEN is referenced by environment variable NAME only (never a value). The ENDPOINT can be passed directly as mcpEndpoint and is stored on the record — an endpoint URL is not a secret — so registering a tenant needs no new env var on this deployment; <CLIENT>_MCP_ENDPOINT still overrides it when set. Publishing stays governed by server-side policy. A bearer_env project is created with no clientSiteBinding (that field is only settable via project.update) — the result carries an advisories[] entry when authMode is bearer_env, since bearer_env also covers internal service projects (monetizer, pdf-tool) that never get one; ignore the advisory for those.", zodSchema: projectCreateInput, inputSchema: projectCreateJsonSchema, execute: async (input) => { const data = projectCreateInput.parse(input); const project = await createProject(projectRepository, data.project); const advisory = bearerEnvClientSiteBindingAdvisory(data.project); return ok({ project, ...(advisory ? { advisories: [advisory] } : {}) }); } }),
    tool({ name: "project.update", description: "Patch a registered project's safe fields (name, env var names, the stored mcpEndpoint — null clears it, auth mode, allowed tools, contract, status, the client-site binding used by the fleet credential reconciler — null clears it) plus one policy field: autonomyMode (autonomous | operator-gated) — whether a run with no recorded operator decision proceeds under policy authority (publishingPolicy.autonomyMode). Identity and the REST of publishing policy (publishEnabled, requiresExplicitPublish) are not patchable.", zodSchema: projectUpdateInput, inputSchema: projectUpdateJsonSchema, execute: async (input) => { const data = projectUpdateInput.parse(input); return ok({ project: await updateProject(projectRepository, data.projectId, data.patch) }); } }),
    tool({ name: "project.delete", description: "Remove an agent-registered project connection. Code-defined default projects cannot be deleted (set status to disabled instead).", zodSchema: projectDeleteInput, inputSchema: projectDeleteJsonSchema, execute: async (input) => { const data = projectDeleteInput.parse(input); return ok(await deleteProject(projectRepository, data.projectId)); } }),
    // T12.11 — the one-call composite entry point (R-C5): site.duplicate / site.duplicate_status.
    ...createSiteDuplicationTools({ executionRepository, workspaceRepository, projectRepository, usageRepository }),
    // Operator surface over the fleet credential reconciler: plan (read-only), apply (fires the
    // Cloud Run Job), execution_status (poll). apply/execution_status are deliberately absent from
    // SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts) — they are operator-only and must never reach a
    // tenant's scoped chat bearer.
    ...createSiteCredentialTools({ projectRepository }),
    // A1 (D1) — the one narrow, site-scoped door to the brand-imagery writer. Present in
    // SITE_CLIENT_MANAGER_TOOLS (siteGenesis.ts) precisely so `node_execute` never has to be:
    // it takes no nodeId, no executionMode, and writes nothing. See visualIdentityTools.ts.
    ...createVisualIdentityTools({ workspaceRepository, executionRepository, projectRepository }),
    ...createAgentTools({ workspaceRepository, projectRepository, conversationTurnRepository: repositoryManager.getConversationTurnRepository(), usageRepository, skillRepository, executionRepository, improvementRepository: repositoryManager.getImprovementRepository() }),
    ...createChangesTools({ workspaceRepository, changeRepository, meta }),
    ...createConstellationTools({ workspaceRepository, executionRepository, usageRepository, skillRepository, projectRepository }),
    ...createImprovementTools({ workspaceRepository, executionRepository, learningRepository, evaluationRepository: repositoryManager.getEvaluationRepository(), improvementRepository: repositoryManager.getImprovementRepository(), meta }),
    // A2 — read-only discovery surface over the operation catalog (operation.list/get/preflight).
    // Code-registered descriptors only; no tenant call, no execution. R2 Piece 2 added one repository
    // read (project record, to derive capability facts), one best-effort durable-ledger write inside
    // preflight (a genuine capability gap), and one plain read tool over that ledger
    // (operation.list_capability_gaps) — see operationTools.ts for all three.
    ...createOperationTools(),
    // Track C — autonomous commissioning. Its own module for the reason every sibling surface has
    // one: the verbs share one subject (a tenant's commissioning policy) and nothing else here does.
    ...createPlannerTools()
  ];
}
