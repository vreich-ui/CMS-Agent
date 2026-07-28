// Platform's contribution to the generic project-hook registry (../projectHooks.ts). Object-native
// client: readiness gate, publish execution in the object dialect, and knowledge. No
// enforceCallToolPolicy is needed here — the legacy fallback tools Dr. Lurie's executable policy
// blocks do not exist on this client's server (they throw), and the config permission model
// (deny-by-default + explicit toolPolicies) is the access control layer.

import { evaluatePlatformPublishReadiness } from "./publishReadiness.js";
import { platformProjectKnowledge } from "./knowledge.js";
import { findDeep, findLockToken } from "../toolResultSearch.js";
import type { PublishExecutionContext, PublishExecutionOutcome } from "../projectHooks.js";

// The object-native publish dialect agreed on the alignment board:
//   object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin
// Validation runs BEFORE any patch (board B1), and publishRun never releases — the production
// release verb is a SEPARATE gate that must appear nowhere in this hook (board B2).
const PLATFORM_PUBLISH_TOOL_SEQUENCE = ["object_create", "object_checkout", "object_validate", "object_patch", "object_publish", "object_checkin"];

// D7 (Wolf): the client's judgement substrate. The engine must never write these into a client
// object, even though set_article_meta's open fields map would accept every one of them.
export const JUDGEMENT_SUBSTRATE_KEYS: ReadonlySet<string> = new Set(["scores", "claims", "sources", "compliance", "emotional_strategy", "lineage"]);

// Tolerant extractors over the client's tool results (envelope shapes vary; see toolResultSearch).
const findObjectId = (value: unknown): string | number | undefined =>
  findDeep(value, (key, child) => (key === "object_id" || key === "id") && ((typeof child === "string" && child !== "") || typeof child === "number")) as string | number | undefined;
const findRecordVersion = (value: unknown): string | number | undefined =>
  findDeep(value, (key, child) => key === "record_version" && (typeof child === "number" || (typeof child === "string" && child !== ""))) as string | number | undefined;

const executePublish = async (ctx: PublishExecutionContext): Promise<PublishExecutionOutcome> => {
  // a. Create the object. D2c: the server mints the id — NEVER send requested_id. The request id
  // stays run-correlation only and is never used as an object id.
  const created = await ctx.call("object_create", { object_type: ctx.clientObjectType });
  const mintedId = findObjectId(created);
  if (mintedId === undefined) throw new Error("create_missing_object_id: could not resolve a server-minted object id (object_id/id) from the object_create result.");
  const objectId = String(mintedId);

  // b. Checkout: take the edit lock and learn the record version the patch must expect.
  const checkout = await ctx.call("object_checkout", { object_id: objectId, ...ctx.owner });
  const lockToken = findLockToken(checkout);
  if (!lockToken) throw new Error("checkout_missing_lock_token: could not resolve lock_token from checkout result.");
  const recordVersion = findRecordVersion(checkout);
  if (recordVersion === undefined) throw new Error("checkout_missing_record_version: could not resolve record_version from checkout result.");

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
  const fields = Object.fromEntries(Object.entries(ctx.body).filter(([key]) => key !== "nodes" && !JUDGEMENT_SUBSTRATE_KEYS.has(key)));
  const nodes = Array.isArray(ctx.body.nodes) ? (ctx.body.nodes as unknown[]) : [];
  // Op arg shapes corrected from the LIVE contract (board platform#014, verbatim arg_schema):
  // set_article_meta is {op, fields, guard?} with `fields` REQUIRED — `meta` would be refused as
  // invalid_op before anything interesting happened. upsert_node {op, node} confirmed as assumed.
  // `guard` is deliberately omitted for now so a compare-and-set mismatch can never be confused
  // with a shape problem during the T1 shakeout.
  const candidatePatch: Array<Record<string, unknown>> = [{ op: "set_article_meta", fields }, ...nodes.map((node) => ({ op: "upsert_node", node }))];

  // d. Validate BEFORE any patch (board B1): the client's own validator is the authority on the
  // client shape, and its verdict is recorded as clientValidation evidence on the publish result.
  const validated = await ctx.call("object_validate", { object_id: objectId, candidate_patch: candidatePatch });
  const parsedValid = findDeep(validated, (key, child) => key === "valid" && typeof child === "boolean");
  const parsedIssues = findDeep(validated, (key, child) => key === "issues" && Array.isArray(child));
  const valid = typeof parsedValid === "boolean" ? parsedValid : false;
  const issues: unknown[] = Array.isArray(parsedIssues) ? parsedIssues : typeof parsedValid === "boolean" ? [] : ["unparseable_validate_result"];
  const clientValidation = {
    tool: "object_validate",
    candidate_patch_summary: `${candidatePatch.length} ops: 1 set_article_meta + ${nodes.length} upsert_node`,
    valid,
    issues
  };
  if (!valid) throw new Error(`object_validate_rejected: ${issues.slice(0, 5).map((issue) => (typeof issue === "string" ? issue : JSON.stringify(issue))).join("; ")}`);

  // e. Patch under the lock, pinned to the checked-out record version.
  await ctx.call("object_patch", { object_id: objectId, lock_token: lockToken, expected_record_version: recordVersion, patch: candidatePatch });

  // f. Publish (commit the export — NOT a release; board B2). Omitting published_time means
  // "immediate" per the client's M-6 pin rules, so it is only sent when the caller pinned a time.
  const publishResult = await ctx.call("object_publish", { object_id: objectId, lock_token: lockToken, ...(ctx.publishedTime ? { published_time: ctx.publishedTime } : {}) });

  // g. Best-effort lock release; a failure here only means the lease expires naturally.
  try { await ctx.call("object_checkin", { object_id: objectId, lock_token: lockToken }); } catch { /* lock expires on its own */ }

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
