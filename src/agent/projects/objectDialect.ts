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

// D7 (Wolf, alignment board 2026-07-28): the client's judgement substrate. The engine must never
// write these into a client object, even though set_article_meta's open `fields` map would accept
// every one of them — the live arg_schema is `{op, fields, guard?}` with fields typed as an open
// JSON map, so a body that happened to carry judge output would otherwise be written through an op
// that never says "scores" anywhere. All judgements stay workspace-side.
export const JUDGEMENT_SUBSTRATE_KEYS: ReadonlySet<string> = new Set(["scores", "claims", "sources", "compliance", "emotional_strategy", "lineage"]);

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

export type ClientValidation = { tool: string; candidate_patch_summary: string; valid: boolean; issues: unknown[] };

// Parse an object_validate result into the clientValidation evidence recorded on the publish result.
// An unparseable envelope is treated as INVALID (not as a pass) — the client's validator is the
// only verdict that counts, so "we could not read it" must never read as "it said yes".
export const parseValidateResult = (validated: unknown, candidatePatchSummary: string): ClientValidation => {
  const parsedValid = findDeep(validated, (key, child) => key === "valid" && typeof child === "boolean");
  const parsedIssues = findDeep(validated, (key, child) => key === "issues" && Array.isArray(child));
  const valid = typeof parsedValid === "boolean" ? parsedValid : false;
  const issues: unknown[] = Array.isArray(parsedIssues) ? parsedIssues : typeof parsedValid === "boolean" ? [] : ["unparseable_validate_result"];
  return { tool: "object_validate", candidate_patch_summary: candidatePatchSummary, valid, issues };
};

export const describeCandidatePatch = (patch: CandidatePatch, nodeCount: number): string =>
  `${patch.length} ops: 1 set_article_meta + ${nodeCount} upsert_node`;

export const formatValidationIssues = (issues: unknown[]): string =>
  issues.slice(0, 5).map((issue) => (typeof issue === "string" ? issue : JSON.stringify(issue))).join("; ");
