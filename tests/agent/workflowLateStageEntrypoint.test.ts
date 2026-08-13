import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../src/agent/workspace/executionTypes.js";
import { getRun, resetRun, runNextNode, startDryRun } from "../../src/agent/workspace/executor.js";
import { repositoryManager, resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
import { handler } from "../../netlify/functions/mcp.mjs";

const TERMINAL = ["completed", "failed", "blocked", "cancelled"];
// R-16 hole: the entrypoint seeds a node output that never executes, so it used to bypass output
// validation entirely. buildInitialRun now holds it to the article_body node's OWN outputSchema —
// which is the CLIENT-shaped envelope, not the workspace-local {schema_version, nodes} shape this
// fixture used to carry. That old fixture is exactly what the node rejects (all six required fields),
// so a test built on it was asserting the defect could reach the publish path.
const validArticleBody = {
  artifact: "client_object.v1",
  summary: "Supplied client-shaped body for a late-stage entrypoint run.",
  clientProjectId: "dr-lurie",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", objectType: "content_item", fetchedAt: "2026-07-28T00:00:00.000Z" },
  body: { slug: "supplied-title", title: "Supplied Title", nodes: [{ id: "n_intro", kind: "content", visibility: "public", public: { title: "Supplied Title", body: "Supplied reader-facing body." } }] }
};
const entrypoint = { nodeId: "article_body", output: validArticleBody };

const drive = async (runId: string, store: ExecutionRepository, options: { approved?: boolean } = {}) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < 50 && !TERMINAL.includes(run.status); i++) run = await runNextNode(runId, { executionRepository: store, approved: options.approved });
  return run as WorkflowExecutionRecord;
};
const state = (run: WorkflowExecutionRecord, id: string) => run.nodes.find((node) => node.nodeId === id)!;
const IDEATION_NODES = ["input_triage", "topic_opportunity", "reader_insight", "research", "draft_writer", "review_aggregator"];

// T8 (Wave 3, 2026-08-13, run_1786557897658_elj34j) reversed R-22's shape: artifact_plan now dependsOn
// [brief_architect, contract_intelligence] and runs BEFORE article_body (it generates and verifies the
// media article_body then binds, instead of planning against a body that already shipped without it).
// artifact_plan is therefore an ANCESTOR of article_body again, not a descendant — so seeding
// article_body's late-stage entry point (buildInitialRun seeds every ANCESTOR of the entry node
// completed) now seeds artifact_plan too. That is correct, not a regression: a late-stage entry
// supplies an ALREADY-FINISHED client object — whatever media it carries is already embedded in the
// supplied body, so there is nothing left for artifact_plan to plan or generate, exactly like the
// ideation/research/draft nodes it already skipped for the same reason. A late-stage run now enters
// one step later, directly at publish_payload.
describe("late-stage entrypoint (article_body -> publish_payload -> publication_controller, with artifact_plan seeded as an ancestor)", () => {
  beforeEach(() => repositoryManager.getUsageRepository().clear());

  it("seeds the entry node and its ancestors (including artifact_plan) as completed and starts at publish_payload", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "late", entrypoint }, store);

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
    // artifact_plan is now an ANCESTOR of article_body, so it is seeded completed too — the supplied
    // body already carries whatever media it has; there is nothing left for artifact_plan to plan.
    expect(state(run, "artifact_plan").status).toBe("completed");
    expect(state(run, "artifact_plan").warnings).toContain("late_stage_entry_skipped");
    // Downstream publish stages remain queued.
    for (const id of ["publish_payload", "publication_controller", "learning_recorder", "publish_executor"]) expect(state(run, id).status).toBe("queued");
  });

  it("runs only the publish stages: consumes the seeded body and stops before the publish-risk node", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "late", entrypoint }, store);

    const final = await drive(run.runId, store);

    expect(state(final, "publish_payload").status).toBe("completed");
    // publish_payload consumed the SUPPLIED article body, not a freshly mocked one.
    expect((state(final, "publish_payload").output as { articleBody: unknown }).articleBody).toEqual(validArticleBody);
    expect(final.status).toBe("blocked");
    expect(final.currentNodeId).toBe("publication_controller");
    // F4 (T-2, run_1785352838155_l544ye): fires on any run termination, not just publication_controller
    // reaching "completed" (which an unapproved dry run's design never lets happen).
    expect(state(final, "learning_recorder").status).toBe("completed");

    // Earlier ideation/research/draft nodes never executed, so they incur no cost — a late-stage run
    // is a fraction of a full run's cost. Only the publish stages that ran are billed.
    const usageNodeIds = (await repositoryManager.getUsageRepository().list({ runId: run.runId })).map((record) => record.nodeId);
    expect(usageNodeIds).toContain("publish_payload");
    for (const id of IDEATION_NODES) expect(usageNodeIds).not.toContain(id);
  });

  it("completes the publish stages when approval is supplied", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "late", entrypoint }, store);

    const final = await drive(run.runId, store, { approved: true });

    expect(final.status).toBe("completed");
    expect(state(final, "publication_controller").status).toBe("completed");
    expect(state(final, "learning_recorder").status).toBe("completed");
    expect(final.currentNodeId).toBeUndefined();
  });

  it("never replays the seeded nodes under overlapping run_next_node calls", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "late", entrypoint }, store);

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
    const run = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "late", entrypoint }, store);
    await drive(run.runId, store); // advance to the blocked publish-risk node

    const afterReset = await resetRun(run.runId, store);

    expect(afterReset.currentNodeId).toBe("publish_payload");
    expect(state(afterReset, "article_body").status).toBe("completed");
    expect(afterReset.stageOutputs.article_body).toEqual(validArticleBody);
    // Upstream nodes are still seeded-completed (the entrypoint is preserved across reset), including
    // artifact_plan now that it is an ancestor of the entry node.
    for (const id of IDEATION_NODES) expect(state(afterReset, id).status).toBe("completed");
    expect(state(afterReset, "artifact_plan").status).toBe("completed");
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

  it("accepts a supplied client_object.v1 and starts the run at publish_payload", async () => {
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: validArticleBody });
    const run = res.result.structuredContent.data.run;
    expect(run.currentNodeId).toBe("publish_payload");
    expect(run.nodes.find((node: any) => node.nodeId === "article_body").status).toBe("completed");
    expect(run.nodes.find((node: any) => node.nodeId === "artifact_plan").status).toBe("completed");
    expect(run.stageOutputs.article_body).toEqual(validArticleBody);
  });

  it("rejects an invalid supplied article body before creating a run", async () => {
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: {}, entrypoint: "article_body", articleBody: { schema_version: "client_object.v1", nodes: [] } });
    // The superseded workspace-local shape is now precisely what gets refused, and the error names the
    // fields the node actually requires rather than a generic "invalid article body".
    expect(JSON.stringify(res.error ?? {})).toContain("invalid_entrypoint_output");
    expect(JSON.stringify(res.error ?? {})).toContain("$.clientObjectType is required");
  });
});

// R-16 hole. validateOutput runs at EXECUTION time, and a seeded entrypoint node never executes — so
// until buildInitialRun validated the seeded value, a late-stage entry was a way straight past the
// validator: a structurally wrong body could be seeded `completed`, emit an artifact, and be consumed by
// publish_payload and the publish gate. That is F-1/T6.3 reachable through a different door, on the T-3
// path, and workflow.get_run_cost actively recommends late-stage entry as the cheapest way to progress.
describe("R-16 — a seeded entrypoint output cannot bypass output validation", () => {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(response.body ?? "{}");
  };
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; delete process.env.WORKSPACE_STORE; resetRepositoryManager(); });
  afterEach(() => { delete process.env.MCP_API_TOKEN; resetRepositoryManager(); });

  it("refuses the superseded workspace-local shape, naming every field the node requires", async () => {
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "platform", input: {}, entrypoint: "article_body", articleBody: { schema_version: "client_object.v1", nodes: [{ id: "n_x", kind: "content", visibility: "public", public: { title: "T", body: "B" } }] } });
    const error = JSON.stringify(res.error ?? {});
    expect(error).toContain("invalid_entrypoint_output");
    for (const field of ["artifact", "summary", "clientProjectId", "clientObjectType", "contractSource", "body"]) {
      expect(error).toContain(`$.${field} is required`);
    }
  });

  it("creates no run at all when the seeded output is invalid", async () => {
    const before = (await call("workflow.list_runs", {})).result.structuredContent.data.runs.length;
    await call("workflow.start_dry_run", { executionMode: "mock", projectId: "platform", input: {}, entrypoint: "article_body", articleBody: { schema_version: "client_object.v1", nodes: [] } });
    const after = (await call("workflow.list_runs", {})).result.structuredContent.data.runs.length;
    // Refused BEFORE creation — no half-seeded run, and nothing for a later step to pick up and trust.
    expect(after).toBe(before);
  });

  it("accepts a body that satisfies the node's own outputSchema", async () => {
    const res = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "platform", input: {}, entrypoint: "article_body", articleBody: validArticleBody });
    expect(res.error).toBeUndefined();
    const run = res.result.structuredContent.data.run;
    expect(run.stageOutputs.article_body).toMatchObject({ artifact: "client_object.v1", clientObjectType: "content_item" });
  });

  it("holds the seeded output to the SAME schema the executor enforces on a real execution", async () => {
    // One authority, not two. If article_body's outputSchema changes (R-23 renaming the contract, say),
    // both paths move together — there is no second copy of "what a body looks like" to drift.
    const schema = (await call("node.get_output_schema", { nodeId: "article_body" })).result.structuredContent.data;
    const validated = await call("node.validate_output", { nodeId: "article_body", value: validArticleBody });
    expect(validated.result.structuredContent.data.validation.valid).toBe(true);
    expect(JSON.stringify(schema)).toContain("clientObjectType");
  });
});
