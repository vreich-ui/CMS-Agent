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
// real permission before configuring the schedule rather than merely advising about it.
//
// `gcloud run jobs test-iam-permissions` DOES NOT EXIST (checked against the gcloud command index:
// add-iam-policy-binding, create, delete, deploy, describe, execute, executions, get-iam-policy,
// list, logs, remove-iam-policy-binding, replace, set-iam-policy, update — no test-iam-permissions).
// An earlier version of this script called that nonexistent subcommand, which would `die` on EVERY
// deploy. The regression test below exists specifically so that mistake cannot reappear silently.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

/** Comment lines document the incident at length; only executable lines can act on it. */
const codeLines = (body: string) => body.split("\n").filter((line) => !line.trimStart().startsWith("#"));
const codeOf = (body: string) => codeLines(body).join("\n");

const script = read("scripts/deploy-site-credential-reconciler-schedule.sh");
const code = codeOf(script);

describe("scripts/deploy-site-credential-reconciler-schedule.sh — the runWithOverrides permission", () => {
  it("names run.jobs.runWithOverrides as the permission this scheduler body needs", () => {
    expect(script).toContain("run.jobs.runWithOverrides");
  });

  it("no longer tells the operator that roles/run.invoker alone is sufficient", () => {
    // The original defect: "Verify $SCHEDULER_SA has the run.jobs.run IAM permission on $JOB
    // (roles/run.invoker or roles/run.developer)". That exact advisory sentence must be gone.
    expect(script).not.toMatch(/run\.jobs\.run IAM permission on \$JOB \(roles\/run\.invoker or roles\/run\.developer\)/);
  });

  it("states plainly that roles/run.invoker does not include runWithOverrides", () => {
    expect(script).toMatch(/roles\/run\.invoker does NOT include|roles\/run\.invoker does not carry it/);
  });

  it("never calls the nonexistent gcloud subcommand `run jobs test-iam-permissions` — regression guard", () => {
    // This exact mistake was caught by the coordinator, not by this suite, on the previous version
    // of this file: `gcloud run jobs test-iam-permissions` is not a real subcommand, and calling it
    // would die on every single deploy. Guard against it reappearing.
    expect(code).not.toMatch(/gcloud\s+run\s+jobs\s+test-iam-permissions/);
  });

  it("hits the real REST method — Cloud Run Admin API v2 :testIamPermissions — with curl", () => {
    expect(code).toMatch(/run\.googleapis\.com\/v2\/projects\/\$\{PROJECT\}\/locations\/\$\{REGION\}\/jobs\/\$\{JOB\}:testIamPermissions/);
    expect(code).toContain("curl");
    // The request body is a double-quoted shell string with escaped inner quotes:
    // -d "{\"permissions\":[\"$REQUIRED_PERMISSION\"]}"
    expect(code).toMatch(/\\"permissions\\":\[\\"\$REQUIRED_PERMISSION\\"\]/);
  });

  it("authenticates the check as an impersonated SCHEDULER_SA token, not the deployer's own identity", () => {
    expect(code).toContain("gcloud auth print-access-token");
    expect(code).toContain('--impersonate-service-account="$SCHEDULER_SA"');
    expect(code).toMatch(/REQUIRED_PERMISSION="run\.jobs\.runWithOverrides"/);
  });

  it("requires curl on PATH as an explicit prerequisite, in the same style as the gcloud check", () => {
    expect(code).toMatch(/command -v curl >\/dev\/null \|\| die/);
  });

  it("distinguishes token-mint failure (deployer lacks impersonation rights) from a missing grant on SCHEDULER_SA, with different remediation for each", () => {
    // Two separate `die` call sites, each naming a different cause and a different fix — not one
    // generic "IAM problem" message that conflates who needs what.
    expect(script).toMatch(/die "Could not mint an impersonated access token/);
    expect(script).toMatch(/lacks roles\/iam\.serviceAccountTokenCreator on \$SCHEDULER_SA — a DIFFERENT grant than run\.jobs\.runWithOverrides/);
    expect(script).toMatch(/die "\$SCHEDULER_SA does NOT hold \$REQUIRED_PERMISSION/);
    expect(script).toMatch(/a role that NAMES run\.jobs\.runWithOverrides explicitly/);
  });

  it("treats an empty testIamPermissions response as a normal negative answer, not an error, but checks for an explicit error field first", () => {
    expect(script).toMatch(/empty .*permissions.* array.*NORMAL negative answer/i);
    expect(code).toContain('grep -q \'"error"\'');
  });

  it("dies (does not merely warn) when the permission is missing, with a concrete, name-agnostic remediation command", () => {
    // The check must be able to fail the script, not just print advice — an unusable scheduler must
    // become impossible to deploy silently. The remediation must not depend on roles/run.developer
    // being correct (that claim is explicitly unverified here) — it must offer a custom role that
    // names the permission directly as the reliable route.
    expect(code).toMatch(/die\s+"\$SCHEDULER_SA does NOT hold \$REQUIRED_PERMISSION/);
    expect(script).toContain("gcloud iam roles create");
    expect(script).toContain("run.jobs.runWithOverrides");
    expect(script).toMatch(/roles\/run\.developer is documented by Google.*not been independently confirmed/s);
  });

  it("offers ALLOW_UNVERIFIED_INVOKER=1 as an explicit, fail-closed-by-default escape hatch that names the real consequence", () => {
    expect(code).toMatch(/ALLOW_UNVERIFIED_INVOKER:-0/);
    expect(code).toContain('"${ALLOW_UNVERIFIED_INVOKER:-0}" == "1"');
    // The default (unset) must take the verifying branch, not the skip branch.
    expect(script).toMatch(/default is fail-closed/i);
    // The warning must name the concrete, specific consequence, not a vague caveat.
    expect(script).toContain("403 on every fire and fail silently");
    expect(script).toContain("five days in September 2026");
  });

  it("runs the permission check before the scheduler job is created or updated", () => {
    const checkIndex = code.indexOf("REQUIRED_PERMISSION=");
    const createIndex = code.indexOf("gcloud scheduler jobs create");
    const updateIndex = code.indexOf("gcloud scheduler jobs update");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeLessThan(createIndex);
    expect(checkIndex).toBeLessThan(updateIndex);
  });

  it("still asserts, in words, that this script does not widen IAM itself", () => {
    // The header's original boundary ("this script does not widen IAM") must survive the rewrite:
    // asserting the permission is the fix, granting it is not this script's job. The remediation
    // commands (impersonation grant, custom-role grant) are advisory text inside die's message for
    // an operator to run by hand — not gcloud calls this script itself makes; the only network calls
    // this script itself executes are the token mint, the testIamPermissions POST, `gcloud run jobs
    // describe`, and `gcloud scheduler jobs describe/create/update`, asserted by name above.
    expect(script).toMatch(/does not widen IAM/);
    expect((script.match(/does not widen IAM/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the container-override args array in lockstep with the apply tool's own args", () => {
    expect(script).toContain('"--import","tsx","src/agent/entrypoints/reconcileSiteCredentialsMain.ts","--apply"');
  });
});
