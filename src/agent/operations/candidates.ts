// Candidate compilation (A4). compileCandidate() validates a caller's proposed field values for one
// object type against the ACTUAL object contract carried in a SiteSnapshot (siteContext.ts) — never
// a hand-written shape maintained separately from what the tenant actually accepts. THIS MODULE
// NEVER WRITES, NEVER DEFAULTS A MISSING VALUE, AND NEVER INVENTS ONE: a required field the caller
// did not supply comes back as a structured, named OperationBlocker (operationTypes.ts) exactly like
// operationPreflight.ts's own missing-field handling, not a silently-applied default.
import { validateOutput } from "../execution/outputValidator.js";
import type { OperationBlocker } from "./operationTypes.js";
import type { SiteSnapshot } from "./siteContext.js";

export type Candidate = {
  tenantId: string;
  objectType: string;
  // The object this candidate would revise, when it revises one that already exists in the
  // snapshot; null for a candidate that would create a new object of this type. Compiled fields are
  // validated identically either way — the object contract does not change shape based on whether
  // the object already exists.
  objectId: string | null;
  intent: string;
  fields: Record<string, unknown>;
  // Binds this candidate to the exact snapshot content it was validated against — changeSet.ts reads
  // this straight through onto the change set it computes, and isChangeSetStale (changeSet.ts)
  // compares it against a later snapshot to detect drift.
  snapshotDigest: string;
  revisionId: string | null;
};

export type CompileCandidateParams = {
  snapshot: SiteSnapshot;
  objectType: string;
  intent: string;
  fields: Record<string, unknown>;
  // Optional: which existing object (of `objectType`) this candidate revises. Omit for a candidate
  // that creates a new object. Not required to already appear in the snapshot's object list — an
  // object the snapshot's listObjects call did not happen to return is still a valid revision target
  // as far as CONTRACT validation goes; changeSet.ts is what needs the object's CURRENT fields (to
  // diff against) and treats an id absent from the snapshot's object list as "no prior state; every
  // field is an addition", the same as a brand-new object.
  objectId?: string | null;
};

export type CompileCandidateResult = { ok: true; candidate: Candidate } | { ok: false; blockers: OperationBlocker[] };

// outputValidator.ts's error strings for a missing required top-level field are exactly
// `$.<field> is required` (validateNode's `for (const key of node.required ?? [])` branch) — parsed
// here so a missing field becomes a blocker that NAMES the field in structured `evidence`, not only
// inside a message string a caller would have to parse themselves.
const REQUIRED_FIELD_ERROR = /^\$\.([A-Za-z0-9_.-]+) is required$/;

const contractUnavailableBlocker = (objectType: string, snapshot: SiteSnapshot): OperationBlocker => ({
  code: "object_contract_unavailable",
  message: `No object contract for type "${objectType}" is present in this snapshot (tenant "${snapshot.tenantId}", revision ${snapshot.revisionId ?? `digest:${snapshot.digest}`}).`,
  remedy: `Capture a site snapshot whose objectTypes includes "${objectType}" (see captureSiteSnapshot in siteContext.ts), then recompile the candidate.`,
  blocking: true,
  evidence: { objectType, availableObjectTypes: Object.keys(snapshot.contracts.byType) }
});

export function compileCandidate(params: CompileCandidateParams): CompileCandidateResult {
  const { snapshot, objectType, intent, fields } = params;
  const contract = snapshot.contracts.byType[objectType];
  if (!contract) return { ok: false, blockers: [contractUnavailableBlocker(objectType, snapshot)] };

  const validation = validateOutput(fields, contract.schema);
  if (!validation.ok) {
    const blockers: OperationBlocker[] = validation.errors.map((message) => {
      const match = message.match(REQUIRED_FIELD_ERROR);
      if (match) {
        const field = match[1];
        return {
          code: "required_field_missing",
          message: `"${field}" is required by the "${objectType}" object contract but was not supplied.`,
          remedy: `Supply a value for "${field}" and recompile the candidate — no default is applied for a required field.`,
          blocking: true,
          evidence: { field, objectType }
        };
      }
      return {
        code: "field_contract_violation",
        message,
        remedy: `Correct the listed field to satisfy the "${objectType}" object contract's schema (see the snapshot's contracts.byType["${objectType}"]) and recompile the candidate.`,
        blocking: true,
        evidence: { objectType }
      };
    });
    return { ok: false, blockers };
  }

  return {
    ok: true,
    candidate: {
      tenantId: snapshot.tenantId,
      objectType,
      objectId: params.objectId ?? null,
      intent,
      fields,
      snapshotDigest: snapshot.digest,
      revisionId: snapshot.revisionId
    }
  };
}
