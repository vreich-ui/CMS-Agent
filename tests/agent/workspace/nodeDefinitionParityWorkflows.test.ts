import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// T6 (docs/plan/two-plane-reconciliation-plan.md §B) — the two checks that watch the canonical/store
// seam, asserted as structure rather than prose. The point of each assertion is a failure mode that
// has actually happened:
//   * the blocking gate silently dropped out of CI and the seam went unwatched (§5F.2);
//   * the credentialed check became a required per-PR check, went red on a diff its author could not
//     fix, and was disabled;
//   * a credentialed run read nothing and reported no drift (the 2026-08-14 false green), which is why
//     the parity job must print the backend it read.
const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
const parity = readFileSync(new URL("../../../.github/workflows/node-definition-parity.yml", import.meta.url), "utf8");

describe("node-definition drift is watched by CI", () => {
  it("runs the offline gate inside the existing drift job, which the summary check requires", () => {
    expect(ci).toContain("npm run nodes:check:offline");
    const driftJob = ci.slice(ci.indexOf("\n  drift:"), ci.indexOf("\n  summary:"));
    expect(driftJob).toContain("npm run nodes:check:offline");
    expect(ci).toContain("needs: [workspace, ui, drift]");
  });

  it("keeps the offline gate credential-free — it must be green on a fork PR", () => {
    const driftJob = ci.slice(ci.indexOf("\n  drift:"), ci.indexOf("\n  summary:"));
    expect(driftJob).not.toContain("secrets.");
    expect(driftJob).not.toContain("google-github-actions/auth");
  });

  it("keeps the credentialed parity check scheduled and dispatchable, never a pull_request check", () => {
    expect(parity).toContain("schedule:");
    expect(parity).toContain("workflow_dispatch:");
    expect(parity).not.toContain("pull_request");
    // 24 minutes after cloud-run-plane's 07:17 so the two never contend for the same service account.
    expect(parity).toContain('cron: "41 7 * * *"');
    expect(readFileSync(new URL("../../../.github/workflows/cloud-run-plane.yml", import.meta.url), "utf8")).toContain('cron: "17 7 * * *"');
  });

  it("runs both directions of the parity check, and does not let the first hide the second", () => {
    expect(parity).toContain("npm run nodes:check");
    expect(parity).toContain("npm run store:check");
    expect(parity.slice(parity.indexOf("npm run nodes:check\n"))).toContain("if: always()");
  });

  it("names the backend and bucket it reads, and never writes", () => {
    expect(parity).toContain("WORKSPACE_STORE: gcs");
    expect(parity).toContain("GCS_BUCKET: cms-agent-503015-cms-agent-state");
    // Comments quote the write commands on purpose (the runbook has to name them); only what the job
    // actually EXECUTES may not write. Both scripts are read-only unless --write is passed.
    const executed = parity.split("\n").filter((line) => line.trimStart().startsWith("run:") || line.trimStart().startsWith("- run:")).join("\n");
    expect(executed).toContain("npm run nodes:check");
    expect(executed).toContain("npm run store:check");
    expect(executed).not.toContain("--write");
    expect(executed).not.toContain("nodes:update");
    expect(executed).not.toContain("store:update");
  });

  it("carries the red-gate runbook where the developer will find it, including the flags never to reach for", () => {
    for (const phrase of ["--allow-prompt-shrink", "--adopt-store-topology", "C-19", "nodes:update"]) expect(parity).toContain(phrase);
  });
});
