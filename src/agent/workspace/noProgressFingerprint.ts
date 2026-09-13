// R2 — THE NO-PROGRESS FINGERPRINT, and why it is not just "retry count".
//
// THE DEFECT THIS CLOSES. Before this file existed, a failing node could be retried without limit
// (workflow.retry_node has no bound of its own — see executor.ts's retryNode) and nothing recorded
// whether a retry was actually justified. The orchestrator's own classified backoff
// (nodeRetryPolicy.ts, W1 T1.1) already stops AUTOMATIC retries of a transient runner error after
// MAX_ORCHESTRATOR_RETRIES — that policy is untouched and this module never re-implements it. The gap
// is what happens AFTER that budget is exhausted and the node goes terminally "failed": a human, an
// agent holding workflow.retry_node (AGENTS.md notes any full bearer or a tenant's scoped chat bearer
// can call it — K-M9), or a background driver re-entering the same run can call retryNode again and
// again on unchanged inputs, hoping a different outcome falls out this time. Time passing, a
// differently-phrased tool call, or a fresh model turn are not progress; nothing before this task
// could tell that attempt N+1 was identical to attempt N in every way that matters.
//
// THE RULE (programme spec): a retry is legitimate only after a classified transient condition
// (nodeRetryPolicy's own job, untouched) OR a relevant state revision. This module gives "a relevant
// state revision" a precise, checkable meaning: the INPUT this node would run with changed, the
// NODE'S OWN DEFINITION (prompt/schema/tools, via WorkspaceNode.updatedAt) was revised, or the
// TENANT'S CAPABILITY STATE (R1's deriveTenantCapabilityAvailability — composed here, not
// reimplemented) changed. If none of those three changed since the node's last terminal failure, and
// the failure normalizes to the same shape, dispatching again cannot produce a different result for
// any reason this engine can name — so executor.ts refuses to dispatch (a $0 refusal, the same
// discipline preflightDriverAuth already holds itself to) and returns a structured stop instead.
//
// WHAT "FINGERPRINT" MEANS HERE, PRECISELY. Two hashes, not one:
//   - `conditionsHash` — workflow+node identity, the node definition's own revision marker, the
//     dispatch input, and the tenant's derived capability state. This is "this exact attempt, under
//     these exact conditions" BEFORE anything is known about how it turns out — computable, and
//     compared, BEFORE a dispatch (so a repeat can be refused at $0, not merely noticed after paying
//     for it again).
//   - `fingerprint` — conditionsHash plus the NORMALIZED failure (see normalizeFailureText below).
//     This is the full identity the spec calls "this exact attempt, under these exact conditions" —
//     recorded once a terminal failure is known, for the run's own audit trail (NoProgressLedgerEntry
//     below) and for Piece 2's durable capability-gap records to key off of.
// The PRE-DISPATCH GATE compares prospective conditionsHash against the stored one from the node's
// last terminal failure — not the full fingerprint, because the new failure text is not yet known.
// This is a deliberate, DOCUMENTED approximation: conditions being unchanged is treated as sufficient
// reason to expect the identical failure, which is exactly the inference "no repeat of an identical
// failed attempt with unchanged fingerprint" asks for. It is NOT a guarantee that two dispatches with
// identical conditions always fail identically (a live provider incident clearing between attempts is
// exactly what nodeRetryPolicy's OWN backoff exists to catch, and that happens first, before a node
// ever reaches terminal status) — see this file's own "WHAT IS NOT COVERED" note at the bottom.
//
// WHAT THIS MODULE DOES NOT DO. It is pure, like capabilityReadiness.ts and operationPreflight.ts
// hold themselves to: no repository, no network client, no clock read (the caller passes `at`). It
// never derives capability availability itself — the caller (executor.ts) loads
// TenantCapabilityFacts via capabilityFactsLoader.ts and derives availability via
// capabilityReadiness.ts's own deriveTenantCapabilityAvailability, then hands the RESULT in here. This
// module only turns already-computed facts into a stable, comparable hash — never a second capability
// vocabulary, never a second derivation rule.
import type { CapabilityAvailability } from "../operations/capabilityReadiness.js";
import { stableStringify, shortHash } from "../shared/stableHash.js";

// ---------------------------------------------------------------------------------------------
// Normalization — DETERMINISTIC and DOCUMENTED, per the task's own requirement. Every pattern below
// exists because it is a KNOWN source of incidental difference between two attempts that changed
// nothing real: a fresh timestamp, a newly-minted run/request id, a random correlation id, or
// whitespace a differently-phrased model turn introduces. Nothing else is normalized — a genuinely
// different error CODE or a genuinely different substantive message is exactly what this exists to
// keep distinguishable.
// ---------------------------------------------------------------------------------------------
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const RUN_ID_PATTERN = /\brun_[a-zA-Z0-9_]+/g;
const REQUEST_ID_PATTERN = /\breq_[a-zA-Z0-9_]+/g;
const BLOCKAGE_ID_PATTERN = /\bblk_[0-9a-f]+/gi;
// A long hex/base36-ish run of characters that is not itself one of the patterns above — the
// catch-all for a provider's own opaque request id (`x-request-id: 7f3a...`), which varies every call
// and carries no information about WHY a call failed.
const LONG_OPAQUE_ID_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const WHITESPACE_PATTERN = /\s+/g;
// Bounded so one pathologically long provider error message cannot make the normalized string (and
// therefore the hash input) unbounded — matches the 1_000-char bound errorHistory entries already use
// (nodeAttemptHistory.ts via executor.ts's boundText).
const MAX_NORMALIZED_FAILURE_LENGTH = 500;

/**
 * Normalize a failure code+message into a stable string: same underlying failure in, same string
 * out, regardless of when it happened, which run it happened in, or which opaque id a provider
 * attached to that one call. Documented rule, in application order:
 *   1. join as `${code}|${message}`   (message may be empty/undefined)
 *   2. replace ISO-8601 timestamps, UUIDs, `run_*`/`req_*`/`blk_*` ids, and any other bare run of
 *      16+ hex characters with a fixed placeholder token
 *   3. lowercase
 *   4. collapse all whitespace runs to a single space, trim
 *   5. truncate to MAX_NORMALIZED_FAILURE_LENGTH characters
 */
export function normalizeFailureText(code: string, message: string | undefined): string {
  const raw = `${code}|${message ?? ""}`;
  const scrubbed = raw
    .replace(ISO_TIMESTAMP_PATTERN, "<ts>")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(RUN_ID_PATTERN, "<run_id>")
    .replace(REQUEST_ID_PATTERN, "<req_id>")
    .replace(BLOCKAGE_ID_PATTERN, "<blockage_id>")
    .replace(LONG_OPAQUE_ID_PATTERN, "<opaque_id>")
    .toLowerCase()
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
  return scrubbed.length > MAX_NORMALIZED_FAILURE_LENGTH ? scrubbed.slice(0, MAX_NORMALIZED_FAILURE_LENGTH) : scrubbed;
}

// stableStringify/shortHash now live in shared/stableHash.ts (R2 Piece 2 extracted them so
// capabilityGapTypes.ts's "normalized requested outcome" hashes the identical way — see that
// module's own header). Re-imported above, not redefined here.

// The sentinel used when no trusted capability facts were derivable for this run's tenant (the same
// "conservative — nothing assumed" posture operationPreflight.ts takes when capabilitySource returns
// nothing). Distinct from any real hash (hex-only) so it can never collide with one.
export const CAPABILITY_STATE_UNKNOWN = "capability_state_unknown";

// The facts a fingerprint is computed from, all ALREADY KNOWN to the caller — this module fetches
// nothing. `capabilityAvailability` is exactly what capabilityReadiness.ts's own
// deriveTenantCapabilityAvailability returns (or undefined — see CAPABILITY_STATE_UNKNOWN above).
export type AttemptConditions = {
  workflowId: string;
  nodeId: string;
  // WorkspaceNode.updatedAt for the definition THIS dispatch resolved and ran — a bumped value means
  // an operator revised the node's prompt/schema/tools/config since the last attempt, which is
  // exactly the "relevant state revision" the programme rule names as a second legitimate reason to
  // retry (the first being nodeRetryPolicy's own transient classification, untouched by this module).
  nodeDefinitionRevision: string;
  // The resolved dispatch input for THIS attempt (NodeExecutionState.input, after every prefetch/
  // dependency merge executor.ts performs — i.e. the actual value about to be handed to the runner).
  input: unknown;
  capabilityAvailability: Record<string, CapabilityAvailability> | undefined;
};

export type AttemptFingerprintComponents = {
  workflowNode: string;
  nodeDefinitionRevision: string;
  inputRevision: string;
  capabilityStateRevision: string;
};

export type ConditionsFingerprint = { conditionsHash: string; components: AttemptFingerprintComponents };

/** The "before anything is known about the outcome" half — see module header. */
export function computeAttemptConditionsHash(conditions: AttemptConditions): ConditionsFingerprint {
  const components: AttemptFingerprintComponents = {
    workflowNode: `${conditions.workflowId}::${conditions.nodeId}`,
    nodeDefinitionRevision: conditions.nodeDefinitionRevision || "unknown",
    inputRevision: shortHash(stableStringify(conditions.input ?? null)),
    capabilityStateRevision: conditions.capabilityAvailability ? shortHash(stableStringify(conditions.capabilityAvailability)) : CAPABILITY_STATE_UNKNOWN
  };
  const conditionsHash = shortHash([components.workflowNode, components.nodeDefinitionRevision, components.inputRevision, components.capabilityStateRevision].join("|"));
  return { conditionsHash, components };
}

export type AttemptFingerprint = ConditionsFingerprint & { fingerprint: string; normalizedFailure: string };

/** The full "this exact attempt, under these exact conditions, with this outcome" identity. */
export function computeAttemptFingerprint(conditions: AttemptConditions, failureCode: string, failureMessage: string | undefined): AttemptFingerprint {
  const { conditionsHash, components } = computeAttemptConditionsHash(conditions);
  const normalizedFailure = normalizeFailureText(failureCode, failureMessage);
  const fingerprint = shortHash(`${conditionsHash}|${normalizedFailure}`);
  return { conditionsHash, components, fingerprint, normalizedFailure };
}

// The durable ledger entry — see executionTypes.ts's NodeExecutionState.noProgress for the field this
// lives in and why retryNode/scheduleNodeRetry must never clear it.
export type NoProgressLedgerEntry = {
  fingerprint: string;
  conditionsHash: string;
  components: AttemptFingerprintComponents;
  code: string;
  normalizedFailure: string;
  // Consecutive TERMINAL failures sharing this exact conditionsHash. Reset to 1 the moment conditions
  // change (new input, revised node, changed capability state), even if the new attempt still fails —
  // a changed-conditions failure is new evidence, not a repeat, however similar its message reads.
  occurrences: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  // Set only when a caller's RunAdvanceOptions.retryJustification bypassed checkNoProgress's refusal
  // for the dispatch that produced THIS entry. See executor.ts's RunAdvanceOptions doc comment — an
  // unverified, audited escape hatch, never proof anything actually changed.
  lastOverrideJustification?: string;
};

/**
 * Called once a node's failure has gone TERMINAL (nodeRetryPolicy.decideNodeRetry returned
 * retry:false — the classified backoff budget is exhausted, or the code was never retryable). Builds
 * or extends the ledger entry: `occurrences` climbs only when conditions truly repeated, and resets
 * to 1 otherwise so the counter always answers "how many times in a row has this exact wall been hit
 * unchanged", never "how many times has this node ever failed".
 */
export function recordTerminalFailure(
  existing: NoProgressLedgerEntry | undefined,
  conditions: AttemptConditions,
  failureCode: string,
  failureMessage: string | undefined,
  at: string,
  overrideJustification?: string
): NoProgressLedgerEntry {
  const { conditionsHash, components, fingerprint, normalizedFailure } = computeAttemptFingerprint(conditions, failureCode, failureMessage);
  const repeated = existing?.conditionsHash === conditionsHash;
  return {
    fingerprint,
    conditionsHash,
    components,
    code: failureCode,
    normalizedFailure,
    occurrences: repeated ? existing!.occurrences + 1 : 1,
    firstAttemptAt: repeated ? existing!.firstAttemptAt : at,
    lastAttemptAt: at,
    ...(overrideJustification ? { lastOverrideJustification: overrideJustification } : {})
  };
}

export type NoProgressCheck =
  | { blocked: false }
  | { blocked: true; entry: NoProgressLedgerEntry; prospective: ConditionsFingerprint };

/**
 * THE PRE-DISPATCH GATE. `existing` is the node's stored ledger entry from its LAST TERMINAL failure
 * (undefined if it has never failed terminally, or if it has since made genuine progress and the
 * ledger was superseded). Returns blocked:true only when conditions are byte-for-byte unchanged from
 * that failure's own conditions — see module header for why comparing conditions (not the full
 * fingerprint, which also needs a not-yet-known new failure) is the correct pre-dispatch check.
 */
export function checkNoProgress(existing: NoProgressLedgerEntry | undefined, conditions: AttemptConditions): NoProgressCheck {
  if (!existing) return { blocked: false };
  const prospective = computeAttemptConditionsHash(conditions);
  if (prospective.conditionsHash !== existing.conditionsHash) return { blocked: false };
  return { blocked: true, entry: existing, prospective };
}

// ---------------------------------------------------------------------------------------------
// WHAT IS NOT COVERED, stated rather than hidden (matching this codebase's own comment standard —
// AGENTS.md "explicit about what is NOT guaranteed"):
//   - Tool-call ARGUMENT equality is not fingerprinted independently of the node's whole input. A
//     runner records only NodeToolCallRecord{toolId, status, ...} on NodeExecutionState — never the
//     full arguments a model sent a tool — so this module cannot fingerprint "the same tool call with
//     the same arguments" any more finely than "the same node dispatch with the same resolved input",
//     which is what conditionsHash.inputRevision already captures. A node that calls three tools and
//     only the second one's arguments changed between attempts is treated as a changed attempt (input
//     differs), which is the conservative direction — see AttemptConditions's own doc comment.
//   - An external fix invisible to this engine (an operator rotating a client's own API credential
//     outside CMS-Agent, a client's server recovering) is NOT reflected in capabilityAvailability
//     (R1's derivation reads only the TENANT'S OWN project record — tool policy and object dialect —
//     never a live probe of the remote server) or in any other fingerprint component. Such a fix does
//     not change the fingerprint, so a retry immediately after it is still refused by checkNoProgress.
//     This is a deliberate, DOCUMENTED and BOUNDED limitation, not an oversight: the caller
//     (executor.ts's retryNode-driven dispatch) accepts an explicit, audited justification
//     (RunAdvanceOptions.retryJustification) as the one sanctioned override — see executor.ts's own
//     comment at the call site for exactly what recording a justification does and does not verify.
// ---------------------------------------------------------------------------------------------
