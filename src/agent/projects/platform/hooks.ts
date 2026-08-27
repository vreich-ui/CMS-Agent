// Platform's contribution to the generic project-hook registry (../projectHooks.ts). Object-native
// client: readiness gate, publish execution in the object dialect, and knowledge. No
// enforceCallToolPolicy is needed here — the legacy fallback tools Dr. Lurie's executable policy
// blocks do not exist on this client's server (they throw), and the config permission model
// (deny-by-default + explicit toolPolicies) is the access control layer.

import { evaluatePlatformPublishReadiness } from "./publishReadiness.js";
import { platformProjectKnowledge } from "./knowledge.js";
import {
  EXCLUDED_CLIENT_BODY_KEYS,
  JUDGEMENT_SUBSTRATE_KEYS,
  buildArticleCandidatePatch,
  buildCreateBody,
  describeCandidatePatch,
  findObjectId,
  findRecordVersion,
  formatValidationIssues,
  parseValidateResult
} from "../objectDialect.js";
import { checkedClientCall, describeClientCallFailure } from "../clientToolResult.js";
import { findLockToken } from "../toolResultSearch.js";
import type { PublishExecutionContext, PublishExecutionOutcome } from "../projectHooks.js";

// The object-native publish dialect agreed on the alignment board:
//   object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin
// Validation runs BEFORE any patch (board B1), and publishRun never releases — the production
// release verb is a SEPARATE gate that must appear nowhere in this hook (board B2).
const PLATFORM_PUBLISH_TOOL_SEQUENCE = ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"];

// D7 (Wolf): the client's judgement substrate now lives in ../objectDialect.ts — the rule is a
// property of the shared object contract, not of one tenant. Re-exported so existing importers of
// this module keep resolving it.
export { JUDGEMENT_SUBSTRATE_KEYS };

const executePublish = async (ctx: PublishExecutionContext): Promise<PublishExecutionOutcome> => {
  // EVERY client call in this sequence goes through `call`, never ctx.call. ctx.call records the step
  // and throws when the TRANSPORT fails; it cannot throw when the client REFUSES, because an MCP
  // refusal (isError: true, reason in content[].text / structuredContent.error) rides home on a
  // successful transport. checkedClientCall closes that gap: a refusal becomes a typed
  // ClientToolRefusalError carrying the client's own sentence, its statusCode and its issues[],
  // instead of falling through to whichever field-reader ran next and being reported as OUR parser's
  // problem. See ../clientToolResult.ts for the live failure that motivated it.
  const call = checkedClientCall(ctx.call);

  // Per-site parameters come from the project config's objectDialect block, never from literals
  // here. platform declares siteObjectId "site_platform" (definition.ts) for exactly this call;
  // firing one tenant's site id at another's server is the failure this refusal prevents.
  const dialect = ctx.objectDialect;
  if (!dialect) throw new Error("missing_object_dialect: the platform project config declares no objectDialect (siteObjectId / taxonomyRegistryObjectId / objectIdSource); refusing to guess per-site parameters.");

  // a. Create the object under its owning site, carrying the body.
  //
  //    `site` is REQUIRED by the live create schema (object_create requires object_type + site +
  //    body; object_contract(content_item).auxiliary_inputs names it "the owning site object id").
  //    Omitting it was a 400 on every publish this client ever attempted. D2c is untouched by
  //    sending it: D2c is about `requested_id` — the server still mints the id here, and the request
  //    id stays run-correlation only.
  //
  //    `body` is required for the same reason and for a second one: the platform validates the body
  //    BEFORE persisting (content_item requires slug/title/nodes), so an empty create is a 422 and
  //    the create-empty-then-patch dialect cannot succeed at all. The patch step below is unchanged
  //    and still carries the full candidate — it is what keeps re-entry idempotent.
  //
  //    S3 item 8: a shell the conductor already created for this request is patched, not re-created.
  let objectId: string;
  if (ctx.existingObjectId) {
    objectId = ctx.existingObjectId;
  } else {
    const created = await call("object_create", {
      object_type: ctx.clientObjectType,
      site: dialect.siteObjectId,
      body: buildCreateBody(ctx.body, EXCLUDED_CLIENT_BODY_KEYS)
    });
    // Reached ONLY when the client did not signal an error — so this now means what it says: the
    // create SUCCEEDED and the success carried no id. It is not the catch-all it used to be; a
    // refusal is a ClientToolRefusalError naming object_create and quoting the client.
    const mintedId = findObjectId(created);
    if (mintedId === undefined) throw new Error("create_missing_object_id: object_create returned a SUCCESS result (no isError) that carries no server-minted object id (object_id/id).");
    objectId = String(mintedId);
  }

  // b. Checkout: take the edit lock and learn the record version the patch must expect.
  const checkout = await call("object_checkout", { object_id: objectId, ...ctx.owner });
  const lockToken = findLockToken(checkout);
  if (!lockToken) throw new Error("checkout_missing_lock_token: object_checkout returned a SUCCESS result (no isError) that carries no lock_token.");
  const recordVersion = findRecordVersion(checkout);
  if (recordVersion === undefined) throw new Error("checkout_missing_record_version: object_checkout returned a SUCCESS result (no isError) that carries no record_version.");

  // c. Build the candidate patch from the client object: one set_article_meta op carrying every
  // non-`nodes` top-level body field (slug, title, deck, description, author, taxonomy, seo,
  // editorial, ...), then one upsert_node op per body node, in order.
  //
  // D7 (Wolf, alignment board, 2026-07-28): ALL judgements stay workspace-side. The client schema
  // declares a judgement substrate (scores, claims, sources, compliance, emotional_strategy, lineage)
  // and set_article_meta's open fields map WOULD accept it — which is precisely why the generic
  // key-copy above must refuse those keys explicitly. Without this exclusion, an envelope whose body
  // happened to carry judge output would write it into the client object through an op that never
  // says "scores" anywhere — the open door the Platform session predicted would be walked through
  // under deadline. The engine never writes judgements into a client object; revisitable post-launch
  // with T1/T5 evidence, per the board record (decision taken on cost, not as a permanent boundary).
  // Arg shapes for these ops are the contract's declared op names with assumed payload keys; T1
  // (req_align_publishpath_20260728_50) is the live shakeout — adjust here, not in the generic
  // publisher, if the client rejects a shape.
  //
  // Op arg shapes corrected from the LIVE contract (board platform#014, verbatim arg_schema):
  // set_article_meta is {op, fields, guard?} with `fields` REQUIRED — `meta` would be refused as
  // invalid_op before anything interesting happened. upsert_node {op, node} confirmed as assumed.
  // `guard` is deliberately omitted for now so a compare-and-set mismatch can never be confused
  // with a shape problem during the T1 shakeout. The builder is shared with the other tenants of
  // this substrate (../objectDialect.ts) because the contract it encodes is the same one.
  // EXCLUDED_CLIENT_BODY_KEYS, not JUDGEMENT_SUBSTRATE_KEYS: the same set the create above sends.
  // The two must be identical or the create and the patch would disagree about what the object is —
  // and the extra key the shared set adds, `schema_version`, is rejected outright by this strict body.
  const { patch: candidatePatch, nodeCount } = buildArticleCandidatePatch(ctx.body, EXCLUDED_CLIENT_BODY_KEYS);

  // d. Validate BEFORE any patch (board B1): the client's own validator is the authority on the
  // client shape, and its verdict is recorded as clientValidation evidence on the publish result.
  // A REFUSED validate (isError) never reaches parseValidateResult: "the client would not judge this
  // candidate" and "the client judged it invalid" are different facts, and only the second one is a
  // verdict about the body.
  const validated = await call("object_validate", { object_id: objectId, candidate_patch: candidatePatch });
  const clientValidation = parseValidateResult(validated, describeCandidatePatch(candidatePatch, nodeCount));
  if (!clientValidation.valid) throw new Error(`object_validate_rejected: ${formatValidationIssues(clientValidation.issues)}`);

  // e. Patch under the lock, pinned to the checked-out record version.
  await call("object_patch", { object_id: objectId, lock_token: lockToken, expected_record_version: recordVersion, patch: candidatePatch });

  // f. Publish (commit the export — NOT a release; board B2). Omitting published_time means
  // "immediate" per the client's M-6 pin rules, so it is only sent when the caller pinned a time.
  const publishResult = await call("object_publish", { object_id: objectId, lock_token: lockToken, ...(ctx.publishedTime ? { published_time: ctx.publishedTime } : {}) });

  // g. Best-effort lock release. The export is already committed, so a refused checkin must never
  // turn a landed publish into a failure — the lease expires on its own. It must not be SILENT
  // either: the client's own sentence is named on the run log, which is the difference between "the
  // lease expired" and "we never knew". The object id is safe to log; the lock token is a capability
  // and is not.
  try {
    await call("object_checkin", { object_id: objectId, lock_token: lockToken });
  } catch (error) {
    console.warn("platform.object_checkin_refused", JSON.stringify({ objectId, clientError: describeClientCallFailure(error) }));
  }

  return { result: publishResult, objectId, clientValidation };
};

export const platformProjectHooks = {
  // GO/NO-GO publish-readiness gate: workspace body contract, pdf-tool-verified media, taxonomy,
  // pinned approval, release/build behavior, and platform's hard constraints (contentPath /
  // artifactProtocol / legacyFallbacksUsed).
  evaluatePublishReadiness: evaluatePlatformPublishReadiness,
  publishToolSequence: PLATFORM_PUBLISH_TOOL_SEQUENCE,
  executePublish,
  knowledge: platformProjectKnowledge
};
