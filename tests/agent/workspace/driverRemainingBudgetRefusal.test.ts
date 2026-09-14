import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

// D2 — an in-request driver must not start a node it cannot stay for.
//
// run_1789303857536_obd2fd's reader_insight was dispatched by http_run_all with ~32s of a 45s budget
// left, against a node whose claim window is 90s. The loop's deadline check runs BETWEEN advances,
// never during one, so the budget never stopped it — the call simply returned with a claim stamped
// and nobody behind it, and the node was unreclaimable for the next six minutes.
const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return response.body ? JSON.parse(response.body) : undefined;
};
const call = async (name: string, args: Record<string, unknown>) => {
  const json = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  if (!json?.result) throw new Error(`${name} failed: ${JSON.stringify(json?.error ?? json).slice(0, 400)}`);
  return json.result.structuredContent as { ok: boolean; data: any };
};

describe("D2 — a driver prices the next dispatch against its own remaining budget", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });
  afterEach(() => {
    delete process.env.MCP_API_TOKEN;
    resetRepositoryManager();
  });

  const seedP95 = async (runId: string, workflowId: string, projectId: string, nodeId: string, durationMs: number) => {
    const timings = repositoryManager.getNodeTimingRepository();
    // p95 over identical samples is that sample.
    for (let attempt = 1; attempt <= 5; attempt++) {
      await timings.record({
        runId, workflowId, projectId, nodeId, durationMs, outcome: "completed", attempt,
        recordedAt: new Date(Date.now() - attempt * 60_000).toISOString()
      } as any);
    }
  };

  it("refuses a 90s-p95 node when the driver's window is 45s, dispatches nothing, and reports the run as continued", async () => {
    const started = await call("workflow.start_dry_run", { executionMode: "openai", projectId: "dr-lurie", requestId: "req_driver_budget_20260914_01", input: { topic: "senior dog joint care", instructions: "d2" } });
    const run = started.data.run;
    const runId = run.runId as string;
    const nextNodeId = run.currentNodeId ?? run.nodes.find((node: any) => node.status === "queued")?.nodeId;
    expect(nextNodeId).toBeTruthy();
    await seedP95(runId, run.workflowId ?? "publishing_conductor", "dr-lurie", nextNodeId, 90_000);

    const result = await call("workflow.run_all", { runId });
    expect(result.data.driverRefusal?.code).toBe("dispatch_exceeds_remaining_driver_budget");
    expect(result.data.driverRefusal.nodeId).toBe(nextNodeId);
    expect(result.data.driverRefusal.expectedMs).toBe(90_000);
    expect(result.data.driverRefusal.expectedSource).toBe("measured_p95");
    expect(result.data.driverRefusal.remainingDriverMs).toBeLessThanOrEqual(45_000);
    // Nothing was dispatched: no claim stamped, nothing in flight, run still advanceable.
    expect(result.data.run.nodes.some((node: any) => node.status === "running" && node.dispatch)).toBe(false);
    expect(result.data.continued).toBe(true);
    expect(["queued", "running"]).toContain(result.data.run.status);
    expect(result.data.driverNote).toMatch(/was NOT dispatched/);
    expect(result.data.driverNote).not.toMatch(/nothing is in flight\./i);
  });

  it("dispatches the same node when its measured p95 fits the window", async () => {
    const started = await call("workflow.start_dry_run", { executionMode: "openai", projectId: "dr-lurie", requestId: "req_driver_budget_20260914_02", input: { topic: "senior dog joint care", instructions: "d2-fits" } });
    const run = started.data.run;
    const runId = run.runId as string;
    const nextNodeId = run.currentNodeId ?? run.nodes.find((node: any) => node.status === "queued")?.nodeId;
    await seedP95(runId, run.workflowId ?? "publishing_conductor", "dr-lurie", nextNodeId, 18_000);

    const result = await call("workflow.run_all", { runId });
    // No budget refusal: 18s + 15s margin fits a 45s window. (The node itself then fails on the
    // absent provider credential in CI, which is a NODE outcome, not a driver refusal.)
    expect(result.data.driverRefusal?.code).not.toBe("dispatch_exceeds_remaining_driver_budget");
  });
});
