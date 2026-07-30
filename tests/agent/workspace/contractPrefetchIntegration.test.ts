import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../../../src/agent/repository/interfaces/WorkspaceRepository.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";

// A minimal stub standing in for a WorkspaceRepository — resolveConductorNodes only calls getNodes()
// (same pattern as tests/agent/workspaceNodeSource.test.ts).
const stubRepo = (getNodes: () => Promise<WorkspaceNode[]>): WorkspaceRepository => ({ getNodes } as unknown as WorkspaceRepository);

// contract_intelligence's live-mirrored canonical definition (nodes.ts, re-seeded from the workspace)
// currently has metadata.contractPrefetch removed: a 2026-07-30 re-seed against the live workspace
// (v226) found the node rolled back to self-fetch mode, correlating with PR #95's same-day fix for a
// cost regression the prefetch caused for the "platform" project — HANDOFF.md's own "Unmeasured"
// section still lists re-confirming the prefetch's cost effect as open work. Rather than couple this
// test (which verifies the WIRING: executor.ts's gate on metadata.contractPrefetch === true, plus
// contractPrefetch.ts's getReducedContract) to whatever the live-mirrored seed happens to carry today,
// force contractPrefetch: true on a workspace-store overlay of contract_intelligence for this test's
// own run only (store mode is the default; overlayStoreNode replaces metadata wholesale when the
// stored node supplies it, so the full canonical metadata is spread forward here). This is exactly the
// override pattern workspaceNodeSource.test.ts already uses to test store-mode promotion, and it makes
// this test immune to nodes.ts's re-seeded contractPrefetch flag drifting in either direction.
const contractIntelligencePrefetchEnabled = (): WorkspaceRepository => {
  const canonical = listWorkspaceNodes().find((node) => node.id === "contract_intelligence")!;
  const promoted: WorkspaceNode = { ...canonical, metadata: { ...canonical.metadata, contractPrefetch: true } };
  return stubRepo(async () => [promoted]);
};

const ENDPOINT = "https://dr-lurie.example/mcp";
const drive = async (runId: string, store: ExecutionRepository, untilNodeId: string, workspaceRepository?: WorkspaceRepository, max = 30) => {
  let run = await getRun(runId, store);
  for (let i = 0; run && i < max; i++) {
    const state = run.nodes.find((node) => node.nodeId === untilNodeId);
    if (state && state.status !== "queued" && state.status !== "running") return run;
    run = await runNextNode(runId, { executionRepository: store, workspaceRepository });
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
    const workspaceRepository = contractIntelligencePrefetchEnabled();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "F1 e2e" }, store, workspaceRepository);

    const run = await drive(started.runId, store, "contract_intelligence", workspaceRepository);
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
    const workspaceRepository = contractIntelligencePrefetchEnabled();
    const started = await startDryRun({ executionMode: "mock", projectId: "dr-lurie", input: "F1 e2e unreachable" }, store, workspaceRepository);

    const run = await drive(started.runId, store, "contract_intelligence", workspaceRepository);
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    // The node dispatch itself still completes (mock mode) — the executor never crashes on a
    // prefetch failure, it just hands the node a prefetchError to react to.
    expect(state.status).toBe("completed");
    const input = state.input as { prefetchedContract?: unknown; prefetchError?: string };
    expect(input.prefetchedContract).toBeUndefined();
    expect(input.prefetchError).toBeTruthy();
    // G2 (T-2 re-run, run_1785405350649_9u5mjz): a prefetch failure used to be visible ONLY inside
    // this one node's own input — a run-level warning is what would have made platform's missing
    // dialect a visible defect instead of a silent cost regression.
    expect(state.warnings).toContain("contract_prefetch_failed:unknown");
  });
});
