// T15.6 (2026-08-25, ADR-2026-08-25-publish-autonomy §4) — release_executor: the ONE node Board
// decision B2 (amended by this ADR) authorizes to say `release_to_production`. Positioned after
// publish_executor, before learning_recorder, in the shared publishing tail (publishingTail.ts).
//
// DETERMINISTIC — no model turn. It reads what publish_executor committed; it decides nothing a model
// could decide better.
//
// IDEMPOTENT, and this is a correctness requirement, not a nicety: keyed on (runId, requestId) via
// run.releaseLedger (executionTypes.ts — a field retryNode never clears, unlike stageOutputs/node.output,
// because a release must stay released across a retry of the node that reports it). Once this module
// has reached a TERMINAL answer for a key — skipped, executed, or a real failure — it NEVER calls
// anything again for that key: a retry, a stale-dispatch reclaim, or a continuation tick all get the
// SAME result back, zero calls. While a release is genuinely in flight (release_to_production already
// succeeded, deploy_status not yet "ready") it reports PENDING and the node is re-queued for one more
// poll on the next dispatch — the same create-or-poll-once idiom captureConductorRoutes.ts uses for
// pdf-tool jobs (T12.8/T14.4): one network round trip per dispatch, never a wait loop inside one
// request window. release_to_production itself is called AT MOST ONCE across the whole sequence.
//
// SKIPS HONESTLY. Nothing published (publish_executor's own record does not carry
// publishCommitted:true) ⇒ status "skipped" with the reason recorded — never "executed", and never
// silently absent (publish.mjs's own release step: "asking production to rebuild for zero commits is
// noise that looks like activity").
//
// NEVER THROWS PAST ITS OWN TRY/CATCH, per publish.mjs:26-28: a release call that errors is reported as
// a typed, RECOVERABLE blocker — nothing is ledgered, so a genuine retry may actually call
// release_to_production again — the same posture publish.mjs took for its own release step ("Only the
// deploy failed, and that is recoverable by calling release again").

import type { CallToolFn } from "./publisher.js";
import { resolvePublishAuthority, type PublishAuthority } from "./publishDecision.js";
import type { ReleaseLedgerEntry, WorkflowExecutionRecord } from "./executionTypes.js";

// The SAME receipt shape publishExecution.ts's publish_execution.v1 carries (T15.5, ADR §8) — release
// happens under the run's SAME resolved authority, so a reader must never see two different renderings
// of one run's authority across its two publish-path artifacts.
export type PublishAuthorityReceipt = { mode: "autonomous" | "operator-gated"; source: "operator_explicit" | "policy_autonomous" | null; operatorDecision: "approved" | "withheld" | null };

const authorityReceipt = (
  run: Pick<WorkflowExecutionRecord, "operatorPublishDecision" | "publishingPolicySnapshot">,
  authority: PublishAuthority
): PublishAuthorityReceipt => ({
  mode: run.publishingPolicySnapshot?.autonomyMode ?? "operator-gated",
  source: authority.authorized ? authority.source : null,
  operatorDecision: run.operatorPublishDecision ?? null
});

export const RELEASE_EXECUTION_ARTIFACT = "release_execution.v1";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const payloadOf = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  if (isRecord(value.structuredContent)) return value.structuredContent as Record<string, unknown>;
  return value;
};

export type ReleaseExecutionOutput = {
  artifact: typeof RELEASE_EXECUTION_ARTIFACT;
  summary: string;
  status: "skipped" | "executed" | "blocked";
  reason?: string;
  releaseId?: string;
  deployedSha?: string;
  approvalMatched?: boolean;
  publishAuthority?: PublishAuthorityReceipt;
  verification?: { deployStatus?: string; productionConfirmed?: boolean };
  result?: Record<string, unknown>;
  blockers: string[];
  notes: string[];
};

// `${runId}:${requestId}` — see executionTypes.ts's WorkflowExecutionRecord.releaseLedger.
export const releaseLedgerKey = (runId: string, requestId: string | undefined): string => `${runId}:${requestId ?? "none"}`;

const MAX_POLL_ATTEMPTS_DEFAULT = 8;

export type ReleaseExecutorDeps = {
  // Injectable so tests exercise this against a stubbed transport and never touch a live site.
  callTool?: CallToolFn;
  // Injectable bound on the number of dispatches this module will poll deploy_status across before
  // giving up and reporting blocked — a real deploy that takes longer than this is not "lost": every
  // later dispatch still only re-polls (release_to_production is never called a second time).
  maxPollAttempts?: number;
};

export type RunDeterministicReleaseExecutorParams = {
  run: Pick<WorkflowExecutionRecord, "runId" | "stageOutputs" | "operatorPublishDecision" | "publishingPolicySnapshot" | "releaseLedger">;
  // The publish request id, resolved the same way publish_executor's engine path resolves it
  // (runContext.requestId first). Falls back to reading it off publish_executor's own receipts when
  // absent — never minted here.
  requestId?: string;
  deps?: ReleaseExecutorDeps;
};

export type ReleaseExecutorOutcome =
  | { kind: "completed"; ok: true; output: ReleaseExecutionOutput; warnings: string[]; ledgerKey: string; ledgerEntry: ReleaseLedgerEntry }
  | { kind: "pending"; ok: true; warnings: string[]; ledgerKey: string; ledgerEntry: ReleaseLedgerEntry }
  | { ok: false; code: string; error: string };

const skippedOutput = (reason: string): ReleaseExecutionOutput => ({
  artifact: RELEASE_EXECUTION_ARTIFACT,
  summary: `release_executor skipped: ${reason}. No release call was made.`,
  status: "skipped",
  reason,
  blockers: [],
  notes: [
    "Nothing was published this run — publish_executor's own record does not carry publishCommitted:true — so asking production to rebuild for zero commits would be noise that looks like activity. release_to_production was never called."
  ]
});

const blockedOutput = (params: { reason: string; detail?: string; recoverable: boolean; releaseId?: string; deployedSha?: string }): ReleaseExecutionOutput => ({
  artifact: RELEASE_EXECUTION_ARTIFACT,
  summary: `release_executor did not confirm go-live: ${params.reason}${params.detail ? ` — ${params.detail}` : ""}.`,
  status: "blocked",
  reason: params.reason,
  ...(params.releaseId ? { releaseId: params.releaseId } : {}),
  ...(params.deployedSha ? { deployedSha: params.deployedSha } : {}),
  blockers: [`${params.reason}${params.detail ? `: ${params.detail}` : ""}`],
  notes: [
    params.recoverable
      ? "Recoverable: nothing here was ledgered as released, so a retry may call release_to_production again."
      : "release_to_production already succeeded for this run; a retry will only re-poll deploy_status, and will never call release_to_production again for this (runId, requestId)."
  ]
});

const nowIso = (): string => new Date().toISOString();

/**
 * THE deterministic dispatch. Never throws — every failure mode returns a typed result instead. See
 * the module header for the idempotency and skip-vs-execute contracts this implements.
 */
export async function runDeterministicReleaseExecutor(params: RunDeterministicReleaseExecutorParams): Promise<ReleaseExecutorOutcome> {
  const { run } = params;
  const deps = params.deps ?? {};
  const maxPollAttempts = deps.maxPollAttempts ?? MAX_POLL_ATTEMPTS_DEFAULT;

  const publishExecutorOutput = isRecord(run.stageOutputs?.publish_executor) ? (run.stageOutputs.publish_executor as Record<string, unknown>) : undefined;
  const receipts = isRecord(publishExecutorOutput?.receipts) ? (publishExecutorOutput!.receipts as Record<string, unknown>) : undefined;
  const requestId = nonEmptyString(params.requestId) ? params.requestId.trim() : nonEmptyString(receipts?.requestId) ? (receipts!.requestId as string) : undefined;
  const key = releaseLedgerKey(run.runId, requestId);
  const existing = run.releaseLedger?.[key];

  // TERMINAL replay — the strong idempotency guarantee. Zero calls, ever again, for this key.
  if (existing && existing.status === "terminal") {
    return { kind: "completed", ok: true, output: existing.output as ReleaseExecutionOutput, warnings: ["release_execution_idempotent_replay"], ledgerKey: key, ledgerEntry: existing };
  }

  const publishCommitted = publishExecutorOutput?.publishCommitted === true;
  if (!existing && !publishCommitted) {
    const output = skippedOutput("nothing_published");
    const entry: ReleaseLedgerEntry = { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output };
    return { kind: "completed", ok: true, output, warnings: ["release_execution_skipped"], ledgerKey: key, ledgerEntry: entry };
  }

  const callTool = deps.callTool;
  if (!callTool) return { ok: false, code: "no_transport", error: "release_executor needs a callTool transport to call release_to_production/deploy_status; none was supplied." };

  const authority = resolvePublishAuthority(run);
  let releaseId: string | undefined = existing && existing.status === "pending" ? existing.releaseId : undefined;
  let deployedSha: string | undefined = existing && existing.status === "pending" ? existing.deployedSha : undefined;
  const priorAttempts = existing && existing.status === "pending" ? existing.attempts : 0;

  if (!existing) {
    // First dispatch for this key: call release_to_production EXACTLY ONCE. Every later branch in this
    // function (including every future dispatch) only ever polls deploy_status.
    let raw: Awaited<ReturnType<CallToolFn>>;
    try {
      raw = await callTool("release_to_production", {});
    } catch (error) {
      const output = blockedOutput({ reason: "release_call_failed", detail: errorText(error), recoverable: true });
      return { kind: "completed", ok: true, output, warnings: ["release_call_failed"], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output } };
    }
    const record = payloadOf(raw.ok ? raw.result : raw);
    if (record.released !== true) {
      // The call landed but the client declined — nothing was actually released, so this is SAFE to
      // retry (not ledgered as a release), matching publish.mjs's own "release_failed ... recoverable".
      const output = blockedOutput({ reason: "release_not_confirmed", detail: nonEmptyString(raw.error) ? raw.error : undefined, recoverable: true });
      return { kind: "completed", ok: true, output, warnings: ["release_not_confirmed"], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output } };
    }
    const deploy = isRecord(record.deploy) ? record.deploy : undefined;
    releaseId = nonEmptyString(deploy?.deployId) ? (deploy!.deployId as string) : nonEmptyString(record.releaseId) ? (record.releaseId as string) : undefined;
    deployedSha = nonEmptyString(record.targetCommit) ? (record.targetCommit as string) : nonEmptyString(record.commit) ? (record.commit as string) : undefined;
    // release_to_production sometimes confirms production immediately in its own response (small
    // sites, fast builds) — go straight to executed without a separate deploy_status round trip.
    if (record.productionConfirmed === true && (record.deployStatus === "ready" || record.status === "ready")) {
      const output: ReleaseExecutionOutput = {
        artifact: RELEASE_EXECUTION_ARTIFACT,
        summary: `Production release confirmed for this run's publish${releaseId ? ` (releaseId ${releaseId})` : ""}.`,
        status: "executed",
        ...(releaseId ? { releaseId } : {}),
        ...(deployedSha ? { deployedSha } : {}),
        approvalMatched: authority.authorized,
        publishAuthority: authorityReceipt(run, authority),
        verification: { deployStatus: "ready", productionConfirmed: true },
        result: record,
        blockers: [],
        notes: ["release_to_production confirmed production in its own response; no separate deploy_status poll was needed."]
      };
      return { kind: "completed", ok: true, output, warnings: ["release_executed"], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output } };
    }
    // Fall through to the poll below with attempts starting at 0.
  }

  // Poll deploy_status ONCE per dispatch — release_to_production is never reachable again below this
  // line for this key, whether this is the first dispatch (just released) or a later one (already
  // ledgered pending).
  const attempts = priorAttempts + 1;
  let pollRaw: Awaited<ReturnType<CallToolFn>>;
  try {
    pollRaw = await callTool("deploy_status", releaseId ? { release_id: releaseId } : {});
  } catch (error) {
    // release_to_production already succeeded — this is a VERIFICATION hiccup, not an unreleased
    // state. Ledger PENDING (never terminal) so the next dispatch polls again instead of re-releasing.
    const entry: ReleaseLedgerEntry = { status: "pending", requestId: requestId ?? "", performedAt: nowIso(), releaseId, deployedSha, attempts };
    return { kind: "pending", ok: true, warnings: [`deploy_status_poll_failed:${errorText(error)}`], ledgerKey: key, ledgerEntry: entry };
  }
  const pollRecord = payloadOf(pollRaw.ok ? pollRaw.result : pollRaw);
  const deployStatus = nonEmptyString(pollRecord.deployStatus) ? (pollRecord.deployStatus as string) : nonEmptyString(pollRecord.status) ? (pollRecord.status as string) : undefined;
  const productionConfirmed = pollRecord.productionConfirmed === true;

  if (deployStatus === "ready" && productionConfirmed) {
    const output: ReleaseExecutionOutput = {
      artifact: RELEASE_EXECUTION_ARTIFACT,
      summary: `Production release confirmed for this run's publish${releaseId ? ` (releaseId ${releaseId})` : ""} after ${attempts} verification poll(s).`,
      status: "executed",
      ...(releaseId ? { releaseId } : {}),
      ...(deployedSha ? { deployedSha } : {}),
      approvalMatched: authority.authorized,
      publishAuthority: authorityReceipt(run, authority),
      verification: { deployStatus, productionConfirmed },
      result: pollRecord,
      blockers: [],
      notes: [`Confirmed via deploy_status after ${attempts} poll(s) across dispatch(es) — release_to_production was called exactly once for this run.`]
    };
    return { kind: "completed", ok: true, output, warnings: ["release_executed"], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output } };
  }

  if (attempts >= maxPollAttempts) {
    const output = blockedOutput({
      reason: "deploy_not_confirmed_after_max_attempts",
      detail: `deployStatus=${deployStatus ?? "unknown"}, productionConfirmed=${productionConfirmed}, attempts=${attempts}`,
      recoverable: false,
      releaseId,
      deployedSha
    });
    return { kind: "completed", ok: true, output, warnings: ["deploy_not_confirmed"], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output } };
  }

  const entry: ReleaseLedgerEntry = { status: "pending", requestId: requestId ?? "", performedAt: nowIso(), releaseId, deployedSha, attempts };
  return { kind: "pending", ok: true, warnings: [`deploy_status_not_ready:${deployStatus ?? "unknown"}`], ledgerKey: key, ledgerEntry: entry };
}
