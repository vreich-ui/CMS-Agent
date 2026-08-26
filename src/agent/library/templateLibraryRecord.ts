// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — the pure decision at the heart of the
// library: given what is already on record for a templateId (if anything) and the content about to
// be deposited, does this deposit mint v1, mint the next version, or leave the latest version alone?
//
// PURE. No I/O, no clock — templateLibraryStore.ts is the only module that touches storage or reads
// wall-clock time (for the ledger-only `publishedAt`, stamped there, never here). This module is a
// straight function of its inputs, so a test can assert "two identical inputs produce identical
// library records" without a store at all.
import { createHash } from "node:crypto";
import type { TemplateLibraryObjectType } from "./templateLibraryTypes.js";

/** Deterministic, key-order-independent stringify: every plain object's keys are sorted before
 *  serialization, recursively, so {a:1,b:2} and {b:2,a:1} hash identically and array ORDER (which IS
 *  meaningful — a template's slots are ordered) is preserved untouched. */
export function canonicalStringify(value: unknown): string {
  const canon = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canon);
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = canon(record[key]);
      return sorted;
    }
    return input;
  };
  return JSON.stringify(canon(value));
}

export type TemplateContentInput = {
  objectType: TemplateLibraryObjectType;
  recipe: Record<string, unknown>;
  sectionTypesUsed: string[];
};

/** sha256 over the canonical form of exactly {objectType, recipe, sectionTypesUsed} — deliberately
 *  NOT provenance or name, so re-stating the same recipe under a re-resolved (but substantively
 *  unchanged) provenance, or a cosmetic rename, is a judgment call left to future work rather than a
 *  version bump forced by this hash. A change to the recipe body or the section types it depends on
 *  is always substantive and always changes this hash. */
export function computeTemplateContentHash(input: TemplateContentInput): string {
  const canonical = canonicalStringify({ objectType: input.objectType, recipe: input.recipe, sectionTypesUsed: [...input.sectionTypesUsed].sort() });
  return createHash("sha256").update(canonical).digest("hex");
}

export type TemplateLatestPointer = { version: number; contentHash: string };
export type TemplateVersionDecision =
  | { outcome: "minted"; version: number }
  | { outcome: "unchanged"; version: number };

/** IMMUTABILITY, decided here and enforced by templateLibraryStore.ts: a published version's content
 *  never changes underneath it. No existing pointer -> version 1. An existing pointer whose
 *  contentHash matches -> the SAME version, unchanged (this deposit is a no-op replay, not a mutation
 *  and not a new version). An existing pointer whose contentHash differs -> the NEXT version, minted
 *  fresh; every version below it is left exactly as it was. */
export function resolveTemplateVersion(input: { existingLatest?: TemplateLatestPointer; contentHash: string }): TemplateVersionDecision {
  if (!input.existingLatest) return { outcome: "minted", version: 1 };
  if (input.existingLatest.contentHash === input.contentHash) return { outcome: "unchanged", version: input.existingLatest.version };
  return { outcome: "minted", version: input.existingLatest.version + 1 };
}
