import { describe, expect, it } from "vitest";
import { summarizeRunForList } from "../../src/agent/workspace/executor.js";
import type { WorkflowExecutionRecord } from "../../src/agent/workspace/executionTypes.js";

describe("workflow.list_runs response bounds", () => {
  it("keeps operational metadata while omitting repeated payload-heavy values", () => {
    const huge = "x".repeat(500_000);
    const run: WorkflowExecutionRecord = {
      runId: "run_large", workflowId: "publishing_conductor", projectId: "dr-lurie", status: "completed",
      startedAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:01:00.000Z", completedAt: "2026-08-03T00:01:00.000Z",
      nodes: [{ nodeId: "article_body", status: "completed", input: huge, output: huge, produces: ["client_object.v1"] }],
      artifacts: [{ id: "artifact_large", nodeId: "article_body", type: "client_object.v1", value: huge, createdAt: "2026-08-03T00:01:00.000Z" }],
      errors: [], approvalsRequired: [], initialInput: huge, stageOutputs: { article_body: huge }, dryRun: true, executionMode: "openai"
    };

    const summary = summarizeRunForList(run) as any;

    expect(summary).toMatchObject({ runId: "run_large", status: "completed", nodeCount: 1, artifactCount: 1 });
    expect(summary.nodes[0]).not.toHaveProperty("input");
    expect(summary.nodes[0]).not.toHaveProperty("output");
    expect(summary).not.toHaveProperty("initialInput");
    expect(summary).not.toHaveProperty("stageOutputs");
    expect(summary).not.toHaveProperty("artifacts");
    expect(JSON.stringify(summary).length).toBeLessThan(4_000);
  });
});
