// Exact diffs and affected targets (A4). computeChangeSet() turns a compiled Candidate
// (candidates.ts) into a server-computed, field-level diff against the snapshot's own record of the
// target object's current state — NEVER a model's description of what it changed. Every change set
// is bound to the snapshot's revisionId/digest it was computed from (isChangeSetStale below detects
// drift), and identical inputs always produce the identical changeSetId (see computeChangeSetId) so
// retrying unchanged work never mints a new identity or a duplicate target.
//
// THIS MODULE NEVER WRITES AND NEVER EXECUTES. Its `effects` are declarations in the exact same
// sense operationTypes.ts's OperationEffect already is: a description of what applying this change
// set would eventually do, authorizing nothing by itself. In particular, this module ONLY ever
// declares a "save" effect (the diff a caller could write to the object's own draft/working copy) —
// never an implied apply/publish/release effect. Object-specific lifecycles (draft -> applied,
// applied -> published) are a SEPARATE concern this module does not model at all; conflating "I
// computed a diff" with "that diff is live" is exactly the Zilberman-shaped mistake this exists to
// prevent (a live house visual standard can sit at version 4, content_revision 2, published_time:
// null — saved four times over, applied not once).
import type { Candidate } from "./candidates.js";
import type { OperationEffect } from "./operationTypes.js";
import type { SiteSnapshot } from "./siteContext.js";
import { contentDigest } from "./contentHash.js";

export type ChangeSetDiffOp = "add" | "remove" | "replace";

export type ChangeSetFieldDiff = {
  field: string;
  op: ChangeSetDiffOp;
  before: unknown;
  after: unknown;
};

export type ChangeSetTarget = {
  objectType: string;
  // null means this change set would CREATE a new object of `objectType`, not revise one that
  // already exists.
  objectId: string | null;
};

// The canonical string key for a target — used both to populate `affectedTargets` on a computed
// change set and, in scopedApproval.ts, to check that an approval's `grantedTargets` covers every
// target a change set affects. Exported so the two modules can never drift on the encoding.
export const targetKey = (target: ChangeSetTarget): string => `${target.objectType}:${target.objectId ?? "__new__"}`;

export type ChangeSet = {
  changeSetId: string;
  tenantId: string;
  objectType: string;
  objectId: string | null;
  revisionId: string | null;
  snapshotDigest: string;
  diffs: ChangeSetFieldDiff[];
  affectedTargets: ChangeSetTarget[];
  effects: OperationEffect[];
};

// Field-level, exact diff between two flat field maps. Deep-equal (via JSON.stringify, matching
// outputValidator.ts's own deepEqual convention) rather than reference-equal, so an unchanged nested
// object built as a fresh literal does not read as a spurious replace. Sorted by field name so two
// calls over the same (before, after) pair always produce byte-identical diffs regardless of the
// two maps' own key insertion order.
function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): ChangeSetFieldDiff[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const diffs: ChangeSetFieldDiff[] = [];
  for (const field of fields) {
    const hasBefore = field in before;
    const hasAfter = field in after;
    if (hasBefore && !hasAfter) {
      diffs.push({ field, op: "remove", before: before[field], after: undefined });
    } else if (!hasBefore && hasAfter) {
      diffs.push({ field, op: "add", before: undefined, after: after[field] });
    } else if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      diffs.push({ field, op: "replace", before: before[field], after: after[field] });
    }
  }
  return diffs;
}

// Content-derived: a change set recomputed from the same snapshot content and the same candidate
// (same tenant/objectType/objectId/diffs) always yields the same id. Deliberately NOT derived from
// candidate.intent or any other free-text field — two callers who describe the identical write
// differently still target the identical change.
function computeChangeSetId(input: { tenantId: string; objectType: string; objectId: string | null; snapshotDigest: string; diffs: ChangeSetFieldDiff[] }): string {
  return `cs_${contentDigest(input)}`;
}

export function computeChangeSet(params: { snapshot: SiteSnapshot; candidate: Candidate }): ChangeSet {
  const { snapshot, candidate } = params;
  const existing = candidate.objectId
    ? (snapshot.objects.byType[candidate.objectType] ?? []).find((object) => object.objectId === candidate.objectId)
    : undefined;
  const before = existing?.fields ?? {};

  const diffs = diffFields(before, candidate.fields);
  const target: ChangeSetTarget = { objectType: candidate.objectType, objectId: candidate.objectId };
  const affectedTargets = [target];

  // Exactly one effect, always "save" — see module header. Whether the object already existed only
  // changes the description, never the effect's kind vocabulary into anything apply/publish/release
  // shaped.
  const effects: OperationEffect[] = [
    {
      kind: existing ? "save_object_revision" : "save_object_draft",
      targetType: candidate.objectType,
      riskLevel: "write",
      description: existing
        ? `Would save ${diffs.length} field-level change(s) to ${candidate.objectType} "${candidate.objectId}"'s working copy. Nothing here applies, publishes, or releases it.`
        : `Would save a new ${candidate.objectType} draft with ${diffs.length} field(s). Nothing here applies, publishes, or releases it.`
    }
  ];

  const changeSetId = computeChangeSetId({
    tenantId: candidate.tenantId,
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    snapshotDigest: candidate.snapshotDigest,
    diffs
  });

  return {
    changeSetId,
    tenantId: candidate.tenantId,
    objectType: candidate.objectType,
    objectId: candidate.objectId,
    revisionId: candidate.revisionId,
    snapshotDigest: candidate.snapshotDigest,
    diffs,
    affectedTargets,
    effects
  };
}

// True when `currentSnapshot` no longer matches the revision/content this change set was computed
// from — the underlying revision moved. A stale change set invalidates its approval: scopedApproval
// authorizes strictly by (changeSetId, revisionId), so a change set that is stale against the
// snapshot it would be applied against should be recomputed (and, if still desired, reapproved)
// rather than authorized against its old approval.
export function isChangeSetStale(changeSet: ChangeSet, currentSnapshot: SiteSnapshot): boolean {
  if (changeSet.tenantId !== currentSnapshot.tenantId) return true;
  if (changeSet.revisionId !== null || currentSnapshot.revisionId !== null) {
    return changeSet.revisionId !== currentSnapshot.revisionId;
  }
  return changeSet.snapshotDigest !== currentSnapshot.digest;
}
