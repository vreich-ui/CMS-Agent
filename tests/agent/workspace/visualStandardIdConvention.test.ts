import { describe, expect, it } from "vitest";
import { sanitizeIdSegment, siteSlugFromObjectId, visualStandardIdFor } from "../../../src/agent/workspace/visualStandardIds.js";
import { visualStandardIdFor as materializerIdFor } from "../../../src/agent/workspace/visualStandardMaterialization.js";
import { houseVisualStandardId } from "../../../src/agent/capture/siteGenesis.js";

// FIX (chat-recovery) — THE ANTI-DRIFT WALL FOR `vis_<site>` / `vis_<site>_<slug>`.
//
// Three places in this repo name a visual_standard, and platform names them a fourth time
// (`visualStandardIdFor` = `vis_${clientId}`). Before this file, nothing held them to each other, and
// nothing at all held the READ side to the rule — which is how a chat came to assemble `vis_` + the
// SITE OBJECT's id and probe `vis_site_drlurie`, an id no writer in either repo can mint.
//
//   visualStandardIds.ts        — the rule. Everything else derives from it or is asserted against it.
//   visualStandardMaterialization.ts — the WRITE path; re-exports the rule, so this is identity.
//   capture/siteGenesis.ts      — the BIRTH path, which derives the same house id from a PROJECT slug
//                                 rather than a site object id, and therefore has its own literal.
//                                 That is the one real drift risk here, and the table below is what
//                                 pins it: genesis's site slug is the project slug with its hyphens
//                                 removed, so `site_<that>` must feed the shared rule to the same id.
describe("the vis_<site> id convention, asserted across every place that derives one", () => {
  it("names the house singleton from the site object id, never from the site OBJECT id verbatim", () => {
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "house" })).toBe("vis_drlurie");
    // The live defect, stated as a test: `vis_` + the site object id is not the convention and never
    // was. The `site_` prefix is the object namespace and comes OFF.
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "house" })).not.toBe("vis_site_drlurie");
    expect(siteSlugFromObjectId("site_drlurie")).toBe("drlurie");
  });

  it("names a template `vis_<site>_<slug>` and refuses rather than inventing when a slug is unusable", () => {
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "template", templateSlug: "Field Notes" })).toBe("vis_drlurie_field_notes");
    // No slug, or a slug that sanitizes to nothing, is a refusal — never the house id by accident,
    // which would file a template's look over the site's declared one.
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "template" })).toBeUndefined();
    expect(visualStandardIdFor({ siteObjectId: "site_drlurie", mode: "template", templateSlug: "  " })).toBeUndefined();
    expect(visualStandardIdFor({ siteObjectId: "site_", mode: "house" })).toBeUndefined();
    expect(sanitizeIdSegment("Field Notes!")).toBe("field_notes");
  });

  it("is the SAME function the write path uses — the materializer cannot drift from the read path", () => {
    for (const siteObjectId of ["site_drlurie", "site_fernwell", "site_a1"]) {
      expect(materializerIdFor({ siteObjectId, mode: "house" })).toBe(visualStandardIdFor({ siteObjectId, mode: "house" }));
      expect(materializerIdFor({ siteObjectId, mode: "template", templateSlug: "field notes" })).toBe(
        visualStandardIdFor({ siteObjectId, mode: "template", templateSlug: "field notes" })
      );
    }
    expect(materializerIdFor).toBe(visualStandardIdFor);
  });

  // siteGenesis derives the house id at BIRTH, from the project slug, before any site object exists to
  // read — so it keeps its own literal. This is the assertion that stops the two rules diverging:
  // genesis's site slug is the project slug with hyphens removed, and `site_<that>` through the shared
  // rule must produce exactly what genesis produces.
  it("agrees with the genesis birth-path derivation for every project-slug shape it accepts", () => {
    for (const slug of ["dr-lurie", "drlurie", "fernwell", "a-b-c", "zilberman-ff"]) {
      const genesisSiteObjectId = `site_${slug.replace(/-/g, "")}`;
      expect(houseVisualStandardId(slug)).toBe(visualStandardIdFor({ siteObjectId: genesisSiteObjectId, mode: "house" }));
    }
    expect(houseVisualStandardId("dr-lurie")).toBe("vis_drlurie");
  });
});
