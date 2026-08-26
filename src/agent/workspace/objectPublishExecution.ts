// T15.6 (2026-08-25, ADR-2026-08-25-publish-autonomy §3, §9) — the canonical TS port of the
// object-scoped publish self-check `src/agent/capture/engine/publish.mjs` (T14.5) pioneered. T15.7
// (#187) deletes that file; THIS module is what it deletes it INTO. Every behaviour publish.mjs's own
// header called out as load-bearing is carried here, unchanged in substance:
//
//   - an object is published only when THAT OBJECT's own postcreate/postpatch validation passed;
//   - an object this run quarantined is NEVER published, even if some validation state says it passed;
//   - everything withheld is NAMED, with its reason — "silence about a withheld object would be the
//     same defect wearing a different hat" (publish.mjs:22-24);
//   - one object's failure never withholds the rest, and nothing here throws past its own loop;
//   - a lease is released in a `finally`, for the same reason emit.mjs does it: a stranded lock on a
//     live page blocks the tenant's own admin chat, which is worse than the failed publish that caused
//     it.
//
// WHAT MOVED. publish.mjs's executePublish() also called `release_to_production` once for the whole
// plan. That call is GONE from this module by design: Board decision B2, amended by this ADR (§4),
// authorizes exactly ONE node to say that verb — release_executor (releaseExecution.ts), a governed
// step downstream in the shared publishing tail. This module's job ends at "which objects got
// object_publish'd"; the tail supplies "and then go live", with the publish-risk safety machinery
// (approvalsRequired, the attention feed) actually able to see it — which publish.mjs's own node,
// tagged riskLevel:"write" to dodge that machinery, could not offer.
//
// THE TYPES ARE DELIBERATELY GENERIC. publish.mjs was capture-only; this module is canonical, so it
// takes an "emission-shaped" report (createdObjects/reusedObjects/validationStates/quarantines)
// without assuming who produced it — capture's emit report and a future clone mint/bind/restamp report
// are both instances of the same shape (ADR §6.2). Wiring a real caller's payload through this module
// — recomposing capture_conductor or clone_conductor onto the tail — is T15.7/T15.9/T15.10's job, not
// this one's: this file is the seam, built and tested standalone so that work has canonical TS to point
// at instead of the .mjs file it is deleting.

import type { CallToolFn } from "./publisher.js";

export class ObjectPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectPublishError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Never reachable, from this module or any other. A build is release_to_production's decision alone. */
export const OBJECT_PUBLISH_FORBIDDEN_VERBS = new Set(["trigger_netlify_build", "deploy", "release_to_production"]);

/** The only verbs this module's per-object loop may use. Release itself is deliberately NOT one of them. */
export const OBJECT_PUBLISH_VERBS = new Set(["object_checkout", "object_publish", "object_checkin"]);

// The LEGACY default publishable-type set, verbatim from publish.mjs's own PUBLISHABLE_TYPES.
// T15.11 (2026-08-25, #190; ADR-2026-08-25-publish-autonomy §6.3) makes the allowlist POLICY-DRIVEN
// per workflow instead of one constant every caller shares: buildObjectPublishPlan below now accepts
// a `publishableTypes` parameter — the calling run's OWN publishingPolicySnapshot.publishableTypes
// (see executionTypes.ts, publishableTypeCharter.ts) — and falls back to THIS set only when a caller
// supplies none, which is the exact pre-T15.11 behavior for any run whose snapshot predates the
// charter field. This constant is never widened for that reason: widening it would widen every
// caller, defeating the whole point of a per-workflow charter.
export const OBJECT_PUBLISHABLE_TYPES = new Set(["page", "navigation"]);

export type ObjectPublishSourceReport = {
  target?: unknown;
  createdObjects?: unknown;
  reusedObjects?: unknown;
  validationStates?: unknown;
  quarantines?: unknown;
};

export type ObjectPublishCandidate = { objectId: string; objectType: string | null; phase: string | null };
export type ObjectPublishWithheld = ObjectPublishCandidate & { reason: string; detail?: string | null };

export type ObjectPublishPlan = {
  schemaVersion: "object_publish_plan.v1";
  target: string;
  publish: ObjectPublishCandidate[];
  withheld: ObjectPublishWithheld[];
  release: boolean;
  forbiddenVerbs: string[];
};

const objectTypeIndex = (report: ObjectPublishSourceReport): Map<string, string> => {
  const index = new Map<string, string>();
  for (const entry of [...rows(report.createdObjects), ...rows(report.reusedObjects)]) {
    if (nonEmptyString(entry.objectId) && nonEmptyString(entry.objectType)) index.set(entry.objectId, entry.objectType as string);
  }
  return index;
};

// Every objectId this run quarantined, for any reason. A quarantine is the emission saying "I did not
// finish with this one" — publishing it would ship a half-write.
const quarantinedIds = (report: ObjectPublishSourceReport): Set<string> => {
  const ids = new Set<string>();
  for (const entry of rows(report.quarantines)) {
    if (nonEmptyString(entry.objectId)) ids.add(entry.objectId);
  }
  return ids;
};

export type BuildObjectPublishPlanParams = {
  report: ObjectPublishSourceReport;
  target?: string;
  // T15.11 (#190, ADR §6.3) — the CALLING RUN's chartered publishable types, i.e.
  // run.publishingPolicySnapshot.publishableTypes, snapshotted onto the run at creation
  // (executor.ts capturePublishingPolicySnapshot / publishableTypeCharter.ts) and passed down here
  // verbatim. This function never resolves a charter itself and never reads anything live — the
  // caller's snapshot is the only authority, which is what keeps a mid-run charter change from
  // altering an in-flight run (determinism, invariant 7). Absent falls back to
  // OBJECT_PUBLISHABLE_TYPES (page, navigation) — the exact pre-T15.11 behavior, for a run whose
  // snapshot predates the charter field.
  publishableTypes?: Iterable<string>;
  // Naming context ONLY, for the refusal's `detail` text — which workflow's charter is doing the
  // refusing. Never consulted for the decision itself (the passed-in publishableTypes already IS that
  // decision); absent renders a slightly less specific but still typed and named refusal.
  workflowId?: string;
};

/**
 * Decide what goes live, from the emission/mint report alone. PURE — no transport, no clock, no I/O —
 * so the decision can be inspected in a dry run and asserted in a test without a site on the other end.
 *
 * Returns { schemaVersion, target, publish: [...], withheld: [...], release }.
 *   publish  — objects whose own postcreate/postpatch validation passed, which nothing quarantined,
 *              and whose object type the calling workflow is CHARTERED to publish (T15.11, ADR §6.3).
 *   withheld — everything else that was WRITTEN, each with the reason it is not going live. A type
 *              outside the charter is withheld with `reason: "type_not_publishable"` and a `detail`
 *              that NAMES the boundary — reject-never-coerce, never a silent drop.
 *   release  — whether release_executor has anything to release (false when nothing is publishable).
 */
export function buildObjectPublishPlan({ report, target, publishableTypes, workflowId }: BuildObjectPublishPlanParams): ObjectPublishPlan {
  if (!isRecord(report)) throw new ObjectPublishError("An object publish plan needs the emission/mint report it is publishing.");
  const resolvedTarget = nonEmptyString(target) ? target.trim() : nonEmptyString(report.target) ? (report.target as string).trim() : null;
  if (!resolvedTarget) throw new ObjectPublishError("An object publish plan needs a target project.");

  const allowedTypes = new Set(publishableTypes ?? OBJECT_PUBLISHABLE_TYPES);
  const types = objectTypeIndex(report);
  const quarantined = quarantinedIds(report);
  const publish: ObjectPublishCandidate[] = [];
  const withheld: ObjectPublishWithheld[] = [];
  const decided = new Set<string>();

  // Walk validationStates, not the object lists: a validation state is the emission's own verdict on
  // one object, and it is the only field that says whether what landed is coherent.
  for (const state of rows(report.validationStates)) {
    const objectId = nonEmptyString(state.objectId) ? (state.objectId as string) : null;
    // A `precreate` state names a requestedId that was never written — there is no object to publish
    // and nothing was lost, so it is not withheld either. It simply is not a candidate.
    if (!objectId || decided.has(objectId)) continue;
    decided.add(objectId);
    const objectType = types.get(objectId) ?? null;
    const entry: ObjectPublishCandidate = { objectId, objectType, phase: nonEmptyString(state.phase) ? (state.phase as string) : null };

    if (state.valid !== true) {
      withheld.push({ ...entry, reason: "validation_failed", detail: nonEmptyString(state.reason) ? (state.reason as string) : null });
      continue;
    }
    if (quarantined.has(objectId)) {
      withheld.push({ ...entry, reason: "quarantined_by_emission" });
      continue;
    }
    if (!objectType || !allowedTypes.has(objectType)) {
      withheld.push({
        ...entry,
        reason: objectType ? "type_not_publishable" : "object_type_unknown",
        // T15.11 (#190, ADR §6.3) — the typed refusal NAMES the boundary: which workflow, which type,
        // which types it IS chartered for. A bare "type_not_publishable" code without this text would
        // still be reject-never-coerce, but this is the sentence a receipt reader (and
        // structure-studio ADR §2.2's enforcement point) actually needs.
        ...(objectType
          ? { detail: `${workflowId ?? "this workflow"} is not chartered to publish object type "${objectType}" (chartered types: ${[...allowedTypes].sort().join(", ") || "none"}). See ADR-2026-08-25-publish-autonomy §6.3.` }
          : {})
      });
      continue;
    }
    publish.push(entry);
  }

  // An object the emission quarantined WITHOUT ever validating it never reaches the loop above, and a
  // silently-dropped object is the failure mode this whole module exists to avoid. Name it.
  for (const entry of rows(report.quarantines)) {
    const objectId = nonEmptyString(entry.objectId) ? (entry.objectId as string) : null;
    if (!objectId || decided.has(objectId)) continue;
    decided.add(objectId);
    withheld.push({
      objectId,
      objectType: types.get(objectId) ?? null,
      phase: null,
      reason: "quarantined_by_emission",
      detail: nonEmptyString(entry.reason) ? (entry.reason as string) : null
    });
  }

  return {
    schemaVersion: "object_publish_plan.v1",
    target: resolvedTarget,
    publish,
    withheld,
    release: publish.length > 0,
    forbiddenVerbs: [...OBJECT_PUBLISH_FORBIDDEN_VERBS].sort()
  };
}

const payloadOf = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  if (isRecord(value.structuredContent)) return value.structuredContent as Record<string, unknown>;
  return value;
};
const lockTokenOf = (value: unknown): string | null => {
  const record = payloadOf(value);
  const token = record.lockToken ?? record.lock_token;
  return typeof token === "string" && token ? token : null;
};
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type ObjectPublishTraceEntry = { verb: string; objectType: string; objectId: string; failed?: boolean };
type ObjectPublishOutcome = { ok: true; publishedTime: string | null; commit: string | null } | { ok: false; reason: string; detail?: string };

/**
 * Publish ONE object through checkout -> object_publish -> checkin. Never throws past the lease
 * release; the caller records the reason and moves to the next object.
 */
async function publishOneObject(params: { callTool: CallToolFn; objectType: string; objectId: string; trace: ObjectPublishTraceEntry[] }): Promise<ObjectPublishOutcome> {
  const { callTool, objectType, objectId, trace } = params;
  let lockToken: string | null = null;
  try {
    const checkout = await callTool("object_checkout", { object_type: objectType, object_id: objectId });
    trace.push({ verb: "object_checkout", objectType, objectId });
    lockToken = lockTokenOf(checkout.ok ? checkout.result : checkout);
    if (!lockToken) return { ok: false, reason: "checkout_returned_no_lock" };

    const published = await callTool("object_publish", { object_type: objectType, object_id: objectId, lock_token: lockToken });
    trace.push({ verb: "object_publish", objectType, objectId });
    const record = payloadOf(published.ok ? published.result : published);
    if (record.published !== true) return { ok: false, reason: "publish_not_confirmed" };
    const receipt = isRecord(record.receipt) ? record.receipt : undefined;
    return {
      ok: true,
      publishedTime: typeof record.published_time === "string" ? record.published_time : null,
      commit: receipt && typeof receipt.commit_sha === "string" ? (receipt.commit_sha as string) : null
    };
  } catch (error) {
    return { ok: false, reason: "publish_failed", detail: errorText(error) };
  } finally {
    if (lockToken) {
      try {
        await callTool("object_checkin", { object_type: objectType, object_id: objectId, lock_token: lockToken });
        trace.push({ verb: "object_checkin", objectType, objectId });
      } catch {
        // A stranded lease is worse than the failed publish that caused it, so it is RECORDED rather
        // than swallowed — the caller's report carries it and an operator can break the lock knowingly.
        trace.push({ verb: "object_checkin", objectType, objectId, failed: true });
      }
    }
  }
}

export type ObjectPublishExecutionResult = {
  schemaVersion: "object_publish_execution.v1";
  target: string;
  published: Array<{ objectId: string; objectType: string; publishedTime: string | null; commit: string | null }>;
  failed: Array<{ objectId: string; objectType: string; reason: string; detail?: string }>;
  withheld: ObjectPublishWithheld[];
  trace: ObjectPublishTraceEntry[];
};

/**
 * Execute a publish plan through an injected transport. NO release call happens here — see the module
 * header; release_executor performs that, exactly once, downstream in the shared tail. One object's
 * failure never withholds the rest, and nothing here throws past the loop.
 */
export async function executeObjectPublish({ plan, callTool }: { plan: ObjectPublishPlan; callTool: CallToolFn }): Promise<ObjectPublishExecutionResult> {
  if (typeof callTool !== "function") throw new ObjectPublishError("A callTool transport is required to publish.");
  if (!isRecord(plan) || !Array.isArray(plan.publish)) throw new ObjectPublishError("An object publish plan is required.");

  const trace: ObjectPublishTraceEntry[] = [];
  const published: ObjectPublishExecutionResult["published"] = [];
  const failed: ObjectPublishExecutionResult["failed"] = [];

  for (const candidate of plan.publish) {
    const { objectId, objectType } = candidate;
    if (typeof objectId !== "string" || typeof objectType !== "string") {
      failed.push({ objectId: typeof objectId === "string" ? objectId : String(objectId ?? ""), objectType: typeof objectType === "string" ? objectType : String(objectType ?? ""), reason: "incomplete_candidate" });
      continue;
    }
    const outcome = await publishOneObject({ callTool, objectType, objectId, trace });
    if (outcome.ok) published.push({ objectId, objectType, publishedTime: outcome.publishedTime, commit: outcome.commit });
    else failed.push({ objectId, objectType, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  }

  return {
    schemaVersion: "object_publish_execution.v1",
    target: plan.target,
    published,
    failed,
    withheld: Array.isArray(plan.withheld) ? plan.withheld : [],
    trace
  };
}
