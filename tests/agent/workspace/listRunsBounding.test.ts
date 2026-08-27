import { describe, expect, it } from "vitest";
import { summarizeRunForList } from "../../../src/agent/workspace/executor.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T7 — WHY workflow_list_runs FAILED THROUGH THE PROXY.
//
// Two defects in one summary function. Per-node `errors`/`warnings` were passed through UNBOUNDED
// while the run-level `errors` beside them was capped at 10 x 2000 chars — so one node with a long
// stack, or a validation loop appending a warning per attempt, blew up a whole page of rows. And the
// truncation that did exist used `String.prototype.slice`, which counts UTF-16 code UNITS: cutting
// between the two halves of a surrogate pair emits a lone surrogate, which is not valid UTF-8 and
// cannot be serialized to JSON a strict reader will accept. One emoji or CJK-extension character on
// a truncation boundary is enough — the prime suspect for the live "Anthropic Proxy: Invalid content
// from server" failure on list_runs.

const EMOJI = "\u{1F4A5}"; // U+1F4A5, a surrogate pair in UTF-16 — length 2, one code point.

const runWith = (overrides: Partial<WorkflowExecutionRecord>): WorkflowExecutionRecord => ({
  runId: "run_x", workflowId: "publishing_conductor", projectId: "p", status: "failed",
  startedAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
  nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true,
  ...overrides
} as WorkflowExecutionRecord);

const hasLoneSurrogate = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

describe("T7 — summarizeRunForList bounds every string it emits", () => {
  it("never splits a surrogate pair, at any truncation boundary", () => {
    // Land the emoji on every offset around the 2000-code-point run-level cap.
    for (let pad = 1_995; pad <= 2_005; pad++) {
      const summary = summarizeRunForList(runWith({ errors: ["e".repeat(pad) + EMOJI + "tail".repeat(500)] }));
      const serialized = JSON.stringify(summary);
      expect(hasLoneSurrogate(serialized), `lone surrogate at pad ${pad}`).toBe(false);
      // Round-trips through UTF-8 unchanged — the property the proxy actually needs.
      expect(Buffer.from(serialized, "utf8").toString("utf8")).toBe(serialized);
    }
  });

  it("bounds per-node errors and warnings, which used to pass through unbounded", () => {
    const summary = summarizeRunForList(runWith({
      nodes: [{
        nodeId: "article_body", status: "failed",
        errors: Array.from({ length: 40 }, (_, i) => `error ${i} ${"x".repeat(50_000)}`),
        warnings: Array.from({ length: 40 }, (_, i) => `warning ${i} ${EMOJI.repeat(20_000)}`)
      }]
    } as Partial<WorkflowExecutionRecord>));

    const node = summary.nodes[0] as { errors: string[]; warnings: string[] };
    expect(node.errors.length).toBeLessThanOrEqual(5);
    expect(node.warnings.length).toBeLessThanOrEqual(5);
    for (const value of [...node.errors, ...node.warnings]) expect([...value].length).toBeLessThanOrEqual(1_001);
    expect(hasLoneSurrogate(JSON.stringify(summary))).toBe(false);
    // A whole page of rows like this used to be unbounded; one row is now firmly in the KBs.
    expect(JSON.stringify(summary).length).toBeLessThan(20_000);
  });

  it("leaves short strings exactly as they are — bounding is not rewriting", () => {
    const summary = summarizeRunForList(runWith({ errors: [`boom ${EMOJI}`], nodes: [{ nodeId: "n", status: "failed", errors: ["short"], warnings: ["also short"] }] } as Partial<WorkflowExecutionRecord>));
    expect(summary.errors).toEqual([`boom ${EMOJI}`]);
    expect((summary.nodes[0] as { errors: string[]; warnings: string[] }).errors).toEqual(["short"]);
    expect((summary.nodes[0] as { errors: string[]; warnings: string[] }).warnings).toEqual(["also short"]);
  });
});
