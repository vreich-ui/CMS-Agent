// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — "the studio's publish step deposits there
// [the library] in addition to the minting tenant." This module is the PURE half of that: given what
// recipe_mint actually created (its `applied` rows, matched back to their full `plan.creates` bodies)
// and what publish_executor actually PUBLISHED (never merely minted-as-draft — a recipe that never
// went live in its own tenant does not leak into the fleet-wide library either), it decides WHICH
// created objects are library deposit candidates and builds each one's deposit input. No I/O, no
// clock: cloneEngine.ts's depositPublishedTemplatesStep is the thin async wrapper that resolves the
// source capture run's sourceUrl and calls TemplateLibraryStore.publish() for each candidate this
// module names.
import { buildTemplateId } from "./templateIdentity.js";

export type TemplateDepositObjectType = "section_template" | "template";

export type TemplateDepositCandidate = {
  templateId: string;
  objectType: TemplateDepositObjectType;
  requestedId: string;
  objectId: string;
  name: string;
  recipe: Record<string, unknown>;
};

const isDepositObjectType = (value: string): value is TemplateDepositObjectType => value === "section_template" || value === "template";

export function buildTemplateDepositCandidates(input: {
  sourceProjectId: string;
  mintApplied: Array<{ objectType: string; objectId: string; requestedId: string; name: string }>;
  mintCreates: Array<{ objectType: string; requestedId: string; body: Record<string, unknown> }>;
  publishedObjects: Array<{ objectType: string; objectId: string }>;
}): TemplateDepositCandidate[] {
  const published = new Set(input.publishedObjects.map((entry) => `${entry.objectType}:${entry.objectId}`));
  const createsByRequestedId = new Map(input.mintCreates.map((create) => [`${create.objectType}:${create.requestedId}`, create]));

  const candidates: TemplateDepositCandidate[] = [];
  for (const row of input.mintApplied) {
    if (!isDepositObjectType(row.objectType)) continue; // "pdf_template" and anything else: not this path — see ADR §7.
    if (!published.has(`${row.objectType}:${row.objectId}`)) continue; // minted but never went live: not a library candidate.
    const create = createsByRequestedId.get(`${row.objectType}:${row.requestedId}`);
    if (!create) continue; // No plan.creates match — nothing to deposit the BODY of; recipe_mint's own report already names this as an inconsistency if it ever happens.
    candidates.push({
      templateId: buildTemplateId({ sourceProjectId: input.sourceProjectId, objectType: row.objectType, requestedId: row.requestedId }),
      objectType: row.objectType,
      requestedId: row.requestedId,
      objectId: row.objectId,
      name: row.name,
      recipe: create.body
    });
  }
  return candidates;
}
