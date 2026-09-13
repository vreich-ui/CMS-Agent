// R2 (no-progress fingerprint) — the ONE place that turns a tenant's persisted project record into
// TenantCapabilityFacts (capabilityReadiness.ts). Extracted from mcp/workspace/operationTools.ts's
// own private `loadTenantCapabilityFacts` (operation.preflight's loader), which this module now
// backs, so a second caller (noProgressFingerprint's capability-state component, wired in
// executor.ts) reads capability facts the identical way rather than growing its own copy of the same
// four lines. Nothing about WHAT counts as a fact or HOW availability is derived changes here — this
// is a shared I/O SHELL around capabilityReadiness.ts's pure derivation, not a second vocabulary and
// not a second derivation rule (see capabilityVocabulary.ts's and capabilityReadiness.ts's own
// headers for why that duplication is exactly what R1 closed).
//
// ASYNC, DELIBERATELY, UNLIKE capabilityReadiness.ts. That module holds itself to zero I/O because it
// is the PURE derivation a caller hands facts to. This module IS the I/O: one project-repository read.
// Callers that also need to stay pure (operationPreflight.ts) receive the result as a synchronous
// closure (`capabilitySource`) built from calling this function once, ahead of time — this module is
// never itself passed across that boundary.
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { effectiveToolPermission } from "../projects/projectTypes.js";
import { CAPABILITY_EVIDENCE_TOOL_NAMES, type TenantCapabilityFacts } from "./capabilityReadiness.js";

// Absent project (unregistered tenantId) returns undefined, which every known caller
// (operationPreflight.ts's capabilitySource contract, and the no-progress fingerprint's capability
// component) reads as "no trusted facts — nothing assumed available" / "capability state unknown",
// never as an error. A disabled project is NOT absent: it flows through with `projectStatus:
// "disabled"`, which deriveTenantCapabilityAvailability reads as every capability "unavailable".
export async function loadTenantCapabilityFacts(tenantId: string, projectRepository: ProjectRepository): Promise<TenantCapabilityFacts | undefined> {
  const config = await projectRepository.get(tenantId);
  if (!config) return undefined;
  return {
    tenantId: config.projectId,
    projectStatus: config.status,
    objectDialectConfigured: Boolean(config.objectDialect),
    registeredToolNames: CAPABILITY_EVIDENCE_TOOL_NAMES.filter((toolName) => effectiveToolPermission(config, toolName) === "allowed")
  };
}
