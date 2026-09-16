import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #329 fixed deploy-site-credential-reconciler-schedule.sh's silent-403 defect (an advisory-only IAM
// footer, never checked) but explicitly left its siblings alone, on the reasoning that each of them
// fires a bare Cloud Run Jobs :run with no overrides body, so roles/run.invoker (run.jobs.run) is
// genuinely the right permission for their call shape — unlike the reconciler's overrides call, which
// needs run.jobs.runWithOverrides. That reasoning about WHICH permission is right still holds. But the
// MECHANISM defect — advising a permission instead of verifying it before the schedule is put in
// place — was never specific to the reconciler's wrong-permission case; it is a defect in any
// schedule script that can end up "Enabled" and 403ing on every fire with nothing catching it. This
// file asserts every sibling closed that mechanism gap the same way the reconciler did: via
// scripts/lib/assert-scheduler-run-permission.sh (see
// tests/deploy/assertSchedulerRunPermissionLib.test.ts for the mechanism itself), naming
// run.jobs.run as the permission their own bare-run call shape actually needs.
const repoFile = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string) => readFileSync(repoFile(relative), "utf8");

const codeLines = (body: string) => body.split("\n").filter((line) => !line.trimStart().startsWith("#"));
const codeOf = (body: string) => codeLines(body).join("\n");

const SIBLINGS = [
  { file: "deploy-strategy-review-schedule.sh", precedesJob: "scripts/deploy-strategy-review.sh" },
  { file: "deploy-strategy-learning-schedule.sh", precedesJob: "scripts/deploy-strategy-learning.sh" },
  { file: "deploy-tracking-ingest-schedule.sh", precedesJob: "scripts/deploy-tracking-ingest.sh" },
] as const;

describe.each(SIBLINGS)("scripts/$file", ({ file, precedesJob }) => {
  const script = read(`scripts/${file}`);
  const code = codeOf(script);

  it("fires a bare :run with no overrides body, so run.jobs.run (roles/run.invoker) is the right permission", () => {
    // The header explains WHY (mentioning overrides.containerOverrides in prose to contrast with
    // deploy-site-credential-reconciler-schedule.sh's --apply call) — only the EXECUTABLE lines must
    // stay free of an actual overrides body.
    expect(code).not.toContain("containerOverrides");
    expect(code).not.toContain("--message-body");
  });

  it("names run.jobs.run as REQUIRED_PERMISSION and offers roles/run.invoker as the grant", () => {
    expect(script).toContain('REQUIRED_PERMISSION="run.jobs.run"');
    expect(script).toContain("roles/run.invoker");
  });

  it("sources the shared #329 mechanism and verifies before configuring the schedule", () => {
    expect(script).toContain("scripts/lib/assert-scheduler-run-permission.sh");
    const assertIndex = code.indexOf("assert_scheduler_run_permission ");
    const createIndex = code.indexOf("gcloud scheduler jobs create");
    const updateIndex = code.indexOf("gcloud scheduler jobs update");
    expect(assertIndex).toBeGreaterThan(-1);
    expect(assertIndex).toBeLessThan(createIndex);
    expect(assertIndex).toBeLessThan(updateIndex);
  });

  it("no longer prints the original bare, unverified advisory footer", () => {
    expect(script).not.toMatch(/say\s+"Verify \$SCHEDULER_SA has run\.jobs\.run on \$JOB \(roles\/run\.invoker\) before the first scheduled fire — this script does not widen IAM\."/);
  });

  it("prints a footer that reflects whether the permission was actually verified", () => {
    expect(code).toContain('scheduler_permission_footer "$REQUIRED_PERMISSION" "$JOB" "$SCHEDULER_SA"');
  });

  it("still refuses to schedule a job that does not exist yet", () => {
    expect(script).toContain(precedesJob);
  });
});
