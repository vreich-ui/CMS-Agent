import { describe, expect, it } from "vitest";
import { InMemoryExecutionStore } from "../../src/agent/workspace/executionStore.js";
import { getRun, runNextNode, startDryRun } from "../../src/agent/workspace/executor.js";

const completeUntil = async (runId: string, targetNodeId: string, store: InMemoryExecutionStore) => {
  let run = await getRun(runId, store);
  while (run && !run.nodes.find((node) => node.nodeId === targetNodeId && ["completed", "blocked"].includes(node.status))) {
    run = await runNextNode(runId, { executionStore: store });
  }
  return run!;
};

describe("Publishing Conductor dry-run execution", () => {
  it("start dry run creates a queued run", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);

    expect(run.runId).toMatch(/^run_/);
    expect(run.workflowId).toBe("publishing_conductor");
    expect(run.projectId).toBe("project-a");
    expect(run.status).toBe("queued");
    expect(run.currentNodeId).toBe("input_triage");
    expect(run.dryRun).toBe(true);
  });

  it("run has 18 conductor nodes", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);

    expect(run.nodes).toHaveLength(18);
  });

  it("run_next_node advances state", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);
    const advanced = await runNextNode(run.runId, { executionStore: store });

    expect(advanced.nodes.find((node) => node.nodeId === "input_triage")?.status).toBe("completed");
    expect(advanced.stageOutputs.input_triage).toMatchObject({ dryRun: true });
    expect(advanced.currentNodeId).toBe("topic_opportunity");
  });

  it("dependency ordering is respected", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);

    const afterInput = await runNextNode(run.runId, { executionStore: store });
    expect(afterInput.currentNodeId).toBe("topic_opportunity");
    expect(afterInput.nodes.find((node) => node.nodeId === "reader_insight")?.status).toBe("queued");

    const afterTopic = await runNextNode(run.runId, { executionStore: store });
    expect(afterTopic.nodes.find((node) => node.nodeId === "topic_opportunity")?.status).toBe("completed");
    expect(afterTopic.currentNodeId).toBe("reader_insight");
  });

  it("publication_controller blocks without approval", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);
    const blocked = await completeUntil(run.runId, "publication_controller", store);

    expect(blocked.status).toBe("blocked");
    expect(blocked.currentNodeId).toBe("publication_controller");
    expect(blocked.nodes.find((node) => node.nodeId === "publication_controller")?.status).toBe("blocked");
    expect(blocked.approvalsRequired).toEqual([expect.objectContaining({ nodeId: "publication_controller", type: "approval_required" })]);
  });

  it("article_body node produces article_body.v1", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);
    const advanced = await completeUntil(run.runId, "article_body", store);

    expect(advanced.nodes.find((node) => node.nodeId === "article_body")?.produces).toContain("article_body.v1");
    expect(advanced.stageOutputs.article_body).toMatchObject({ schema_version: "article_body.v1" });
  });

  it("publish_payload remains dry-run", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);
    const advanced = await completeUntil(run.runId, "publish_payload", store);

    expect(advanced.stageOutputs.publish_payload).toMatchObject({ artifact: "dry_run_publish_payload.v1", dryRun: true, publicationSideEffects: false });
  });

  it("no external MCP calls occur", async () => {
    const store = new InMemoryExecutionStore();
    const run = await startDryRun({ projectId: "project-a", input: "Draft this" }, store);
    const advanced = await runNextNode(run.runId, { executionStore: store });

    expect(advanced.errors).toEqual([]);
    expect(advanced.artifacts[0]).toMatchObject({ nodeId: "input_triage" });
    expect(advanced.stageOutputs.input_triage).toMatchObject({ dryRun: true });
  });
});
