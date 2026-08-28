// Shared helpers for the OBJECT-NATIVE publish dialect
//   object_create -> object_checkout -> object_validate -> object_patch -> object_publish -> object_checkin
// which every tenant of the object substrate speaks (platform/client 0 and Dr. Lurie today). The
// per-client hooks own their own call sequence and per-site parameters; what lives here is the part
// that is genuinely identical across tenants because it is derived from the SAME enforcing code —
// the content_item body/op contract served by object_contract.
//
// Nothing in this module is client-specific: no site ids, no taxonomy registries, no request-id
// shapes. Those are per-site parameters and come from the project config's objectDialect block.

import { findDeep } from "./toolResultSearch.js";
import { isAlreadyExistsRefusal, type ClientToolCall } from "./clientToolResult.js";
import type { ProjectObjectDialect } from "./projectTypes.js";

// D7 (Wolf, alignment board 2026-07-28): the client's judgement substrate. The engine must never
// write these into a client object, even though set_article_meta's open `fields` map would accept
// every one of them — the live arg_schema is `{op, fields, guard?}` with fields typed as an open
// JSON map, so a body that happened to carry judge output would otherwise be written through an op
// that never says "scores" anywhere. All judgements stay workspace-side.
export const JUDGEMENT_SUBSTRATE_KEYS: ReadonlySet<string> = new Set(["scores", "claims", "sources", "compliance", "emotional_strategy", "lineage"]);

// Every key the engine must strip before a client body crosses the wire, in EITHER direction — the
// D7 judgement substrate above plus `schema_version`, which is client_object.v1's own envelope label
// and has no place in a content_item body (that body is zod .strict(), so carrying it through is
// rejected at write). Dr. Lurie's hook declared this pair locally; platform's did not, which left
// platform's set_article_meta willing to send `schema_version` into a strict schema. One shared set
// means the two tenants of this substrate cannot drift apart again.
export const EXCLUDED_CLIENT_BODY_KEYS: ReadonlySet<string> = new Set([...JUDGEMENT_SUBSTRATE_KEYS, "schema_version"]);

// Tolerant extractors over a client's tool results (envelope shapes vary; see toolResultSearch).
export const findObjectId = (value: unknown): string | number | undefined =>
  findDeep(value, (key, child) => (key === "object_id" || key === "id") && ((typeof child === "string" && child !== "") || typeof child === "number")) as string | number | undefined;

export const findRecordVersion = (value: unknown): string | number | undefined =>
  findDeep(value, (key, child) => key === "record_version" && (typeof child === "number" || (typeof child === "string" && child !== ""))) as string | number | undefined;

export type CandidatePatch = Array<Record<string, unknown>>;

// Build the candidate patch from a client object: one set_article_meta op carrying every top-level
// body field that is not `nodes` and not excluded, then one upsert_node op per body node, in order.
//
// Op arg shapes are the LIVE contract's (object_contract(content_item).patch_ops, verbatim
// arg_schema): set_article_meta is {op, fields, guard?} with `fields` REQUIRED — `meta` is refused
// as invalid_op before anything interesting happens — and upsert_node is {op, node, position?}.
// `guard` is deliberately omitted so a compare-and-set mismatch can never be confused with a shape
// problem during a live shakeout.
export const buildArticleCandidatePatch = (body: Record<string, unknown>, excludedMetaKeys: ReadonlySet<string>): { patch: CandidatePatch; nodeCount: number } => {
  const fields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "nodes" && !excludedMetaKeys.has(key)));
  const nodes = Array.isArray(body.nodes) ? (body.nodes as unknown[]) : [];
  return { patch: [{ op: "set_article_meta", fields }, ...nodes.map((node) => ({ op: "upsert_node", node }))], nodeCount: nodes.length };
};

// The body to send AT CREATE TIME. object_create's live schema requires {object_type, site, body}
// and the platform validates that body BEFORE persisting (content_item requires slug/title/nodes),
// so the historical create-empty-then-patch dialect is structurally unsatisfiable: an empty create is
// a 422 and every later step then addresses an object that was never made. The create therefore
// carries the same client object the patch does, minus the keys the engine must never write.
// The patch step still runs afterwards and is unchanged — it is what makes re-entry over an
// already-created object (the S3 item 8 shell, or a retried run) idempotent.
export const buildCreateBody = (
  body: Record<string, unknown>,
  excludedKeys: ReadonlySet<string> = EXCLUDED_CLIENT_BODY_KEYS
): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([key]) => !excludedKeys.has(key)));

// WHERE THE OBJECT ID COMES FROM, recorded so a receipt reader can tell a first attempt from a
// re-entry. "created" is the ordinary path; "adopted_existing" means this run found the object its
// own request id names already there and continued over it; "conductor_shell" is the content-item
// shell artifact_plan made before this publish began (S3 item 8).
export type PublishObjectOrigin = "created" | "adopted_existing" | "conductor_shell";

export type ObjectCreation = { objectId: string; origin: Extract<PublishObjectOrigin, "created" | "adopted_existing"> };

/**
 * object_create for a publish that may be a RE-ENTRY — the shared half of both tenants' step (a).
 *
 * Live, 2026-08-27 (run_1787862284296_x53xz0, dr-lurie): object_create SUCCEEDED and object_checkout
 * then refused, so the attempt threw before it could return the id it had just minted. The run kept
 * no record of the object, and every retry re-created and 409'd — the run was unrecoverable through
 * the pipeline for an article that already existed.
 *
 * TWO GUARDS, both required, because adopting the WRONG object would publish somebody else's article
 * under this request's approval:
 *   1. the dialect must mint the object id from the request id (objectIdSource "request_id"). On a
 *      server-minted dialect a 409 identifies no object at all — we never told the server which id to
 *      use — so there is nothing to adopt and the refusal is rethrown untouched.
 *   2. the refusal must be the client's genuine already-exists answer: status 409 AND its own
 *      "already exists" sentence (isAlreadyExistsRefusal).
 * The adopted id is then the id the create REQUESTED — `requestId`, the exact value sent as
 * `requested_id` — never an id read back out of an error, and never a guess.
 */
export async function createOrAdoptObject(params: {
  // Log prefix, e.g. "dr_lurie" — the same convention the hooks' checkin warning uses.
  project: string;
  // The CHECKED call (checkedClientCall), so a refusal arrives as a typed ClientToolRefusalError.
  call: ClientToolCall;
  dialect: ProjectObjectDialect;
  requestId: string;
  args: Record<string, unknown>;
}): Promise<ObjectCreation> {
  const { project, call, dialect, requestId, args } = params;
  let created: unknown;
  try {
    // idempotency_key is the run's own requestId, unmodified: stable across every retry of THIS
    // publish (a workflow_retry_node re-entry hands createOrAdoptObject the SAME requestId it used
    // the first time, exactly like requested_id above already relies on for the request_id dialect),
    // and distinct per request (a different article/run gets its own requestId). A timestamp or
    // attempt counter would defeat the point — either would mint a NEW key on the very retry this
    // exists to catch. On the server_minted dialect (platform), where a 409 cannot be adopted (see
    // the guard below), this is what actually closes the gap: a retry now replays the first attempt's
    // stored object_create result instead of minting a second object.
    created = await call("object_create", { ...args, idempotency_key: requestId });
  } catch (error) {
    if (dialect.objectIdSource !== "request_id" || !isAlreadyExistsRefusal(error)) throw error;
    // Named on the run log, not swallowed: "this run re-entered" and "this run created" are different
    // facts about a live site, and only one of them left an object behind on an earlier attempt. The
    // structured counterpart travels home on the publish record (PublishExecutionReceipts.objectOrigin).
    console.warn(`${project}.object_create_adopted_existing`, JSON.stringify({ objectId: requestId, clientError: error.clientError }));
    return { objectId: requestId, origin: "adopted_existing" };
  }
  // Reached ONLY when the client did not signal an error — so this means what it says: the create
  // SUCCEEDED and the success carried no id.
  const mintedId = findObjectId(created);
  if (mintedId === undefined) {
    throw new Error(`create_missing_object_id: object_create returned a SUCCESS result (no isError) that carries no ${dialect.objectIdSource === "server_minted" ? "server-minted " : ""}object id (object_id/id).`);
  }
  return { objectId: String(mintedId), origin: "created" };
}

// What an object_create answer actually says, read at EVERY envelope level this substrate uses.
// The platform answers {content:[{type:"text",text:JSON}], structuredContent:{record:{object_id,…}}},
// so a reader pinned to the raw result's own top level sees none of it. `existed` is true when the
// client is telling us this call did not make a new object: an explicit created:false / existing:true
// / idempotent_replay:true, or the substrate's real replay key, `replayed_from_idempotency_key`,
// which is a VALUE (the key echoed back), not a boolean — a boolean-only reader misses every replay.
export type CreateOutcome = { objectId: string | undefined; existed: boolean };
export const readCreateOutcome = (result: unknown): CreateOutcome => {
  const flag = (name: string): boolean | undefined =>
    findDeep(result, (key, child) => key === name && typeof child === "boolean") as boolean | undefined;
  const replayKey = findDeep(result, (key, child) => key === "replayed_from_idempotency_key" && child !== null && child !== undefined && child !== "");
  const minted = findObjectId(result);
  return {
    objectId: minted === undefined ? undefined : String(minted),
    existed: flag("created") === false || flag("existing") === true || flag("idempotent_replay") === true || replayKey !== undefined
  };
};

export type ClientValidation = { tool: string; candidate_patch_summary: string; valid: boolean; issues: unknown[] };

// Parse an object_validate result into the clientValidation evidence recorded on the publish result.
// An unparseable envelope is treated as INVALID (not as a pass) — the client's validator is the
// only verdict that counts, so "we could not read it" must never read as "it said yes".
export const parseValidateResult = (validated: unknown, candidatePatchSummary: string): ClientValidation => {
  const parsedValid = findDeep(validated, (key, child) => key === "valid" && typeof child === "boolean");
  const parsedIssues = findDeep(validated, (key, child) => key === "issues" && Array.isArray(child));
  // The id-less dry-run flavor (object_validate {object_type, body} — a candidate for an object that
  // does not exist yet) answers with the platform's CHECKLIST shape, not {valid, issues}:
  //   { dry_run, validation: [...groups...], summary: { level, eligible: boolean, blockers: [...] } }
  // `summary.eligible` is that shape's verdict and `summary.blockers` its issues. Learned live
  // (run_1786555553280_r7a4fd, 2026-08-12): once the validate REQUEST was fixed to actually reach the
  // client, this parser read the checklist answer as "unparseable_validate_result" and a correct
  // `eligible: true` verdict was recorded as a client_validation_failed blocker. {valid} still wins
  // where both appear — it is the explicit form — and a result carrying NEITHER boolean stays
  // unparseable-as-invalid, exactly as before.
  const parsedEligible = findDeep(validated, (key, child) => key === "eligible" && typeof child === "boolean");
  const parsedBlockers = findDeep(validated, (key, child) => key === "blockers" && Array.isArray(child));
  const valid = typeof parsedValid === "boolean" ? parsedValid : typeof parsedEligible === "boolean" ? parsedEligible : false;
  const issues: unknown[] =
    Array.isArray(parsedIssues) ? parsedIssues
    : typeof parsedValid === "boolean" ? []
    : typeof parsedEligible === "boolean" ? (Array.isArray(parsedBlockers) ? parsedBlockers : [])
    : ["unparseable_validate_result"];
  return { tool: "object_validate", candidate_patch_summary: candidatePatchSummary, valid, issues };
};

export const describeCandidatePatch = (patch: CandidatePatch, nodeCount: number): string =>
  `${patch.length} ops: 1 set_article_meta + ${nodeCount} upsert_node`;

export const formatValidationIssues = (issues: unknown[]): string =>
  issues.slice(0, 5).map((issue) => (typeof issue === "string" ? issue : JSON.stringify(issue))).join("; ");
