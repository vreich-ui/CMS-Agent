import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../src/agent/workspace/executionTypes.js";
import { getRun, resetRun, runNextNode, startDryRun } from "../../src/agent/workspace/executor.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
import { handler } from "../../netlify/functions/mcp.mjs";

const TERMINAL = ["completed", "failed", "blocked", "cancelled"];
const validArticleBody = { schema_version: "article_body.v1", nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Supplied Title", body: "Supplied reader-facing body." } }] };
const entrypoint = { nodeId: "article_body", output: validArticleBody };

const drive = async (runId: string, store: ExecutionRepository, options: { approved?: boolean } = {}) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < 50 && !TERMINAL.includes(run.status); i++) run = await runNextNode(runId, { executionRepository: store, approved: options.approved });
  return run as WorkflowExecutionRecord;
};
const state = (run: WorkflowExecutionRecord, id: string) => run.nodes.find((node) => node.nodeId === id)!;
const IDEATION_NODES = ["input_triage", "topic_opportunity", "reader_insight", "research", "draft_writer", "review_aggregator"];

describe("late-stage entrypoint (article_body -> publish_payload -> publication_controller)", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("seeds the entry node and its ancestors as completed and starts at publish_payload", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "late", entrypoint }, store);

    expect(run.status).toBe("queued");
    expect(run.currentNodeId).toBe("publish_payload");
    expect(state(run, "article_body").status).toBe("completed");
    expect(state(run, "article_body").output).toEqual(validArticleBody);
    expect(run.stageOutputs.article_body).toEqual(validArticleBody);
    // Every upstream ideation/research/draft node is seeded completed (skipped), not queued.
    for (const id of IDEATION_NODES) {
      expect(state(run, id).status).toBe("completed");
      expect(state(run, id).warnings).toContain("late_stage_entry_skipped");
    }
    // Downstream publish stages remain queued.
    for (const id of ["publish_payload", "publication_controller", "learning_recorder"]) expect(state(run, id).status).toBe("queued");
  });

  it("runs only the publish stages: consumes the seeded body and stops before the publish-risk node", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "late", entrypoint }, store);

    const final = await drive(run.runId, store);

    expect(state(final, "publish_payload").status).toBe("completed");
    // publish_payload consumed the SUPPLIED article body, not a freshly mocked one.
    expect((state(final, "publish_payload").output as { articleBody: unknown }).articleBody).toEqual(validArticleBody);
    expect(final.status).toBe("blocked");
    expect(final.currentNodeId).toBe("publication_controller");
    expect(state(final, "learning_recorder").status).toBe("queued");

    // Earlier ideation/research/draft nodes never executed, so they incur no cost — a late-stage run
    // is a fraction of a full run's cost. Only the publish stages that ran are billed.
    const usageNodeIds = (await repositoryManager.getUsageRepository().list({ runId: run.runId })).map((record) => record.nodeId);
    expect(usageNodeIds).toContain("publish_payload");
    for (const id of IDEATION_NODES) expect(usageNodeIds).not.toContain(id);
  });

  it("completes the publish stages when approval is supplied", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "late", entrypoint }, store);

    const final = await drive(run.runId, store, { approved: true });

    expect(final.status).toBe("completed");
    expect(state(final, "publication_controller").status).toBe("completed");
    expect(state(final, "learning_recorder").status).toBe("completed");
    expect(final.currentNodeId).toBeUndefined();
  });

  it("never replays the seeded nodes under overlapping run_next_node calls", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "late", entrypoint }, store);

    await Promise.all(Array.from({ length: 6 }, () => runNextNode(run.runId, { executionRepository: store })));
    const final = (await getRun(run.runId, store))!;

    // Exactly one artifact for the seeded article_body (from seeding) and one for publish_payload —
    // no seeded node was re-run.
    const artifactNodeIds = final.artifacts.map((artifact) => artifact.nodeId);
    expect(artifactNodeIds.filter((id) => id === "article_body")).toHaveLength(1);
    expect(artifactNodeIds.filter((id) => id === "publish_payload")).toHaveLength(1);
    expect(new Set(artifactNodeIds).size).toBe(artifactNodeIds.length);
    expect(final.status).toBe("blocked");
    expect(final.currentNodeId).toBe("publication_controller");
  });

  it("reset restores the seeded late-stage state, not a full run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ projectId: "dr-lurie", input: "late", entrypoint }, store);
    await drive(run.runId, store); // advance to the blocked publish-risk node

    const afterReset = await resetRun(run.runId, store);

    expect(afterReset.currentNodeId).toBe("publish_payload");
    expect(state(afterReset, "article_body").status).toBe("completed");
    expect(afterReset.stageOutputs.article_body).toEqual(validArticleBody);
    // Upstream nodes are still seeded-completed (the entrypoint is preserved across reset).
    for (const id of IDEATION_NODES) expect(state(afterReset, id).status).toBe("completed");
    expect(state(afterReset, "publish_payload").status).toBe("queued");
  });
});

describe("late-stage entrypoint via the MCP endpoint", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("accepts a supplied article_body.v1 and starts the run at publish_payload", async () => {
    const res = await call("workflow.start_dry_run", { projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody });
    const run = res.result.structuredContent.data.run;
    expect(run.currentNodeId).toBe("publish_payload");
    expect(run.nodes.find((node: any) => node.nodeId === "article_body").status).toBe("completed");
    expect(run.stageOutputs.article_body).toEqual(validArticleBody);
  });

  it("rejects an invalid supplied article body before creating a run", async () => {
    const res = await call("workflow.start_dry_run", { projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: { schema_version: "article_body.v1", nodes: [] } });
    expect(JSON.stringify(res.error ?? {})).toContain("invalid_article_body");
  });
});
