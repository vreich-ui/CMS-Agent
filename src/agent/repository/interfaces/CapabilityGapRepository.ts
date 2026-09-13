import type { CapabilityGapRecord, GenuineCapabilityGapReason } from "../../operations/capabilityGapTypes.js";
import type { RepositoryHealth } from "../RepositoryHealth.js";

// R2 Piece 2 — the durable, deduplicated capability-gap ledger. See capabilityGapTypes.ts's own
// header for what "normalized requested outcome" and "genuine" mean; this interface only names the
// storage contract. `recordOccurrence` is the ONLY writer: it is a CAS-safe upsert keyed by
// (tenantId, operationId, operationVersion, capability) — the SAME record is returned/extended on a
// repeat, never a new sibling — mirroring BlobLearningRepository.mutateLedger's read-modify-write CAS
// discipline (see that module's header for why that pattern, not an unconditional overwrite, is
// required here: concurrent discoveries of the same gap must not lose an increment).
export type CapabilityGapOccurrenceInput = {
  tenantId: string;
  capability: string;
  operationId: string;
  operationVersion: number;
  reason: GenuineCapabilityGapReason;
  // Already redacted by the caller — see capabilityGapTypes.ts's module header. This repository never
  // redacts on its own; it persists exactly what it is handed.
  evidence: Record<string, unknown>;
  proposedRemedy: string;
  // A runId or short correlation string for THIS occurrence, appended (bounded, deduplicated) to the
  // record's sourceRefs. Optional — a bare discovery call may have nothing to name.
  sourceRef?: string;
  // Defaults to now() inside the implementation when omitted; a caller supplies it only to keep a
  // test's clock deterministic (matching every other repository's `at`-parameter convention in this
  // codebase — e.g. nodeAttemptHistory's appendNodeAttempt).
  at?: string;
};

export interface CapabilityGapRepository {
  recordOccurrence(input: CapabilityGapOccurrenceInput): Promise<CapabilityGapRecord>;
  get(tenantId: string, gapId: string): Promise<CapabilityGapRecord | undefined>;
  // TENANT-SCOPED BY CONSTRUCTION: both implementations key/partition storage by tenantId FIRST (see
  // each implementation's own header), so this can never return another tenant's records — there is
  // no unfiltered variant to accidentally call, unlike the K-M10 shape this deliberately avoids.
  listForTenant(tenantId: string): Promise<CapabilityGapRecord[]>;
  health(): Promise<RepositoryHealth>;
}
