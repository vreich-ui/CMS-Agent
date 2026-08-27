import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { RUN_DRIVER_TIME_BUDGET_CEILING_MS, RUN_DRIVER_TIME_BUDGET_MS, compactRun } from "../../../src/agent/mcp/workspace/tools.js";

const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};
const call = async (name: string, args: Record<string, unknown> = {}) => (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));

// S1 (chat-path). workflow.run_all used to (a) drive for 240s by default — above every caller's
// request timeout, so the chat client saw a transport error while the loop kept going — and (b)
// return the FULL run record (inputs, outputs, stageOutputs, artifacts), hundreds of KB the chat
// tool result cannot carry. It now caps at 45s (env override clamped), takes a per-call budgetMs,
// returns a compact view, and says whether the run is still live (`continued`).
describe("workflow.run_all — budget below caller timeouts, compact response", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });
  afterEach(() => { delete process.env.PLATFORM_MCP_ENDPOINT; });

  it("defaults to 45s and never above it, even when the env asks for more", () => {
    expect(RUN_DRIVER_TIME_BUDGET_CEILING_MS).toBe(45_000);
    expect(RUN_DRIVER_TIME_BUDGET_MS).toBeLessThanOrEqual(45_000);
  });

  it("advertises budgetMs (5s..45s) and describes the compact shape", async () => {
    const tools: Array<{ name: string; description: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    const runAll = tools.find((tool) => tool.name === "workflow_run_all")!;
    expect(runAll.inputSchema.properties.budgetMs).toMatchObject({ type: "number", minimum: 5_000, maximum: 45_000 });
    expect(runAll.description).toContain("continued");
    expect(runAll.description).toContain("workflow.get_run");
  });

  it("returns {run: compact, continued} with no inputs/outputs/stageOutputs/artifacts; get_run stays full", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: { artifact: "content_source.v1", summary: "compact fixture" } });
    const runId: string = started.result.structuredContent.data.run.runId;

    const response = await call("workflow.run_all", { runId, budgetMs: 30_000 });
    expect(response.error).toBeUndefined();
    const data = response.result.structuredContent.data;
    expect(typeof data.continued).toBe("boolean");
    expect(Object.keys(data.run).sort()).toEqual(expect.arrayContaining(["runId", "projectId", "status", "errors", "approvalsRequired", "nodes"]));
    for (const forbidden of ["stageOutputs", "artifacts", "initialInput"]) expect(data.run).not.toHaveProperty(forbidden);
    for (const node of data.run.nodes) {
      expect(node).not.toHaveProperty("input");
      expect(node).not.toHaveProperty("output");
      expect(node).not.toHaveProperty("toolCalls");
      expect(Object.keys(node)).toEqual(expect.arrayContaining(["nodeId", "status"]));
    }
    // A mock run drives to the publish gate within the budget; it is not live any more.
    expect(["blocked", "completed"]).toContain(data.run.status);
    expect(data.continued).toBe(false);

    // T7: get_run now DEFAULTS to the same compact view (the raw record was 110KB on a live run);
    // detail:"full" is the opt-in that returns the node payloads.
    const compact = (await call("workflow.get_run", { runId })).result.structuredContent.data.run;
    expect(compact).not.toHaveProperty("stageOutputs");
    expect(compact.nodes.every((node: { output?: unknown }) => node.output === undefined)).toBe(true);

    const full = (await call("workflow.get_run", { runId, detail: "full" })).result.structuredContent.data.run;
    expect(full).toHaveProperty("stageOutputs");
    expect(full.nodes.some((node: { output?: unknown }) => node.output !== undefined)).toBe(true);
  });

  it("rejects a budgetMs outside 5s..45s", async () => {
    const started = await call("workflow.start_dry_run", { projectId: "platform", executionMode: "mock", input: { artifact: "content_source.v1", summary: "budget fixture" } });
    const runId: string = started.result.structuredContent.data.run.runId;
    const tooLong = await call("workflow.run_all", { runId, budgetMs: 240_000 });
    expect(tooLong.error ?? tooLong.result?.structuredContent?.ok === false).toBeTruthy();
  });

  it("compactRun reports continued semantics through status and keeps dispatch provenance", () => {
    const view = compactRun({
      runId: "r", workflowId: "w", projectId: "p", status: "running", startedAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
      nodes: [{ nodeId: "n1", status: "completed", durationMs: 12, output: { big: "x".repeat(10) }, lastDispatch: { dispatchedAt: "2026-08-17T00:00:00.000Z", driver: "http_run_all", projectEndpointConfigured: true } }],
      artifacts: [], errors: [], approvalsRequired: [], stageOutputs: { n1: {} }, dryRun: true, budgetUsd: 2
    });
    // T7 — the compact view is now also what a plain workflow.get_run returns, so it carries the
    // short scalar facts an operator reads by name (ids, mode, timestamps, artifact COUNT). What it
    // still must never carry is the bulk: node inputs/outputs, stageOutputs, artifact values.
    expect(view).toEqual({
      runId: "r", workflowId: "w", projectId: "p", status: "running", executionMode: undefined, budget: { budgetUsd: 2 },
      startedAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", artifactCount: 0,
      errors: [], approvalsRequired: [],
      nodes: [{ nodeId: "n1", status: "completed", durationMs: 12, lastDispatch: { dispatchedAt: "2026-08-17T00:00:00.000Z", driver: "http_run_all", projectEndpointConfigured: true } }]
    });
    expect(view).not.toHaveProperty("stageOutputs");
    expect(JSON.stringify(view)).not.toContain("xxxxx");
  });
});
