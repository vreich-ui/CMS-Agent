import { defaultProjectConnections } from "./defaultProjects.js";
import { GENESIS_TENANT_DEFINITION_VERSION, genesisTenantProfile, isGenesisMintedProject } from "./genesisTenantProfile.js";
import type { ProjectConnectionConfig, ToolPermission } from "./projectTypes.js";
import { effectiveToolPermission } from "./projectTypes.js";

const clone = <T>(value: T): T => structuredClone(value);

const defaultProjectsById = new Map(defaultProjectConnections.map((project) => [project.projectId, project]));

/**
 * Projects that are SERVICES this workspace calls, not publishing tenants it runs workflows on:
 * pdf-tool is the artifact/PDF foundry, monetizer is the offer index. No conductor route targets them,
 * so their deny-all posture is correct and they are excluded from the route-policy union by name —
 * not by a heuristic that could quietly swallow a real tenant.
 */
export const SERVICE_PROJECT_IDS: readonly string[] = Object.freeze(["pdf-tool", "monetizer"]);

/**
 * TENANT ROUTE PARITY (2026-09-16, Wolf: "core wide ... all tenants as well as future ones").
 *
 * Union the derived tenant route policy into a code-defined TENANT's map. One place, applied on every
 * read, rather than a list per definition file — which is how `fernwell` ended up declaring seven read
 * verbs and deny-all underneath (every write route refused pre-transport, invisible because that record
 * is disabled), and `platform` ended up holding two site-wide apply verbs at "needs_approval", which a
 * deterministic route cannot satisfy and is refused exactly like "blocked".
 *
 * GAPS ONLY — a definition row WINS over the derived set. The union closes the case where nobody ever
 * wrote a row (fernwell: every write route refused because the map simply did not mention them); it
 * does not overrule a row somebody wrote on purpose. `platform` holding the two site-wide apply verbs
 * at "needs_approval" is such a row, and reversing it from here would widen what a node can do to a
 * live site with no operator in the loop — the one thing CLAUDE.md says to stop and ask about. That
 * gap stays visible instead: the capability audit reports it, and tenantRouteParity.test.ts carries it
 * as a named exception with a reason. Withholding therefore has three honest homes, all of them
 * readable: the fleet-wide `GENESIS_WITHHELD_ROUTE_VERBS`, a tenant's own definition row, and a
 * per-tenant `operatorToolPolicies` pin, which outranks everything here and survives every migration.
 *
 * Lazy by construction — called from functions, never at module load — because the route manifests sit
 * in the workspace layer, whose own import tree reaches back into this one.
 */
export function applyTenantRoutePolicy(config: ProjectConnectionConfig): ProjectConnectionConfig {
  if (SERVICE_PROJECT_IDS.includes(config.projectId)) return config;
  return { ...config, toolPolicies: { ...genesisTenantProfile().toolPolicies, ...(config.toolPolicies ?? {}) } };
}

export function migrateDefaultProjectConfig(config: ProjectConnectionConfig): { config: ProjectConnectionConfig; changed: boolean } {
  const defaultConfig = defaultProjectsById.get(config.projectId);
  if (!defaultConfig) {
    // G5 — genesis-minted tenants. Before this branch existed the function returned here for EVERY
    // minted tenant, which is why zilberman's hand-tuned tool policy could diverge from what genesis
    // writes with nothing to notice, let alone reconcile it.
    //
    // MERGE, NEVER REPLACE. The code-project path below swaps in the whole default record, which is
    // right there (a code project's definition IS its record) and catastrophic here: it would erase
    // the minted tenant's endpoint, tokenSecretRef, objectDialect, capturePolicy and site binding.
    // Only the profile's own narrow fields are applied; everything else on the record survives
    // untouched.
    if (!isGenesisMintedProject(config)) return { config: clone(config), changed: false };
    if (config.definitionVersion === GENESIS_TENANT_DEFINITION_VERSION) return { config: clone(config), changed: false };
    return { config: { ...clone(config), ...genesisTenantProfile() }, changed: true };
  }

  if (config.definitionVersion === defaultConfig.definitionVersion) {
    return { config: clone(config), changed: false };
  }

  // OPERATOR OVERLAY (2026-09-16). The code-project branch swaps in the WHOLE default record, which
  // is right for everything a code definition owns and wrong for the one thing it does not: a decision
  // an operator made about this tenant. Carried across explicitly, because there is nothing else here
  // to carry it — this line is why a hand-granted verb on dr-lurie or platform now survives the next
  // definitionVersion bump instead of disappearing on the read that follows it.
  const preserved = config.operatorToolPolicies && Object.keys(config.operatorToolPolicies).length > 0
    ? { operatorToolPolicies: clone(config.operatorToolPolicies) }
    : {};
  return { config: applyTenantRoutePolicy({ ...clone(defaultConfig), ...preserved }), changed: true };
}

/**
 * The tool policy this tenant's record is MANAGED to — what a migration or a reconcile would put
 * there if nobody had touched it. Code projects: their own definition. Genesis-minted tenants: the
 * genesis profile. Anything else (a hand-registered project no code owns): its own current policy,
 * since nothing rewrites it and therefore nothing can erase an edit to it.
 *
 * This is the reference `deriveOperatorToolPolicies` diffs against, so "operator decision" means
 * exactly "differs from what code would have written", with no second list to keep in step.
 */
export function managedPolicyBaseline(
  config: ProjectConnectionConfig
): Pick<ProjectConnectionConfig, "allowedTools" | "defaultToolPolicy" | "toolPolicies"> {
  const defaultConfig = defaultProjectsById.get(config.projectId);
  if (defaultConfig) {
    return {
      allowedTools: [...defaultConfig.allowedTools],
      defaultToolPolicy: defaultConfig.defaultToolPolicy,
      toolPolicies: { ...(defaultConfig.toolPolicies ?? {}) }
    };
  }
  if (isGenesisMintedProject(config)) {
    const profile = genesisTenantProfile();
    return { allowedTools: [], defaultToolPolicy: profile.defaultToolPolicy, toolPolicies: { ...profile.toolPolicies } };
  }
  return {
    allowedTools: [...config.allowedTools],
    defaultToolPolicy: config.defaultToolPolicy,
    toolPolicies: { ...(config.toolPolicies ?? {}) }
  };
}

/**
 * The operator overlay implied by a record's CURRENT managed map: every verb whose effective
 * permission differs from the managed baseline's answer for that verb.
 *
 * DELIBERATELY ADDITIONS-AND-CHANGES ONLY. A verb the baseline names and the written map OMITS is not
 * pinned: `toolPolicies` replaces wholesale, so an omission is as often a caller sending a partial map
 * (the failure mode `requirePatchField` exists for) as it is a decision — and pinning it would make
 * that accident permanent and put the profile's own later grants permanently out of reach. An operator
 * who means "never allow this here" says so by naming the verb "blocked", which IS a difference and IS
 * pinned.
 */
export function deriveOperatorToolPolicies(config: ProjectConnectionConfig): Record<string, ToolPermission> {
  const baseline = managedPolicyBaseline(config);
  // Start from the overlay the record already carries, and let the WRITTEN map add to it or release
  // from it. Recomputing from scratch instead would hand `genesis:reconcile` the erasure this whole
  // change exists to remove: reconcile's patch IS the baseline map, so a from-scratch derivation would
  // find no deviations and drop every pin on the very call meant to leave them alone.
  const overlay: Record<string, ToolPermission> = { ...(config.operatorToolPolicies ?? {}) };
  for (const [verb, permission] of Object.entries(config.toolPolicies ?? {})) {
    // Named and different -> an operator decision, pinned. Named and identical to the baseline -> the
    // operator has handed the verb back to the managed policy, so the pin is released. Not named at
    // all -> untouched, because an omission from a wholesale map is not a decision (see above).
    if (effectiveToolPermission(baseline, verb) !== permission) overlay[verb] = permission;
    else delete overlay[verb];
  }
  return overlay;
}

export function defaultProjectConfigs(): ProjectConnectionConfig[] {
  return defaultProjectConnections.map((project) => applyTenantRoutePolicy(clone(project)));
}
