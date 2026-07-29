import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";

const ENDPOINT = "https://dr-lurie.example/mcp";
const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store });
  }
  return run!;
};

// F1 (T-2, run_1785352838155_l544ye): verifies the actual wiring, not just the unit pieces —
// dispatching contract_intelligence through the real DAG (mock execution mode, so no real model call
// is needed) must inject `prefetchedContract` into its input BEFORE the node runs, exactly the way a
// live (openai-mode) run would receive it instead of having to fetch the contract itself.
describe("contract prefetch wired into node dispatch (F1, end to end through the DAG)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { arguments?: Record<string, unknown> } };
      const result = request.method === "tools/call"
        ? { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write" }] } } }
        : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("injects prefetchedContract into contract_intelligence's own input before it dispatches", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "F1 e2e" }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    expect(state.status).toBe("completed");
    const input = state.input as { prefetchedContract?: { clientObjectType: string; idConventions: unknown[] }; prefetchError?: string };
    expect(input.prefetchError).toBeUndefined();
    expect(input.prefetchedContract).toBeDefined();
    expect(input.prefetchedContract!.clientObjectType).toBe("content_item");
    expect(input.prefetchedContract!.idConventions).toEqual([expect.objectContaining({ id: "article_slug" })]);
    // The deterministic prefetch happened exactly once for this node's single dispatch, via a plain
    // MCP call — not a tool call inside the node's own (mock, in this test) agent loop.
    expect(remoteFetch).toHaveBeenCalledTimes(1);
  });

  it("hands the node prefetchError instead of crashing the dispatch when the client is unreachable", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT; // simulate an unconfigured/unreachable client connection
    const store = new RepositoryManager().getExecutionRepository();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "F1 e2e unreachable" }, store);

    const run = await drive(started.runId, store, "contract_intelligence");
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    // The node dispatch itself still completes (mock mode) — the executor never crashes on a
    // prefetch failure, it just hands the node a prefetchError to react to.
    expect(state.status).toBe("completed");
    const input = state.input as { prefetchedContract?: unknown; prefetchError?: string };
    expect(input.prefetchedContract).toBeUndefined();
    expect(input.prefetchError).toBeTruthy();
  });
});
