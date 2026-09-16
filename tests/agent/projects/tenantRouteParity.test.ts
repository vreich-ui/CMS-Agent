// TENANT ROUTE PARITY (2026-09-16) — the containment property for the WHOLE fleet, not one tenant.
//
// WHAT WENT WRONG. `workspace.audit_capabilities` reported
// `route_tool_blocked_by_policy:zilberman:site_apply_brand_imagery`, and the sweep behind fixing it
// found the same shape three more times: `platform` held site_apply_theme and site_apply_brand_imagery
// at "needs_approval" — which for a DETERMINISTIC route is refused identically to "blocked", since a
// route has no approval step to enter — and `fernwell` was declared with seven read verbs and deny-all
// underneath, so every write route on it was refused pre-transport. None of the three was visible as a
// failing run: a refused route either degrades to applied:false or stalls a tenant nobody was watching.
//
// THE PROPERTY. Every verb a route manifest declares resolves to exactly "allowed" on every PUBLISHING
// TENANT, including the profile a new tenant is minted with. Not "not blocked" — "allowed", because
// that is the string tenantInvoke and visualStandardMaterialization actually test for.
//
// This test is the reason the class cannot come back quietly: a new route verb, a new tenant, or a
// policy row edited to "needs_approval" fails here, with the tenant and the verb named.
import { describe, expect, it } from "vitest";
import { declaredRouteVerbs } from "../../../src/agent/projects/genesisParity.js";
import { defaultProjectConfigs, SERVICE_PROJECT_IDS } from "../../../src/agent/projects/defaultMigration.js";
import { genesisTenantProfile, GENESIS_WITHHELD_ROUTE_VERBS } from "../../../src/agent/projects/genesisTenantProfile.js";
import { effectiveToolPermission, type ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// Read through defaultProjectConfigs(), which is what ensureSeeded and every migration path read —
// so this asserts the policy a tenant's RECORD is actually seeded and re-seeded with, not the literal
// in its definition file. SERVICE_PROJECT_IDS (pdf-tool, monetizer) are services this workspace calls,
// never tenants it runs routes on, and are excluded there by name.

const tenantConfigs = (): Array<{ id: string; config: Pick<ProjectConnectionConfig, "allowedTools" | "defaultToolPolicy" | "toolPolicies" | "operatorToolPolicies"> }> => [
  ...defaultProjectConfigs()
    .filter((project) => !SERVICE_PROJECT_IDS.includes(project.projectId))
    .map((project) => ({ id: project.projectId, config: project })),
  // The tenant that does not exist yet: what genesis mints tomorrow must pass the same bar.
  { id: "<genesis-minted>", config: { allowedTools: [], ...genesisTenantProfile() } }
];

/**
 * The ONE gap that is a decision rather than an omission. `platform` declares both site-wide apply
 * verbs as "needs_approval" (BRIEF §3.3/R6). For a deterministic route that is refused exactly like
 * "blocked" — there is no approval step for a route to enter — so on this tenant the apply half of
 * visual_identity and clone's theme_bind does not run, and the capability audit says so out loud
 * (route_tool_blocked_by_policy:platform:...). Flipping it would let a node write site-wide to Wolf's
 * own main site with no operator in the loop, which is an operator's call, not a refactor's.
 *
 * Listed here so the gap has a name and a reason, and so a STALE entry fails: the last test below
 * asserts every exception is still a real declared verb that is still not "allowed".
 */
const DECLARED_TENANT_EXCEPTIONS: Record<string, Record<string, string>> = {
  platform: {
    site_apply_theme: "operator decision (BRIEF §3.3/R6): site-wide theme apply is held on platform",
    site_apply_brand_imagery: "operator decision (BRIEF §3.3/R6): site-wide imagery apply is held on platform"
  }
};

const isDeclaredException = (tenant: string, verb: string): boolean =>
  Boolean(DECLARED_TENANT_EXCEPTIONS[tenant]?.[verb]);

describe("tenant route parity", () => {
  it("covers every code tenant and the genesis profile", () => {
    const ids = tenantConfigs().map((tenant) => tenant.id);
    expect(ids).toContain("dr-lurie");
    expect(ids).toContain("platform");
    expect(ids).toContain("fernwell");
    expect(ids).toContain("<genesis-minted>");
    expect(ids).not.toContain("pdf-tool");
  });

  it("resolves every declared route verb to \"allowed\" on every tenant", () => {
    const verbs = declaredRouteVerbs();
    expect(verbs.length).toBeGreaterThan(0);
    const gaps = tenantConfigs().flatMap((tenant) =>
      verbs
        .filter((verb) => !GENESIS_WITHHELD_ROUTE_VERBS.includes(verb) && !isDeclaredException(tenant.id, verb))
        .map((verb) => ({ tenant: tenant.id, verb, permission: effectiveToolPermission(tenant.config, verb) }))
        .filter((entry) => entry.permission !== "allowed")
    );
    expect(gaps).toEqual([]);
  });

  it("never lets a route verb sit at \"needs_approval\", which a route cannot satisfy", () => {
    const held = tenantConfigs().flatMap((tenant) =>
      declaredRouteVerbs()
        .filter((verb) => !isDeclaredException(tenant.id, verb))
        .filter((verb) => effectiveToolPermission(tenant.config, verb) === "needs_approval")
        .map((verb) => `${tenant.id}:${verb}`)
    );
    expect(held).toEqual([]);
  });

  it("grants the site-wide apply verbs a minted tenant used to be born without", () => {
    const profile = { allowedTools: [], ...genesisTenantProfile() };
    expect(effectiveToolPermission(profile, "site_apply_brand_imagery")).toBe("allowed");
    expect(effectiveToolPermission(profile, "site_apply_theme")).toBe("allowed");
    // The withhold mechanism stays, empty and visible: a future withhold is a decision with a name.
    expect(GENESIS_WITHHELD_ROUTE_VERBS).toEqual([]);
  });

  it("derives the profile from the manifests, so a new route verb needs no policy edit", () => {
    const profile = genesisTenantProfile();
    for (const verb of declaredRouteVerbs()) expect(profile.toolPolicies[verb]).toBe("allowed");
  });

  it("fills a tenant's GAPS without overruling a row it declared on purpose", () => {
    const fernwell = defaultProjectConfigs().find((project) => project.projectId === "fernwell")!;
    // fernwell declared seven read verbs and deny-all underneath; the union closes that.
    for (const verb of declaredRouteVerbs()) expect(effectiveToolPermission(fernwell, verb)).toBe("allowed");
    // platform declared its two rows deliberately; the union leaves them exactly as written.
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    expect(effectiveToolPermission(platform, "site_apply_brand_imagery")).toBe("needs_approval");
  });

  it("keeps every declared exception honest — a stale one fails here", () => {
    const verbs = declaredRouteVerbs();
    for (const [tenant, exceptions] of Object.entries(DECLARED_TENANT_EXCEPTIONS)) {
      const config = defaultProjectConfigs().find((project) => project.projectId === tenant);
      expect(config, `exception names an unknown tenant: ${tenant}`).toBeDefined();
      for (const [verb, reason] of Object.entries(exceptions)) {
        expect(verbs, `exception names a verb no route declares: ${verb}`).toContain(verb);
        expect(reason.length).toBeGreaterThan(20);
        // Still a gap. Once the row is allowed, the exception is dead weight and must be deleted.
        expect(effectiveToolPermission(config!, verb), `stale exception ${tenant}:${verb}`).not.toBe("allowed");
      }
    }
  });
});
