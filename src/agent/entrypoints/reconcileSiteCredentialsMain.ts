import { reconcileSiteClientManagerCredentials } from "../capture/siteCredentialReconciler.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";
import { repositoryManager } from "../runtime/repositories.js";

const apply = process.argv.includes("--apply");

try {
  bootstrapWorkspaceStore();
  const results = await reconcileSiteClientManagerCredentials(
    { apply },
    { projectRepository: repositoryManager.getProjectRepository() }
  );
  // Safe report: project/site names, status, and catalogued code only. No bearer or response body.
  process.stdout.write(`${JSON.stringify({ contract: "site_credential_reconcile.v1", mode: apply ? "apply" : "dry_run", results })}\n`);
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "credential_reconcile_failed";
  process.stderr.write(`${JSON.stringify({ contract: "site_credential_reconcile.v1", mode: apply ? "apply" : "dry_run", ok: false, errorCode: code })}\n`);
  process.exitCode = 1;
}
