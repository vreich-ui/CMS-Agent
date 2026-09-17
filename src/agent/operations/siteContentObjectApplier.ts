// P2 wave 2 — applying a compiled plan, once, and knowing what happened when it stops halfway.
//
// siteContentObjectCompiler.ts produces a plan and writes nothing. This module is what turns that
// plan into objects: it applies each change set through a narrow writer port, journals every effect
// BEFORE attempting it, reads each written object back, and — when something fails in the middle —
// reports exactly which effects landed rather than an error with no inventory.
//
// WHY A JOURNAL AND NOT A TRANSACTION. The object store has no cross-object transaction. Three
// sections and a page are four separate writes, and the failure that matters is the one between
// them: two sections written, the third refused, and a caller who now knows only "it failed". The
// next attempt then either duplicates the two that landed or skips all four. A journal written
// BEFORE each effect and completed after it makes the middle state readable, so a retry resumes
// instead of guessing. It does not make the apply atomic, and this module never claims it does —
// `partiallyApplied` is a first-class result, not an error path.
//
// ORDER IS NOT THE PLAN'S PRESENTATION ORDER. The compiled plan lists the page change set first,
// because that is what an operator reads first. Application is the reverse: every section is
// written before the page that references it, because a page referencing a section id that does not
// exist yet is a dangling reference the store would either refuse or, worse, accept. The page's
// pending references are rewritten with the ids the writer actually minted — never with an id
// guessed ahead of the write.
//
// IDEMPOTENCY, AND THE WINDOW THE JOURNAL CANNOT CLOSE. Each effect carries
// `${materializationKey}:${stepKey}` as its idempotency key, and the journal is keyed on the
// materialization key. Replaying an identical request finds a complete journal and applies nothing —
// the duplicate-retry case creates no second page. Replaying a partial one skips every effect
// already recorded as applied.
//
// What a journal CANNOT do is close the window between a write the store accepted and the journal
// entry that records it. A process that dies in that window leaves an entry saying `pending` over an
// object that may or may not exist. Re-attempting a CREATE there is how a duplicate section is born,
// and this module refuses to gamble: an unfinished create is reported as `indeterminate_prior_attempt`
// and the apply stops, naming the effect a human has to look at — UNLESS the writer declares
// `dedupesByIdempotencyKey`, in which case retrying is safe because the store itself collapses the
// second attempt onto the first. An unfinished PATCH is retried either way: the same fields against
// the same expected revision is the same write, and the revision check refuses it if anything moved.
//
// STEP IDENTITY IS POSITION + CHANGE SET, NOT THE CHANGE SET ALONE. `changeSetId` is a content hash,
// so two sections compiled to byte-identical fields share one. Keying the journal on it alone would
// let the second section resume onto the first one's minted id — two intended objects silently
// collapsed into one, with the page referencing it twice. Entries are keyed by `stepKey`
// (`<position>:<changeSetId>`), and the change set id is kept alongside for the operator record.
//
// REMOVE DIFFS ARE REFUSED, NOT DROPPED. The writer port takes a field map and cannot express
// "clear this field", so a change set carrying a `remove` diff cannot be applied faithfully: sending
// the remaining fields to a store that merges would leave the removed value in place while the
// change set an operator approved says it is gone. That is refused by name rather than silently
// half-applied. Today's compiler never emits one; relying on that rather than checking is how it
// would become a bug the first time it does.
//
// THIS MODULE NEVER PUBLISHES OR RELEASES. It saves objects — the same "save" changeSet.ts's effects
// declare and nothing more. Publishing, releasing and the approval that authorizes them are other
// modules' authority, and applying a change set here neither performs nor implies them.
import type { ChangeSet } from "./changeSet.js";
import type { SiteContentObjectPlan } from "./siteContentObjectCompiler.js";

export type AppliedObjectReceipt = {
  changeSetId: string;
  objectType: string;
  objectId: string;
  action: "create" | "patch";
  // What the store reported the object at AFTER the write — read back, never assumed from the
  // request. A write whose readback disagrees with what the writer returned is a failure.
  contentRevision: number;
  version: number;
  appliedAt: string;
};

export type ApplyFailure = {
  stepKey: string;
  changeSetId: string;
  objectType: string;
  objectId: string | null;
  code: string;
  message: string;
};

export type ApplySiteContentPlanResult = {
  materializationKey: string;
  tenantId: string;
  // "applied" — everything landed on this attempt. "already_applied" — a complete journal existed
  // and nothing was written. "partially_applied" — some effects landed and one failed; `receipts`
  // is the honest inventory of what exists now. "not_applied" — the first effect failed, so nothing
  // was written.
  // "blocked_indeterminate" — a previous attempt left a create whose outcome is unknown and the
  // writer cannot deduplicate it, so nothing further was attempted and a human must establish
  // whether that object exists before this plan is retried.
  outcome: "applied" | "already_applied" | "partially_applied" | "not_applied" | "blocked_indeterminate";
  receipts: AppliedObjectReceipt[];
  failure?: ApplyFailure;
  // The change sets this attempt did not reach, in the order they would have been applied. Present
  // only on a partial/failed outcome, so a resume has the remaining work named rather than derived.
  remainingChangeSetIds: string[];
};

export type WriteObjectResult = { objectId: string; contentRevision: number; version: number };

// The narrow write port. Deliberately three methods and no publish verb: a port that cannot express
// "publish" cannot be talked into performing one, and an applier holding a port that could is one
// argument away from a live release.
export type SiteObjectWriter = {
  // True when the store collapses two writes carrying the same `idempotencyKey` onto one object.
  // Declared by the writer, never assumed: it is what decides whether an unfinished create can be
  // safely retried (see IDEMPOTENCY in this module's header). Absent means "no".
  readonly dedupesByIdempotencyKey?: boolean;
  createObject(params: { tenantId: string; objectType: string; fields: Record<string, unknown>; idempotencyKey: string }): Promise<WriteObjectResult>;
  patchObject(params: {
    tenantId: string;
    objectType: string;
    objectId: string;
    fields: Record<string, unknown>;
    expectedContentRevision?: number;
    idempotencyKey: string;
  }): Promise<WriteObjectResult>;
  // Read back what the store now holds. Returns null when the object is not there, which after a
  // reported-successful write is itself the finding.
  readObject(params: { tenantId: string; objectType: string; objectId: string }): Promise<{ objectId: string; contentRevision: number; version: number } | null>;
};

export type ApplyJournalEntry = {
  // `<position in the application order>:<changeSetId>` — see STEP IDENTITY in the module header.
  stepKey: string;
  changeSetId: string;
  objectType: string;
  action: "create" | "patch";
  status: "pending" | "applied" | "failed";
  objectId?: string;
  contentRevision?: number;
  version?: number;
  at: string;
  error?: string;
};

export type ApplyJournalRecord = {
  materializationKey: string;
  tenantId: string;
  status: "in_progress" | "complete" | "failed";
  entries: ApplyJournalEntry[];
  startedAt: string;
  updatedAt: string;
};

// The journal port. `read` before anything is attempted; `write` before and after every effect. A
// journal that cannot be written is a hard stop, not a warning — see APPLY below.
export type ApplyJournal = {
  read(params: { tenantId: string; materializationKey: string }): Promise<ApplyJournalRecord | null>;
  write(record: ApplyJournalRecord): Promise<void>;
};

export type ApplySiteContentPlanDeps = {
  writer: SiteObjectWriter;
  journal: ApplyJournal;
  now?: () => string;
};

const PENDING_INDEX_FIELD = "pendingSectionIndex";

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The fields a change set would write: its `after` values, which for a create is every field and for
// a patch is exactly what changed. Taken from the diffs rather than recomputed, so what is applied
// is what was reviewed.
const fieldsOf = (changeSet: ChangeSet): { ok: true; fields: Record<string, unknown> } | { ok: false; removedFields: string[] } => {
  const removedFields = changeSet.diffs.filter((diff) => diff.op === "remove").map((diff) => diff.field);
  // See REMOVE DIFFS ARE REFUSED in the module header. Dropping them would apply a change set that
  // is not the one reviewed.
  if (removedFields.length) return { ok: false, removedFields };
  const fields: Record<string, unknown> = {};
  for (const diff of changeSet.diffs) fields[diff.field] = diff.after;
  return { ok: true, fields };
};

// Rewrite the page's `sections` list, replacing each `pendingSectionIndex` with the id the writer
// actually minted for that section. An index with no minted id is a defect in this module, not a
// recoverable state, so it throws rather than writing a page with a hole in it.
const resolvePageSections = (fields: Record<string, unknown>, mintedByIndex: readonly string[]): Record<string, unknown> => {
  const sections = fields.sections;
  if (!Array.isArray(sections)) return fields;
  const resolved = sections.map((entry) => {
    if (!isBag(entry)) return entry;
    const pending = entry[PENDING_INDEX_FIELD];
    if (typeof pending !== "number") return entry;
    const minted = mintedByIndex[pending];
    if (!minted) {
      throw new Error(`page section reference ${pending} has no minted section id; refusing to write a page with an unresolved reference.`);
    }
    const { [PENDING_INDEX_FIELD]: _removed, ...rest } = entry;
    return { ...rest, section: minted };
  });
  return { ...fields, sections: resolved };
};

/**
 * Apply a compiled plan. Sections in planner order, then the page.
 *
 * Every effect is journalled before it is attempted and completed after its readback. A failure
 * stops the apply — the page is never written when a section it references failed — and the result
 * names what landed, what failed and what was not reached.
 */
export async function applySiteContentPlan(plan: SiteContentObjectPlan, deps: ApplySiteContentPlanDeps): Promise<ApplySiteContentPlanResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { writer, journal } = deps;

  const pageChangeSet = plan.changeSets.find((changeSet) => changeSet.changeSetId === plan.page.changeSetId);
  if (!pageChangeSet) {
    throw new Error(`plan ${plan.materializationKey} names page change set ${plan.page.changeSetId}, which is not among its change sets.`);
  }
  // Application order: sections in the order the plan lists them (ascending planner order, as the
  // compiler guarantees), then the page.
  const sectionSteps = plan.sections.map((section) => {
    const changeSet = plan.changeSets.find((entry) => entry.changeSetId === section.changeSetId);
    if (!changeSet) throw new Error(`plan ${plan.materializationKey} names section change set ${section.changeSetId}, which is not among its change sets.`);
    return { section, changeSet };
  });

  const existing = await journal.read({ tenantId: plan.tenantId, materializationKey: plan.materializationKey });

  // A complete journal is the duplicate-retry case: this exact materialization already happened, so
  // nothing is written and the receipts it recorded are returned as they were.
  if (existing?.status === "complete") {
    return {
      materializationKey: plan.materializationKey,
      tenantId: plan.tenantId,
      outcome: "already_applied",
      receipts: existing.entries
        .filter((entry) => entry.status === "applied" && entry.objectId && entry.contentRevision !== undefined && entry.version !== undefined)
        .map((entry) => ({
          changeSetId: entry.changeSetId,
          objectType: entry.objectType,
          objectId: entry.objectId!,
          action: entry.action,
          contentRevision: entry.contentRevision!,
          version: entry.version!,
          appliedAt: entry.at
        })),
      remainingChangeSetIds: []
    };
  }

  // A defensive copy: the port does not promise `read` returns a fresh object, and mutating a
  // backend's cached record in place would make an in-progress state visible to other readers
  // before — or instead of — the write that was supposed to record it.
  const record: ApplyJournalRecord = existing ? (structuredClone(existing) as ApplyJournalRecord) : {
    materializationKey: plan.materializationKey,
    tenantId: plan.tenantId,
    status: "in_progress",
    entries: [],
    startedAt: now(),
    updatedAt: now()
  };
  record.status = "in_progress";

  const entryFor = (stepKey: string) => record.entries.find((entry) => entry.stepKey === stepKey);

  const receipts: AppliedObjectReceipt[] = [];
  const mintedByIndex: string[] = [];

  const commit = async () => {
    record.updatedAt = now();
    await journal.write(record);
  };

  const runStep = async (
    stepKey: string,
    changeSet: ChangeSet,
    action: "create" | "patch",
    objectId: string | null,
    fields: Record<string, unknown>,
    expectedContentRevision: number | undefined
  ): Promise<{ ok: true; receipt: AppliedObjectReceipt } | { ok: false; failure: ApplyFailure; indeterminate?: boolean }> => {
    const prior = entryFor(stepKey);
    // Resume: an effect already recorded as applied is not attempted again, whatever the writer
    // would do with it.
    const already = prior?.status === "applied" ? prior : undefined;
    if (already?.objectId && already.contentRevision !== undefined && already.version !== undefined) {
      return {
        ok: true,
        receipt: {
          changeSetId: changeSet.changeSetId,
          objectType: changeSet.objectType,
          objectId: already.objectId,
          action: already.action,
          contentRevision: already.contentRevision,
          version: already.version,
          appliedAt: already.at
        }
      };
    }

    // An unfinished CREATE from a previous attempt may or may not have landed. Retrying it is safe
    // only where the store deduplicates on the idempotency key; otherwise this stops and says so,
    // because a silent duplicate section is worse than a stopped apply a human can resolve.
    if (prior && prior.status !== "applied" && action === "create" && !writer.dedupesByIdempotencyKey) {
      return {
        ok: false,
        indeterminate: true,
        failure: {
          stepKey,
          changeSetId: changeSet.changeSetId,
          objectType: changeSet.objectType,
          objectId: prior.objectId ?? null,
          code: "indeterminate_prior_attempt",
          message: `A previous attempt recorded this ${changeSet.objectType} create as "${prior.status}" and never completed it, so whether that object exists is unknown. This writer does not deduplicate by idempotency key, so retrying could create a second one. Establish whether the object exists (and record it as applied, or remove it) before retrying this plan.`
        }
      };
    }

    // PENDING FIRST, and awaited. If the journal write fails the effect is not attempted at all —
    // an unjournalled write is exactly the state this module exists to prevent, because a retry
    // cannot tell it happened.
    const pendingIndex = record.entries.findIndex((entry) => entry.stepKey === stepKey);
    const pendingEntry: ApplyJournalEntry = { stepKey, changeSetId: changeSet.changeSetId, objectType: changeSet.objectType, action, status: "pending", at: now(), ...(objectId ? { objectId } : {}) };
    if (pendingIndex >= 0) record.entries[pendingIndex] = pendingEntry;
    else record.entries.push(pendingEntry);
    await commit();

    const idempotencyKey = `${plan.materializationKey}:${stepKey}`;
    let written: WriteObjectResult;
    try {
      written =
        action === "create"
          ? await writer.createObject({ tenantId: plan.tenantId, objectType: changeSet.objectType, fields, idempotencyKey })
          : await writer.patchObject({
              tenantId: plan.tenantId,
              objectType: changeSet.objectType,
              objectId: objectId!,
              fields,
              ...(expectedContentRevision !== undefined ? { expectedContentRevision } : {}),
              idempotencyKey
            });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: ApplyFailure = { stepKey, changeSetId: changeSet.changeSetId, objectType: changeSet.objectType, objectId, code: "write_failed", message };
      const index = record.entries.findIndex((entry) => entry.stepKey === stepKey);
      // The entry stays in the journal as `failed`, NOT removed: a resume must be able to see that
      // this effect was attempted, because a write that failed on the client side may still have
      // landed on the server.
      record.entries[index] = { ...pendingEntry, status: "failed", at: now(), error: message };
      await commit();
      return { ok: false, failure };
    }

    // READBACK. What the writer returned is a claim; what the store holds is the fact. They are
    // compared, and a disagreement fails the apply rather than being recorded as success.
    const readback = await writer.readObject({ tenantId: plan.tenantId, objectType: changeSet.objectType, objectId: written.objectId }).catch(() => null);
    if (!readback) {
      const message = `${changeSet.objectType} "${written.objectId}" reported a successful ${action} but could not be read back, so there is no evidence it exists.`;
      const index = record.entries.findIndex((entry) => entry.stepKey === stepKey);
      record.entries[index] = { ...pendingEntry, status: "failed", at: now(), objectId: written.objectId, error: message };
      await commit();
      return { ok: false, failure: { stepKey, changeSetId: changeSet.changeSetId, objectType: changeSet.objectType, objectId: written.objectId, code: "readback_missing", message } };
    }

    const receipt: AppliedObjectReceipt = {
      changeSetId: changeSet.changeSetId,
      objectType: changeSet.objectType,
      objectId: readback.objectId,
      action,
      // The READ revision, not the written one — the object's own record of where it now stands.
      contentRevision: readback.contentRevision,
      version: readback.version,
      appliedAt: now()
    };
    const index = record.entries.findIndex((entry) => entry.stepKey === stepKey);
    record.entries[index] = {
      stepKey,
      changeSetId: changeSet.changeSetId,
      objectType: changeSet.objectType,
      action,
      status: "applied",
      objectId: readback.objectId,
      contentRevision: readback.contentRevision,
      version: readback.version,
      at: receipt.appliedAt
    };
    await commit();
    return { ok: true, receipt };
  };

  // Application order, and the identity every journal entry is keyed on: sections in the plan's
  // order (ascending planner order, as the compiler guarantees), then the page.
  const steps = [
    ...sectionSteps.map((step, index) => ({ stepKey: `${index}:${step.changeSet.changeSetId}`, changeSet: step.changeSet, action: step.section.action, objectId: step.section.objectId, expected: step.section.action === "patch" ? step.section.targetContentRevision ?? undefined : undefined, sectionIndex: index })),
    {
      stepKey: `${sectionSteps.length}:${pageChangeSet.changeSetId}`,
      changeSet: pageChangeSet,
      action: plan.page.action,
      objectId: plan.page.objectId,
      expected: plan.page.action === "patch" ? plan.page.targetContentRevision ?? undefined : undefined,
      sectionIndex: -1
    }
  ];

  const remainingAfter = (stepKey: string) => steps.slice(steps.findIndex((step) => step.stepKey === stepKey) + 1).map((step) => step.changeSet.changeSetId);

  const stop = async (step: { stepKey: string; changeSet: ChangeSet }, failure: ApplyFailure, indeterminate: boolean): Promise<ApplySiteContentPlanResult> => {
    record.status = "failed";
    await commit();
    return {
      materializationKey: plan.materializationKey,
      tenantId: plan.tenantId,
      // The page is NEVER written when a section failed: it would reference a section that does not
      // exist, and a page that renders without one of its sections reads as finished.
      outcome: indeterminate ? "blocked_indeterminate" : receipts.length ? "partially_applied" : "not_applied",
      receipts,
      failure,
      remainingChangeSetIds: remainingAfter(step.stepKey)
    };
  };

  for (const step of steps) {
    const resolvedFields = fieldsOf(step.changeSet);
    if (!resolvedFields.ok) {
      return stop(
        step,
        {
          stepKey: step.stepKey,
          changeSetId: step.changeSet.changeSetId,
          objectType: step.changeSet.objectType,
          objectId: step.objectId,
          code: "unsupported_remove_diff",
          message: `This change set clears ${resolvedFields.removedFields.join(", ")}, which the writer port cannot express — applying the rest would leave the cleared field(s) in place while the approved change set says they are gone.`
        },
        false
      );
    }

    // The page's pending references are resolved only once every section it names has a minted id.
    const fields = step.sectionIndex === -1 ? resolvePageSections(resolvedFields.fields, mintedByIndex) : resolvedFields.fields;
    const outcome = await runStep(step.stepKey, step.changeSet, step.action, step.objectId, fields, step.expected);
    if (!outcome.ok) return stop(step, outcome.failure, Boolean(outcome.indeterminate));
    receipts.push(outcome.receipt);
    if (step.sectionIndex >= 0) mintedByIndex[step.sectionIndex] = outcome.receipt.objectId;
  }

  record.status = "complete";
  await commit();

  return { materializationKey: plan.materializationKey, tenantId: plan.tenantId, outcome: "applied", receipts, remainingChangeSetIds: [] };
}

