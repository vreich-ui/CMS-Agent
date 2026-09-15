import { describe, expect, it } from "vitest";
import { compactRun } from "../../../src/agent/mcp/workspace/tools.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// Follow-up to #351. THE MISSING PROJECTION FIELD, and why it is worth a test of its own.
//
// #351 taught the Workbench rail to read a node's supplied-output provenance off the run record, and
// to fall back to a per-node `node_list_outputs` query only for a node the record says nothing about.
// It never added `outputProvenance` to compactRun — which is what `workflow.get_run` returns by
// default and what the rail binds to. The field was therefore absent for EVERY node of EVERY run, so:
//   1. the fallback fired unconditionally — one request per completed node, 25 on a publishing run,
//      on every rail paint, to answer a question the run record already held; and
//   2. the markers the feature exists to show never rendered at all.
// A projection is a contract. This test is the contract.

const run = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run_compact",
  requestId: "req_compact",
  workflowId: "publishing_conductor",
  projectId: "platform",
  status: "running",
  startedAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  nodes: [
    { nodeId: "input_triage", status: "completed", durationMs: 12 },
    { nodeId: "research", status: "completed", durationMs: 0, outputProvenance: { source: "default_output", updatedAt: "2026-09-15T00:00:00.000Z", note: "fixture" } },
    { nodeId: "draft_writer", status: "queued" }
  ],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  executionMode: "mock",
  ...overrides
}) as unknown as WorkflowExecutionRecord;

describe("compactRun carries what the rail reads", () => {
  it("emits outputProvenance for a supplied node, so no per-node query is needed to find it", () => {
    const nodes = compactRun(run()).nodes as Array<{ nodeId: string; outputProvenance?: { source: string; note?: string } }>;
    const research = nodes.find((node) => node.nodeId === "research")!;
    expect(research.outputProvenance).toEqual({ source: "default_output", updatedAt: "2026-09-15T00:00:00.000Z", note: "fixture" });
  });

  it("omits it on a node that produced its own output — absence is the signal, not a placeholder", () => {
    const nodes = compactRun(run()).nodes as Array<{ nodeId: string; outputProvenance?: unknown }>;
    const triage = nodes.find((node) => node.nodeId === "input_triage")!;
    expect(Object.prototype.hasOwnProperty.call(triage, "outputProvenance")).toBe(false);
  });

  it("carries the run-level ledger and output mode, which the Workbench otherwise could only get from a full read", () => {
    const view = compactRun(run({ defaultedNodeIds: ["research"], outputMode: "defaults_where_set" })) as unknown as { defaultedNodeIds?: string[]; outputMode?: string };
    expect(view.defaultedNodeIds).toEqual(["research"]);
    expect(view.outputMode).toBe("defaults_where_set");
  });

  it("leaves an ordinary run's compact view byte-identical to what it was before", () => {
    const view = compactRun(run({ nodes: [{ nodeId: "input_triage", status: "completed", durationMs: 12 }] as WorkflowExecutionRecord["nodes"] })) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(view, "defaultedNodeIds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(view, "outputMode")).toBe(false);
  });
});
