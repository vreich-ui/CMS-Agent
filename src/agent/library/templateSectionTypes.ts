// T15.31 (#207) — reads which registered section types a minted recipe body depends on, straight
// from the SAME body shape recipeBody() in capture/engine/clone.mjs constructs (object_create's own
// `body`, matching sectionTemplateBodySchema/templateBodySchema): a section_template names ONE type
// at `blueprint.type`; a page template names one type per slot at `slots[].allowed[0]` (clone.mjs
// widens a slot's single sectionType into that one-element `allowed` array — see clone.mjs's
// recipeBody). Pure, total, and never guesses: a body missing the field it should carry contributes
// nothing rather than a fabricated type name, and the caller (templateDeposit.ts) is what decides an
// empty result is worth refusing over.
import type { TemplateLibraryObjectType } from "./templateLibraryTypes.js";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function sectionTypesUsedInRecipe(objectType: TemplateLibraryObjectType, recipe: Record<string, unknown>): string[] {
  if (objectType === "section_template") {
    const blueprint = isRecord(recipe.blueprint) ? recipe.blueprint : undefined;
    const type = typeof blueprint?.type === "string" ? blueprint.type.trim() : "";
    return type ? [type] : [];
  }
  if (objectType === "template") {
    const slots = Array.isArray(recipe.slots) ? recipe.slots : [];
    const types = new Set<string>();
    for (const slot of slots) {
      if (!isRecord(slot)) continue;
      const allowed = Array.isArray(slot.allowed) ? slot.allowed : [];
      for (const candidate of allowed) {
        if (typeof candidate === "string" && candidate.trim()) types.add(candidate.trim());
      }
    }
    return [...types].sort();
  }
  // pdf_template: not a section-type consumer at all (ADR §7 — a different store, a different
  // discipline). Empty by construction, never a refusal.
  return [];
}
