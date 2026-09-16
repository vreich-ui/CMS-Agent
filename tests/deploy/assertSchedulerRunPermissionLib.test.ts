import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/lib/assert-scheduler-run-permission.sh is the ONE place the #329 fix lives: verifying,
// via a live Cloud Run Admin API v2 testIamPermissions call, that a Cloud Scheduler job's service
// account actually holds the IAM permission its request shape needs — instead of a deploy-*-
// schedule.sh script only printing advice an operator might follow for the wrong permission.
//
// #329's own incident: deploy-site-credential-reconciler-schedule.sh advised "grant roles/run.invoker",
// an operator did, and every fire still 403'd, because that job's request carries
// overrides.containerOverrides.args and needs run.jobs.runWithOverrides instead. The mechanism that
// fixed it is asserted HERE, once, so every deploy-*-schedule.sh script that sources this file gets
// the same guarantee rather than a copy that could drift or a sibling that never got the fix at all.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

/** Comment lines document the incident at length; only executable lines can act on it. */
const codeLines = (body: string) => body.split("\n").filter((line) => !line.trimStart().startsWith("#"));
const codeOf = (body: string) => codeLines(body).join("\n");

const lib = read("scripts/lib/assert-scheduler-run-permission.sh");
const code = codeOf(lib);

describe("scripts/lib/assert-scheduler-run-permission.sh", () => {
  it("never calls the nonexistent gcloud subcommand `run jobs test-iam-permissions` — regression guard", () => {
    // An earlier version of this mechanism (before it was shared) called that nonexistent
    // subcommand, which would `die` on every single deploy. Guard against it reappearing anywhere.
    expect(code).not.toMatch(/gcloud\s+run\s+jobs\s+test-iam-permissions/);
  });

  it("hits the real REST method — Cloud Run Admin API v2 :testIamPermissions — with curl", () => {
    expect(code).toMatch(/run\.googleapis\.com\/v2\/projects\/\$\{project\}\/locations\/\$\{region\}\/jobs\/\$\{job\}:testIamPermissions/);
    expect(code).toContain("curl");
    expect(code).toMatch(/\\"permissions\\":\[\\"\$required_permission\\"\]/);
  });

  it("authenticates the check as an impersonated SCHEDULER_SA token, not the deployer's own identity", () => {
    expect(code).toContain("gcloud auth print-access-token");
    expect(code).toContain('--impersonate-service-account="$scheduler_sa"');
  });

  it("requires curl on PATH as an explicit prerequisite", () => {
    expect(code).toMatch(/command -v curl >\/dev\/null \|\| die/);
  });

  it("distinguishes token-mint failure (deployer lacks impersonation rights) from a missing grant, with different remediation for each", () => {
    expect(lib).toMatch(/die "Could not mint an impersonated access token/);
    expect(lib).toMatch(/lacks roles\/iam\.serviceAccountTokenCreator on \$scheduler_sa — a DIFFERENT grant than \$required_permission/);
    expect(lib).toMatch(/die "\$scheduler_sa does NOT hold \$required_permission/);
  });

  it("captures the impersonation token's stdout and stderr separately, so component-update chatter cannot corrupt the Authorization header", () => {
    expect(code).toMatch(/2>"\$token_stderr"/);
    expect(code).not.toMatch(/print-access-token[^\n]*2>&1/);
  });

  it("checks for an explicit error field before reading permissions, and treats an empty array as a normal negative, not an error", () => {
    expect(lib).toMatch(/empty .*permissions.* array.*NORMAL negative answer/i);
    expect(code).toContain('grep -q \'"error"\'');
    // The error check must run BEFORE the permission-name case statement.
    expect(code.indexOf('grep -q \'"error"\'')).toBeLessThan(code.indexOf(`case "$iam_check_response"`));
  });

  it("names #329 as the incident this mechanism exists to prevent from recurring", () => {
    expect(lib).toMatch(/#329/);
  });

  it("offers ALLOW_UNVERIFIED_INVOKER=1 as an explicit, fail-closed-by-default escape hatch", () => {
    expect(code).toMatch(/ALLOW_UNVERIFIED_INVOKER:-0/);
    expect(code).toContain('"${ALLOW_UNVERIFIED_INVOKER:-0}" == "1"');
    expect(code).toContain("403 on every fire and fail silently");
  });

  it("sets SCHEDULER_PERMISSION_VERIFIED so callers can shape their own closing footer", () => {
    expect(code).toContain("SCHEDULER_PERMISSION_VERIFIED=1");
    expect(code).toContain("SCHEDULER_PERMISSION_VERIFIED=0");
    expect(code).toContain('SCHEDULER_PERMISSION_VERIFIED:-0');
  });

  it("takes the permission and its remedy as parameters, rather than hard-coding one job's permission", () => {
    // The whole point of sharing this file is that it is permission-agnostic: callers pass
    // run.jobs.run or run.jobs.runWithOverrides (or any future permission) plus their own remedy.
    expect(code).not.toContain('REQUIRED_PERMISSION="run.jobs');
    expect(code).toMatch(/assert_scheduler_run_permission\(\)\s*\{/);
    expect(code).toMatch(/local project="\$1" region="\$2" job="\$3" scheduler_sa="\$4" required_permission="\$5" role_hint="\$6" grant_command="\$7"/);
  });
});

describe("every deploy-*-schedule.sh script sources the shared IAM-verification mechanism", () => {
  // The whole point of #329's generalized fix: no schedule script may go back to an advisory-only
  // footer, whether by never being fixed or by a future script being added without this call.
  const scriptsDir = repoFile("scripts");
  const scheduleScripts = readdirSync(scriptsDir).filter((name) => /^deploy-.*-schedule\.sh$/.test(name));

  it("found at least the six known schedule scripts", () => {
    expect(scheduleScripts.length).toBeGreaterThanOrEqual(6);
  });

  it.each(scheduleScripts)("%s sources scripts/lib/assert-scheduler-run-permission.sh and calls assert_scheduler_run_permission before writing the schedule", (name) => {
    const body = read(`scripts/${name}`);
    const bodyCode = codeOf(body);
    expect(bodyCode).toContain("lib/assert-scheduler-run-permission.sh");
    const assertIndex = bodyCode.indexOf("assert_scheduler_run_permission ");
    expect(assertIndex).toBeGreaterThan(-1);
    for (const verb of ["gcloud scheduler jobs create", "gcloud scheduler jobs update"]) {
      const verbIndex = bodyCode.indexOf(verb);
      if (verbIndex > -1) expect(assertIndex).toBeLessThan(verbIndex);
    }
  });

  it.each(scheduleScripts)("%s no longer carries a bare advisory-only IAM footer with no verification call", (name) => {
    const body = read(`scripts/${name}`);
    // The original defect shape, in either of its two wordings seen in this repo: a `say` line
    // telling the operator to "Verify"/"verify" a permission, with the script never having called
    // assert_scheduler_run_permission anywhere above it.
    const bodyCode = codeOf(body);
    const hasAssert = bodyCode.includes("assert_scheduler_run_permission ");
    const hasBareAdvisory = /say\s+"[^"]*\b[Vv]erify\b[^"]*run\.jobs\.run[^"]*IAM permission/.test(body);
    expect(hasAssert).toBe(true);
    expect(hasBareAdvisory).toBe(false);
  });
});
