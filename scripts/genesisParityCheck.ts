#!/usr/bin/env tsx
// G5 (2026-09-14) — `npm run genesis:parity-check -- <projectId> [--reconcile] [--apply] [--json]`
//
// Prints every record-level way a tenant differs from the fleet's publishing reference (dr-lurie) and
// exits NON-ZERO on any divergence, so it can be the gate on a mint rather than a thing somebody
// remembers to eyeball. The whole decision lives in `src/agent/projects/genesisParity.ts` (pure); this
// file is argument parsing, a live store, and formatting.
//
//   --reconcile   also print what `genesis:reconcile` WOULD change (writes nothing).
//   --apply       with --reconcile, actually apply it. Deliberately two flags: a repair of a live
//                 tenant's record is never a side effect of asking a question.
//   --json        machine-readable, for a CI step or a run record.
//
// WHAT A CLEAN RESULT DOES AND DOES NOT MEAN. Zero divergences means the REGISTRY RECORD carries every
// fact the fleet's working tenants carry. It says nothing about whether the tenant's Netlify site is
// deployed, its per-site secrets are installed, or its baseline objects are seeded — those live on the
// site and in its blob store, and the honest way to learn them is the tenant's own `health` and
// `object_list`, not a registry read. The script says so in its own output rather than letting a green
// line imply more than it checked.
import { genesisParityDivergences } from "../src/agent/projects/genesisParity.js";
import { planGenesisReconcile, runGenesisReconcile } from "../src/agent/capture/genesisReconcile.js";
import { GENESIS_DEFAULT_OBJECT_TYPE, GENESIS_REQUEST_ID_PATTERN } from "../src/agent/capture/siteGenesis.js";

const die = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const projectId = args.find((argument) => !argument.startsWith("--"));
if (!projectId) die("usage: npm run genesis:parity-check -- <projectId> [--reconcile] [--apply] [--json]");

const liveProjectRepository = async () => {
  const store = (process.env.WORKSPACE_STORE ?? "memory").trim();
  if (store === "" || store === "memory") {
    die(
      'WORKSPACE_STORE is unset, so it defaults to "memory" — the registry would read as EMPTY and this check would report an unknown project for a tenant that exists. ' +
      "Point it at the production store (WORKSPACE_STORE=gcs GCS_BUCKET=<bucket> [GCS_KEY_PREFIX=...], with GCP credentials)."
    );
  }
  const { bootstrapWorkspaceStore } = await import("../src/agent/entrypoints/runConductorJob.js");
  bootstrapWorkspaceStore();
  const { repositoryManager } = await import("../src/agent/runtime/repositories.js");
  return repositoryManager.getProjectRepository();
};

const main = async () => {
  const repository = await liveProjectRepository();
  const config = await repository.get(projectId!);
  if (!config) die(`unknown_project: no project "${projectId}" is registered.`);

  const divergences = genesisParityDivergences(config!, {
    requestIdPattern: GENESIS_REQUEST_ID_PATTERN,
    defaultObjectType: GENESIS_DEFAULT_OBJECT_TYPE
  });
  const plan = flags.has("--reconcile") ? planGenesisReconcile(config!) : undefined;

  if (flags.has("--reconcile") && flags.has("--apply")) {
    const result = await runGenesisReconcile(projectId!, repository, { dryRun: false });
    process.stdout.write(`[genesis:reconcile] applied=${result.applied} patch=${JSON.stringify(result.patch)}\n`);
  }

  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify({ projectId, divergences, ...(plan ? { reconcile: { patch: plan.patch, deferred: plan.deferred } } : {}) }, null, 2)}\n`);
  } else if (divergences.length === 0) {
    process.stdout.write(
      `[genesis:parity-check] ${projectId}: no record-level divergences from the fleet reference.\n` +
      "  Scope note: this checked the REGISTRY RECORD only — dialect, publish autonomy, effective tool permissions, sink partition, site binding, token custody, profile version.\n" +
      "  It did NOT check that the site is deployed, that PUBLISH_SECRET and the rest of the per-site env are installed, or that the five baseline objects are seeded. Ask the tenant's own health / object_list for those.\n"
    );
  } else {
    process.stdout.write(`[genesis:parity-check] ${projectId}: ${divergences.length} divergence(s) from the fleet reference.\n\n`);
    for (const divergence of divergences) {
      process.stdout.write(
        `  ${divergence.field}\n` +
        `      expected: ${divergence.expected}\n` +
        `      actual:   ${divergence.actual}\n` +
        `      breaks:   ${divergence.consequence}\n` +
        `      repair:   ${divergence.reconcilable ? "genesis:reconcile" : "not repairable from the record alone — see the consequence above"}\n\n`
      );
    }
    if (plan) {
      process.stdout.write(`  reconcile would patch: ${JSON.stringify(plan.patch)}\n`);
      for (const deferredItem of plan.deferred) process.stdout.write(`  reconcile defers ${deferredItem.field}: ${deferredItem.reason}\n`);
    }
  }
  process.exit(divergences.length === 0 ? 0 : 1);
};

void main();
