// R2 Piece 2 — the durable capability-gap record. ONE record per (tenant, normalized requested
// outcome, missing capability) — never one per attempt. Composes with R1 (capabilityVocabulary.ts /
// capabilityReadiness.ts) and with operationPreflight.ts's own OperationCapabilityGap shape (the
// per-call, non-durable finding this module turns into a durable, deduplicated record); it does not
// invent a second notion of "capability" or "gap".
//
// WHAT "NORMALIZED REQUESTED OUTCOME" MEANS HERE. The obvious candidate — hash the operation's full
// input — was rejected: two callers asking for the SAME kind of outcome (e.g. "render this article as
// a PDF") almost always differ in incidental fields (which article, its title, its body), and hashing
// the whole input would mint a new record per attempt, exactly the defect Piece 2 exists to close, and
// would risk hashing PRIVATE CONTENT into a record's identity even though the hash itself reveals
// nothing (see the redaction note below for why that still matters). "Requested outcome" is therefore
// modeled at the OPERATION level: `${operationId}@${version}` — every attempt to run a given
// registered operation, for a given tenant, that is missing the same capability, is genuinely asking
// for the SAME outcome and collapses into the SAME record. This is coarser than a per-input hash,
// deliberately: a finer grain would defeat deduplication for the common case (many real requests,
// same missing capability) to preserve a distinction (which request) this record never needed to make
// — the individual attempts are still named, boundedly, in `sourceRefs`.
//
// PRIVACY. `evidence` MUST be passed through redactSensitiveKeys (observability/redaction.ts) by the
// caller before it reaches recordOccurrence — this module does not redact on its own (it holds no
// opinion about I/O), but every writer in this task does (see capabilityGapRecorder.ts). Nothing here
// ever stores an operation's raw input, only: the operationId/version, the capability id, the reason
// R1 already computed, already-redacted evidence, and a short caller-supplied ref string per
// occurrence (a runId or a short correlation string — never full request payloads).
import type { OperationCapabilityGap } from "./operationTypes.js";
import { shortHash } from "../shared/stableHash.js";

// Mirrors OperationCapabilityGap's own reason union MINUS "unavailable": a disabled/currently-down
// project is an OPERATIONAL state (re-enable it, nothing to configure), not a genuine capability GAP
// — recording a durable "gap" for it would be wrong on its own terms (capabilityGapRemedy's own text
// for "unavailable" is "re-enable the project", never "build/configure something"), and would also
// mean a routine maintenance window mints (and keeps growing) a durable record for every disabled
// tenant. Piece 2 only durably records the two reasons that actually describe something missing.
export type GenuineCapabilityGapReason = Extract<OperationCapabilityGap["reason"], "not_configured" | "not_supported">;
export const GENUINE_CAPABILITY_GAP_REASONS: readonly GenuineCapabilityGapReason[] = ["not_configured", "not_supported"];
export const isGenuineCapabilityGapReason = (reason: OperationCapabilityGap["reason"]): reason is GenuineCapabilityGapReason =>
  (GENUINE_CAPABILITY_GAP_REASONS as readonly string[]).includes(reason);

// Bounded exactly like every other per-record history list in this codebase (nodeAttemptHistory's
// MAX_NODE_ATTEMPT_HISTORY = 10): the record answers "how often, and where recently", not "every
// attempt ever" — an unbounded list here would be the K-P2 hazard (a hot, ever-growing document) one
// key space over.
export const MAX_CAPABILITY_GAP_SOURCE_REFS = 10;

export type CapabilityGapRecord = {
  id: string;
  tenantId: string;
  capability: string;
  operationId: string;
  operationVersion: number;
  reason: GenuineCapabilityGapReason;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  // Bounded, deduplicated, most-recent-last. A runId when the discovery happened inside a run,
  // otherwise a short caller-supplied correlation string (e.g. a bare preflight call carries none —
  // see operationTools.ts's own note on this being best-effort until a caller threads one through).
  sourceRefs: string[];
  // Already redacted by the caller (capabilityGapRecorder.ts) before this record is built — see
  // module header.
  evidence: Record<string, unknown>;
  proposedRemedy: string;
  // Optimistic-concurrency token, same contract as WorkflowExecutionRecord.rev: the repository's CAS
  // write increments it; a caller never sets it directly.
  rev?: number;
};

/**
 * The stable identity of a gap record — deterministic so two independent discoveries of "tenant T is
 * missing capability C for operation O" always resolve to the SAME record rather than minting a
 * sibling. Readable prefix (capability id) plus a short hash of the rest, matching the `blk_<hash>`
 * convention execution/blockage.ts already uses for the same reason (an idempotency key a re-read
 * reproduces, not a random id a second discovery would fail to find).
 */
export function capabilityGapId(tenantId: string, operationId: string, operationVersion: number, capability: string): string {
  return `gap_${capability}_${shortHash(`${tenantId}|${operationId}|${operationVersion}`)}`;
}
