import { describe, expect, it } from "vitest";
import { mergeNodeAdvance } from "../../../src/agent/workspace/nodeAdvanceSave.js";
import { dispatchToolContext } from "../../../src/agent/execution/dispatchAuthorization.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// Follow-up to #351. Two holes the first pass left, both about the SUPPLIED-OUTPUT LEDGER
// (run.defaultedNodeIds) rather than about the gates it feeds — the gates themselves fall back to
// per-node outputProvenance, which is why neither of these was a publish-safety hole. They are record
// and corpus defects, and the record is the whole point of the feature.

const record = (overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord => ({
  runId: "run_ledger",
  requestId: "req_ledger",
  workflowId: "publishing_conductor",
  projectId: "platform",
  status: "running",
  startedAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  nodes: [{ nodeId: "research", status: "completed" }, { nodeId: "draft_writer", status: "queued" }],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  executionMode: "mock",
  ...overrides
}) as unknown as WorkflowExecutionRecord;

describe("the supplied-output ledger survives a concurrent save", () => {
  // saveNodeAdvance writes `advanced` straight through when nothing conflicts, so this only bites
  // under a real CAS conflict — another driver touched the run while this advance was in flight.
  // That is precisely when the record matters most and is hardest to reproduce by hand.
  it("mergeNodeAdvance UNIONS defaultedNodeIds rather than letting either side win", () => {
    const stored = record({ defaultedNodeIds: ["input_triage"] });
    const advanced = record({ defaultedNodeIds: ["research"], updatedAt: "2026-09-15T00:01:00.000Z" });
    const merged = mergeNodeAdvance(stored, advanced, ["research"]);
    expect(merged.defaultedNodeIds).toEqual(["input_triage", "research"]);
  });

  it("taking `advanced` alone would have discarded an override recorded mid-flight", () => {
    const stored = record({ defaultedNodeIds: ["input_triage"] });
    const advanced = record({});
    expect(mergeNodeAdvance(stored, advanced, ["research"]).defaultedNodeIds).toEqual(["input_triage"]);
  });

  it("an ordinary run's record is byte-identical — the field is omitted, not written empty", () => {
    const merged = mergeNodeAdvance(record({}), record({}), ["research"]);
    expect(Object.prototype.hasOwnProperty.call(merged, "defaultedNodeIds")).toBe(false);
  });

  it("does not duplicate a node both sides already recorded", () => {
    const merged = mergeNodeAdvance(record({ defaultedNodeIds: ["research"] }), record({ defaultedNodeIds: ["research"] }), ["research"]);
    expect(merged.defaultedNodeIds).toEqual(["research"]);
  });
});

describe("a node that runs inside a partly-fixture run knows it", () => {
  const node = { id: "draft_writer", riskLevel: "write" } as WorkspaceNode;

  // The MCP-side learning.record_observation guard shipped in #351 covers an external caller. It does
  // NOT cover the tool a MODEL TURN reaches for, which is toolRegistry.ts's own registration — and
  // that is the path a node inside a run actually uses. The context is what carries the fact there.
  it("dispatchToolContext carries the run's supplied-output ledger to the tools a node can call", () => {
    const context = dispatchToolContext({ run: record({ defaultedNodeIds: ["research"] }), node });
    expect(context.defaultedNodeIds).toEqual(["research"]);
  });

  it("omits the field entirely on an ordinary run, so nothing downstream has to special-case empty", () => {
    const context = dispatchToolContext({ run: record({}), node });
    expect(Object.prototype.hasOwnProperty.call(context, "defaultedNodeIds")).toBe(false);
  });
});
