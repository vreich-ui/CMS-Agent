import { describe, expect, it } from "vitest";
import { platformClientId, platformScaffoldObjectIds } from "../../../src/agent/projects/platformScaffoldIds.js";
import { conventionalStrategyObjectId, conventionalTenantSlug } from "../../../src/agent/projects/projectTypes.js";
import { visualStandardIdFor } from "../../../src/agent/workspace/visualStandardIds.js";

// G2 — THE CROSS-REPO PIN.
//
// This repo cannot import platform's `packages/core/cli/create-site.mjs` (two separately-deployed
// services, no shared package — the same constraint `genesisPolicy.ts` already lives under), so the
// scaffold's derivation is restated here and held to a TABLE of slugs with the expected ids written
// out longhand. The expected column is not computed from the implementation; it is transcribed from
// what the scaffold actually produces, and the committed proof for the hyphenated case is in the
// platform repo at `sites/genesis-lab-2/config/site-identity.ts`:
//
//     siteId: 'site_genesis_lab_2',   siteSlug: 'genesis-lab-2'
//
// If platform ever changes `idsFor`, this table fails and somebody has to change both sides in one
// wave — which is the only property that matters here.
describe("the ids the platform scaffold mints for a tenant", () => {
  const table: Array<{ slug: string; siteObjectId: string; taxonomyRegistryObjectId: string; voiceObjectId: string; strategyObjectId: string; visualStandardId: string; trackingConfigObjectId: string; themeObjectId: string }> = [
    {
      slug: "genesis-lab-2",
      siteObjectId: "site_genesis_lab_2",
      taxonomyRegistryObjectId: "tax_genesis_lab_2",
      voiceObjectId: "voice_genesis_lab_2",
      strategyObjectId: "strat_genesis_lab_2",
      visualStandardId: "vis_genesis_lab_2",
      trackingConfigObjectId: "trk_genesis_lab_2",
      themeObjectId: "thm_genesis_lab_2_default"
    },
    {
      slug: "drlurie",
      siteObjectId: "site_drlurie",
      taxonomyRegistryObjectId: "tax_drlurie",
      voiceObjectId: "voice_drlurie",
      strategyObjectId: "strat_drlurie",
      visualStandardId: "vis_drlurie",
      trackingConfigObjectId: "trk_drlurie",
      themeObjectId: "thm_drlurie_default"
    },
    {
      slug: "seniorpets",
      siteObjectId: "site_seniorpets",
      taxonomyRegistryObjectId: "tax_seniorpets",
      voiceObjectId: "voice_seniorpets",
      strategyObjectId: "strat_seniorpets",
      visualStandardId: "vis_seniorpets",
      trackingConfigObjectId: "trk_seniorpets",
      themeObjectId: "thm_seniorpets_default"
    },
    {
      slug: "genesis-lab-3",
      siteObjectId: "site_genesis_lab_3",
      taxonomyRegistryObjectId: "tax_genesis_lab_3",
      voiceObjectId: "voice_genesis_lab_3",
      strategyObjectId: "strat_genesis_lab_3",
      visualStandardId: "vis_genesis_lab_3",
      trackingConfigObjectId: "trk_genesis_lab_3",
      themeObjectId: "thm_genesis_lab_3_default"
    }
  ];

  for (const row of table) {
    it(`matches create-site.mjs idsFor("${row.slug}")`, () => {
      const { clientId, ...ids } = platformScaffoldObjectIds(row.slug);
      const { slug, ...expected } = row;
      expect(clientId).toBe(slug.replace(/-/g, "_"));
      expect(ids).toEqual(expected);
    });
  }

  // The shared in-repo rule and the scaffold agree once the scaffold's site object id is fed to it.
  it("agrees with this repo's own vis_<site> rule for every slug in the table", () => {
    for (const row of table) {
      expect(visualStandardIdFor({ siteObjectId: row.siteObjectId, mode: "house" })).toBe(row.visualStandardId);
    }
  });

  // THE DIVERGENCE THIS MODULE EXISTS FOR, stated as a test so nobody "simplifies" one into the other.
  //
  // `conventionalTenantSlug` is NOT the scaffold's derivation and must not become it. It answers a
  // different question — "if nobody configured this tenant, where would its singletons be?" — and it
  // is right for dr-lurie, whose CMS-Agent project id ("dr-lurie") is not its platform slug
  // ("drlurie"). Snake-casing it would send dr-lurie to `strat_dr_lurie`, an id nothing ever wrote.
  // The two agree for every hyphen-free slug, which is why the disagreement went unseen until the
  // first hyphenated tenant was minted.
  it("deliberately differs from the convention for a hyphenated slug, and agrees without one", () => {
    expect(conventionalTenantSlug("genesis-lab-2")).toBe("genesislab2");
    expect(platformClientId("genesis-lab-2")).toBe("genesis_lab_2");
    expect(conventionalStrategyObjectId("genesis-lab-2")).toBe("strat_genesislab2");
    expect(platformScaffoldObjectIds("genesis-lab-2").strategyObjectId).toBe("strat_genesis_lab_2");

    expect(conventionalStrategyObjectId("seniorpets")).toBe("strat_seniorpets");
    expect(platformScaffoldObjectIds("seniorpets").strategyObjectId).toBe("strat_seniorpets");
    // dr-lurie: the convention is correct and the scaffold derivation would NOT be — which is the
    // whole reason genesis writes a pointer instead of anyone changing the convention.
    expect(conventionalStrategyObjectId("dr-lurie")).toBe("strat_drlurie");
    expect(platformScaffoldObjectIds("dr-lurie").strategyObjectId).toBe("strat_dr_lurie");
  });
});
