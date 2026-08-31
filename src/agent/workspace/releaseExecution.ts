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
// request window. Once release_to_production has been ACKNOWLEDGED for a key it is never called again
// for that key.
//
// SKIPS HONESTLY. Nothing published (publish_executor's own record does not carry
// publishCommitted:true) ⇒ status "skipped" with the reason recorded — never "executed", and never
// silently absent (publish.mjs's own release step: "asking production to rebuild for zero commits is
// noise that looks like activity").
//
// NEVER THROWS PAST ITS OWN TRY/CATCH, per publish.mjs:26-28: every failure mode is a typed result.
//
// W7 (2026-08-31, run_1788023523567_qdv9et, project dr-lurie) — ONE BUILD PER RELEASE ATTEMPT, EVEN
// ACROSS A 504. The site's release_to_production POSTs the production build hook and then waits for
// the deploy inside its own serverless window; when that window is exhausted the call comes back
// HTTP 504 AFTER the hook has already fired (deploy 6a952b5e started 07:21:02, ready 07:21:54). The
// pre-W7 code read that 504 as "nothing happened" (ledger none) and the next dispatch called
// release_to_production again, firing a SECOND production build (6a952b93 at 07:21:55). Three things
// close that:
//   1. Every release_to_production call carries `idempotency_key` — `release:<runId>:<publishCommitSha
//      |objectId>` (releaseIdempotencyKey), minted once per release attempt of this run, PERSISTED on
//      the ledger entry the moment it is first used, and reused verbatim on every later dispatch for
//      the same ledger key. The site's documented contract: the same key replays the ORIGINAL receipt
//      instead of re-POSTing the hook. A deliberate new release (workflow.reset_run re-publishes, so
//      publish_executor's commitSha changes) derives a different key on its own — no minting path is
//      invented here.
//   2. Every call carries `timeout_seconds` sized under this executor's own request window
//      (RELEASE_CALL_TIMEOUT_SECONDS), so where the site honours it the call returns a structured
//      `build_not_confirmed_live` receipt instead of a 504.
//   3. A 504 / transport failure is ledgered PENDING with `releaseUnconfirmed: true` and the key — never
//      "none". The next dispatch polls deploy_status by commit FIRST (W1.3) and, only if production is
//      not yet confirmed, re-calls release_to_production with the SAME key. A structured
//      `build_not_confirmed_live` / `build_ready_not_published` receipt (released:false, hook fired) is
//      ledgered pending WITHOUT releaseUnconfirmed — the release landed, only verification is open.

import type { CallToolFn } from "./publisher.js";
import { describeMcpErrorResult, isMcpErrorResult } from "../projects/clientToolResult.js";
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
// Bounded single-line rendering of an unrecognised deploy_status body, so a "unknown" verdict carries
// the evidence it was derived from instead of being undiagnosable (W1.3: 7 polls on
// run_1788011844073_ipwrnx all said `deploy_status_not_ready:unknown` while the page was live).
const RAW_RESPONSE_MAX = 500;
const truncatedRaw = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  const flattened = text.replace(/\s+/g, " ");
  return flattened.length > RAW_RESPONSE_MAX ? `${flattened.slice(0, RAW_RESPONSE_MAX)}…` : flattened;
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
  // W7 — the idempotency_key every release_to_production call for this run carried (auditable
  // alongside the ledger; the schema is additionalProperties:true). Absent on a skip (no call made).
  idempotencyKey?: string;
  blockers: string[];
  notes: string[];
};

// `${runId}:${requestId}` — see executionTypes.ts's WorkflowExecutionRecord.releaseLedger.
export const releaseLedgerKey = (runId: string, requestId: string | undefined): string => `${runId}:${requestId ?? "none"}`;

// W7 — the client-supplied `idempotency_key` release_to_production is called with. Stable per release
// ATTEMPT of this run: the identity is the commit publish_executor committed (publish_execution.v1's
// receipts.commitSha), else the client object id it published; either is fixed for the run once
// publish_executor has completed, and a reset that re-publishes yields a new commit and therefore a new
// key of its own accord. The LAST fallback (neither exists on the receipt) is the ledger key's own
// requestId component, still stable across every re-dispatch of this run.
export const releaseIdempotencyKey = (runId: string, identity: string): string => `release:${runId}:${identity}`;

// W7 — `timeout_seconds` for release_to_production. The dispatch that carries this call runs inside a
// request window every real driver caps at RUN_DRIVER_TIME_BUDGET_CEILING_MS (45s — mcp/workspace/
// tools.ts: the chat client's tool-call timeout and the MCP gateway both cut the connection there, and
// the continuation tick's own CONTINUATION_TICK_BUDGET_MS defaults to the same 45s). The in-call wait
// must leave room for the deploy_status poll that follows in the SAME dispatch plus a margin, so the
// site returns a structured `build_not_confirmed_live` receipt instead of the platform killing the call
// with a 504. Not imported from tools.ts: that module imports executor.ts, which imports this one, and
// a module-evaluation-time cycle is exactly the kind of thing a constant should not risk. The test
// suite pins the relation (releaseExecution.test.ts: timeout + margin <= ceiling).
export const RELEASE_CALL_TIMEOUT_MARGIN_SECONDS = 5;
export const RELEASE_CALL_TIMEOUT_SECONDS = 40;

// release_to_production statuses that mean the build hook DID fire and only verification is still open
// (the site's own contract text: "released:false with status build_not_confirmed_live means the build
// did not finish within the wait budget (re-check deploy_status)"; build_ready_not_published means the
// build is ready but Auto Publishing is locked). Neither is a decline: re-calling would at best replay.
const HOOK_FIRED_UNCONFIRMED_STATUSES = new Set(["build_not_confirmed_live", "build_ready_not_published"]);

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
  // `ledger` says whether this outcome may be written to the run's release ledger as TERMINAL.
  // "none" is the recoverable case: release_to_production was never confirmed to have landed, so the
  // next dispatch must be free to call it again. Writing those outcomes terminal is what made
  // run_1787930929962_njffct unrecoverable on 2026-08-29 — the release DID land (production served
  // the commit), the wait cap returned HTTP 504, the 504 was ledgered terminal, and every later
  // retry replayed the stored 504 verbatim and called nothing. The comment on blockedOutput's
  // recoverable note has always claimed "nothing here was ledgered"; now the code agrees with it.
  | { kind: "completed"; ok: true; output: ReleaseExecutionOutput; warnings: string[]; ledgerKey: string; ledgerEntry: ReleaseLedgerEntry; ledger: "terminal" | "pending" | "none" }
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

const blockedOutput = (params: { reason: string; detail?: string; recoverable: boolean; releaseId?: string; deployedSha?: string; idempotencyKey?: string; note?: string }): ReleaseExecutionOutput => ({
  artifact: RELEASE_EXECUTION_ARTIFACT,
  summary: `release_executor did not confirm go-live: ${params.reason}${params.detail ? ` — ${params.detail}` : ""}.`,
  status: "blocked",
  reason: params.reason,
  ...(params.releaseId ? { releaseId: params.releaseId } : {}),
  ...(params.deployedSha ? { deployedSha: params.deployedSha } : {}),
  ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  blockers: [`${params.reason}${params.detail ? `: ${params.detail}` : ""}`],
  notes: [
    params.note ??
      (params.recoverable
        ? "Recoverable: nothing here was ledgered as released, so a retry may call release_to_production again — with this run's same idempotency_key, so the site replays rather than re-fires if the hook did go out."
        : "release_to_production already succeeded for this run; a retry will only re-poll deploy_status, and will never call release_to_production again for this (runId, requestId).")
  ]
});

const nowIso = (): string => new Date().toISOString();


// W7 — how a release_to_production call came back, folded from the transport's verdict (`ok`), the
// HTTP status it carried, and the client's own body. Three answers, because they demand three
// different ledger postures:
//   "acknowledged"  the site answered with a receipt: released:true, or a hook-fired status
//                   (build_not_confirmed_live / build_ready_not_published). The hook went out.
//   "declined"      the site answered and said no (released:false with a real decline, an isError
//                   result, a 4xx, a permission hold): the hook did NOT go out. Safe to ledger none.
//   "unacknowledged" no usable answer: the call threw, or came back ok:false without a 4xx (an HTTP
//                   504/502, a reset connection, an abort). The hook MAY have gone out.
type ReleaseCallVerdict =
  | { verdict: "acknowledged"; record: Record<string, unknown>; replayed: boolean }
  | { verdict: "declined"; detail?: string }
  | { verdict: "unacknowledged"; detail: string };

const callReleaseToProduction = async (callTool: CallToolFn, args: Record<string, unknown>): Promise<ReleaseCallVerdict> => {
  let raw: Awaited<ReturnType<CallToolFn>>;
  try {
    raw = await callTool("release_to_production", args);
  } catch (error) {
    return { verdict: "unacknowledged", detail: errorText(error) };
  }
  if (!raw.ok) {
    const detail = nonEmptyString(raw.error) ? raw.error : "release_to_production call was rejected";
    // A permission hold or a 4xx is the site (or this plane) refusing to run the call at all — nothing
    // fired. Everything else that is not ok — 5xx, or no status at all (a thrown-then-described network
    // error) — is a call whose fate is unknown.
    const status = typeof raw.httpStatus === "number" ? raw.httpStatus : undefined;
    const refused = raw.requiresApproval === true || raw.permission === "blocked" || (status !== undefined && status >= 400 && status < 500);
    return refused ? { verdict: "declined", detail } : { verdict: "unacknowledged", detail };
  }
  if (isMcpErrorResult(raw.result)) return { verdict: "declined", detail: describeMcpErrorResult(raw.result as Record<string, unknown>) };
  const record = payloadOf(raw.result);
  const status = nonEmptyString(record.status) ? (record.status as string) : undefined;
  if (record.released === true || (status !== undefined && HOOK_FIRED_UNCONFIRMED_STATUSES.has(status))) {
    const replayed = nonEmptyString(record.replayed_from_idempotency_key) || record.idempotent_replay === true;
    return { verdict: "acknowledged", record, replayed };
  }
  const detail = nonEmptyString(record.error) ? (record.error as string) : nonEmptyString(record.message) ? (record.message as string) : status;
  return { verdict: "declined", detail };
};

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
  // The commit publish_executor actually committed — publish_execution.v1's receipts.commitSha
  // (publishExecution.ts reads it off the client's own publish result via findCommitSha). This is the
  // sha deploy_status's schema wants under `commit`; it is the fallback identity for the poll whenever
  // release_to_production did not name a deploy id or target commit of its own. Never invented here.
  const receiptCommitSha = nonEmptyString(receipts?.commitSha) ? (receipts!.commitSha as string).trim() : undefined;
  const receiptObjectId = nonEmptyString(receipts?.objectId) ? (receipts!.objectId as string).trim() : undefined;
  const key = releaseLedgerKey(run.runId, requestId);
  const existing = run.releaseLedger?.[key];

  // TERMINAL replay — the strong idempotency guarantee. Zero calls, ever again, for this key.
  if (existing && existing.status === "terminal") {
    return { kind: "completed", ok: true, output: existing.output as ReleaseExecutionOutput, warnings: ["release_execution_idempotent_replay"], ledgerKey: key, ledgerEntry: existing, ledger: "terminal" };
  }

  const publishCommitted = publishExecutorOutput?.publishCommitted === true;
  if (!existing && !publishCommitted) {
    const output = skippedOutput("nothing_published");
    const entry: ReleaseLedgerEntry = { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output };
    return { kind: "completed", ok: true, output, warnings: ["release_execution_skipped"], ledgerKey: key, ledgerEntry: entry, ledger: "terminal" };
  }

  const callTool = deps.callTool;
  if (!callTool) return { ok: false, code: "no_transport", error: "release_executor needs a callTool transport to call release_to_production/deploy_status; none was supplied." };

  const authority = resolvePublishAuthority(run);
  const pending = existing && existing.status === "pending" ? existing : undefined;
  // W7 — the key is minted ONCE per release attempt and then read back off the ledger, never re-derived
  // on a dispatch that already has one: a receipt field that appears late (commitSha resolved on a
  // later read) must not silently change the key a build hook was already fired under.
  const idempotencyKey = pending && nonEmptyString(pending.idempotencyKey) ? pending.idempotencyKey : releaseIdempotencyKey(run.runId, receiptCommitSha ?? receiptObjectId ?? (requestId ?? "none"));
  const releaseArgs: Record<string, unknown> = { idempotency_key: idempotencyKey, timeout_seconds: RELEASE_CALL_TIMEOUT_SECONDS };
  const pendingEntry = (fields: { releaseId?: string; deployedSha?: string; attempts: number; releaseUnconfirmed?: true }): ReleaseLedgerEntry => ({
    status: "pending",
    requestId: requestId ?? "",
    performedAt: nowIso(),
    releaseId: fields.releaseId,
    deployedSha: fields.deployedSha,
    attempts: fields.attempts,
    idempotencyKey,
    ...(fields.releaseUnconfirmed ? { releaseUnconfirmed: true } : {})
  });
  const executedOutput = (fields: { releaseId?: string; deployedSha?: string; verification: { deployStatus: string; productionConfirmed: boolean }; result: Record<string, unknown>; summary: string; notes: string[] }): ReleaseExecutionOutput => ({
    artifact: RELEASE_EXECUTION_ARTIFACT,
    summary: fields.summary,
    status: "executed",
    ...(fields.releaseId ? { releaseId: fields.releaseId } : {}),
    ...(fields.deployedSha ? { deployedSha: fields.deployedSha } : {}),
    approvalMatched: authority.authorized,
    publishAuthority: authorityReceipt(run, authority),
    verification: fields.verification,
    result: fields.result,
    idempotencyKey,
    blockers: [],
    notes: fields.notes
  });
  const terminal = (output: ReleaseExecutionOutput, warning: string): ReleaseExecutorOutcome => ({
    kind: "completed", ok: true, output, warnings: [warning], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output }, ledger: "terminal"
  });

  let releaseId: string | undefined = pending?.releaseId;
  // On a re-poll dispatch an older pending entry may predate commit tracking — fall back to the
  // publish receipt's commit so the poll still names the release instead of degrading to a bare call.
  let deployedSha: string | undefined = pending ? (nonEmptyString(pending.deployedSha) ? pending.deployedSha : receiptCommitSha) : receiptCommitSha;
  let priorAttempts = pending?.attempts ?? 0;
  // release_to_production is reachable on exactly two shapes of dispatch: the FIRST for this key, and a
  // re-dispatch after an UNACKNOWLEDGED call (W7). A pending entry without releaseUnconfirmed means the
  // site acknowledged the release — it is never called again for that key.
  const releaseReachable = !existing || pending?.releaseUnconfirmed === true;
  const releaseNotes: string[] = [];

  if (releaseReachable && pending && deployedSha) {
    // W7 — re-dispatch after an unacknowledged call: the hook may already have fired, so ask production
    // about THE commit first (W1.3 polls by commit). Confirmed live ⇒ executed, and release_to_production
    // is never touched again. Anything else (not ready, rejected, threw) falls through to the keyed
    // re-call below, which replays the original receipt if the hook did go out.
    const pre = await pollDeployStatus(callTool, { commit: deployedSha });
    if (pre.kind === "ready") {
      const attempts = priorAttempts + 1;
      return terminal(
        executedOutput({
          releaseId: nonEmptyString(pre.record.deployId) ? (pre.record.deployId as string) : releaseId,
          deployedSha,
          verification: { deployStatus: pre.deployStatus, productionConfirmed: true },
          result: pre.record,
          summary: `Production release confirmed for this run's publish after ${attempts} verification poll(s); the earlier release_to_production call was never acknowledged but its build is live.`,
          notes: [`The first release_to_production call for this run was not acknowledged (${describeUnacknowledged(pending)}); deploy_status confirmed commit ${deployedSha} live before any second call was made, so release_to_production was NOT called again (idempotency_key ${idempotencyKey}).`]
        }),
        "release_executed"
      );
    }
  }

  if (releaseReachable) {
    const call = await callReleaseToProduction(callTool, releaseArgs);
    if (call.verdict === "unacknowledged") {
      // W7 — the 504 case. The hook MAY have fired: ledger PENDING with the key, never "none", so the
      // next dispatch polls by commit and re-calls only with this SAME key. Bounded by maxPollAttempts
      // like every other pending sequence; at the bound, hand it to the operator as a blocked (but
      // still pending-ledgered, so a workflow_retry_node can continue it) outcome.
      const attempts = priorAttempts + 1;
      if (attempts >= maxPollAttempts) {
        const output = blockedOutput({
          reason: "release_not_acknowledged_after_max_attempts",
          detail: `${call.detail}; attempts=${attempts}`,
          recoverable: true,
          deployedSha,
          idempotencyKey,
          note: `release_to_production was called ${attempts} time(s) with idempotency_key ${idempotencyKey} and never acknowledged; every call carried the SAME key, so at most one build fired. A retry re-polls deploy_status by commit and re-calls only with that same key.`
        });
        return { kind: "completed", ok: true, output, warnings: ["release_not_acknowledged"], ledgerKey: key, ledgerEntry: pendingEntry({ deployedSha, attempts: 0, releaseUnconfirmed: true }), ledger: "pending" };
      }
      return { kind: "pending", ok: true, warnings: [`release_call_failed:${call.detail}`], ledgerKey: key, ledgerEntry: pendingEntry({ deployedSha, attempts, releaseUnconfirmed: true }) };
    }
    if (call.verdict === "declined") {
      // The call landed and the client declined — nothing was actually released, so this is SAFE to
      // retry (not ledgered as a release), matching publish.mjs's own "release_failed ... recoverable".
      const output = blockedOutput({ reason: "release_not_confirmed", detail: call.detail, recoverable: true, idempotencyKey });
      return { kind: "completed", ok: true, output, warnings: ["release_not_confirmed"], ledgerKey: key, ledgerEntry: { status: "terminal", requestId: requestId ?? "", performedAt: nowIso(), output }, ledger: "none" };
    }
    const record = call.record;
    if (call.replayed) releaseNotes.push(`release_to_production replayed the original receipt for idempotency_key ${idempotencyKey} — no second build hook was fired.`);
    if (pending) releaseNotes.push(`The first release_to_production call for this run was not acknowledged (${describeUnacknowledged(pending)}); the re-call carried the SAME idempotency_key ${idempotencyKey}.`);
    const deploy = isRecord(record.deploy) ? record.deploy : undefined;
    releaseId = nonEmptyString(deploy?.deployId) ? (deploy!.deployId as string) : nonEmptyString(record.releaseId) ? (record.releaseId as string) : releaseId;
    // Prefer the sha release_to_production itself named; fall back to the publish receipt's
    // commitSha (publish_execution.v1) so the deploy_status poll below can always ask about THE
    // commit this run published rather than calling bare.
    deployedSha = nonEmptyString(record.targetCommit) ? (record.targetCommit as string) : nonEmptyString(record.commit) ? (record.commit as string) : deployedSha;
    // The release is now ACKNOWLEDGED: verification attempts start over from here.
    priorAttempts = 0;
    // release_to_production sometimes confirms production immediately in its own response (small
    // sites, fast builds) — go straight to executed without a separate deploy_status round trip.
    if (record.productionConfirmed === true && (record.deployStatus === "ready" || record.status === "ready")) {
      return terminal(
        executedOutput({
          releaseId,
          deployedSha,
          verification: { deployStatus: "ready", productionConfirmed: true },
          result: record,
          summary: `Production release confirmed for this run's publish${releaseId ? ` (releaseId ${releaseId})` : ""}.`,
          notes: ["release_to_production confirmed production in its own response; no separate deploy_status poll was needed.", ...releaseNotes]
        }),
        "release_executed"
      );
    }
    // Fall through to the poll below with attempts starting at 0.
  }

  // Poll deploy_status ONCE per dispatch — release_to_production is never reachable again below this
  // line for this key, whether this is the first dispatch (just released) or a later one (already
  // ledgered pending).
  const attempts = priorAttempts + 1;
  // deploy_status's own schema declares only `commit`/`deployId` (additionalProperties:false) — a
  // `release_id` key is rejected outright, which used to make every poll read as "not ready" instead
  // of surfacing the reject. Prefer deployId (what release_to_production actually returned); fall back
  // to the commit when no deploy id was reported — the release response's own sha first, else the
  // publish receipt's commitSha (folded into deployedSha above). A bare {} only when NO identity
  // exists anywhere (both deploy_status fields are optional, so a bare call is schema-valid).
  const pollArgs: Record<string, unknown> = releaseId ? { deployId: releaseId } : deployedSha ? { commit: deployedSha } : {};
  const poll = await pollDeployStatus(callTool, pollArgs);
  if (poll.kind === "failed") {
    // release_to_production already succeeded — this is a VERIFICATION hiccup, not an unreleased
    // state. Ledger PENDING (never terminal) so the next dispatch polls again instead of re-releasing.
    return { kind: "pending", ok: true, warnings: [poll.warning], ledgerKey: key, ledgerEntry: pendingEntry({ releaseId, deployedSha, attempts }) };
  }
  if (poll.kind === "ready") {
    return terminal(
      executedOutput({
        releaseId,
        deployedSha,
        verification: { deployStatus: poll.deployStatus, productionConfirmed: true },
        result: poll.record,
        summary: `Production release confirmed for this run's publish${releaseId ? ` (releaseId ${releaseId})` : ""} after ${attempts} verification poll(s).`,
        notes: [`Confirmed via deploy_status after ${attempts} poll(s) across dispatch(es) — release_to_production fired at most one build for this run (idempotency_key ${idempotencyKey}).`, ...releaseNotes]
      }),
      "release_executed"
    );
  }

  if (attempts >= maxPollAttempts) {
    const output = blockedOutput({
      reason: "deploy_not_confirmed_after_max_attempts",
      detail: `deployStatus=${poll.deployStatus ?? "unknown"}, productionConfirmed=${poll.productionConfirmed}, attempts=${attempts}`,
      recoverable: false,
      releaseId,
      deployedSha,
      idempotencyKey
    });
    // The release LANDED — only verification gave up. Ledger PENDING, not terminal: release_to_production
    // stays unreachable for this key (the `existing.status === "pending"` branch above skips it), but a
    // later workflow_retry_node can still re-poll deploy_status and flip this to "executed". A build that
    // finishes one minute after the last poll must not leave the run permanently reporting "not live".
    return { kind: "completed", ok: true, output, warnings: ["deploy_not_confirmed"], ledgerKey: key, ledgerEntry: pendingEntry({ releaseId, deployedSha, attempts: 0 }), ledger: "pending" };
  }

  // A genuinely unknown verdict (no deployStatus AND no error anywhere in the body — the rejection
  // branches above caught everything error-shaped) carries the raw response so it is diagnosable
  // instead of a bare "unknown" that names nothing.
  return { kind: "pending", ok: true, warnings: [poll.warning], ledgerKey: key, ledgerEntry: pendingEntry({ releaseId, deployedSha, attempts }) };
}

const describeUnacknowledged = (pending: Extract<ReleaseLedgerEntry, { status: "pending" }>): string =>
  `${pending.attempts} unacknowledged attempt(s) ledgered at ${pending.performedAt}`;

// One deploy_status round trip, folded into the three verdicts the caller acts on. "failed" covers a
// thrown transport, a rejected call (ok:false), an isError MCP result, and an error-shaped body without
// the flag — every one of those is evidence about the CALL, never about the deploy (W1.3).
type DeployStatusVerdict =
  | { kind: "ready"; deployStatus: string; record: Record<string, unknown> }
  | { kind: "not_ready"; deployStatus?: string; productionConfirmed: boolean; warning: string }
  | { kind: "failed"; warning: string };

const pollDeployStatus = async (callTool: CallToolFn, pollArgs: Record<string, unknown>): Promise<DeployStatusVerdict> => {
  let pollRaw: Awaited<ReturnType<CallToolFn>>;
  try {
    pollRaw = await callTool("deploy_status", pollArgs);
  } catch (error) {
    return { kind: "failed", warning: `deploy_status_poll_failed:${errorText(error)}` };
  }
  if (!pollRaw.ok) {
    // The call itself was rejected (e.g. a request shape the site's schema does not accept, or an
    // auth failure) — that is a verification failure, never evidence the deploy isn't ready. Report it
    // under the same poll-failed warning a thrown transport error gets, not "not ready".
    return { kind: "failed", warning: `deploy_status_poll_failed:${nonEmptyString(pollRaw.error) ? pollRaw.error : "deploy_status call was rejected"}` };
  }
  // A client REFUSAL rides home as ok:true (the transport succeeded; the MCP result carries
  // isError) — see publisher.ts's own note on `ok` being the TRANSPORT's verdict. W1.3
  // (run_1788011844073_ipwrnx): the site's deploy_status schema (additionalProperties:false) rejected
  // every poll and this module read the refusal as "not ready" — 7 polls of
  // `deploy_status_not_ready:unknown` while the page was live. A rejected CALL is evidence about the
  // call's shape, never about the deploy: report it as its own retryable verification failure and
  // ledger PENDING so the next dispatch re-polls (release_to_production stays unreachable).
  if (isMcpErrorResult(pollRaw.result)) {
    return { kind: "failed", warning: `deploy_status_call_rejected:${describeMcpErrorResult(pollRaw.result as Record<string, unknown>)}` };
  }
  const pollRecord = payloadOf(pollRaw.result);
  const deployStatus = nonEmptyString(pollRecord.deployStatus) ? (pollRecord.deployStatus as string) : nonEmptyString(pollRecord.status) ? (pollRecord.status as string) : undefined;
  const productionConfirmed = pollRecord.productionConfirmed === true;
  // Error-shaped without the isError flag: no deployStatus at all but the body DOES carry an error
  // message. Same verdict as the isError case above — the call was rejected, the deploy's state is
  // simply unknown, and "unknown" must never be spelled "not ready".
  if (!deployStatus) {
    const rejectionMessage = nonEmptyString(pollRecord.error) ? (pollRecord.error as string) : nonEmptyString(pollRecord.message) ? (pollRecord.message as string) : undefined;
    if (rejectionMessage) return { kind: "failed", warning: `deploy_status_call_rejected:${truncatedRaw(rejectionMessage)}` };
  }
  if (deployStatus === "ready" && productionConfirmed) return { kind: "ready", deployStatus, record: pollRecord };
  const warning = deployStatus ? `deploy_status_not_ready:${deployStatus}` : `deploy_status_not_ready:unknown raw=${truncatedRaw(pollRaw.result)}`;
  return { kind: "not_ready", deployStatus, productionConfirmed, warning };
};
