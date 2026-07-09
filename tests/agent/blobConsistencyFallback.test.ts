import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBlobJson, type BlobStoreClient } from "../../src/agent/repository/blobs/blobClient.js";
import { RepositoryManager } from "../../src/agent/repository/RepositoryManager.js";
import { resetRepositoryManager } from "../../src/agent/runtime/repositories.js";
import { handler } from "../../netlify/functions/mcp.mjs";

// Mirrors the real @netlify/blobs error: thrown when a strong-consistency read is attempted in an
// environment that has not been configured with an `uncachedEdgeURL`. The message only names the
// missing property — it never carries a site ID, token, or other Blobs internals.
class BlobsConsistencyError extends Error {
  constructor() {
    super("Netlify Blobs has failed to perform a read using strong consistency because the environment has not been configured with a 'uncachedEdgeURL' property");
    this.name = "BlobsConsistencyError";
  }
}

describe("getBlobJson consistency fallback (unit)", () => {
  it("returns the strong-consistency read when it is available", async () => {
    const get = vi.fn(async (_key: string, options?: { consistency?: string }) => {
      expect(options?.consistency).toBe("strong");
      return { value: "from-strong-read" };
    });
    const store = { get, setJSON: vi.fn(), list: vi.fn() } as unknown as BlobStoreClient;

    await expect(getBlobJson(store, "some/key.json")).resolves.toEqual({ value: "from-strong-read" });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal consistency when strong consistency is unavailable", async () => {
    const get = vi.fn(async (_key: string, options?: { consistency?: string }) => {
      if (options?.consistency === "strong") throw new BlobsConsistencyError();
      expect(options?.consistency).toBe("eventual");
      return { value: "from-fallback-read" };
    });
    const store = { get, setJSON: vi.fn(), list: vi.fn() } as unknown as BlobStoreClient;

    await expect(getBlobJson(store, "some/key.json")).resolves.toEqual({ value: "from-fallback-read" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not retry and rethrows errors unrelated to consistency", async () => {
    const networkError = new Error("network unavailable");
    const get = vi.fn(async () => { throw networkError; });
    const store = { get, setJSON: vi.fn(), list: vi.fn() } as unknown as BlobStoreClient;

    await expect(getBlobJson(store, "some/key.json")).rejects.toThrow("network unavailable");
    expect(get).toHaveBeenCalledTimes(1);
  });
});

const blobData = vi.hoisted(() => new Map<string, unknown>());

// Simulates a deployment where strong consistency is selected but unavailable (no
// `uncachedEdgeURL`): every strong-consistency get() throws, and every eventual-consistency get()
// serves the in-memory store normally. Writes are unaffected.
vi.mock("@netlify/blobs", () => ({
  getStore: vi.fn(() => ({
    get: vi.fn(async (key: string, options?: { consistency?: string }) => {
      if (options?.consistency === "strong") throw new BlobsConsistencyError();
      return blobData.has(key) ? structuredClone(blobData.get(key)) : null;
    }),
    setJSON: vi.fn(async (key: string, value: unknown) => {
      blobData.set(key, structuredClone(value));
      return { modified: true, etag: `etag-${key}` };
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({
      blobs: [...blobData.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: `etag-${key}` })),
      directories: []
    }))
  }))
}));

describe("Blob repositories when strong consistency is unavailable", () => {
  beforeEach(() => blobData.clear());

  it("repository.get_health succeeds instead of throwing MissingBlobsEnvironmentError-style failures", async () => {
    const manager = new RepositoryManager({ backend: "blobs" });

    await expect(manager.getRepositoryHealth()).resolves.toMatchObject({
      backend: "blobs",
      storageHealth: "healthy",
      workspace: { readable: true, writable: true },
      execution: { readable: true, writable: true },
      artifact: { readable: true, writable: true },
      learning: { readable: true, writable: true },
      usage: { readable: true, writable: true }
    });
  });

  it("workspace.get_nodes reads succeed via the normal-consistency fallback", async () => {
    const manager = new RepositoryManager({ backend: "blobs" });

    const nodes = await manager.getWorkspaceRepository().getNodes();
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.map((node) => node.id)).toContain("input_triage");
  });

  it("a write remains readable through the fallback on a fresh repository instance", async () => {
    const first = new RepositoryManager({ backend: "blobs" }).getWorkspaceRepository();
    await first.updateNodePrompt("input_triage", "Prompt written under degraded consistency.");

    const second = new RepositoryManager({ backend: "blobs" }).getWorkspaceRepository();
    await expect(second.getNode("input_triage")).resolves.toMatchObject({
      id: "input_triage",
      prompt: "Prompt written under degraded consistency."
    });
  });
});

describe("Netlify MCP endpoint when strong consistency is unavailable", () => {
  beforeEach(() => {
    blobData.clear();
    process.env.WORKSPACE_STORE = "blobs";
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  afterEach(() => {
    delete process.env.WORKSPACE_STORE;
    resetRepositoryManager();
  });

  const call = async (body: unknown) => {
    const response = await handler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify(body)
    });
    return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
  };

  it("repository.get_health tool call succeeds and reports a safe, healthy status", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repository.get_health", arguments: {} } });

    expect(response.statusCode).toBe(200);
    expect(response.json.result.structuredContent.ok).toBe(true);
    expect(response.json.result.structuredContent.data.health).toMatchObject({ backend: "blobs", storageHealth: "healthy" });
    expect(JSON.stringify(response.json.result.structuredContent.data.health)).not.toMatch(/token|secret|authorization|site.?id|uncachedEdgeURL/i);
  });

  it("workspace.get_nodes tool call succeeds via the normal-consistency fallback", async () => {
    const response = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace.get_nodes", arguments: {} } });

    expect(response.statusCode).toBe(200);
    expect(response.json.result.structuredContent.ok).toBe(true);
    expect(response.json.result.structuredContent.data.nodes.length).toBeGreaterThan(0);
  });
});
