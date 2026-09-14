// G2 — THE ONE PLACE CMS-AGENT SPELLS A MINTED TENANT'S OBJECT IDS.
//
// THE BUG THIS CLOSES. Three modules derived "the tenant's short id" three different ways, and the
// three agreed for every slug in the fleet because every slug in the fleet is hyphen-free:
//
//   projectTypes.conventionalTenantSlug   toLowerCase().replace(/[^a-z0-9]/g, "")   "genesis-lab-2" -> "genesislab2"
//   visualStandardIds.sanitizeIdSegment   replace(/[^a-z0-9]+/g, "_")               "genesis-lab-2" -> "genesis_lab_2"
//   siteGenesis.houseVisualStandardId     slug.replace(/-/g, "")                    "genesis-lab-2" -> "genesislab2"
//
// The platform scaffold — the code that ACTUALLY WRITES these objects — uses a fourth spelling of
// the same intent (`create-site.mjs` `idsFor`: `clientSlug.replace(/-/g, '_')`), and it is the only
// one whose answer is checkable against a file on disk: `sites/genesis-lab-2/config/site-identity.ts`
// declares `siteId: 'site_genesis_lab_2'`. So on the first hyphenated tenant the engine addressed
// `strat_genesislab2` and `vis_genesislab2` against a site that had minted `strat_genesis_lab_2` and
// `vis_genesis_lab_2`, and every governed-singleton read degraded.
//
// WHY THIS MODULE RATHER THAN "FIX THE CONVENTION". Neither existing convention can be changed
// safely. `conventionalTenantSlug` also resolves the tracking partition and the strategy address for
// `dr-lurie`, whose project id ("dr-lurie") differs from its platform slug ("drlurie") — snake-casing
// it would send that tenant to `strat_dr_lurie`, an id nothing has ever written. And re-deriving the
// SCAFFOLD's ids would rename live objects under an already-minted tenant. So the fix is neither: the
// convention stays a fallback for tenants nobody configured, and genesis — which knows exactly which
// scaffold minted which ids, because it invoked it — writes the addresses down on the record, where
// every reader already prefers a pointer to a convention.
//
// PINNED BY TEST across a table of slugs against platform's own `idsFor` (see
// `tests/agent/projects/platformScaffoldIds.test.ts`), the same way `visualStandardIdConvention.test.ts`
// already pins the `vis_` rule across the two repos.

/** Platform's `idsFor().clientId`: `create-site.mjs` turns the client SLUG into the id segment by
 *  replacing hyphens with underscores and nothing else. A scaffold slug is already validated
 *  lowercase-alphanumeric-and-hyphen (`SLUG_RE`), so no other character can reach this. */
export const platformClientId = (slug: string): string => slug.trim().toLowerCase().replace(/-/g, "_");

/** Every governed singleton id the platform scaffold mints for a tenant, by its own conventions. */
export type PlatformScaffoldObjectIds = {
  clientId: string;
  siteObjectId: string;
  taxonomyRegistryObjectId: string;
  voiceObjectId: string;
  strategyObjectId: string;
  visualStandardId: string;
  trackingConfigObjectId: string;
  themeObjectId: string;
};

/**
 * The ids `packages/core/cli/create-site.mjs` writes for `slug`:
 *   idsFor()          -> site_<id>, tax_<id>, thm_<id>_default, vis_<id>
 *   the seed writers  -> voice_<id> (voice-seed-data), strat_<id> (strategy-seed-data),
 *                        trk_<id> (tracking-config-seed-data)
 */
export const platformScaffoldObjectIds = (slug: string): PlatformScaffoldObjectIds => {
  const clientId = platformClientId(slug);
  return {
    clientId,
    siteObjectId: `site_${clientId}`,
    taxonomyRegistryObjectId: `tax_${clientId}`,
    voiceObjectId: `voice_${clientId}`,
    strategyObjectId: `strat_${clientId}`,
    visualStandardId: `vis_${clientId}`,
    trackingConfigObjectId: `trk_${clientId}`,
    themeObjectId: `thm_${clientId}_default`
  };
};
