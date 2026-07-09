import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @netlify/blobs so we can observe when getStore() and connectLambda() are called without
// contacting the real Blobs service. vi.hoisted keeps the spies available inside the hoisted
// vi.mock factory, and the spy references stay stable across vi.resetModules().
const { getStore, connectLambda } = vi.hoisted(() => ({
  getStore: vi.fn(() => ({
    get: vi.fn(async () => null),
    setJSON: vi.fn(async () => ({ modified: true, etag: "etag" })),
    list: vi.fn(async () => ({ blobs: [], directories: [] }))
  })),
  connectLambda: vi.fn(() => undefined)
}));

vi.mock("@netlify/blobs", () => ({ getStore, connectLambda }));

// A Netlify Lambda event carrying a Blobs context. connectLambda is mocked, so the base64 payload
// is never decoded here — its contents are irrelevant to the assertions.
const lambdaEvent = (body: unknown) => ({
  httpMethod: "POST",
  headers: { authorization: "Bearer test-token", "x-nf-site-id": "site-id", "x-nf-deploy-id": "deploy-id" },
  blobs: "eyJ1cmwiOiJodHRwczovL2Jsb2JzLmV4YW1wbGUiLCJ0b2tlbiI6InJlZGFjdGVkIn0=",
  body: JSON.stringify(body)
});

const importMcpHandler = async () => (await import("../../netlify/functions/mcp.mjs")).handler;

describe("Netlify Blobs Lambda initialization", () => {
  beforeEach(() => {
    // Fresh module graph (and a fresh lazy RepositoryManager singleton) per test, with the Blobs
    // backend selected before anything is imported.
    vi.resetModules();
    getStore.mockClear();
    connectLambda.mockClear();
    process.env.WORKSPACE_STORE = "blobs";
    process.env.MCP_API_TOKEN = "test-token";
  });

  afterEach(() => {
    delete process.env.WORKSPACE_STORE;
  });

  it("does not construct Blob-backed repositories (getStore) at module import time", async () => {
    await import("../../src/agent/runtime/repositories.js");
    await importMcpHandler();
    // Even with WORKSPACE_STORE=blobs, importing the modules must not build the RepositoryManager
    // or call getStore() — construction is deferred to the first request.
    expect(getStore).not.toHaveBeenCalled();
    expect(connectLambda).not.toHaveBeenCalled();
  });

  it("connects Netlify Blobs before constructing the RepositoryManager on a request", async () => {
    const handler = await importMcpHandler();
    expect(getStore).not.toHaveBeenCalled();

    const response = await handler(lambdaEvent({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    expect(response.statusCode).toBe(200);
    expect(connectLambda).toHaveBeenCalledTimes(1);
    expect(getStore).toHaveBeenCalled();
    // Ordering guarantee: connectLambda(event) runs before the first getStore().
    expect(connectLambda.mock.invocationCallOrder[0]).toBeLessThan(getStore.mock.invocationCallOrder[0]);
  });

  it("builds the RepositoryManager at request time even without a Blobs context to connect", async () => {
    const handler = await importMcpHandler();

    const response = await handler({
      httpMethod: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    });

    expect(response.statusCode).toBe(200);
    // No Blobs context on the event, so connectLambda is skipped, but repositories are still
    // constructed at request time (not import time).
    expect(connectLambda).not.toHaveBeenCalled();
    expect(getStore).toHaveBeenCalled();
  });
});
