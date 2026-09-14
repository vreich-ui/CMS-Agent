// G5 (2026-09-14) — IS THIS MINTED TENANT ACTUALLY AT PARITY WITH THE FLEET?
//
// THE CLASS OF BUG THIS EXISTS TO END. Every genesis defect found on genesis-lab-2 had the same
// shape: a field the fleet's working tenants carry, that the birth path never wrote, discovered
// months later as an opaque runtime degradation on a tenant nobody had reason to suspect. The
// objectDialect, the object-store credential, the publish autonomy — three instances of one
// structural problem, which is that "what a tenant needs in order to work" lived only in the heads
// of the people who had hand-tuned the tenants that already worked.
//
// So this module states it, mechanically, in one place, as a DIFF a script can exit non-zero on.
// Genesis writes it at birth (`runSiteGenesis`), `genesisReconcile.ts` repairs a tenant born before
// it, and `scripts/genesisParityCheck.ts` reports on any tenant at any time. All three read THIS.
//
// WHAT PARITY MEANS HERE, precisely, and what it deliberately does not mean:
//   IN  — the record-level configuration a tenant cannot publish without: a complete object dialect,
//         the publish autonomy posture, the effective permission on every verb the engine's own route
//         manifests say a run will speak, the sink partition, the site binding, the token custody
//         source, the profile version.
//   OUT — anything that is legitimately per-tenant: the endpoint, the slug, the capture policy
//         (deny-all is CORRECT for a mint-only tenant), the editorial voice/strategy CONTENT, the
//         human checklist. A parity check that flagged those would be noise, and a noisy check is an
//         ignored check.
//   OUT — `publishableTypes`. It is NOT a project field: `resolvePublishableTypeCharter(workflowId)`
//         (workspace/publishableTypeCharter.ts) answers per WORKFLOW, and `publishing_conductor`
//         resolves to `["page","navigation"]` for dr-lurie exactly as it does for a minted tenant.
//         The run-level `publishingPolicySnapshot.publishableTypes` that looks like a divergence is
//         the same value on both. Comparing it would mint a permanent false positive, and "widening"
//         it is forbidden by the publish charter (ADR-2026-08-25-structure-studio §2.2).
import { ROUTE_MANIFESTS } from "../workspace/routeRegistry.js";
import { drLurieProjectConfig } from "./drLurie/definition.js";
import { GENESIS_TENANT_DEFINITION_VERSION, GENESIS_WITHHELD_ROUTE_VERBS, isGenesisMintedProject } from "./genesisTenantProfile.js";
import { platformScaffoldObjectIds } from "./platformScaffoldIds.js";
import { effectiveToolPermission, type ProjectConnectionConfig, type ProjectObjectDialect } from "./projectTypes.js";

/** The fleet reference tenant. dr-lurie publishes today, which is the only credential a reference
 *  needs; every expectation below is READ off its record rather than restated beside it. */
export const PARITY_REFERENCE_PROJECT_ID = drLurieProjectConfig.projectId;

/** Every tenant verb the engine's own route manifests declare a run will speak. Derived, never
 *  hand-listed — a route that starts speaking a new verb makes this check fail rather than stalling
 *  a tenant at runtime, which is the lesson W4.3 already paid for once. */
export const declaredRouteVerbs = (): string[] =>
  [
    ...new Set(
      ROUTE_MANIFESTS.flatMap((manifest) => [
        ...(manifest.requiredTools ?? []).map((tool) => tool.verb),
        ...manifest.phases.flatMap((phase) => (phase.requiredTools ?? []).map((tool) => tool.verb))
      ])
    )
  ].sort();

export type ParityDivergence = {
  /** Stable machine key, so a script's output can be diffed run over run. */
  field: string;
  expected: string;
  actual: string;
  /** What breaks while this is true. A divergence with no consequence is not a divergence. */
  consequence: string;
  /** Can `genesis:reconcile` fix it from the record alone, with no Netlify or store access? */
  reconcilable: boolean;
};

/** The dialect genesis writes today for `projectId`. Kept here rather than in siteGenesis so the
 *  reconcile path and the birth path cannot disagree about what a correct dialect is. */
export const expectedObjectDialect = (projectId: string, requestIdPattern: string, defaultObjectType: string): ProjectObjectDialect => {
  const ids = platformScaffoldObjectIds(projectId);
  return {
    siteObjectId: ids.siteObjectId,
    taxonomyRegistryObjectId: ids.taxonomyRegistryObjectId,
    objectIdSource: "server_minted",
    requestIdPattern,
    defaultObjectType,
    voiceObjectId: ids.voiceObjectId,
    strategyObjectId: ids.strategyObjectId
  };
};

export type ParityOptions = {
  /** Fleet dialect constants, injected so this module does not import the capture layer (which would
   *  make a pure config check depend on the Netlify client). siteGenesis exports both. */
  requestIdPattern: string;
  defaultObjectType: string;
};

/**
 * The divergence list. PURE: a record in, a list out — no repository, no network, no clock. That is
 * what lets `genesisParity.test.ts` assert the whole table and what lets the CLI be a thin wrapper.
 *
 * An empty list means this tenant carries every record-level fact the fleet's publishing tenants
 * carry. It does NOT mean the tenant's site is deployed, its objects are seeded or its secrets are
 * installed — those are facts about a Netlify site and a blob store, and the honest place to learn
 * them is the tenant's own `health` and `object_list`, not a registry read.
 */
export function genesisParityDivergences(config: ProjectConnectionConfig, options: ParityOptions): ParityDivergence[] {
  const divergences: ParityDivergence[] = [];
  const reference = drLurieProjectConfig;
  const expectedDialect = expectedObjectDialect(config.projectId, options.requestIdPattern, options.defaultObjectType);

  // 1. The object dialect, field by field. A whole-object comparison would report one divergence for
  // a dialect missing one pointer, which tells an operator to rewrite all of it.
  for (const field of ["siteObjectId", "taxonomyRegistryObjectId", "objectIdSource", "requestIdPattern", "defaultObjectType", "voiceObjectId", "strategyObjectId"] as const) {
    const expected = expectedDialect[field];
    const actual = config.objectDialect?.[field];
    if (expected !== undefined && actual !== expected) {
      divergences.push({
        field: `objectDialect.${field}`,
        expected: String(expected),
        actual: actual === undefined ? "(unset)" : String(actual),
        consequence:
          field === "siteObjectId" ? "every site-scoped artifact bridge verb refuses artifact_site_scope_missing — no PDF and no image slot on any run can materialize"
          : field === "defaultObjectType" ? "contract prefetch no-ops prefetch_object_type_unresolved, which withholds the site prefetch and leaves the aggression ceiling unresolved (resolved_vector_unclamped:no_ceiling)"
          : field === "voiceObjectId" ? "voice prefetch cannot read the tenant's live editorial_voice object and every voice-consuming node runs on the record fallback"
          : field === "strategyObjectId" ? "the strategy read falls back to the conventional address, which for a hyphenated slug is not the id the platform scaffold minted"
          : field === "taxonomyRegistryObjectId" ? "taxonomy terms cannot be resolved and every write that carries one is blocked"
          : field === "objectIdSource" ? "the publisher either sends a requested_id the tenant will not honour, or fails to read back a server-minted one"
          : "the publisher falls back to the shared contract default instead of this tenant's declared request-id shape",
        reconcilable: true
      });
    }
  }

  // 2. Publish autonomy. The fleet's standing decision (Wolf, 2026-09-07) read off the reference
  // rather than restated: whatever dr-lurie publishes under, a minted tenant publishes under.
  const expectedAutonomy = reference.publishingPolicy.autonomyMode ?? "autonomous";
  if ((config.publishingPolicy.autonomyMode ?? "operator-gated") !== expectedAutonomy) {
    divergences.push({
      field: "publishingPolicy.autonomyMode",
      expected: expectedAutonomy,
      actual: config.publishingPolicy.autonomyMode ?? "(unset — resolves operator-gated)",
      consequence: "every run this tenant starts parks at publication_controller waiting for an operator decision nobody was told to make; publish_executor and release_executor stay refused",
      reconcilable: true
    });
  }
  if (config.publishingPolicy.publishEnabled !== reference.publishingPolicy.publishEnabled) {
    divergences.push({
      field: "publishingPolicy.publishEnabled",
      expected: String(reference.publishingPolicy.publishEnabled),
      actual: String(config.publishingPolicy.publishEnabled),
      consequence: "the hard kill-switch precondition is off; no run on this tenant can publish at all",
      // Server-controlled by design: project.update exposes autonomyMode ONLY.
      reconcilable: false
    });
  }

  // 3. Effective tool permission, verb by verb, against the reference's OWN effective answer. This is
  // the comparison that matters and the one a policy-map diff gets wrong: dr-lurie is
  // `defaultToolPolicy: "allowed"` with two exceptions, a minted tenant is `blocked` with an explicit
  // map, and the maps therefore look nothing alike while the EFFECTIVE answers must match.
  for (const verb of declaredRouteVerbs()) {
    if (GENESIS_WITHHELD_ROUTE_VERBS.includes(verb)) continue;
    const expected = effectiveToolPermission(reference, verb);
    const actual = effectiveToolPermission(config, verb);
    if (actual !== expected) {
      divergences.push({
        field: `toolPolicies.${verb}`,
        expected,
        actual,
        consequence: `the route that speaks ${verb} is refused pre-transport on this tenant and reports blocked, while it runs on ${reference.projectId}`,
        reconcilable: true
      });
    }
  }

  // 4. The addressing facts every fleet job reads off a record.
  if (!config.tracking?.projectId) {
    divergences.push({
      field: "tracking.projectId",
      expected: config.projectId.toLowerCase().replace(/[^a-z0-9]/g, ""),
      actual: "(unset)",
      consequence: "the sink partition is derived rather than recorded, so a tenant whose partition is not the conventional one is read at the wrong one and its tracking looks empty",
      reconcilable: true
    });
  }
  if (!config.clientSiteBinding?.netlifySiteName) {
    divergences.push({
      field: "clientSiteBinding.netlifySiteName",
      expected: "(the tenant's Netlify site name)",
      actual: "(unset)",
      consequence: "the fleet credential reconciler silently OMITS this tenant from every plan — it reads as nothing-to-do right up until its chat bearer 401s",
      reconcilable: false
    });
  }
  if (!config.tokenSecretRef && !config.tokenEnvVar) {
    divergences.push({
      field: "tokenSecretRef",
      expected: "(a Secret Manager version reference, or a token env var NAME)",
      actual: "(neither)",
      consequence: "no plane can resolve this tenant's inbound bearer; every tenant call 401s",
      reconcilable: false
    });
  }
  // GENESIS-MINTED RECORDS ONLY. `definitionVersion` is per-DEFINITION, not fleet-wide: a
  // code-defined project carries its own definition's version (dr-lurie is at 10 and always will be
  // ahead of the genesis profile), and comparing the two numbers would be comparing two unrelated
  // counters. `isGenesisMintedProject` keys on clientSiteBinding, which only genesis, the reconciler
  // and project.update can set.
  if (isGenesisMintedProject(config) && (config.definitionVersion ?? 0) !== GENESIS_TENANT_DEFINITION_VERSION) {
    divergences.push({
      field: "definitionVersion",
      expected: String(GENESIS_TENANT_DEFINITION_VERSION),
      actual: config.definitionVersion === undefined ? "(unset)" : String(config.definitionVersion),
      consequence: "this tenant is a profile version behind and will be re-migrated on every read until it is not",
      reconcilable: true
    });
  }
  return divergences;
}
