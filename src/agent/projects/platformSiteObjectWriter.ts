// P2 v2 -- the REAL SiteObjectWriter binding for a `page` object, over the same
// checkout -> validate -> patch -> checkin dialect drLurie/hooks.ts and platform/hooks.ts already
// speak for content_item (objectDialect.ts's own header names the shared sequence). This module
// exists only so siteContentObjectApplier.ts's port has a live implementation; nothing wires it into
// a workflow node or a tenant's scoped bearer here -- see siteContentTools.ts's own comment on
// `site_content.apply_page_objects` for why that is a separate, later decision.
//
// TESTED ONLY AGAINST A MOCKED ClientToolCall. Every call this module makes is write-adjacent
// (object_create, object_checkout, object_validate, object_patch, object_checkin) and per this task's
// own instruction none of them may be exercised against the live connector -- only object_contract,
// object_get, registry_get and object_inventory may run live, and this module never calls any of
// those either except object_get (read-only, already in READ_TOOL_ALLOWLIST) for the pre-patch
// staleness check and the post-write readback.
//
// FIELD NAMES: WHAT IS EVIDENCED, WHAT IS NOT. object_contract's own `workflow.sequence`
// (read live, 2026-09-18) states the shape in prose: "object_checkout -> lock_token + record_version"
// then "object_patch (with lock_token + expected_record_version)" -- so the ARGS this module sends are
// exactly as documented (`lock_token`, `expected_record_version`, snake_case) and match every other
// live caller of this dialect (drLurie/hooks.ts, platform/hooks.ts). What object_contract does NOT
// give is the checkout RESPONSE's own field spelling, and toolResultSearch.ts's `findLockToken`
// already carries the answer from a REAL failure this codebase hit: the checkout response returns
// `lockToken` (camelCase), not `lock_token` -- run_1787930929962_njffct, 2026-08-28, documented in
// that module's own header. This writer reuses that reader (and objectDialect.ts's `findRecordVersion`
// / `findObjectId`) rather than re-deriving the tolerance from scratch, so the two dialects cannot
// drift apart on a shape this codebase has already been burned by once.
//
// readContentRevision/readVersion USE THE SAME findDeep TOLERANCE, AND THAT WAS A REAL BUG, NOT
// DEFENSIVE PADDING (corrected 2026-09-18, post-merge adversarial review of PR #387). A live,
// read-only `object_get({object_type:"page", object_id:"page_home", projection:"summary"})` call
// shows the real envelope nests EVERYTHING under a `record` key:
// `{record: {..., version, content_revision, body: {...}}}` -- not at the envelope's own top level, the
// depth this module originally read at. A shallow reader therefore found nothing on a REAL response,
// so `readObject` always returned null in production, the staleness guard failed open, and -- worse --
// a `createObject` whose object_create response nests the same way would report a landed create as
// `not_applied`, then `blocked_indeterminate` on the applier's own retry (siteContentObjectApplier.ts):
// an orphan object nobody is told about. `readContentRevision`/`readVersion` now use `findDeep` -- the
// SAME depth-agnostic search `findObjectId`/`findRecordVersion` (objectDialect.ts) already used, which
// is exactly why those two never showed this bug and readContentRevision/readVersion did. What is NOT
// independently re-confirmed here (forbidden -- see above) is object_create/object_patch's OWN response
// envelope for `content_revision`/`version` -- only object_get's was read live; findDeep's bounded
// (depth <= 6) walk is what carries the same tolerance to those two without a second live call. When
// either counter is absent even after the deep search, this module still defers ENTIRELY to the
// applier's mandatory readback (object_get) for the receipt it actually records -- a provisional 0 here
// is never treated as evidence of anything, only as a placeholder the readback immediately supersedes.
//
// dedupesByIdempotencyKey IS FALSE. objectDialect.ts's own P5 note (quoted in this module's tests)
// says object_create's idempotency_key replay is best-effort: "the handler runs the side effect
// before attempting to store its successful result... Result storage is best-effort; failures are not
// cached." That is not a guarantee a retry collapses onto the first attempt -- it is a description of
// exactly the race this applier's `indeterminate_prior_attempt` path exists to catch. Declaring `true`
// here would be the "invented" trust siteContentObjectApplier.ts's own header warns against; `false`
// costs a human a look at object_inventory before a crashed create is retried, which is a small price
// for never risking a silently duplicated page.
import { findDeep, findLockToken } from "./toolResultSearch.js";
import { findObjectId, findRecordVersion, parseValidateResult, formatValidationIssues } from "./objectDialect.js";
import { checkedClientCall, describeClientCallFailure, type ClientToolCall } from "./clientToolResult.js";
import type { PageObjectPatchOp } from "../operations/siteContentObjectCompiler.js";
import type { SiteObjectWriter, WriteObjectResult } from "../operations/siteContentObjectApplier.js";

// Depth-agnostic, matching objectDialect.ts's findObjectId/findRecordVersion -- see this module's own
// header ("readContentRevision/readVersion USE THE SAME findDeep TOLERANCE") for the real, nested
// `{record: {content_revision, version, ...}}` envelope this replaced a shallow top-level read for.
const readNumberField = (value: unknown, names: readonly string[]): number | undefined =>
  findDeep(value, (key, child) => names.includes(key) && typeof child === "number") as number | undefined;
const readContentRevision = (value: unknown): number | undefined => readNumberField(value, ["content_revision", "contentRevision"]);
const readVersion = (value: unknown): number | undefined => readNumberField(value, ["version"]);

// Wire spelling of a page-patch op, exactly as object_contract's live patch_ops arg_schemas name
// their fields (object_id/section_id snake_case; `op` and `section`/`fields`/`visibility` unchanged).
// This module's own PageObjectPatchOp type (siteContentObjectCompiler.ts) uses camelCase internally
// to match this codebase's own TS convention; the translation happens ONLY here, at the wire boundary.
const toWireOp = (op: PageObjectPatchOp): Record<string, unknown> => {
  switch (op.op) {
    case "set_page_meta":
      return { op: "set_page_meta", fields: op.fields };
    case "upsert_section":
      return { op: "upsert_section", section: op.section, ...(op.position !== undefined ? { position: op.position } : {}) };
    case "update_section_data":
      return { op: "update_section_data", section_id: op.sectionId, fields: op.fields };
    case "move_section":
      return { op: "move_section", section_id: op.sectionId, to_index: op.toIndex };
    case "set_section_visibility":
      return { op: "set_section_visibility", section_id: op.sectionId, visibility: op.visibility };
    case "remove_section":
      return { op: "remove_section", section_id: op.sectionId };
    case "set_tracking":
      // The live arg_schema is `{op, fields}` (fields nullable) -- no `section_id`, and no rename.
      return { op: "set_tracking", fields: op.fields };
  }
};

export type PlatformSiteObjectWriterDeps = {
  // The unchecked tenant call -- the same `ctx.call` every project hook receives. Wrapped internally
  // with checkedClientCall so an isError result becomes a typed ClientToolRefusalError, matching
  // every other caller of this dialect.
  call: ClientToolCall;
  // ProjectObjectDialect.siteObjectId -- object_create's required `site` argument (the owning site
  // object id, e.g. "site_platform"). Callers resolve this from the project's own objectDialect
  // record; this module never guesses it.
  siteObjectId: string;
  // Passed through to object_checkout verbatim when set; omitted uses the tenant's own default lease.
  leaseSeconds?: number;
  // Attribution recorded on the checkout lock (object_checkout's own `agent_name`), matching
  // drLurie/hooks.ts's convention. Optional: a caller with no per-agent identity yet omits it.
  agentName?: string;
};

/**
 * The live `page` object writer: object_create (with idempotency_key) for a create, and the full
 * checkout -> (staleness check) -> validate -> patch -> checkin sequence for a patch. See this
 * module's own header for what is and is not independently evidenced.
 */
export function createPlatformSiteObjectWriter(deps: PlatformSiteObjectWriterDeps): SiteObjectWriter {
  const call = checkedClientCall(deps.call);

  return {
    dedupesByIdempotencyKey: false,

    async createObject({ objectType, fields, idempotencyKey }): Promise<WriteObjectResult> {
      const created = await call("object_create", {
        object_type: objectType,
        site: deps.siteObjectId,
        body: fields,
        idempotency_key: idempotencyKey,
        ...(deps.agentName ? { agent_name: deps.agentName } : {})
        // requested_id is deliberately omitted: page ids are server-minted (object_contract's own
        // id_object constraint -- "page_ / ... + lowercase; omit requested_id on create to have it
        // minted"), so this writer never invents one.
      });
      const objectId = findObjectId(created);
      if (objectId === undefined) {
        throw new Error(`platform_object_create_missing_id: object_create for a "${objectType}" succeeded (no isError) but returned no object id (object_id/id).`);
      }
      return { objectId: String(objectId), contentRevision: readContentRevision(created) ?? 0, version: readVersion(created) ?? 0 };
    },

    async patchObject({ objectType, objectId, ops, expectedContentRevision }): Promise<WriteObjectResult> {
      const checkout = await call("object_checkout", {
        object_type: objectType,
        object_id: objectId,
        ...(deps.leaseSeconds !== undefined ? { lease_seconds: deps.leaseSeconds } : {}),
        ...(deps.agentName ? { agent_name: deps.agentName } : {})
      });
      const lockToken = findLockToken(checkout);
      if (!lockToken) throw new Error(`platform_checkout_missing_lock_token: object_checkout for "${objectType}" "${objectId}" succeeded (no isError) but returned no lock_token.`);
      const recordVersion = findRecordVersion(checkout);
      if (recordVersion === undefined) throw new Error(`platform_checkout_missing_record_version: object_checkout for "${objectType}" "${objectId}" succeeded (no isError) but returned no record_version.`);

      let checkedIn = false;
      const checkin = async (): Promise<void> => {
        if (checkedIn) return;
        checkedIn = true;
        try {
          await call("object_checkin", { object_type: objectType, object_id: objectId, lock_token: lockToken });
        } catch (error) {
          // Same discipline as drLurie/hooks.ts's own checkin warning: a refused checkin must never
          // turn a landed (or correctly-refused) patch into a reported failure -- the lease expires on
          // its own -- but it must not be silent either.
          console.warn("platform_site_object_writer.checkin_failed", JSON.stringify({ objectType, objectId, clientError: describeClientCallFailure(error) }));
        }
      };

      try {
        // Read-under-lease, compared against the plan's OWN frozen belief. This is a fast, honest
        // failure ahead of object_patch's own (also real) expected_record_version check -- it names
        // the fact ("the page moved") instead of leaving a caller to decode a 409.
        if (expectedContentRevision !== undefined) {
          const current = await call("object_get", { object_type: objectType, object_id: objectId });
          const currentRevision = readContentRevision(current);
          if (currentRevision !== undefined && currentRevision !== expectedContentRevision) {
            throw new Error(`page_target_moved: "${objectId}" is at content revision ${currentRevision}, not the ${expectedContentRevision} this plan was compiled against. Re-read the page, re-approve, and recompile.`);
          }
        }

        const wireOps = ops.map(toWireOp);
        const validated = await call("object_validate", { object_type: objectType, object_id: objectId, candidate_patch: wireOps });
        const validation = parseValidateResult(validated, `${wireOps.length} page patch op(s): ${ops.map((op) => op.op).join(", ")}`);
        if (!validation.valid) throw new Error(`platform_patch_invalid: object_validate refused this page patch: ${formatValidationIssues(validation.issues)}`);

        const patched = await call("object_patch", { object_type: objectType, object_id: objectId, lock_token: lockToken, expected_record_version: recordVersion, ops: wireOps });
        const patchedId = findObjectId(patched) ?? objectId;
        return { objectId: String(patchedId), contentRevision: readContentRevision(patched) ?? 0, version: readVersion(patched) ?? 0 };
      } finally {
        await checkin();
      }
    },

    async readObject({ objectType, objectId }) {
      let result: unknown;
      try {
        result = await call("object_get", { object_type: objectType, object_id: objectId });
      } catch {
        // A refused read (not found, or any other client refusal) is reported as "not there" -- the
        // same honest absence a null return already means to the applier; it never guesses which.
        return null;
      }
      const contentRevision = readContentRevision(result);
      const version = readVersion(result);
      if (contentRevision === undefined || version === undefined) return null;
      const foundId = findObjectId(result) ?? objectId;
      return { objectId: String(foundId), contentRevision, version };
    }
  };
}
