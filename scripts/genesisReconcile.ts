#!/usr/bin/env tsx
// G2 (2026-09-14) — `npm run genesis:reconcile -- <projectId> [--apply]`
//
// The CODE PATH that repairs a tenant minted before the birth path wrote its object dialect and
// publish posture — the alternative to a hand `project.update`, which fixes one tenant and leaves the
// next one to be found the same way. Dry-run by default: it prints the patch and changes nothing
// unless `--apply` is passed.
//
// The whole decision is `src/agent/capture/genesisReconcile.ts` (pure, tested); this is a thin shell.
import { planGenesisReconcile, runGenesisReconcile } from "../src/agent/capture/genesisReconcile.js";

const die = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const projectId = args.find((argument) => !argument.startsWith("--"));
if (!projectId) die("usage: npm run genesis:reconcile -- <projectId> [--apply]");

const liveProjectRepository = async () => {
  const store = (process.env.WORKSPACE_STORE ?? "memory").trim();
  if (store === "" || store === "memory") {
    die('WORKSPACE_STORE is unset, so it defaults to "memory" — the registry would read as EMPTY. Point it at the production store (WORKSPACE_STORE=gcs GCS_BUCKET=<bucket>, with GCP credentials).');
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
  const plan = planGenesisReconcile(config!);

  process.stdout.write(`[genesis:reconcile] ${projectId}: ${plan.divergences.length} divergence(s).\n`);
  process.stdout.write(`  patch: ${JSON.stringify(plan.patch, null, 2)}\n`);
  for (const deferredItem of plan.deferred) process.stdout.write(`  DEFERRED ${deferredItem.field}: ${deferredItem.reason}\n`);

  if (!apply) {
    process.stdout.write("  (dry run — nothing was written. Re-run with --apply to write the patch above.)\n");
    process.exit(0);
  }
  const result = await runGenesisReconcile(projectId!, repository, { dryRun: false });
  process.stdout.write(`  applied=${result.applied}\n`);
  process.exit(0);
};

void main();
