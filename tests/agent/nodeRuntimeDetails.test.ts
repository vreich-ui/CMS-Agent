import { describe, expect, it } from "vitest";
import { getNodeDetails } from "../../src/agent/workspace/nodeRuntime.js";
import { listWorkspaceNodes } from "../../src/agent/workspace/nodes.js";

describe("node.get detail bounds", () => {
  it("returns only actual changes to the requested node instead of whole-workspace snapshots", async () => {
    const nodes = listWorkspaceNodes();
    const target = nodes.find((node) => node.id === "input_triage")!;
    const unrelatedOnly = nodes.map((node) => node.id === "topic_opportunity" ? { ...node, prompt: `${node.prompt}\nunrelated edit` } : node);
    const targetChanged = unrelatedOnly.map((node) => node.id === target.id ? { ...node, prompt: `${node.prompt}\ntarget edit`, updatedAt: "2026-08-03T00:00:00.000Z" } : node);
    const workspaceRepository = {
      getNode: async () => target,
      getVersions: async () => [
        { workspaceVersion: 1, createdAt: "2026-08-01T00:00:00.000Z", nodes },
        { workspaceVersion: 2, createdAt: "2026-08-02T00:00:00.000Z", summary: "another node changed", nodes: unrelatedOnly },
        { workspaceVersion: 3, createdAt: "2026-08-03T00:00:00.000Z", summary: "target changed", nodes: targetChanged }
      ]
    };
    const executionRepository = { listRuns: async () => [] };

    const details = await getNodeDetails(target.id, { workspaceRepository, executionRepository } as any) as any;

    expect(details.versionCount).toBe(2);
    expect(details.versions.map((version: any) => version.workspaceVersion)).toEqual([1, 3]);
    expect(details.versions[1]).toMatchObject({ summary: "target changed", changedFields: expect.arrayContaining(["prompt", "updatedAt"]) });
    expect(details.versions.every((version: any) => !("nodes" in version))).toBe(true);
    expect(JSON.stringify(details.versions).length).toBeLessThan(4_000);
  });

  it("summarizes the latest execution without embedding node inputs, outputs, or artifacts", async () => {
    const target = listWorkspaceNodes().find((node) => node.id === "input_triage")!;
    const huge = "x".repeat(500_000);
    const workspaceRepository = { getNode: async () => target, getVersions: async () => [] };
    let listCalls = 0;
    const executionRepository = { listRuns: async () => { listCalls += 1; return [{
      runId: "run_large", workflowId: "publishing_conductor", projectId: "dr-lurie", status: "completed",
      startedAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:01:00.000Z", completedAt: "2026-08-03T00:01:00.000Z",
      nodes: [{ nodeId: target.id, status: "completed", input: huge, output: huge }],
      artifacts: [{ id: "artifact_large", nodeId: target.id, type: "triage", value: huge, createdAt: "2026-08-03T00:01:00.000Z" }],
      errors: [], approvalsRequired: [], stageOutputs: { [target.id]: huge }, dryRun: true, executionMode: "openai"
    }]; } };

    const details = await getNodeDetails(target.id, { workspaceRepository, executionRepository } as any) as any;

    expect(details.latestExecution).toMatchObject({ runId: "run_large", artifactCount: 1, node: { nodeId: target.id, status: "completed" } });
    expect(details.latestExecution.node).not.toHaveProperty("input");
    expect(details.latestExecution.node).not.toHaveProperty("output");
    expect(details.latestOutputSummary).toMatchObject({ id: "artifact_large", runId: "run_large" });
    expect(listCalls).toBe(1);
    expect(JSON.stringify(details.latestExecution).length).toBeLessThan(4_000);
  });
});
