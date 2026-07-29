import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReducedContract } from "../../../src/agent/workspace/contractPrefetch.js";
import { RunScopedCache } from "../../../src/agent/workspace/conductor.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";

const ENDPOINT = "https://dr-lurie.example/mcp";

// F1 (T-2, run_1785352838155_l544ye): contract_intelligence used to fetch this via a tool call inside
// its own agent loop, re-sending the raw contract on every subsequent turn. getReducedContract is the
// deterministic replacement — a plain function call the conductor makes once, before the node runs.
describe("getReducedContract (F1 deterministic contract prefetch)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  const remoteMethods: string[] = [];

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    remoteMethods.length = 0;
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      remoteMethods.push(request.method);
      const result = request.method === "tools/call"
        ? { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write", description: "slug rules" }] } } }
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

  it("fetches, reduces, and resolves the object type from the project's configured default", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getReducedContract({ runId: "run-prefetch-1", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reduced.clientObjectType).toBe("content_item");
      expect(result.reduced.idConventions).toEqual([expect.objectContaining({ id: "article_slug" })]);
      expect(result.reduced.contractSource.tool).toBe("object_contract");
    }
    expect(remoteMethods).toEqual(["tools/call"]);
  });

  it("caches the reduction per run — a second call for the same run/project never refetches", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getReducedContract({ runId: "run-prefetch-2", projectId: "dr-lurie" }, { projectRepository, cache });
    await getReducedContract({ runId: "run-prefetch-2", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteFetch).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache across different runs", async () => {
    const projectRepository = new MemoryProjectRepository();
    const cache = new RunScopedCache();
    await getReducedContract({ runId: "run-prefetch-3a", projectId: "dr-lurie" }, { projectRepository, cache });
    await getReducedContract({ runId: "run-prefetch-3b", projectId: "dr-lurie" }, { projectRepository, cache });

    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it("reports a clear error for an unknown project instead of throwing", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getReducedContract({ runId: "run-prefetch-4", projectId: "does-not-exist" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does-not-exist");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("honors an explicit requestedObjectType over the project's configured default", async () => {
    const projectRepository = new MemoryProjectRepository();
    const result = await getReducedContract({ runId: "run-prefetch-5", projectId: "dr-lurie", requestedObjectType: "page" }, { projectRepository, cache: new RunScopedCache() });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reduced.clientObjectType).toBe("page");
  });

  it("still honors the project's own executable policy block before any transport", async () => {
    // save_json_blob_* names are blocked by dr-lurie's executable policy; object_contract itself is
    // not, so this exercises the same policy hook a real block would use without depending on one.
    const projectRepository = new MemoryProjectRepository();
    const project = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...project!, toolPolicies: { ...project!.toolPolicies, object_contract: "blocked" } });
    const result = await getReducedContract({ runId: "run-prefetch-6", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    // toolPolicies "blocked" is enforced inside callTool itself (after the executable-policy hook
    // above finds nothing to block), so this still surfaces as a clean ok:false, not a thrown error.
    expect(result.ok).toBe(false);
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
