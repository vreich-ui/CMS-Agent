import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useWorkflowRun } from "../src/hooks/useWorkflowRun";
import type { McpClient } from "../src/mcp/client";
import type { WorkflowExecutionRecord } from "../src/types/workspace";

const fullRun: WorkflowExecutionRecord = {
  runId: "run_1", workflowId: "publishing_conductor", projectId: "dr-lurie", status: "completed",
  startedAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:01:00.000Z", completedAt: "2026-08-03T00:01:00.000Z",
  nodes: [{ nodeId: "article_body", status: "completed", output: { title: "Full output" } }],
  artifacts: [{ id: "artifact_1", nodeId: "article_body", type: "client_object.v1", value: { title: "Full output" }, createdAt: "2026-08-03T00:01:00.000Z" }],
  errors: [], approvalsRequired: [], stageOutputs: { article_body: { title: "Full output" } }, dryRun: true, executionMode: "openai"
};

describe("useWorkflowRun", () => {
  it("hydrates only the selected list row through workflow.get_run", async () => {
    const calls: string[] = [];
    const client: McpClient = {
      method: async () => { throw new Error("unused"); },
      call: async <T,>(name: string): Promise<T> => {
        calls.push(name);
        if (name === "workflow.list_runs") return { runs: [{ ...fullRun, artifacts: [], stageOutputs: {}, nodes: [{ nodeId: "article_body", status: "completed" }] }] } as T;
        if (name === "workflow.get_run") return { run: fullRun } as T;
        throw new Error(`unexpected tool call: ${name}`);
      }
    };
    const { result } = renderHook(() => useWorkflowRun(client));

    await act(async () => { await result.current.listRuns("dr-lurie"); });

    expect(calls).toEqual(["workflow.list_runs", "workflow.get_run"]);
    expect(result.current.runs[0].artifacts).toEqual([]);
    expect(result.current.currentRun?.artifacts[0].value).toEqual({ title: "Full output" });
  });
});
