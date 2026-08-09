import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";

describe("CA3 schema-bound regression fixture", () => {
  it("keeps the full canonical mock conductor dry-run byte-structurally unchanged", async () => {
    const fixture = JSON.parse(await readFile(new URL("../../fixtures/ca3-schema-bound-dry-run.json", import.meta.url), "utf8"));
    const store = new RepositoryManager().getExecutionRepository();
    let run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "CA3 regression" }, store);
    for (let index = 0; index < 30 && !["blocked", "completed", "failed", "cancelled"].includes(run.status); index += 1) {
      run = await runNextNode(run.runId, { executionRepository: store });
    }
    const actual = {
      status: run.status,
      currentNodeId: run.currentNodeId,
      nodes: run.nodes.map((node) => [node.nodeId, node.status, node.produces?.[0]]),
      approvalsRequired: run.approvalsRequired.map((approval) => [approval.nodeId, approval.type])
    };
    expect(actual).toEqual(fixture);
  });
});
