import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReducedContract } from "../../../src/agent/workspace/contractPrefetch.js";
import { RunScopedCache } from "../../../src/agent/workspace/conductor.js";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { MemoryWorkspaceRepository } from "../../../src/agent/repository/memory/MemoryWorkspaceRepository.js";

const ENDPOINT = "https://dr-lurie.example/mcp";

// §2.20: a cross-run cache of already-reduced contracts, keyed by (projectId, objectType,
// fingerprint) — so a run whose client contract has not changed since a prior run's fetch reuses the
// reduction instead of recomputing it. §2.21 supplies the fingerprint this cache keys on. Each test
// uses a DIFFERENT runId per call so the existing RunScopedCache (run-scoped only) can never itself
// explain a hit — only the workspaceRepository-backed cross-run cache can.
describe("cross-run reduced-contract cache (§2.20)", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  let contractPayload: Record<string, unknown>;

  const stubRemote = () => {
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { arguments?: Record<string, unknown> } };
      const result = request.method === "tools/call"
        ? { structuredContent: { contract: { object_type: request.params?.arguments?.object_type, ...contractPayload } } }
        : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);
  };

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    contractPayload = { body_schema: { type: "object", required: ["slug"] }, constraints: [{ id: "article_slug", severity: "blocks_write", description: "slug rules" }] };
    stubRemote();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("hits the cache across runs when the fingerprint is unchanged: the raw contract is still fetched, but the reduction is reused (put() is not called a second time)", async () => {
    const projectRepository = new MemoryProjectRepository();
    const workspaceRepository = new MemoryWorkspaceRepository();
    const putSpy = vi.spyOn(workspaceRepository, "putReducedContractCacheEntry");

    const first = await getReducedContract({ runId: "run-cache-1a", projectId: "dr-lurie" }, { projectRepository, workspaceRepository, cache: new RunScopedCache() });
    const second = await getReducedContract({ runId: "run-cache-1b", projectId: "dr-lurie" }, { projectRepository, workspaceRepository, cache: new RunScopedCache() });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The raw contract is fetched every time — caching only skips the reduction, per spec.
    expect(remoteFetch).toHaveBeenCalledTimes(2);
    // But the reduction was only ever WRITTEN once: the second call found it already cached.
    expect(putSpy).toHaveBeenCalledTimes(1);
    if (first.ok && second.ok) expect(second.reduced).toEqual(first.reduced);
  });

  it("misses the cache when the contract content changes between runs (different fingerprint)", async () => {
    const projectRepository = new MemoryProjectRepository();
    const workspaceRepository = new MemoryWorkspaceRepository();
    const putSpy = vi.spyOn(workspaceRepository, "putReducedContractCacheEntry");

    const first = await getReducedContract({ runId: "run-cache-2a", projectId: "dr-lurie" }, { projectRepository, workspaceRepository, cache: new RunScopedCache() });
    // Change the raw contract's content — a different fingerprint, so this must be a cache miss too.
    contractPayload = { body_schema: { type: "object", required: ["slug", "title"] }, constraints: [{ id: "article_slug", severity: "blocks_write", description: "slug rules v2" }] };
    const second = await getReducedContract({ runId: "run-cache-2b", projectId: "dr-lurie" }, { projectRepository, workspaceRepository, cache: new RunScopedCache() });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(remoteFetch).toHaveBeenCalledTimes(2);
    // Both calls wrote a (different) reduction — neither found the other's fingerprint cached.
    expect(putSpy).toHaveBeenCalledTimes(2);
    if (first.ok && second.ok) {
      expect(second.reduced.contractSource.fingerprint).not.toBe(first.reduced.contractSource.fingerprint);
      expect(second.reduced).not.toEqual(first.reduced);
    }
  });

  it("is optional and best-effort: omitting workspaceRepository behaves exactly as before (no cross-run reuse, no error)", async () => {
    const projectRepository = new MemoryProjectRepository();
    const first = await getReducedContract({ runId: "run-cache-3a", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });
    const second = await getReducedContract({ runId: "run-cache-3b", projectId: "dr-lurie" }, { projectRepository, cache: new RunScopedCache() });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });
});

describe("reduced-contract cache storage: cap and eviction", () => {
  it("caps at 20 entries, evicting the oldest first", async () => {
    const workspaceRepository = new MemoryWorkspaceRepository();
    for (let index = 0; index < 21; index++) {
      await workspaceRepository.putReducedContractCacheEntry({
        projectId: "dr-lurie",
        objectType: "content_item",
        fingerprint: `fp_${index}`,
        reduced: { clientObjectType: "content_item", bodySchema: null, idConventions: [], mediaConvention: { policy: null, notes: [] }, taxonomy: { notes: [], blockingConstraints: [] }, constraints: [], publishPolicy: null, workflowSequence: [], validationSurface: [], contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-10T00:00:00.000Z", fingerprint: `fp_${index}` } } as any
      });
    }

    // The very first entry (fp_0) was evicted; the most recent 20 (fp_1..fp_20) remain.
    expect(await workspaceRepository.getReducedContractCacheEntry("dr-lurie", "content_item", "fp_0")).toBeUndefined();
    expect(await workspaceRepository.getReducedContractCacheEntry("dr-lurie", "content_item", "fp_1")).toBeDefined();
    expect(await workspaceRepository.getReducedContractCacheEntry("dr-lurie", "content_item", "fp_20")).toBeDefined();
  });

  it("overwrites in place on a repeated key without growing the cache or evicting anything else", async () => {
    const workspaceRepository = new MemoryWorkspaceRepository();
    const write = (fingerprint: string) => workspaceRepository.putReducedContractCacheEntry({
      projectId: "dr-lurie", objectType: "content_item", fingerprint,
      reduced: { clientObjectType: "content_item", bodySchema: null, idConventions: [], mediaConvention: { policy: null, notes: [] }, taxonomy: { notes: [], blockingConstraints: [] }, constraints: [], publishPolicy: null, workflowSequence: [], validationSurface: [], contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-10T00:00:00.000Z", fingerprint } } as any
    });
    await write("fp_a");
    await write("fp_b");
    await write("fp_a");

    const entryA = await workspaceRepository.getReducedContractCacheEntry("dr-lurie", "content_item", "fp_a");
    const entryB = await workspaceRepository.getReducedContractCacheEntry("dr-lurie", "content_item", "fp_b");
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
  });
});
