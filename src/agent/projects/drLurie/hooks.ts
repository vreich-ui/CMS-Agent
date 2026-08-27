// Dr. Lurie's contribution to the generic project-hook registry (../projectHooks.ts). This is the
// architecturally correct home for client rules: policy as a plugin the workspace invokes through
// project.validate_handoff / project.get — never prose baked into generic prompts or tools.

import { summarizeArtifactPolicyWarnings, validateNoRawImageArtifactPublicUrls, type ArtifactPolicyWarning } from "./artifactPolicy.js";
import { evaluateDrLurieCallToolPolicy } from "./executablePolicy.js";
import { evaluateDrLuriePublishReadiness } from "./publishReadiness.js";
import { drLurieProjectKnowledge } from "./knowledge.js";
import { DR_LURIE_VOICE_FALLBACK } from "./editorialVoice.js";
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

const validateHandoffPolicy = (payload: { contentSource?: unknown; articleBody?: unknown }): ArtifactPolicyWarning[] => [
  // Article bodies get the full artifact policy: inline image placement + raw artifact URL rules
  // + the PDF fallback advisory.
  ...(payload.articleBody !== undefined ? summarizeArtifactPolicyWarnings(payload.articleBody) : []),
  // Content-source envelopes are scanned for raw image artifact references leaking into
  // public-facing fields.
  ...(payload.contentSource !== undefined ? validateNoRawImageArtifactPublicUrls(payload.contentSource) : [])
];

// The object-native publish dialect, the ONLY sanctioned publish path for this client:
//   object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin
// Validation runs BEFORE any patch (board B1), and publishRun never releases — the production
// release verb is a SEPARATE gate that must appear nowhere in this hook (board B2).
//
// This replaced the frozen save_json_blob_* dialect (create_article_draft -> checkout_request ->
// publish_by_time -> checkin_request). That pipeline is legacy: its post collection was wiped and
// the ratified alignment doc (vreich-ui/platform, docs/agents/cms-agent-contract-alignment.md)
// froze it and directed that save_json_blob_* is NOT to be allowlisted for dr-lurie. The seeded
// config blocks the whole family (see definition.ts) and executablePolicy.ts refuses it at
// call_tool time, so there is no path back to it from here.
const DR_LURIE_PUBLISH_TOOL_SEQUENCE = ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"];

// Keys the engine must never write into the client object:
//   - the judgement substrate (D7) — all judgements stay workspace-side, and set_article_meta's open
//     `fields` map would otherwise accept every one of them;
//   - `schema_version` — client_object.v1's own label. The content_item body has NO schema_version and
//     is zod .strict(), so carrying it through would be rejected at write (mapping rule: drop it).
// Kept as a named local for readers of this file; the set itself now lives in ../objectDialect.ts so
// platform speaks the identical dialect (it previously excluded the judgement substrate only).
const EXCLUDED_META_KEYS: ReadonlySet<string> = EXCLUDED_CLIENT_BODY_KEYS;

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
  // here — the owning site object id and the taxonomy registry differ per tenant on this substrate,
  // and firing one tenant's identifiers at another's server is exactly the failure this prevents.
  const dialect = ctx.objectDialect;
  if (!dialect) throw new Error("missing_object_dialect: the dr-lurie project config declares no objectDialect (siteObjectId / taxonomyRegistryObjectId / objectIdSource); refusing to guess per-site parameters.");

  // a. Create the object under its owning site. object_contract(content_item).auxiliary_inputs names
  //    `site` ("the owning site object id") as the create-time input. Unlike platform (server-minted
  //    ids, board D2c), this client's content_item KEEPS the request-id shape as its object id
  //    (constraint id_object), so the caller-supplied request id is sent as requested_id — the
  //    publisher has already validated it against this project's declared request-id pattern.
  //    S3 item 8: when the conductor already created the content-item shell for this request (before
  //    artifact_plan), that object is patched — a second object_create under the same requested_id
  //    would either collide or fork the request.
  let objectId: string;
  if (ctx.existingObjectId) {
    objectId = ctx.existingObjectId;
  } else {
    const created = await call("object_create", {
      object_type: ctx.clientObjectType,
      site: dialect.siteObjectId,
      // The body is REQUIRED at create time: this platform validates it BEFORE persisting
      // (content_item requires slug/title/nodes), so the create-empty-then-patch dialect this hook
      // used to speak was a 422 that never made an object. The patch step below is unchanged and
      // still carries the full candidate, which is what keeps re-entry idempotent.
      body: buildCreateBody(ctx.body, EXCLUDED_META_KEYS),
      ...(dialect.objectIdSource === "request_id" ? { requested_id: ctx.requestId } : {})
    });
    // Reached ONLY when the client did not signal an error — so this now means what it says: the
    // create SUCCEEDED and the success carried no id. On run_1787656120374_18bobg it was raised for
    // a create the client had refused outright (object_inventory proved no object existed), which is
    // how a refusal came to be reported as an unfamiliar response shape. It is meant to be rare.
    const mintedId = findObjectId(created);
    if (mintedId === undefined) throw new Error("create_missing_object_id: object_create returned a SUCCESS result (no isError) that carries no object id (object_id/id).");
    objectId = String(mintedId);
  }

  // b. Checkout: take the edit lock and learn the record version the patch must expect.
  const checkout = await call("object_checkout", { object_type: ctx.clientObjectType, object_id: objectId, ...ctx.owner });
  const lockToken = findLockToken(checkout);
  if (!lockToken) throw new Error("checkout_missing_lock_token: object_checkout returned a SUCCESS result (no isError) that carries no lock_token.");
  const recordVersion = findRecordVersion(checkout);
  if (recordVersion === undefined) throw new Error("checkout_missing_record_version: object_checkout returned a SUCCESS result (no isError) that carries no record_version.");

  // c. Build the candidate patch: one set_article_meta op carrying every non-`nodes` top-level body
  //    field (slug, title, deck, description, author, taxonomy, seo, editorial, ...), then one
  //    upsert_node op per body node, in order.
  const { patch: candidatePatch, nodeCount } = buildArticleCandidatePatch(ctx.body, EXCLUDED_META_KEYS);

  // d. Validate BEFORE any patch (board B1): the client's own validator is the authority on the
  //    client shape, and its verdict is recorded as clientValidation evidence on the publish result.
  //    A REFUSED validate (isError) never reaches parseValidateResult: "the client would not judge
  //    this candidate" and "the client judged it invalid" are different facts, and only the second
  //    one is a verdict about the body.
  const validated = await call("object_validate", { object_type: ctx.clientObjectType, object_id: objectId, candidate_patch: candidatePatch });
  const clientValidation = parseValidateResult(validated, describeCandidatePatch(candidatePatch, nodeCount));
  if (!clientValidation.valid) {
    // Taxonomy blockers are the common, actionable rejection: terms must resolve active in this
    // site's registry, so the message names the registry the operator has to extend or correct.
    const issues = formatValidationIssues(clientValidation.issues);
    const taxonomyHint = /taxonom|term/i.test(issues) ? ` (taxonomy terms resolve against ${dialect.taxonomyRegistryObjectId})` : "";
    throw new Error(`object_validate_rejected: ${issues}${taxonomyHint}`);
  }

  // e. Patch under the lock, pinned to the checked-out record version.
  await call("object_patch", { object_type: ctx.clientObjectType, object_id: objectId, lock_token: lockToken, expected_record_version: recordVersion, patch: candidatePatch });

  // f. Publish (commit the export — NOT a release; board B2). Omitting published_time means
  //    "immediate" per the client's M-6 pin rules, so it is only sent when the caller pinned a time.
  const publishResult = await call("object_publish", { object_type: ctx.clientObjectType, object_id: objectId, lock_token: lockToken, ...(ctx.publishedTime ? { published_time: ctx.publishedTime } : {}) });

  // g. Best-effort lock release. The export is already committed, so a refused checkin must never
  //    turn a landed publish into a failure — the lease expires on its own. It must not be SILENT
  //    either: the client's own sentence is named on the run log, which is the difference between
  //    "the lease expired" and "we never knew". The object id is safe to log; the lock token is a
  //    capability and is not.
  try {
    await call("object_checkin", { object_type: ctx.clientObjectType, object_id: objectId, lock_token: lockToken });
  } catch (error) {
    console.warn("dr_lurie.object_checkin_refused", JSON.stringify({ objectId, clientError: describeClientCallFailure(error) }));
  }

  return { result: publishResult, objectId, clientValidation };
};

export const drLurieProjectHooks = {
  validateHandoffPolicy,
  // Blocks legacy artifact fallback tools, the retired publish dialect, and fallback artifact-source
  // arguments at call_tool time.
  enforceCallToolPolicy: evaluateDrLurieCallToolPolicy,
  // GO/NO-GO publish-readiness gate: pdf-tool-verified media, taxonomy, pinned approval, and hard
  // constraints (contentPath / artifactProtocol / legacyFallbacksUsed) before any live publish.
  evaluatePublishReadiness: evaluateDrLuriePublishReadiness,
  publishToolSequence: DR_LURIE_PUBLISH_TOOL_SEQUENCE,
  executePublish,
  knowledge: drLurieProjectKnowledge,
  // voicePrefetch.ts falls back to this ONLY when the live voice_drlurie object is unconfigured,
  // unreachable, or missing (a named, run-visible warning always accompanies the fallback).
  editorialVoiceFallback: DR_LURIE_VOICE_FALLBACK
};
