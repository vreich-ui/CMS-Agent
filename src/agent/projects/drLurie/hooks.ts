// Dr. Lurie's contribution to the generic project-hook registry (../projectHooks.ts). This is the
// architecturally correct home for client rules: policy as a plugin the workspace invokes through
// project.validate_handoff / project.get — never prose baked into generic prompts or tools.

import { summarizeArtifactPolicyWarnings, validateNoRawImageArtifactPublicUrls, type ArtifactPolicyWarning } from "./artifactPolicy.js";
import { evaluateDrLurieCallToolPolicy } from "./executablePolicy.js";
import { evaluateDrLuriePublishReadiness } from "./publishReadiness.js";
import { drLurieProjectKnowledge } from "./knowledge.js";
import {
  JUDGEMENT_SUBSTRATE_KEYS,
  buildArticleCandidatePatch,
  describeCandidatePatch,
  findObjectId,
  findRecordVersion,
  formatValidationIssues,
  parseValidateResult
} from "../objectDialect.js";
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
const EXCLUDED_META_KEYS: ReadonlySet<string> = new Set([...JUDGEMENT_SUBSTRATE_KEYS, "schema_version"]);

const executePublish = async (ctx: PublishExecutionContext): Promise<PublishExecutionOutcome> => {
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
  const created = await ctx.call("object_create", {
    object_type: ctx.clientObjectType,
    site: dialect.siteObjectId,
    ...(dialect.objectIdSource === "request_id" ? { requested_id: ctx.requestId } : {})
  });
  const mintedId = findObjectId(created);
  if (mintedId === undefined) throw new Error("create_missing_object_id: could not resolve the object id (object_id/id) from the object_create result.");
  const objectId = String(mintedId);

  // b. Checkout: take the edit lock and learn the record version the patch must expect.
  const checkout = await ctx.call("object_checkout", { object_id: objectId, ...ctx.owner });
  const lockToken = findLockToken(checkout);
  if (!lockToken) throw new Error("checkout_missing_lock_token: could not resolve lock_token from checkout result.");
  const recordVersion = findRecordVersion(checkout);
  if (recordVersion === undefined) throw new Error("checkout_missing_record_version: could not resolve record_version from checkout result.");

  // c. Build the candidate patch: one set_article_meta op carrying every non-`nodes` top-level body
  //    field (slug, title, deck, description, author, taxonomy, seo, editorial, ...), then one
  //    upsert_node op per body node, in order.
  const { patch: candidatePatch, nodeCount } = buildArticleCandidatePatch(ctx.body, EXCLUDED_META_KEYS);

  // d. Validate BEFORE any patch (board B1): the client's own validator is the authority on the
  //    client shape, and its verdict is recorded as clientValidation evidence on the publish result.
  const validated = await ctx.call("object_validate", { object_id: objectId, candidate_patch: candidatePatch });
  const clientValidation = parseValidateResult(validated, describeCandidatePatch(candidatePatch, nodeCount));
  if (!clientValidation.valid) {
    // Taxonomy blockers are the common, actionable rejection: terms must resolve active in this
    // site's registry, so the message names the registry the operator has to extend or correct.
    const issues = formatValidationIssues(clientValidation.issues);
    const taxonomyHint = /taxonom|term/i.test(issues) ? ` (taxonomy terms resolve against ${dialect.taxonomyRegistryObjectId})` : "";
    throw new Error(`object_validate_rejected: ${issues}${taxonomyHint}`);
  }

  // e. Patch under the lock, pinned to the checked-out record version.
  await ctx.call("object_patch", { object_id: objectId, lock_token: lockToken, expected_record_version: recordVersion, patch: candidatePatch });

  // f. Publish (commit the export — NOT a release; board B2). Omitting published_time means
  //    "immediate" per the client's M-6 pin rules, so it is only sent when the caller pinned a time.
  const publishResult = await ctx.call("object_publish", { object_id: objectId, lock_token: lockToken, ...(ctx.publishedTime ? { published_time: ctx.publishedTime } : {}) });

  // g. Best-effort lock release; a failure here only means the lease expires naturally.
  try { await ctx.call("object_checkin", { object_id: objectId, lock_token: lockToken }); } catch { /* lock expires on its own */ }

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
  knowledge: drLurieProjectKnowledge
};
