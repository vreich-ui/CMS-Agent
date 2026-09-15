// CMP-W2 — the BOUND OBJECT DOSSIER: one deterministic `object_get` at turn start, rendered into
// the prompt, so a chat bound to an object does not spend its first tool call learning what the
// editor is already looking at.
//
// THE SEAM IS voicePrefetch.ts's, DELIBERATELY. Same posture, same reasons: a plain function call
// made by deterministic code before the model runs, never a tool the model invokes inside its own
// loop; an explicit timeout, because a call that bypasses executeTool inherits none; and a
// degradation that is NAMED rather than silent. The one difference is the budget — a chat turn has
// an editor waiting on it, so the read gets a quarter of the turn's own timeout and no more.
//
// FAILURE IS NEVER SILENCE. When the read does not land, the block says "dossier unavailable — read
// before acting", which puts rev 8's behaviour back exactly as it was. An OMITTED block would be
// read by the model as "there is nothing to know about this object", which is the one interpretation
// that is never true.
import type { ProjectConnectionConfig } from "../../projects/projectTypes.js";
import { tenantAdapterFor } from "../../tools/tenantInvoke.js";
import { SAFE_READ_FAILURES, promptSafe, safeReadFailure } from "./safeReason.js";

// A quarter of the turn's own budget: enough for one read against a healthy tenant, small enough
// that a dead one costs the editor a fraction of the wait rather than the whole turn. Floored so a
// caller passing the contract's 1,000 ms minimum still gets a survivable window, ceilinged so a
// generous timeout does not turn into a long hang on an unreachable tenant.
export const dossierBudgetMs = (turnTimeoutMs: number): number => Math.min(8_000, Math.max(1_500, Math.floor(turnTimeoutMs / 4)));

export const DOSSIER_UNAVAILABLE = "dossier unavailable — read before acting";

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// Same tolerant envelope descent voicePrefetch.ts documents: prefer structuredContent (checking the
// two nesting keys real platform responses have used), parse content[]'s text block only when
// structuredContent is absent entirely. Never assumed beyond what THIS call returned.
export const extractObjectRecord = (result: unknown): Record<string, unknown> | undefined => {
  if (!isObject(result)) return undefined;
  const structured = result.structuredContent;
  if (isObject(structured)) {
    if (isObject(structured.record)) return structured.record;
    if (isObject(structured.object)) return structured.object;
    return structured;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((block): block is { text: string } => isObject(block) && typeof block.text === "string")?.text;
    if (typeof text === "string") {
      try { const parsed: unknown = JSON.parse(text); return isObject(parsed) ? parsed : undefined; } catch { return undefined; }
    }
  }
  return result;
};

// Field names on the tenant's object record are the PLATFORM's contract, not this repo's, and they
// have historically come back in both snake and camel spellings depending on the transport. So each
// fact is read through a candidate list and reported only when one of them actually answered — a
// missing field renders as nothing at all rather than as an invented value.
//
// EVERY value returned here goes through `promptSafe` (safeReason.ts). These fields are written by
// whoever can edit an object in the tenant CMS, and this block is rendered OUTSIDE the untrusted-JSON
// marker — so an article title carrying a newline and a `## ` would otherwise open a new section of
// the system prompt. Truncation alone was not enough, and that was a review finding on this change.
const firstString = (record: Record<string, unknown>, keys: string[], max = 200): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return promptSafe(value, max);
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

export type ObjectDossierFacts = {
  objectType: string;
  objectId: string;
  title?: string;
  status?: string;
  lifecycleState?: string;
  lastRevision?: string;
  openReview?: string;
  /** The contract digest for this object's own type, rendered by contractDigest.ts. */
  contractDigest?: string;
  /** Set once a write has landed in this same turn; the prompt then knows to re-read. */
  stale?: boolean;
  unavailableReason?: string;
};

export const factsFromRecord = (objectType: string, objectId: string, record: Record<string, unknown>): ObjectDossierFacts => {
  const review = record.review;
  const openReview = isObject(review)
    ? firstString(review, ["state", "status", "decision"]) && `${firstString(review, ["state", "status", "decision"])}${firstString(review, ["note", "reason"]) ? ` — ${firstString(review, ["note", "reason"], 160)}` : ""}`
    : undefined;
  const history = record.history;
  const latest = Array.isArray(history) ? history.filter(isObject).at(-1) : undefined;
  return {
    objectType,
    objectId,
    title: firstString(record, ["title", "name", "label"], 160) ?? (isObject(record.body) ? firstString(record.body, ["title", "name", "headline"], 160) : undefined),
    status: firstString(record, ["status", "state"]),
    lifecycleState: firstString(record, ["lifecycle_state", "lifecycleState", "publication_state", "publicationState"]),
    lastRevision: latest ? firstString(latest, ["summary", "reason", "note", "message"], 200) ?? firstString(latest, ["at", "createdAt", "created_at"]) : firstString(record, ["updated_at", "updatedAt"]),
    openReview: openReview || undefined
  };
};

/**
 * The `## Bound object` block.
 *
 * The lifecycle words (`Draft`/`Approved`/`Published`/`Live`) are NOT normalised here. The prompt's
 * "Lifecycle vocabulary" section makes those four terms precise and forbids using them as synonyms;
 * translating a tenant's own `status` string into one of them would be this module deciding, from a
 * string, a thing the prompt insists must be decided from evidence. The tenant's own word is
 * reported, labelled as the tenant's word.
 */
export const renderObjectDossier = (facts: ObjectDossierFacts): string => {
  const head = `## Bound object\nThis conversation is bound to ${promptSafe(facts.objectType, 128)} \`${promptSafe(facts.objectId, 256)}\`. Work on THIS object unless the editor explicitly names another.`;
  if (facts.unavailableReason) return `${head}\n- ${DOSSIER_UNAVAILABLE} (${facts.unavailableReason})`;
  const lines = [
    ...(facts.title ? [`- Title: ${facts.title}`] : []),
    ...(facts.status ? [`- Status, in the tenant's own word: ${facts.status}`] : []),
    ...(facts.lifecycleState ? [`- Lifecycle state: ${facts.lifecycleState}`] : []),
    ...(facts.lastRevision ? [`- Last revision: ${facts.lastRevision}`] : []),
    ...(facts.openReview ? [`- Open review: ${facts.openReview}`] : []),
    ...(facts.contractDigest ? [`- What its type allows:\n${facts.contractDigest.split("\n").map((digestLine) => `  ${digestLine}`).join("\n")}`] : []),
    ...(facts.stale ? ["- STALE: a write landed in this turn. Re-read this object before the next write."] : [])
  ];
  return lines.length
    ? `${head}\n${lines.join("\n")}`
    : `${head}\n- The read returned a record with none of the fields this block renders. Read it yourself before acting on its state.`;
};

export type ObjectDossierDeps = { config: ProjectConnectionConfig; conversationId: string };

/**
 * One read, abort-aware, never allowed to hold the turn past its budget.
 *
 * Returns facts rather than text so the caller can fold in the contract digest (which it already
 * resolved for the briefing) without this function needing to know about contracts at all.
 */
export const prefetchObjectDossier = async (
  params: { objectType: string; objectId: string; turnTimeoutMs: number },
  deps: ObjectDossierDeps
): Promise<ObjectDossierFacts> => {
  const adapter = tenantAdapterFor(deps.config, { caller: "engine", runId: `chat:${deps.conversationId}` });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dossierBudgetMs(params.turnTimeoutMs));
  try {
    const call = await adapter.callReadTool("object_get", { object_type: params.objectType, object_id: params.objectId }, controller.signal);
    // NEVER `call.error`. See safeReason.ts: a transport's own message names env vars, endpoints and
    // status codes, none of which may cross into a system prompt.
    if (!call.ok) return { objectType: params.objectType, objectId: params.objectId, unavailableReason: safeReadFailure(call.error, { authFailed: call.authFailed, httpStatus: call.httpStatus }) };
    const record = extractObjectRecord(call.result);
    if (!record) return { objectType: params.objectType, objectId: params.objectId, unavailableReason: SAFE_READ_FAILURES.unusable };
    return factsFromRecord(params.objectType, params.objectId, record);
  } catch (error: unknown) {
    // Includes the abort: an over-budget read is a degradation the editor should be told about, in
    // the same shape as every other one, never an exception that fails the turn.
    return { objectType: params.objectType, objectId: params.objectId, unavailableReason: safeReadFailure(error) };
  } finally {
    clearTimeout(timer);
  }
};
