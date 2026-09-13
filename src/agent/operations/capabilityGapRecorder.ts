// R2 Piece 2 — turns operationPreflight.ts's PER-CALL OperationCapabilityGap findings into DURABLE,
// deduplicated CapabilityGapRecord occurrences. This module is the ONLY place that writes through
// CapabilityGapRepository — operationPreflight.ts itself stays exactly as pure as its own header
// insists (ZERO writes, ZERO probes); this module is the caller-side write that module's header
// anticipates ("deps.repository... a test can hand this function a repository double... the function
// never references it at all" — that repository is reserved for a DIFFERENT, later read path; this is
// the write path, and it lives outside preflightOperation on purpose).
import { redactSensitiveKeys } from "../observability/redaction.js";
import { isKnownCapability } from "./capabilityVocabulary.js";
import { isGenuineCapabilityGapReason, type CapabilityGapRecord, type GenuineCapabilityGapReason } from "./capabilityGapTypes.js";
import type { OperationCapabilityGap } from "./operationTypes.js";
import type { CapabilityGapRepository } from "../repository/interfaces/CapabilityGapRepository.js";

export type RecordCapabilityGapsInput = {
  tenantId: string;
  operationId: string;
  operationVersion: number;
  capabilityGaps: readonly OperationCapabilityGap[];
  repository: CapabilityGapRepository;
  // A runId or short correlation string for this discovery, appended to each record's sourceRefs.
  // Optional — see operationTools.ts's own note on why a bare preflight call often has nothing to
  // name yet.
  sourceRef?: string;
  at?: string;
};

/**
 * Filters `capabilityGaps` down to the ones worth a durable record — see
 * capabilityGapTypes.ts's own header for why "unavailable" (a disabled/down tenant, not a genuine
 * gap) and a non-vocabulary capability id (e.g. preflight's own "workflow_binding" finding, which
 * describes an unimplemented OPERATION, not a tenant-specific missing CAPABILITY — see R1's closed
 * vocabulary, capabilityVocabulary.ts) are both excluded — then records one occurrence per surviving
 * gap. Best-effort by DESIGN at the call site (operationTools.ts wraps this in try/catch): a
 * capability-gap write failing must never turn a successful, read-only preflight response into an
 * error. This function itself does not swallow errors — it is the caller's job to decide that,
 * exactly like every other best-effort telemetry write in this codebase (e.g. executor.ts's
 * `recordNodeTiming(...).catch(() => undefined)`).
 */
export async function recordGenuineCapabilityGaps(input: RecordCapabilityGapsInput): Promise<CapabilityGapRecord[]> {
  const genuine = input.capabilityGaps.filter(
    (gap): gap is OperationCapabilityGap & { reason: GenuineCapabilityGapReason } =>
      isGenuineCapabilityGapReason(gap.reason) && isKnownCapability(gap.capability)
  );
  const recorded: CapabilityGapRecord[] = [];
  for (const gap of genuine) {
    const record = await input.repository.recordOccurrence({
      tenantId: input.tenantId,
      capability: gap.capability,
      operationId: input.operationId,
      operationVersion: input.operationVersion,
      reason: gap.reason,
      evidence: redactSensitiveKeys(gap.evidence),
      proposedRemedy: gap.remedy,
      sourceRef: input.sourceRef,
      at: input.at
    });
    recorded.push(record);
  }
  return recorded;
}
