// T15.9 (#188) — chains clone_conductor after a site.duplicate-originated capture_conductor run
// reaches ITS OWN terminal state, so "URL in -> live site out" is one call: `site.duplicate` never
// requires a second, human-issued `workflow.start_dry_run({workflowId:"clone_conductor",
// input:{captureRunId, targetProjectId}})`. This is the clone-driven entry mode structure-studio ADR
// §3 describes — the handoff travels by `captureRunId`, which is exactly the provenance field the
// template library (#207) will read back out.
//
// WHAT THIS FUNCTION DOES, precisely: it decides, and — when the decision is to proceed — it STARTS
// the clone run (workflow.start_dry_run's own machinery, unchanged) and records the decision. It
// does NOT drive the new clone run forward itself. The clone run is created "queued", which is one
// of the two statuses the run-continuation tick's own selector (CONTINUABLE_RUN_STATUSES,
// decideRunContinuation, above) already re-enters on its own next pass — so the SAME machinery that
// picked up the parked capture run picks up the freshly chained clone run, with no code here
// re-implementing "drive a run to its terminal state". This is deliberate, not an oversight: it
// keeps the chain's own surface to "decide, then start" (the part that must be exactly-once and
// auditable) and leaves "advance a run" to the one piece of code that already does it correctly for
// every other run, including giving an operator a real window to act on the NEW clone run (e.g.
// set_operator_publish_decision "withheld") before the next tick ever reaches its publish stage.
//
// WHERE THIS IS CALLED FROM, and why both call sites exist (neither is redundant coverage of the
// same event — each is the ONLY place that ever OBSERVES some capture runs' terminal transition):
//   1. site.duplicate's own in-call kick (siteDuplicationTools.ts) — covers a capture run that
//      happens to reach a halted status synchronously inside the one call (no external job ever
//      parked it).
//   2. the run-continuation tick (runContinuation.ts) — covers the normal case, since
//      capture_crawl parks on the pdf-tool plane and the tick is what drives the run home,
//      completely outside any MCP call.
// This function is idempotent — chain.status is read back and honoured before ever starting a
// second clone for the same capture run — so double-invocation from an overlapping tick, a retried
// advance, or both call sites racing can never mint two clone runs for one capture.
//
// SCOPE. Only a capture_conductor run that carries the site.duplicate request marker
// (SITE_DUPLICATION_REQUEST_STAGE_KEY) is a chaining candidate. A capture run started directly via
// workflow.start_dry_run (an operator/test surface, per T15's own boundary) is NEVER auto-chained —
// chaining is a site.duplicate behavior, not a capture_conductor behavior, exactly as the issue
// title ("...inside site.duplicate") frames it.
//
// FAILURE SEMANTICS (issue #188 point 4). A capture run that does not reach run status "completed"
// — "blocked" (a publish/budget gate the operator has not cleared), "failed", "cancelled", or
// "paused" — never chains. Nothing here retries it, proceeds past it, or starts a clone against a
// snapshot the capture run itself did not consider finished; the capture's own (possibly partial)
// output is left exactly where the executor put it. The refusal is NAMED on the SAME request record
// site.duplicate_status already reads (`chain.status:"refused"`, `chain.code`, `chain.reason`), so
// "why didn't my clone start" has one answer in one place.
//
// BUDGET (issue #188 point 3). The ORIGINAL site.duplicate call's `budgetUsd`, when the caller
// supplied one, is the ceiling for the WHOLE chain — not a fresh ceiling handed to the clone run for
// free. The clone run's OWN `budgetUsd` is set to (original total − capture's own accrued spend),
// read via the SAME `actualCostUsdEstimate` figure `evaluateRunBudget`/`getBudgetStatus` already
// treat as the one true spend figure (R-20: only status:"actual" records count — a mock run's
// estimated figures never erode the ceiling, matching every other budget read in this codebase). A
// remaining ceiling below clone_conductor's own entry-node reservation refuses the chain rather than
// minting a clone run that could never dispatch its first node — the same law site.duplicate's own
// pre-flight budget check already applies to capture's entry node (entryNodeReservationUsd in
// siteDuplicationTools.ts; this module re-derives the identical shape for clone_conductor). No
// budgetUsd on the original call -> no ceiling on either half of the chain; nothing here invents a
// ceiling nobody asked for.
//
// DETERMINISM (#200). Every value this module derives — captureRunId, targetProjectId, and the
// clone's budgetUsd — is a pure read of the capture run's OWN already-persisted record (its runId,
// its projectId, and its own accrued cost). Nothing here reads a clock or mints a random id beyond
// what startDryRun's own run/request-id minting already does for every workflow start in this
// codebase (unrelated to this module, and unchanged by it); two capture runs of the same URL that
// reach the same terminal state chain identically, in the same order, every time.
import { startDryRun, getRun } from "./executor.js";
import { CAPTURE_CONDUCTOR_WORKFLOW_ID } from "./captureConductorWorkflow.js";
import { CLONE_CONDUCTOR_WORKFLOW_ID } from "./cloneConductorWorkflow.js";
import { getWorkflowDefinition } from "./workflowRegistry.js";
import { HALTED_EXECUTION_STATUSES, type WorkflowExecutionRecord } from "./executionTypes.js";
import { summarizeModelUsage } from "../observability/modelUsage.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { UsageRepository } from "../repository/interfaces/UsageRepository.js";

// Unchanged from siteDuplicationTools.ts's original definition — this module is now the one place
// that owns the constant; siteDuplicationTools.ts imports and re-exports it so existing importers
// (tests included) keep resolving the same string from the same familiar path.
export const SITE_DUPLICATION_REQUEST_STAGE_KEY = "site_duplicate:request";

export type DuplicationChainState =
  | { status: "started"; cloneRunId: string; startedAt: string; budgetUsd?: number }
  | { status: "refused"; code: string; reason: string; refusedAt: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const roundUsd = (value: number): number => Math.round(value * 10000) / 10000;

// The reservation the target workflow's entry node will demand before dispatching. Generalizes
// siteDuplicationTools.ts's own entryNodeReservationUsd (identical shape, kept in sync deliberately
// rather than imported cross-module, since that helper is a private detail of the MCP tool layer and
// this is a private detail of the chain).
const entryNodeReservationUsd = (workflowId: string): { nodeId: string; reservationUsd: number } => {
  const definition = getWorkflowDefinition(workflowId);
  const nodes = definition?.canonicalNodes() ?? [];
  const entry = nodes.find((node) => node.dependsOn.length === 0);
  const declared = entry?.modelConfig && typeof (entry.modelConfig as Record<string, unknown>).budgetUsd === "number"
    ? ((entry.modelConfig as Record<string, unknown>).budgetUsd as number)
    : 0;
  return { nodeId: entry?.id ?? "unknown", reservationUsd: declared };
};

export type ChainDeps = { executionRepository: ExecutionRepository; workspaceRepository?: WorkspaceRepository; usageRepository: UsageRepository };

export type ChainOutcome =
  | { action: "not_applicable" }
  | { action: "already_decided"; chain: DuplicationChainState }
  | { action: "chained"; cloneRunId: string; captureRun: WorkflowExecutionRecord; cloneRun: WorkflowExecutionRecord }
  | { action: "refused"; code: string; reason: string; captureRun: WorkflowExecutionRecord };

// Reads the current site.duplicate request record off a run, loosely typed: this module only ever
// needs `artifact`, `targetProjectId`, `budgetUsd` and `chain` — the richer shape (genesis, human
// checklist) lives with siteDuplicationTools.ts's own DuplicationRequestRecord type and is untouched
// by a read-modify-write here (the spread below preserves every field it does not know about).
const readRequest = (run: WorkflowExecutionRecord): Record<string, unknown> | undefined => {
  const value = run.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY];
  return isRecord(value) && value.artifact === "site_duplication.v1" ? value : undefined;
};

export async function maybeChainCloneAfterCapture(run: WorkflowExecutionRecord, deps: ChainDeps): Promise<ChainOutcome> {
  if (run.workflowId !== CAPTURE_CONDUCTOR_WORKFLOW_ID) return { action: "not_applicable" };
  // Only a run the executor itself has stopped driving is a chaining candidate. A capture run that is
  // merely parked mid-flight (status "running", the crawl job pending on the pdf-tool plane) is NOT a
  // terminal state — deciding here would misread "not finished yet" as "finished badly".
  if (!HALTED_EXECUTION_STATUSES.has(run.status)) return { action: "not_applicable" };
  const request = readRequest(run);
  if (!request) return { action: "not_applicable" };
  const existingChain = request.chain;
  if (isRecord(existingChain) && (existingChain.status === "started" || existingChain.status === "refused")) {
    return { action: "already_decided", chain: existingChain as unknown as DuplicationChainState };
  }

  // Read-modify-write against the FRESHEST persisted state (not the possibly-stale `run` a caller
  // handed in), the same reload-before-write discipline every other read-modify-write in this
  // codebase follows against concurrent writers.
  const persistChain = async (chain: DuplicationChainState): Promise<WorkflowExecutionRecord> => {
    const fresh = (await getRun(run.runId, deps.executionRepository)) ?? run;
    const freshRequest = readRequest(fresh) ?? request;
    const updatedRequest = { ...freshRequest, chain };
    const updated: WorkflowExecutionRecord = { ...fresh, stageOutputs: { ...fresh.stageOutputs, [SITE_DUPLICATION_REQUEST_STAGE_KEY]: updatedRequest }, updatedAt: new Date().toISOString() };
    return deps.executionRepository.saveRun(updated);
  };

  if (run.status !== "completed") {
    const reason = `Capture run ${run.runId} did not reach a terminal SUCCESS state (status: "${run.status}"); a clone must never start against a partial or withheld capture snapshot. The chain is refused — the capture's own output is left exactly where the executor put it, and nothing here retried or proceeded past it.`;
    const chain: DuplicationChainState = { status: "refused", code: "chain_capture_not_terminal_success", reason, refusedAt: new Date().toISOString() };
    return { action: "refused", code: chain.code, reason, captureRun: await persistChain(chain) };
  }

  const targetProjectId = typeof request.targetProjectId === "string" && request.targetProjectId.trim() ? request.targetProjectId.trim() : run.projectId;
  const originalBudgetUsd = typeof request.budgetUsd === "number" ? request.budgetUsd : undefined;

  let cloneBudgetUsd: number | undefined;
  if (originalBudgetUsd !== undefined) {
    const usage = await summarizeModelUsage({ runId: run.runId }, deps.usageRepository);
    const captureSpent = usage.actualCostUsdEstimate;
    const remaining = roundUsd(Math.max(0, originalBudgetUsd - captureSpent));
    const entry = entryNodeReservationUsd(CLONE_CONDUCTOR_WORKFLOW_ID);
    if (remaining < entry.reservationUsd) {
      const reason = `The chain's shared budgetUsd ($${originalBudgetUsd}) has $${remaining} remaining after capture's own accrued spend ($${roundUsd(captureSpent)}) — below clone_conductor's entry-node reservation ($${entry.reservationUsd} for ${entry.nodeId}). Starting the clone would mint a run that could never dispatch its first node, so the chain refuses instead of silently double-spending capture's own budget on a run born blocked.`;
      const chain: DuplicationChainState = { status: "refused", code: "chain_budget_exhausted", reason, refusedAt: new Date().toISOString() };
      return { action: "refused", code: chain.code, reason, captureRun: await persistChain(chain) };
    }
    cloneBudgetUsd = remaining;
  }

  const started = await startDryRun(
    {
      projectId: targetProjectId,
      workflowId: CLONE_CONDUCTOR_WORKFLOW_ID,
      executionMode: run.executionMode,
      input: { captureRunId: run.runId, targetProjectId },
      ...(cloneBudgetUsd !== undefined ? { budgetUsd: cloneBudgetUsd } : {})
    },
    deps.executionRepository,
    deps.workspaceRepository
  );

  const chain: DuplicationChainState = { status: "started", cloneRunId: started.runId, startedAt: new Date().toISOString(), ...(cloneBudgetUsd !== undefined ? { budgetUsd: cloneBudgetUsd } : {}) };
  const captureRun = await persistChain(chain);

  // Deliberately NOT driven any further here — see this module's header. `started` is "queued",
  // which the run-continuation tick's own selector already re-enters on its next pass; nothing here
  // duplicates that machinery or passes `approved` (authority is resolvePublishAuthority's alone,
  // ADR-2026-08-25-publish-autonomy §2.4, unaffected by anything this chain does).
  return { action: "chained", cloneRunId: started.runId, captureRun, cloneRun: started };
}
