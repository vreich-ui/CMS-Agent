import { defaultProjectConnections } from "./defaultProjects.js";
import { GENESIS_TENANT_DEFINITION_VERSION, genesisTenantProfile, isGenesisMintedProject } from "./genesisTenantProfile.js";
import type { ProjectConnectionConfig } from "./projectTypes.js";

const clone = <T>(value: T): T => structuredClone(value);

const defaultProjectsById = new Map(defaultProjectConnections.map((project) => [project.projectId, project]));

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

  return { config: clone(defaultConfig), changed: true };
}

export function defaultProjectConfigs(): ProjectConnectionConfig[] {
  return defaultProjectConnections.map((project) => clone(project));
}
