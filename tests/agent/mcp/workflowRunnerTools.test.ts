import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS } from "../../../src/agent/mcp/workspace/tools.js";
import { DETERMINISTIC_STAGE_MIN_TIMEOUT_MS } from "../../../src/agent/workspace/routeRegistry.js";

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
    const started = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: { instructions: "e2e" } });
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
    // F4 (T-2, run_1785352838155_l544ye): fires on any run termination, not just publication_controller
    // reaching "completed" (which an unapproved dry run's design never lets happen).
    expect(nodeStatus(run, "learning_recorder")).toBe("completed");

    // get_run and run_next_node agree on the effective next node.
    const fetched = (await call("workflow.get_run", { runId })).data.run;
    expect(fetched.currentNodeId).toBe("publication_controller");
    expect(fetched.status).toBe("blocked");
  });

  it("does not re-run completed nodes when run_next_node calls are batched concurrently", async () => {
    const started = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: { instructions: "concurrent" } });
    const runId = started.data.run.runId as string;

    // A JSON-RPC batch dispatches every element through Promise.all — genuinely overlapping
    // run_next_node calls on one run, which previously re-ran already-completed nodes.
    const batch = Array.from({ length: 6 }, (_unused, index) => ({
      jsonrpc: "2.0", id: index + 1, method: "tools/call",
      params: { name: "workflow.run_next_node", arguments: { runId } }
    }));
    await post(batch);

    // detail:"full" — this assertion is about run.artifacts, which the compact default omits.
    const run = (await call("workflow.get_run", { runId, detail: "full" })).data.run;
    const artifactNodeIds = run.artifacts.map((artifact: any) => artifact.nodeId);
    // One artifact per completed node — no replays. Twelve atomic commits: each advance persists a
    // dispatch claim (the ~300s silent-death heartbeat) plus the completion save.
    expect(new Set(artifactNodeIds).size).toBe(artifactNodeIds.length);
    // W6b serializes reader_insight behind monetization_strategy so the engine decision can stop the
    // run before any later paid stage. Six advances therefore complete six nodes, still with no replay.
    expect(run.nodes.filter((node: any) => node.status === "completed")).toHaveLength(6);
    expect(run.rev).toBe(12);
  });

  it("rejects removed per-call dependencies instead of silently ignoring them", async () => {
    const started = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: { instructions: "schema" } });
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workflow.run_node", arguments: { runId: started.data.run.runId, dependencies: { article_body: ["input_triage"] } } } });

    expect(response.json.error).toMatchObject({ code: -32603, data: { ok: false, error: { code: "validation_error" } } });

    const catalog = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const runNode = catalog.json.result.tools.find((tool: { name: string }) => tool.name === "workflow_run_node");
    expect(runNode.inputSchema.properties).not.toHaveProperty("dependencies");
  });

  // D9 — DRIVING A LONG NODE FROM AN MCP CLIENT USED TO ORPHAN IT. capture_crawl is a deterministic
  // capture stage: its dispatch claims DETERMINISTIC_STAGE_MIN_TIMEOUT_MS (300s), and the whole of
  // that claim is spent inside ONE synchronous workflow.run_* call — the driver's time budget is only
  // checked BETWEEN advances and there is no abort on the outer request. The calling client's own
  // request timeout (~180s) therefore reached the driver first, killed it mid-node, and left the node
  // claimed with nobody behind it for timeoutMs + STALL_MARGIN_MS. The drivers now price the dispatch
  // BEFORE starting it and refuse to own a claim past their ceiling — a named, non-advancing outcome,
  // not an error, and not a wider claim window.
  it("refuses to dispatch a node whose planned claim exceeds the in-request driver ceiling, and dispatches nothing", async () => {
    const started = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "platform", workflowId: "capture_conductor", input: { sourceUrl: "https://example.com/", targetProjectId: "platform" } });
    const runId = started.data.run.runId as string;
    expect(started.data.run.currentNodeId).toBe("capture_crawl");

    const refused = await call("workflow.run_next_node", { runId });
    expect(refused.data.driverRefusal).toMatchObject({
      code: "dispatch_claim_exceeds_driver_ceiling",
      nodeId: "capture_crawl",
      plannedClaimMs: DETERMINISTIC_STAGE_MIN_TIMEOUT_MS,
      ceilingMs: RUN_DRIVER_DISPATCH_CLAIM_CEILING_MS
    });
    // The note has to be actionable on its own: which node, how wide its claim, and who drives it now.
    expect(refused.data.driverNote).toContain("capture_crawl");
    expect(refused.data.driverNote).toContain("continuation tick");

    // NOTHING was dispatched — no claim stamped, no status moved. This is the assertion that separates
    // a refusal from a failed dispatch: a stamped claim with no driver is the defect itself.
    const after = (await call("workflow.get_run", { runId, detail: "full" })).data.run;
    expect(nodeStatus(after, "capture_crawl")).toBe("queued");
    expect(after.nodes.every((node: any) => node.dispatch === undefined)).toBe(true);
    expect(after.errors).toEqual([]);

    // Every in-request driver answers the same way; run_all still reports the run as one the
    // continuation tick will carry (continued), rather than pretending it is finished.
    const until = await call("workflow.run_until", { runId, nodeId: "capture_map" });
    expect(until.data.driverRefusal.nodeId).toBe("capture_crawl");
    const named = await call("workflow.run_node", { runId, nodeId: "capture_crawl" });
    expect(named.data.driverRefusal.nodeId).toBe("capture_crawl");
    expect(named.data.driverNote).toContain("the node you named");
    const all = await call("workflow.run_all", { runId });
    expect(all.data.driverRefusal.nodeId).toBe("capture_crawl");
    expect(all.data.continued).toBe(true);
  });

  it("reset then resume does not restore any pre-reset completed node state", async () => {
    const started = await call("workflow.start_dry_run", { executionMode: "mock", projectId: "dr-lurie", input: { instructions: "reset" } });
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
