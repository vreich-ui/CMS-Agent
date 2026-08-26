// T15.31 (#207; ADR-2026-08-25-structure-studio §4.1) — "templateId, stable across versions."
//
// A recipe's `requestedId` (recipe_mint's own id scheme, clone.mjs's RECIPE_ID_PREFIX + a content
// hash of the design — see clone.mjs) is already stable FOR ONE TENANT: re-running clone against the
// same source with an unchanged design produces the same requestedId in that tenant's own inventory,
// which is exactly the property T13.1's header names as "the same intake replayed twice must produce
// the same plan twice". requestedId's uniqueness, though, is only ever guaranteed WITHIN one tenant's
// object store — two different tenants' clone runs could in principle mint the same requestedId for
// two unrelated recipes. The library is cross-tenant (§5.2), so its own identity must not collide
// across tenants the way a bare requestedId could. templateId is therefore the MINTING tenant plus
// the requestedId, joined — stable across every later version of the SAME recipe (re-depositing the
// same (sourceProjectId, objectType, requestedId) always resolves the same templateId), and never
// colliding with another tenant's differently-sourced recipe that happens to share a requestedId.
export function buildTemplateId(input: { sourceProjectId: string; objectType: "section_template" | "template"; requestedId: string }): string {
  const project = input.sourceProjectId.trim();
  const requestedId = input.requestedId.trim();
  if (!project) throw new Error("buildTemplateId requires a non-empty sourceProjectId.");
  if (!requestedId) throw new Error("buildTemplateId requires a non-empty requestedId.");
  return `${project}::${input.objectType}::${requestedId}`;
}
