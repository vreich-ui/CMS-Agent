// G2 (2026-09-14) — REPAIRING A TENANT BORN BEFORE THE BIRTH PATH WAS RIGHT.
//
// THE RULE THIS OBEYS (Wolf, 2026-09-13): fix the mechanism, not the tenant. genesis-lab-2 is
// missing an object dialect and a publish posture, and the temptation is a one-line `project.update`
// in a console. That would repair one tenant and leave the NEXT one to be discovered the same way.
// So the repair is a code path: it derives what genesis would write for this tenant TODAY (from the
// same `genesisParity` table the birth path and the parity check read), applies exactly the subset it
// can apply from the record alone, and reports the rest. Running it twice is a no-op; running it on a
// tenant that is already correct writes nothing.
//
// WHAT IT WILL NOT DO, and why each refusal is deliberate:
//   - It never touches `publishEnabled` or `requiresExplicitPublish`. Those stay server-controlled;
//     `autonomyMode` is the single sanctioned crack (T15.5 / ADR-2026-08-25-publish-autonomy §2.2).
//   - It never writes `clientSiteBinding` or a token reference. Both are ASSERTIONS about a Netlify
//     site and a secret this process may not have provisioned; inventing either would make the
//     credential reconciler act on a binding nobody minted.
//   - It never rotates a bearer, never calls Netlify, and never writes to the tenant's object store.
//     A record repair that reached for infrastructure would be a second, unaudited genesis.
//   - It never overwrites a dialect field that is already set to something ELSE. A tenant whose
//     objects genuinely live at non-conventional ids has been deliberately configured, and a
//     "reconcile" that silently re-pointed it at the convention would break a working tenant. Such a
//     field is reported as a divergence for a human to judge, never repaired.
import { updateProject } from "../projects/projectAdmin.js";
import { genesisParityDivergences, type ParityDivergence } from "../projects/genesisParity.js";
import { expectedObjectDialect } from "../projects/genesisParity.js";
import type { ProjectConnectionConfig, ProjectObjectDialect, ProjectSummary } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { GENESIS_DEFAULT_OBJECT_TYPE, GENESIS_REQUEST_ID_PATTERN } from "./siteGenesis.js";
import { genesisTenantProfile } from "../projects/genesisTenantProfile.js";

export type GenesisReconcilePlan = {
  projectId: string;
  divergences: ParityDivergence[];
  /** The `project.update` patch this plan would apply. Empty object = nothing to do. */
  patch: {
    objectDialect?: ProjectObjectDialect;
    autonomyMode?: "autonomous" | "operator-gated";
    defaultToolPolicy?: ProjectConnectionConfig["defaultToolPolicy"];
    toolPolicies?: ProjectConnectionConfig["toolPolicies"];
    tracking?: { projectId: string };
  };
  /** Divergences this plan deliberately leaves alone, each with the reason. */
  deferred: Array<{ field: string; reason: string }>;
};

const parityOptions = { requestIdPattern: GENESIS_REQUEST_ID_PATTERN, defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE };

/**
 * PURE. Decide what to repair, without repairing anything — so the decision is testable on its own
 * and an operator can read it before it is applied.
 */
export function planGenesisReconcile(config: ProjectConnectionConfig): GenesisReconcilePlan {
  const divergences = genesisParityDivergences(config, parityOptions);
  const patch: GenesisReconcilePlan["patch"] = {};
  const deferred: GenesisReconcilePlan["deferred"] = [];

  const dialectDivergences = divergences.filter((divergence) => divergence.field.startsWith("objectDialect."));
  if (dialectDivergences.length > 0) {
    const expected = expectedObjectDialect(config.projectId, parityOptions.requestIdPattern, parityOptions.defaultObjectType);
    const conflicting = dialectDivergences.filter((divergence) => divergence.actual !== "(unset)");
    if (conflicting.length > 0) {
      // Set to something else ON PURPOSE, as far as this code can tell. Report, never overwrite.
      for (const divergence of conflicting) {
        deferred.push({
          field: divergence.field,
          reason: `This tenant already declares ${divergence.field} = "${divergence.actual}", which is not the id the platform scaffold mints ("${divergence.expected}"). A dialect pointer that disagrees with the convention is the documented escape hatch for a tenant whose objects genuinely live elsewhere, so reconcile will not overwrite it. Confirm against object_list on the tenant, then set it deliberately with project.update if it is wrong.`
        });
      }
    } else {
      // Additive only: fill the unset fields, keep anything already there.
      patch.objectDialect = { ...expected, ...(config.objectDialect ?? {}) } as ProjectObjectDialect;
    }
  }

  if (divergences.some((divergence) => divergence.field === "publishingPolicy.autonomyMode")) patch.autonomyMode = "autonomous";
  if (divergences.some((divergence) => divergence.field.startsWith("toolPolicies.")) || divergences.some((divergence) => divergence.field === "definitionVersion")) {
    // The whole profile, not a per-verb patch: `toolPolicies` replaces the map wholesale through
    // project.update, and a partial map would silently drop every verb it did not mention.
    const profile = genesisTenantProfile();
    patch.defaultToolPolicy = profile.defaultToolPolicy;
    patch.toolPolicies = profile.toolPolicies;
  }
  if (divergences.some((divergence) => divergence.field === "tracking.projectId")) {
    patch.tracking = { projectId: config.projectId.toLowerCase().replace(/[^a-z0-9]/g, "") };
  }

  for (const divergence of divergences.filter((entry) => !entry.reconcilable)) {
    deferred.push({
      field: divergence.field,
      reason: `Not repairable from the record alone: ${divergence.consequence}. Expected ${divergence.expected}, found ${divergence.actual}.`
    });
  }
  return { projectId: config.projectId, divergences, patch, deferred };
}

export type GenesisReconcileResult = GenesisReconcilePlan & { applied: boolean; project?: ProjectSummary };

/**
 * Apply the plan. `dryRun` (the default) reports and writes nothing — an operator reads the plan
 * before a record changes, the same posture site genesis takes with its own dry-run mode.
 *
 * `definitionVersion` is NOT patchable through `project.update` (it is a trusted create-time field),
 * so a tenant behind on the profile version has its policy map brought current here and the version
 * itself is left to `migrateDefaultProjectConfig`. The divergence is still reported, which is the
 * point: it is visible either way.
 */
export async function runGenesisReconcile(
  projectId: string,
  repository: ProjectRepository,
  { dryRun = true }: { dryRun?: boolean } = {}
): Promise<GenesisReconcileResult> {
  const config = await repository.get(projectId);
  if (!config) throw new Error(`unknown_project: no project "${projectId}" is registered.`);
  const plan = planGenesisReconcile(config);
  if (dryRun || Object.keys(plan.patch).length === 0) return { ...plan, applied: false };
  const project = await updateProject(repository, projectId, plan.patch);
  return { ...plan, applied: true, project };
}
