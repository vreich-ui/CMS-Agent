import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// Drives the workflow runner through the real MCP endpoint (auth, JSON-RPC, tool dispatch) rather
// than the executor in isolation, so the tool wiring and the state-advancement fix are exercised
// together. Uses the default in-memory store; the repository singleton persists across handler
// calls within a test and is reset between tests.

const TERMINAL = ["completed", "failed", "blocked", "cancelled"];

const post = async (body: unknown) => {
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify(body)
  });
  return { statusCode: response.statusCode, json: response.body ? JSON.parse(response.body) : undefined };
};

const call = async (name: string, args: Record<string, unknown>) => {
  const { json } = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return json.result.structuredContent as { ok: boolean; data: any };
};

const nodeStatus = (run: any, nodeId: string) => run.nodes.find((node: any) => node.nodeId === nodeId)?.status;

describe("workflow runner MCP tools (end-to-end)", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });
  afterEach(() => {
    delete process.env.MCP_API_TOKEN;
    resetRepositoryManager();
  });

  it("advances to article_body -> publish_payload then stops before the publish-risk node", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "dr-lurie", input: { instructions: "e2e" } });
    const runId = started.data.run.runId as string;

    let run = started.data.run;
    for (let i = 0; i < 50 && !TERMINAL.includes(run.status); i++) {
      run = (await call("workflow.run_next_node", { runId })).data.run;
    }

    expect(nodeStatus(run, "article_body")).toBe("completed");
    expect(nodeStatus(run, "publish_payload")).toBe("completed");
    expect(run.status).toBe("blocked");
    expect(run.currentNodeId).toBe("publication_controller");
    expect(nodeStatus(run, "publication_controller")).toBe("blocked");
    expect(nodeStatus(run, "learning_recorder")).toBe("queued");

    // get_run and run_next_node agree on the effective next node.
    const fetched = (await call("workflow.get_run", { runId })).data.run;
    expect(fetched.currentNodeId).toBe("publication_controller");
    expect(fetched.status).toBe("blocked");
  });

  it("does not re-run completed nodes when run_next_node calls are batched concurrently", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "dr-lurie", input: { instructions: "concurrent" } });
    const runId = started.data.run.runId as string;

    // A JSON-RPC batch dispatches every element through Promise.all — genuinely overlapping
    // run_next_node calls on one run, which previously re-ran already-completed nodes.
    const batch = Array.from({ length: 6 }, (_unused, index) => ({
      jsonrpc: "2.0", id: index + 1, method: "tools/call",
      params: { name: "workflow.run_next_node", arguments: { runId } }
    }));
    await post(batch);

    const run = (await call("workflow.get_run", { runId })).data.run;
    const artifactNodeIds = run.artifacts.map((artifact: any) => artifact.nodeId);
    // One artifact per completed node, and six atomic commits — no replays.
    expect(new Set(artifactNodeIds).size).toBe(artifactNodeIds.length);
    expect(run.nodes.filter((node: any) => node.status === "completed")).toHaveLength(6);
    expect(run.rev).toBe(6);
  });

  it("reset then resume does not restore any pre-reset completed node state", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "dr-lurie", input: { instructions: "reset" } });
    const runId = started.data.run.runId as string;
    await call("workflow.run_next_node", { runId });
    await call("workflow.run_next_node", { runId });
    expect((await call("workflow.get_run", { runId })).data.run.nodes.filter((node: any) => node.status === "completed")).toHaveLength(2);

    const afterReset = (await call("workflow.reset_run", { runId })).data.run;
    expect(afterReset.nodes.every((node: any) => node.status === "queued")).toBe(true);
    expect(afterReset.stageOutputs).toEqual({});
    expect(afterReset.artifacts).toEqual([]);

    const afterGet = (await call("workflow.get_run", { runId })).data.run;
    expect(afterGet.nodes.every((node: any) => node.status === "queued")).toBe(true);

    const afterResume = (await call("workflow.resume_run", { runId })).data.run;
    expect(afterResume.status).toBe("queued");
    expect(afterResume.nodes.every((node: any) => node.status === "queued")).toBe(true);
    expect(afterResume.stageOutputs).toEqual({});
  });
});
