import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/deploy-site-credential-reconciler-schedule.sh configures the ONE Cloud Scheduler job that
// fires the fleet Client Manager credential reconciler WITH --apply. Confirmed live 2026-09-14: every
// fire 403'd from deployment, because the scheduler's request body carries
// overrides.containerOverrides.args (how --apply is injected) and running a Cloud Run job WITH
// OVERRIDES needs run.jobs.runWithOverrides — a permission roles/run.invoker does NOT carry, even
// though the role name reads as though it should cover "running a job". This file asserts the
// script no longer tells operators that roles/run.invoker is sufficient, and that it VERIFIES the
// real permission before configuring the schedule (via the shared
// scripts/lib/assert-scheduler-run-permission.sh mechanism — see
// tests/deploy/assertSchedulerRunPermissionLib.test.ts for the mechanism itself) rather than merely
// advising about it.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

/** Comment lines document the incident at length; only executable lines can act on it. */
const codeLines = (body: string) => body.split("\n").filter((line) => !line.trimStart().startsWith("#"));
const codeOf = (body: string) => codeLines(body).join("\n");

const script = read("scripts/deploy-site-credential-reconciler-schedule.sh");
const code = codeOf(script);

describe("scripts/deploy-site-credential-reconciler-schedule.sh — the runWithOverrides permission", () => {
  it("names run.jobs.runWithOverrides, not run.jobs.run, as the permission this scheduler body needs", () => {
    expect(script).toContain('REQUIRED_PERMISSION="run.jobs.runWithOverrides"');
  });

  it("no longer tells the operator that roles/run.invoker alone is sufficient", () => {
    // The original defect: "Verify $SCHEDULER_SA has the run.jobs.run IAM permission on $JOB
    // (roles/run.invoker or roles/run.developer)". That exact advisory sentence must be gone.
    expect(script).not.toMatch(/run\.jobs\.run IAM permission on \$JOB \(roles\/run\.invoker or roles\/run\.developer\)/);
  });

  it("states plainly that roles/run.invoker does not include runWithOverrides", () => {
    expect(script).toMatch(/roles\/run\.invoker does NOT include|roles\/run\.invoker does NOT carry it|roles\/run\.invoker does not carry it/);
  });

  it("sources the shared IAM-verification mechanism rather than inlining its own copy", () => {
    expect(script).toContain("scripts/lib/assert-scheduler-run-permission.sh");
    expect(code).toContain("source ");
    // The REST call itself, the ALLOW_UNVERIFIED_INVOKER branch, and the token-mint logic now live
    // in the shared library (asserted by tests/deploy/assertSchedulerRunPermissionLib.test.ts), not
    // duplicated here — this script's own job is only to name its permission and its remedy.
    expect(code).not.toMatch(/gcloud\s+run\s+jobs\s+test-iam-permissions/);
  });

  it("passes a name-agnostic, custom-role remediation as its grant command — not a role-name grep", () => {
    // The remediation must not depend on roles/run.developer being correct (that claim is explicitly
    // unverified here) — it must offer a custom role that names the permission directly.
    expect(script).toContain("gcloud iam roles create");
    expect(script).toContain("run.jobs.runWithOverrides");
    expect(script).toMatch(/roles\/run\.developer is documented by Google.*not been independently confirmed/s);
  });

  it("runs the permission check before the scheduler job is created or updated", () => {
    const assertIndex = code.indexOf("assert_scheduler_run_permission ");
    const createIndex = code.indexOf("gcloud scheduler jobs create");
    const updateIndex = code.indexOf("gcloud scheduler jobs update");
    expect(assertIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(-1);
    expect(assertIndex).toBeLessThan(createIndex);
    expect(assertIndex).toBeLessThan(updateIndex);
  });

  it("prints a footer that reflects whether the permission was actually verified", () => {
    expect(code).toContain('scheduler_permission_footer "$REQUIRED_PERMISSION" "$JOB" "$SCHEDULER_SA"');
  });

  it("still asserts, in words, that this script does not widen IAM itself", () => {
    // The header's original boundary ("this script does not widen IAM") must survive the rewrite:
    // asserting the permission is the fix, granting it is not this script's job.
    expect(script).toMatch(/does not widen IAM/);
  });

  it("keeps the container-override args array in lockstep with the apply tool's own args", () => {
    expect(script).toContain('"--import","tsx","src/agent/entrypoints/reconcileSiteCredentialsMain.ts","--apply"');
  });
});
