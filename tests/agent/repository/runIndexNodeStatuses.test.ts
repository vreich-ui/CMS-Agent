import { describe, expect, it } from "vitest";
import { runSummaryOf, RUN_INDEX_NODE_STATUS_CODES } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// W5. The rail's per-node failure chips were costing five FULL run records (up to 1.2 MB each) per
// paint, twice. These assertions pin the replacement: one letter per node on the index row itself.

const run = (nodes: Array<{ nodeId: string; status: string }>): WorkflowExecutionRecord =>
  ({
    runId: "run_1", projectId: "p", workflowId: "publishing_conductor", status: "running",
    startedAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    nodes, artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true
  } as unknown as WorkflowExecutionRecord);

describe("W5 — per-node status on the run index row", () => {
  it("carries one letter per node and spells out only the failures", () => {
    const row = runSummaryOf(run([
      { nodeId: "input_triage", status: "completed" },
      { nodeId: "research", status: "failed" },
      { nodeId: "article_body", status: "queued" },
      { nodeId: "artifact_plan", status: "skipped" }
    ]));

    expect(row.nodeStatuses).toEqual({ input_triage: "c", research: "f", article_body: "q", artifact_plan: "s" });
    expect(row.failedNodeIds).toEqual(["research"]);
    // The listing still carries no node RECORDS — that is the whole saving.
    expect(row).not.toHaveProperty("nodes");
  });

  it("omits both fields entirely rather than writing empty ones", () => {
    // A run with no nodes, and a run with no failures, must each read byte-identically to a row
    // written before this field existed — otherwise every legacy row looks subtly different.
    const empty = runSummaryOf(run([]));
    expect(empty).not.toHaveProperty("nodeStatuses");
    expect(empty).not.toHaveProperty("failedNodeIds");
    expect(runSummaryOf(run([{ nodeId: "a", status: "completed" }]))).not.toHaveProperty("failedNodeIds");
  });

  it("omits an unrecognised status rather than mapping it to a wrong letter", () => {
    // A missing chip is honest; a chip labelled with a guess is not.
    const row = runSummaryOf(run([{ nodeId: "a", status: "completed" }, { nodeId: "b", status: "invented_status" }]));
    expect(row.nodeStatuses).toEqual({ a: "c" });
  });

  it("codes are distinct, so no two statuses can collide into one chip", () => {
    const codes = Object.values(RUN_INDEX_NODE_STATUS_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
