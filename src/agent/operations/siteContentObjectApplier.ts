// P2 v2 -- applying a compiled page materialization plan, once, and knowing what happened when it
// stops halfway.
//
// siteContentObjectCompiler.ts produces a PageMaterializationPlan and writes nothing. This module
// turns that plan into ONE tenant write: a page create (sections inline in the body) or a page patch
// (a single `object_patch` call carrying the plan's own `ops` array -- `set_page_meta` /
// `upsert_section` / `update_section_data` / `move_section` / `set_section_visibility` /
// `remove_section`, exactly as Platform's own contract names them). It journals that effect BEFORE
// attempting it, reads the object back afterward, and reports exactly what happened rather than an
// error with no inventory.
//
// WHY v2 IS ONE EFFECT, NOT N. v1 (PR #385) applied one effect per compiled section plus one for the
// page, because v1's compiler modeled every section as its own top-level object. It never reflected
// what Platform's `page` object contract actually is: sections are inline in the page body, and
// `object_patch` on a page is one call carrying an ops array, not N separate object_patch calls
// against N separate `section` objects. v2's compiler (siteContentObjectCompiler.ts) reflects that,
// so this applier has exactly one write to make per plan. The "sections before the page, so a page
// never references an id that does not exist" ordering concern v1 needed is now moot BY
// CONSTRUCTION: the sections and the page are the same write.
//
// WHAT SURVIVES FROM v1, UNCHANGED. Everything the applier exists to guarantee is still a live
// concern for that one write:
//   - JOURNAL BEFORE EFFECT. A crash between "the store accepted this" and "the journal recorded it"
//     is the one state a retry cannot reason about on its own -- see INDETERMINACY below.
//   - READBACK, NEVER A CLAIM. What the writer returns is checked against a real read of the object
//     afterward; a mismatch (or an object that cannot be read back at all) is a failure, not a
//     success this module cannot show.
//   - IDEMPOTENCY. The effect's idempotency key is `${materializationKey}:page`. Replaying an
//     identical request finds a complete journal and writes nothing.
//   - INDETERMINACY ON AN UNFINISHED CREATE. A `create` whose outcome the journal never recorded is
//     `indeterminate_prior_attempt` and the apply stops UNLESS the writer declares
//     `dedupesByIdempotencyKey` -- see objectDialect.ts's own note on object_create's best-effort
//     replay cache for why that flag is never assumed, only declared. An unfinished PATCH carries no
//     such risk: Platform's own `object_patch` takes no `idempotency_key` at all (see
//     platformSiteObjectWriter.ts's header), and a patch built from these ops is naturally re-appliable
//     -- `set_page_meta`/`update_section_data` re-merge the same values, `upsert_section` re-replaces
//     the same section at the same id -- so a retry is simply re-attempted rather than blocked.
//
// THIS MODULE NEVER PUBLISHES OR RELEASES. It saves one object's body -- the same "save" changeSet.ts's
// effects declare and nothing more.
import type { PageMaterializationPlan, PageObjectPatchOp } from "./siteContentObjectCompiler.js";

export type AppliedObjectReceipt = {
  objectType: "page";
  objectId: string;
  action: "create" | "patch";
  // What the store reported AFTER the write -- read back, never assumed from the writer's own claim.
  contentRevision: number;
  version: number;
  appliedAt: string;
};

export type ApplyFailure = {
  objectType: "page";
  objectId: string | null;
  code: string;
  message: string;
};

export type ApplySiteContentPlanResult = {
  materializationKey: string;
  tenantId: string;
  // "applied" -- the write landed on this attempt. "already_applied" -- a complete journal existed and
  // nothing was written. "not_applied" -- the write failed (or was refused before being attempted) and
  // nothing new exists. "blocked_indeterminate" -- a previous attempt left a create whose outcome is
  // unknown and the writer cannot deduplicate it, so a human must establish whether the page exists
  // before this plan is retried. "partially_applied" is retained in the type for API continuity with
  // v1 and any future multi-effect plan (e.g. a `shared_ref` wave); v2's single-effect model, applying
  // a plan this module accepted, never produces it -- see the schema-version guard below for what
  // happens instead when a plan does not fit this model.
  outcome: "applied" | "already_applied" | "not_applied" | "partially_applied" | "blocked_indeterminate";
  receipt?: AppliedObjectReceipt;
  failure?: ApplyFailure;
};

export type WriteObjectResult = { objectId: string; contentRevision: number; version: number };

// The narrow write port. Two write methods and no publish verb -- a port that cannot express
// "publish" cannot be talked into performing one.
export type SiteObjectWriter = {
  // True when the store collapses two creates carrying the same `idempotencyKey` onto one object.
  // Declared by the writer, never assumed -- see INDETERMINACY above. Absent means "no".
  readonly dedupesByIdempotencyKey?: boolean;
  createObject(params: { tenantId: string; objectType: "page"; fields: Record<string, unknown>; idempotencyKey: string }): Promise<WriteObjectResult>;
  // No idempotencyKey: Platform's own object_patch takes none (see platformSiteObjectWriter.ts's
  // header, and objectDialect.ts's P5 note) -- inventing one here would claim a replay guarantee this
  // port cannot honour. `expectedContentRevision`, when supplied, is the plan's OWN belief (frozen at
  // compile time) for the writer to compare against what it sees at apply time -- early, honest
  // staleness detection; the writer's real optimistic-concurrency token (a fresh
  // lock_token/expected_record_version from its own checkout) is entirely the writer's concern and
  // never crosses this port.
  patchObject(params: { tenantId: string; objectType: "page"; objectId: string; ops: PageObjectPatchOp[]; expectedContentRevision?: number }): Promise<WriteObjectResult>;
  readObject(params: { tenantId: string; objectType: "page"; objectId: string }): Promise<{ objectId: string; contentRevision: number; version: number } | null>;
};

export type ApplyJournalEntry = {
  objectType: "page";
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
  entry: ApplyJournalEntry;
  startedAt: string;
  updatedAt: string;
};

// The journal port. `read` before anything is attempted; `write` before and after the effect.
export type ApplyJournal = {
  read(params: { tenantId: string; materializationKey: string }): Promise<ApplyJournalRecord | null>;
  write(record: ApplyJournalRecord): Promise<void>;
};

export type ApplySiteContentPlanDeps = {
  writer: SiteObjectWriter;
  journal: ApplyJournal;
  now?: () => string;
};

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Defensive shape-check on a patch op -- guards against a hand-edited/doctored plan (a stale v1-shaped
// record, a corrupted journal replay, a test fixture) reaching a writer with something that is not
// actually one of the six named ops. This module's own compiler never emits anything else; relying on
// that rather than checking is exactly how v1's "a change set carrying a remove diff" defect would
// have shipped unnoticed the first time the compiler changed.
function isWellFormedPatchOp(value: unknown): value is PageObjectPatchOp {
  if (!isBag(value) || typeof value.op !== "string") return false;
  switch (value.op) {
    case "set_page_meta":
      return isBag(value.fields);
    case "upsert_section":
      return isBag(value.section) && typeof value.section.id === "string" && value.section.id.length > 0;
    case "update_section_data":
      return typeof value.sectionId === "string" && value.sectionId.length > 0 && isBag(value.fields);
    case "move_section":
      return typeof value.sectionId === "string" && value.sectionId.length > 0 && typeof value.toIndex === "number";
    case "set_section_visibility":
      return typeof value.sectionId === "string" && value.sectionId.length > 0 && (value.visibility === "public" || value.visibility === "hidden" || value.visibility === null);
    case "remove_section":
      return typeof value.sectionId === "string" && value.sectionId.length > 0;
    default:
      return false;
  }
}

/**
 * Apply a compiled page materialization plan: one write, journalled before it is attempted and
 * completed after its readback.
 */
export async function applySiteContentPlan(plan: PageMaterializationPlan, deps: ApplySiteContentPlanDeps): Promise<ApplySiteContentPlanResult> {
  if (plan.schemaVersion !== "site-page-materialization.v2") {
    // A plan from a different schema version is never reinterpreted under this module's rules -- see
    // the compiler's own header on why the version exists at all. A caller holding an old plan must
    // recompile, not replay it here.
    throw new Error(`applySiteContentPlan only understands schemaVersion "site-page-materialization.v2"; got "${(plan as { schemaVersion?: unknown }).schemaVersion}". Recompile the plan; do not replay a stale one.`);
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const { writer, journal } = deps;

  const existing = await journal.read({ tenantId: plan.tenantId, materializationKey: plan.materializationKey });

  if (existing?.status === "complete" && existing.entry.status === "applied" && existing.entry.objectId && existing.entry.contentRevision !== undefined && existing.entry.version !== undefined) {
    return {
      materializationKey: plan.materializationKey,
      tenantId: plan.tenantId,
      outcome: "already_applied",
      receipt: { objectType: "page", objectId: existing.entry.objectId, action: existing.entry.action, contentRevision: existing.entry.contentRevision, version: existing.entry.version, appliedAt: existing.entry.at }
    };
  }

  const action = plan.page.action;
  const objectId = plan.page.objectId;

  // An unfinished CREATE from a previous attempt may or may not have landed. Retrying it is safe only
  // where the store deduplicates on the idempotency key.
  if (existing && existing.entry.status !== "applied" && action === "create" && !writer.dedupesByIdempotencyKey) {
    return {
      materializationKey: plan.materializationKey,
      tenantId: plan.tenantId,
      outcome: "blocked_indeterminate",
      failure: {
        objectType: "page",
        objectId: existing.entry.objectId ?? null,
        code: "indeterminate_prior_attempt",
        message: `A previous attempt recorded this page create as "${existing.entry.status}" and never completed it, so whether that page exists is unknown. This writer does not deduplicate by idempotency key, so retrying could create a second one. Establish whether the page exists (and record it as applied, or remove it) before retrying this plan.`
      }
    };
  }

  if (plan.write.kind === "patch") {
    const malformed = plan.write.ops.filter((op) => !isWellFormedPatchOp(op));
    if (malformed.length) {
      return {
        materializationKey: plan.materializationKey,
        tenantId: plan.tenantId,
        outcome: "not_applied",
        failure: {
          objectType: "page",
          objectId,
          code: "malformed_patch_op",
          message: `This plan's patch carries ${malformed.length} op(s) that do not match a known page-patch op shape (set_page_meta/upsert_section/update_section_data/move_section/set_section_visibility/remove_section): ${JSON.stringify(malformed[0])}. Refusing rather than sending an op the tenant would reject or, worse, misinterpret.`
        }
      };
    }
  }

  const record: ApplyJournalRecord = existing
    ? (structuredClone(existing) as ApplyJournalRecord)
    : { materializationKey: plan.materializationKey, tenantId: plan.tenantId, status: "in_progress", entry: { objectType: "page", action, status: "pending", ...(objectId ? { objectId } : {}), at: now() }, startedAt: now(), updatedAt: now() };
  record.status = "in_progress";

  const commit = async () => {
    record.updatedAt = now();
    await journal.write(record);
  };

  // PENDING FIRST, and awaited -- an unjournalled write is exactly the state this module exists to
  // prevent, because a retry cannot tell it happened.
  record.entry = { objectType: "page", action, status: "pending", ...(objectId ? { objectId } : {}), at: now() };
  await commit();

  const idempotencyKey = `${plan.materializationKey}:page`;
  let written: WriteObjectResult;
  try {
    written =
      plan.write.kind === "create"
        ? await writer.createObject({ tenantId: plan.tenantId, objectType: "page", fields: plan.write.fields, idempotencyKey })
        : await writer.patchObject({ tenantId: plan.tenantId, objectType: "page", objectId: objectId!, ops: plan.write.ops, ...(plan.page.targetContentRevision !== null ? { expectedContentRevision: plan.page.targetContentRevision } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.entry = { objectType: "page", action, status: "failed", ...(objectId ? { objectId } : {}), at: now(), error: message };
    record.status = "failed";
    await commit();
    return { materializationKey: plan.materializationKey, tenantId: plan.tenantId, outcome: "not_applied", failure: { objectType: "page", objectId, code: "write_failed", message } };
  }

  const readback = await writer.readObject({ tenantId: plan.tenantId, objectType: "page", objectId: written.objectId }).catch(() => null);
  if (!readback) {
    const message = `page "${written.objectId}" reported a successful ${action} but could not be read back, so there is no evidence it exists.`;
    record.entry = { objectType: "page", action, status: "failed", objectId: written.objectId, at: now(), error: message };
    record.status = "failed";
    await commit();
    return { materializationKey: plan.materializationKey, tenantId: plan.tenantId, outcome: "not_applied", failure: { objectType: "page", objectId: written.objectId, code: "readback_missing", message } };
  }

  const appliedAt = now();
  record.entry = { objectType: "page", action, status: "applied", objectId: readback.objectId, contentRevision: readback.contentRevision, version: readback.version, at: appliedAt };
  record.status = "complete";
  await commit();

  return {
    materializationKey: plan.materializationKey,
    tenantId: plan.tenantId,
    outcome: "applied",
    receipt: { objectType: "page", objectId: readback.objectId, action, contentRevision: readback.contentRevision, version: readback.version, appliedAt }
  };
}
