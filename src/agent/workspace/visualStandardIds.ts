// R2 — THE ONE PLACE THAT KNOWS WHAT A `visual_standard` IS CALLED.
//
// WHY THIS IS ITS OWN MODULE. The convention (`vis_<site>` for the house singleton, `vis_<site>_<slug>`
// for a template) used to live inside `visualStandardMaterialization.ts`, which is the WRITER: it pulls
// in the project repository, the MCP adapter and the tool-permission machinery, so nothing that merely
// needs to NAME a standard could import it without dragging the whole write path along. The practical
// consequence was that the read side did not derive the id at all — and an id nobody derives is an id
// something eventually guesses.
//
// THE GUESS THIS EXISTS TO PREVENT. A fresh chat on a site with no house standard ran
// `object_list(visual_standard)` (empty — the normal state of a tenant whose backfill has not run),
// then assembled `vis_` + the SITE OBJECT id and called `object_get("vis_site_drlurie")`. That id can
// never exist: `<site>` is the site object id with its `site_` prefix REMOVED, so the site object
// `site_drlurie` names `vis_drlurie`, next to its own `voice_drlurie`. The model had no way to know
// that, because nothing told it — so it inferred a rule from a prefix and got a red "Object record not
// found" card for a site that was simply new. Deriving belongs in code; this is the code.
//
// Platform implements the same rule on its side (`visualStandardIdFor` = `vis_${clientId}`), and
// `capture/siteGenesis.ts` derives the same house id from a project slug on the birth path. Those two
// and this one are asserted against each other in
// `tests/agent/workspace/visualStandardIdConvention.test.ts` so the rule cannot drift in one place.

/** `site_drlurie` → `drlurie`. The `site_` prefix is the object namespace, not part of the slug. */
export const siteSlugFromObjectId = (siteObjectId: string): string => siteObjectId.replace(/^site_/, "").trim();

// Lowercase alphanumerics + underscore, matching the id vocabulary every other `<prefix>_<site>`
// singleton in this codebase uses. A slug that sanitizes to nothing is a refusal, never a silent "".
export const sanitizeIdSegment = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * The id a `visual_standard` occupies — or WOULD occupy if one were written — for this site.
 *
 * `undefined` (never a partial or a placeholder) when the inputs cannot produce a real id: a site
 * object id that reduces to nothing, or mode 'template' with no usable slug. A caller that gets
 * `undefined` has learned that this site cannot name a standard, which is a refusal it must report,
 * not a hole to fill with a plausible string.
 */
export function visualStandardIdFor(params: { siteObjectId: string; mode: "house" | "template"; templateSlug?: string }): string | undefined {
  const site = sanitizeIdSegment(siteSlugFromObjectId(params.siteObjectId));
  if (!site) return undefined;
  if (params.mode === "house") return `vis_${site}`;
  const slug = sanitizeIdSegment(params.templateSlug ?? "");
  return slug ? `vis_${site}_${slug}` : undefined;
}
