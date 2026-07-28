// Dr. Lurie's contribution to the generic project-hook registry (../projectHooks.ts). This is the
// architecturally correct home for client rules: policy as a plugin the workspace invokes through
// project.validate_handoff / project.get — never prose baked into generic prompts or tools.

import { summarizeArtifactPolicyWarnings, validateNoRawImageArtifactPublicUrls, type ArtifactPolicyWarning } from "./artifactPolicy.js";
import { evaluateDrLurieCallToolPolicy } from "./executablePolicy.js";
import { evaluateDrLuriePublishReadiness } from "./publishReadiness.js";
import { drLurieProjectKnowledge } from "./knowledge.js";
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

// Dr. Lurie's LEGACY publish dialect: create draft -> checkout (lock) -> publish_by_time -> checkin,
// via the save_json_blob_* tools. This is the exact sequence the generic publisher used to inline;
// it moved here unchanged when publish execution became a per-project hook. publishRun never
// releases (board B2) — there is no release step in this dialect.
const executePublish = async (ctx: PublishExecutionContext): Promise<PublishExecutionOutcome> => {
  await ctx.call("save_json_blob_create_article_draft", { request_id: ctx.requestId, input: { record_type: "content_source", schema_version: "content_source.v1", content: { article_body: ctx.body } } });
  const checkout = await ctx.call("save_json_blob_checkout_request", { request_id: ctx.requestId, ...ctx.owner });
  const lockToken = findLockToken(checkout);
  if (!lockToken) throw new Error("checkout_missing_lock_token: could not resolve lock_token from checkout result.");
  const publishResult = await ctx.call("save_json_blob_publish_by_time", { request_id: ctx.requestId, lock_token: lockToken, ...(ctx.publishedTime ? { published_time: ctx.publishedTime } : {}) });
  // Best-effort lock release; a failure here only means the lease expires naturally.
  try { await ctx.call("save_json_blob_checkin_request", { request_id: ctx.requestId, lock_token: lockToken }); } catch { /* lock expires on its own */ }
  return { result: publishResult };
};

export const drLurieProjectHooks = {
  validateHandoffPolicy,
  // Blocks legacy artifact fallback tools and fallback artifact-source arguments at call_tool time.
  enforceCallToolPolicy: evaluateDrLurieCallToolPolicy,
  // GO/NO-GO publish-readiness gate: pdf-tool-verified media, taxonomy, pinned approval, and hard
  // constraints (contentPath / artifactProtocol / legacyFallbacksUsed) before any live publish.
  evaluatePublishReadiness: evaluateDrLuriePublishReadiness,
  publishToolSequence: ["save_json_blob_create_article_draft", "save_json_blob_checkout_request", "save_json_blob_publish_by_time", "save_json_blob_checkin_request"],
  executePublish,
  knowledge: drLurieProjectKnowledge
};
