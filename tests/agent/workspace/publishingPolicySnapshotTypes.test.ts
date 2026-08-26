import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { getRun, resetRun, startDryRun } from "../../../src/agent/workspace/executor.js";
import { resolvePublishableTypeCharter } from "../../../src/agent/workspace/publishableTypeCharter.js";

// T15.11 (2026-08-25, #190; ADR-2026-08-25-publish-autonomy §6.3, §2.5) — the charter is SNAPSHOTTED
// onto the run at creation (executor.ts capturePublishingPolicySnapshot), keyed by the run's OWN
// workflowId, and survives workflow.reset_run exactly like autonomyMode/publishEnabled do (§2.5's
// same reasoning, one field over).

describe("run creation snapshots this run's chartered publishable types (T15.11/#190)", () => {
  it("publishing_conductor's run snapshots the narrow page/navigation charter", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    expect(run.workflowId).toBe("publishing_conductor");
    expect([...(run.publishingPolicySnapshot?.publishableTypes ?? [])].sort()).toEqual(["navigation", "page"]);
  });

  it("capture_conductor's run snapshots the T15.11-widened charter (page, navigation, theme, site, section_template)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", workflowId: "capture_conductor", input: { sourceUrl: "https://example.com" } }, store);
    expect(run.workflowId).toBe("capture_conductor");
    expect([...(run.publishingPolicySnapshot?.publishableTypes ?? [])].sort()).toEqual(["navigation", "page", "section_template", "site", "theme"]);
  });

  it("the run's snapshot equals resolvePublishableTypeCharter(run.workflowId).publishableTypes at creation time", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", workflowId: "capture_conductor", input: { sourceUrl: "https://example.com" } }, store);
    const charter = resolvePublishableTypeCharter("capture_conductor");
    expect([...(run.publishingPolicySnapshot?.publishableTypes ?? [])].sort()).toEqual([...charter.publishableTypes].sort());
  });

  it("workflow.reset_run PRESERVES the run's original publishableTypes snapshot (never re-derived)", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "project-a", workflowId: "capture_conductor", input: { sourceUrl: "https://example.com" } }, store);
    const before = started.publishingPolicySnapshot?.publishableTypes;
    const reset = await resetRun(started.runId, store);
    expect(reset.publishingPolicySnapshot?.publishableTypes).toEqual(before);
    const reloaded = await getRun(started.runId, store);
    expect(reloaded?.publishingPolicySnapshot?.publishableTypes).toEqual(before);
  });
});
