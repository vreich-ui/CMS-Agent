// A2.3 (2026-09-15) — ONE DERIVATION FOR A TENANT'S NETLIFY SITE NAME.
//
// THE DIVERGENCE THIS ENDS. The fleet's minted tenants are `kugel-genesis-lab-2`, `kugel-fernwell`,
// `kugel-platform`. The mint of genesis-lab-3 created a site called `genesis-lab-3`. Nothing in
// either repo was wrong on its own terms — that is the problem. Both the checkout-backed path
// (platform's `create-site.mjs --provision-only`, which falls back to `plan.clientSlug`) and the
// checkout-less path (siteGenesis's own `createSite`, which fell back to the slug) default to the
// BARE slug, and the `kugel-` prefix on every existing tenant was typed by a human passing
// `--netlify-site-name`. So the convention lived in an operator's habit, and the first mint nobody
// hand-held broke it.
//
// WHY A PREFIX AT ALL, rather than dropping the convention. `*.netlify.app` is a single global
// namespace: `platform.netlify.app` was already taken (W14 T14.3), which is the reason the prefix
// exists. A bare-slug default therefore fails unpredictably — sometimes a collision, sometimes a
// site named after a word somebody else wanted — and a tenant's site name is load-bearing in three
// places that all read it off the record: the derived `/mcp` endpoint, the credential reconciler's
// fleet plan, and the self-capture origin.
//
// WHERE THIS IS USED. `runSiteGenesis` derives the name from it and passes it EXPLICITLY to
// create-site on both paths, so the two repos can no longer disagree; `genesisParity` flags a
// genesis-minted record whose binding diverges from it; and `netlifySiteName` on the call stays the
// operator override for the cases a convention cannot cover (`drluriescience`,
// `zilbermanfilmfoundation` — both older than genesis, and both correct).
export const GENESIS_SITE_NAME_PREFIX = "kugel-";

/**
 * The Netlify site name a tenant slug is born with.
 *
 * IDEMPOTENT ON THE PREFIX: `kugel-platform` in gives `kugel-platform` out, never
 * `kugel-kugel-platform`. That matters because the prefixed form is what already sits in
 * `clientSiteBinding` for three live tenants, and a re-run of genesis (A2.2) passes whatever it
 * finds back through here.
 */
export const genesisNetlifySiteName = (slug: string): string => {
  const trimmed = slug.trim();
  return trimmed.startsWith(GENESIS_SITE_NAME_PREFIX) ? trimmed : `${GENESIS_SITE_NAME_PREFIX}${trimmed}`;
};

/** Where a record's site name came from. Recorded so the parity check can tell a DIVERGENCE from a
 *  deliberate override, and so it never nags about the two tenants that predate the convention. */
export const genesisSiteNameSources = ["derived", "override"] as const;
export type GenesisSiteNameSource = typeof genesisSiteNameSources[number];
