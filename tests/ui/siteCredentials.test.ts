import { describe, expect, it } from "vitest";
import { applyGate, describeExecutionStatus, isTerminalExecutionState, summarizeFleet, tenantStatusLabel } from "../../ui/src/siteCredentials.js";
import type { SiteCredentialExecutionStatus, SiteCredentialPlan } from "../../ui/src/types/workspace.js";

const plan = (staleCount: number, results: SiteCredentialPlan["results"] = []): SiteCredentialPlan => ({ mode: "dry_run", results, staleCount });

describe("isTerminalExecutionState", () => {
  it("recognizes known terminal states case-insensitively", () => {
    expect(isTerminalExecutionState("SUCCEEDED")).toBe(true);
    expect(isTerminalExecutionState("failed")).toBe(true);
    expect(isTerminalExecutionState("Cancelled")).toBe(true);
    expect(isTerminalExecutionState("  completed  ")).toBe(true);
  });

  it("treats in-flight and unrecognized states as non-terminal", () => {
    expect(isTerminalExecutionState("ACTIVE")).toBe(false);
    expect(isTerminalExecutionState("running")).toBe(false);
    expect(isTerminalExecutionState("queued")).toBe(false);
    expect(isTerminalExecutionState("some_future_state")).toBe(false);
  });
});

describe("summarizeFleet", () => {
  it("returns null before a plan has loaded", () => {
    expect(summarizeFleet(null)).toBeNull();
  });

  it("reports all-current fleets as success", () => {
    const summary = summarizeFleet(plan(0));
    expect(summary).toEqual({ tone: "success", message: "All tenants current — no scoped-bearer repair needed." });
  });

  it("singularizes 'tenant' for exactly one stale tenant", () => {
    expect(summarizeFleet(plan(1))?.message).toBe("1 tenant needs repair.");
  });

  it("pluralizes for more than one stale tenant", () => {
    expect(summarizeFleet(plan(3))?.message).toBe("3 tenants need repair.");
  });
});

describe("applyGate", () => {
  it("blocks apply before a plan has loaded", () => {
    expect(applyGate(null)).toEqual({ allowed: false, reason: "Load the plan before repairing." });
  });

  it("blocks apply when staleCount is zero, with a visible reason", () => {
    const gate = applyGate(plan(0));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/nothing to repair/i);
  });

  it("allows apply when at least one tenant is stale", () => {
    expect(applyGate(plan(1))).toEqual({ allowed: true });
  });
});

describe("tenantStatusLabel", () => {
  it("labels current and planned rows", () => {
    expect(tenantStatusLabel("current")).toBe("Current");
    expect(tenantStatusLabel("planned")).toBe("Needs repair");
  });
});

describe("describeExecutionStatus", () => {
  const status = (over: Partial<SiteCredentialExecutionStatus>): SiteCredentialExecutionStatus => ({ state: "ACTIVE", ...over });

  it("reports non-terminal states as in-progress info", () => {
    const view = describeExecutionStatus(status({ state: "ACTIVE" }));
    expect(view.tone).toBe("info");
    expect(view.headline).toMatch(/in progress/i);
    expect(view.detail).toMatch(/10-20 minutes/);
  });

  it("reports a clean terminal success", () => {
    const view = describeExecutionStatus(status({ state: "SUCCEEDED", succeededCount: 4, failedCount: 0 }));
    expect(view.tone).toBe("success");
    expect(view.headline).toBe("Repair complete — 4 tenants repaired.");
  });

  it("singularizes a single successful repair", () => {
    const view = describeExecutionStatus(status({ state: "SUCCEEDED", succeededCount: 1, failedCount: 0 }));
    expect(view.headline).toBe("Repair complete — 1 tenant repaired.");
  });

  it("surfaces a partial failure as an error, not a swallowed success, and points at Cloud Run", () => {
    const view = describeExecutionStatus(status({ state: "SUCCEEDED", succeededCount: 2, failedCount: 1 }), "reconcile-site-credentials");
    expect(view.tone).toBe("error");
    expect(view.headline).toBe("Repair finished with 1 failure.");
    expect(view.detail).toMatch(/2 tenants repaired, 1 failed/);
    expect(view.detail).toMatch(/Cloud Run/);
    expect(view.detail).toMatch(/reconcile-site-credentials/);
  });

  it("surfaces a terminal state with no reported counts (failed/cancelled before any work) as an error", () => {
    const view = describeExecutionStatus(status({ state: "FAILED", succeededCount: 0, failedCount: 0 }));
    expect(view.tone).toBe("error");
    expect(view.headline).toBe("Repair did not complete.");

    const cancelled = describeExecutionStatus(status({ state: "CANCELLED" }));
    expect(cancelled.tone).toBe("error");
    expect(cancelled.headline).toBe("Repair did not complete.");
  });
});
