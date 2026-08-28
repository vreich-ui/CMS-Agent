import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../src/agent/workspace/executor.js";
import { repositoryManager } from "../../src/agent/runtime/repositories.js";
import { validateOutput } from "../../src/agent/execution/outputValidator.js";
import { listWorkspaceNodes } from "../../src/agent/workspace/nodes.js";
import * as registry from "../../src/agent/execution/runnerRegistry.js";
import { promptVersionIdForNode } from "../../src/agent/workspace/nodeExecutionProvenance.js";

const completeUntil = async (runId: string, targetNodeId: string, store: ExecutionRepository) => {
  let run = await getRun(runId, store);
  while (run && !run.nodes.find((node) => node.nodeId === targetNodeId && ["completed", "blocked"].includes(node.status))) {
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

describe("Publishing Conductor dry-run execution", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());
  it("start dry run creates a queued run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);

    expect(run.runId).toMatch(/^run_/);
    expect(run.workflowId).toBe("publishing_conductor");
    expect(run.projectId).toBe("project-a");
    expect(run.status).toBe("queued");
    expect(run.currentNodeId).toBe("input_triage");
    expect(run.dryRun).toBe(true);
  });

  // R-22: 21 since nodes.ts was re-seeded from the live workspace (contract_intelligence, artifact_plan,
  // publish_executor joined the graph); a run seeding 18 nodes was the visible symptom that the conductor
  // was executing a July 3 snapshot rather than the pipeline the alignment wave rebuilt. §2.16: 23 with
  // placement_resolver and monetization_strategy. T15.6: 24 with release_executor (ADR-2026-08-25
  // §4.3 — lands after publish_executor, before learning_recorder).
  it("run has 24 conductor nodes", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);

    expect(run.nodes).toHaveLength(24);
  });

  it("run_next_node advances state", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    const advanced = await runNextNode(run.runId, { executionRepository: store });

    expect(advanced.nodes.find((node) => node.nodeId === "input_triage")?.status).toBe("completed");
    expect(advanced.stageOutputs.input_triage).toMatchObject({ dryRun: true });
    expect(advanced.currentNodeId).toBe("placement_resolver");
  });

  it("dependency ordering is respected", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);

    const afterInput = await runNextNode(run.runId, { executionRepository: store });
    expect(afterInput.currentNodeId).toBe("placement_resolver");
    expect(afterInput.nodes.find((node) => node.nodeId === "topic_opportunity")?.status).toBe("queued");

    const afterPlacement = await runNextNode(run.runId, { executionRepository: store });
    expect(afterPlacement.nodes.find((node) => node.nodeId === "placement_resolver")?.status).toBe("completed");
    expect(afterPlacement.currentNodeId).toBe("topic_opportunity");

    const afterTopic = await runNextNode(run.runId, { executionRepository: store });
    expect(afterTopic.nodes.find((node) => node.nodeId === "topic_opportunity")?.status).toBe("completed");
    expect(afterTopic.currentNodeId).toBe("monetization_strategy");
  });

  it("publication_controller blocks without approval", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    const blocked = await completeUntil(run.runId, "publication_controller", store);

    expect(blocked.status).toBe("blocked");
    expect(blocked.currentNodeId).toBe("publication_controller");
    expect(blocked.nodes.find((node) => node.nodeId === "publication_controller")?.status).toBe("blocked");
    expect(blocked.approvalsRequired).toEqual([expect.objectContaining({ nodeId: "publication_controller", type: "approval_required" })]);
  });

  it("article_body node produces client_object.v1", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    const advanced = await completeUntil(run.runId, "article_body", store);

    expect(advanced.nodes.find((node) => node.nodeId === "article_body")?.produces).toContain("client_object.v1");

    // This assertion used to read `toMatchObject({ schema_version: "client_object.v1" })`, which
    // codified the defect T-2 found: `schema_version` is the pre-contract-as-truth shape, and the
    // node's own outputSchema requires `artifact` and `summary` instead. The old assertion therefore
    // passed only because nothing validated the output (R-16) and the fixture was hand-written (R-17).
    // The honest assertion is that the node satisfies its own declared schema.
    const node = listWorkspaceNodes().find((candidate) => candidate.id === "article_body")!;
    const validation = validateOutput(advanced.stageOutputs.article_body, node.outputSchema);
    expect(validation.ok, !validation.ok ? validation.errors.join("; ") : "").toBe(true);
    expect(advanced.stageOutputs.article_body).toMatchObject({ artifact: "client_object.v1" });
  });

  it("publish_payload remains dry-run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    const advanced = await completeUntil(run.runId, "publish_payload", store);

    expect(advanced.stageOutputs.publish_payload).toMatchObject({ artifact: "dry_run_publish_payload.v1", dryRun: true, publicationSideEffects: false });
  });

  it("dry-run node execution records estimated usage", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    await runNextNode(run.runId, { executionRepository: store });

    const records = await repositoryManager.getUsageRepository().list({ runId: run.runId, nodeId: "input_triage" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ runId: run.runId, projectId: "project-a", nodeId: "input_triage", status: "estimated", provider: "openai" });
    expect(records[0].totalTokens).toBe(records[0].inputTokens + records[0].outputTokens);
  });

  it("live node execution persists the exact prompt-version identity and actual model", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "openai", projectId: "project-a", input: "Draft this" }, store);
    const node = listWorkspaceNodes().find((candidate) => candidate.id === "input_triage")!;
    const spy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true }),
      run: async () => ({
        ok: true,
        output: { artifact: "content_source.v1", summary: "Live model output." },
        model: "gpt-t20-actual"
      })
    });

    try {
      const advanced = await runNextNode(run.runId, { executionRepository: store });
      const state = advanced.nodes.find((candidate) => candidate.nodeId === "input_triage");

      expect(state?.provenance).toMatchObject({
        promptVersion: promptVersionIdForNode(node),
        model: "gpt-t20-actual"
      });
      expect(state?.provenance?.capturedAt).toBe(state?.completedAt);
    } finally {
      spy.mockRestore();
    }
  });

  // W-4 (run_1785405350649_9u5mjz): client identity is run state the conductor delivers to every
  // node, not something a prompt may assume. That run — a platform run — produced a Dr. Lurie CTA
  // because the editorial chain executed with no client identity in its input at all.
  it("every executed node's input carries the run's clientProjectId", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    const advanced = await completeUntil(run.runId, "article_body", store);

    const executed = advanced.nodes.filter((node) => node.status === "completed" && node.input !== undefined);
    expect(executed.length).toBeGreaterThan(0);
    for (const node of executed) {
      expect(node.input, `node ${node.nodeId} input should carry clientProjectId`).toMatchObject({ clientProjectId: "project-a" });
    }
  });

  // W-4: where the client cannot be resolved, the node fails by NAME rather than guessing — the same
  // contract as prefetch_object_type_unresolved (H2, #95). A blank projectId can only reach this code
  // through a legacy record or a direct caller (the wire schema requires minLength 1), which is
  // exactly why the guard lives at dispatch: it protects every node regardless of how the run was minted.
  it("a run without a resolvable client fails the node with client_project_unresolved", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "  ", input: "Draft this" }, store);
    const advanced = await runNextNode(run.runId, { executionRepository: store });

    expect(advanced.status).toBe("failed");
    expect(advanced.errors).toContain("input_triage:client_project_unresolved");
    const node = advanced.nodes.find((candidate) => candidate.nodeId === "input_triage");
    expect(node?.status).toBe("failed");
    expect(node?.errors?.[0]).toBe("client_project_unresolved");
    expect(node?.output).toMatchObject({ error: { code: "client_project_unresolved" } });
    expect(advanced.stageOutputs.input_triage).toBeUndefined();
  });

  it("no external MCP calls occur", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "project-a", input: "Draft this" }, store);
    const advanced = await runNextNode(run.runId, { executionRepository: store });

    expect(advanced.errors).toEqual([]);
    expect(advanced.artifacts[0]).toMatchObject({ nodeId: "input_triage" });
    expect(advanced.stageOutputs.input_triage).toMatchObject({ dryRun: true });
  });
});
