import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import { RunScopedCache, conductorCache } from "../../../src/agent/workspace/conductor.js";
import { AUTH_PREFLIGHT_TOOL, DRIVER_AUTH_FAILED_PREFIX, preflightDriverAuth } from "../../../src/agent/workspace/driverEnvPreflight.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";

// T1 (autonomous-publish). The pre-existing driver preflight asked only whether a project's MCP
// ENDPOINT resolved in this process. A plane holding a stale, absent or unreadable TOKEN passes that
// check and looks completely healthy right up to its first client call — which is several paid nodes
// in. Three runs burned ~$1.45 each that way, producing artifacts nothing could publish.
//
// `initialize` / project.test_connection cannot close the gap: these servers answer both without a
// credential. Only an authenticated READ can, so the preflight makes exactly one — registry_get —
// once per (run, project), immediately before the first paid dispatch.

const openaiRun = (runId: string, projectId: string): Pick<WorkflowExecutionRecord, "runId" | "projectId" | "executionMode"> => ({
  runId,
  projectId,
  executionMode: "openai"
});

const jsonResponse = (status: number, body: unknown = { jsonrpc: "2.0", id: 1, result: {} }) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("preflightDriverAuth", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "a-token";
    remoteFetch = vi.fn(async () => jsonResponse(200));
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("makes one authenticated registry_get read and passes when the client accepts the credential", async () => {
    const result = await preflightDriverAuth(openaiRun("run-auth-ok", "dr-lurie"), repositoryManager.getProjectRepository(), { cache: new RunScopedCache() });

    expect(result.ok).toBe(true);
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((remoteFetch.mock.calls[0]![1] as { body: string }).body) as { method: string; params?: { name?: string } };
    // A tool CALL, not initialize — initialize is answered unauthenticated, which is exactly why
    // "the connection tested fine" has never been evidence a run can read anything.
    expect(body.method).toBe("tools/call");
    expect(body.params?.name).toBe(AUTH_PREFLIGHT_TOOL);
  });

  it("refuses on 401 and names the credential an operator has to fix", async () => {
    remoteFetch.mockImplementation(async () => jsonResponse(401));

    const result = await preflightDriverAuth(openaiRun("run-auth-401", "dr-lurie"), repositoryManager.getProjectRepository(), { cache: new RunScopedCache() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(`${DRIVER_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`);
      expect(result.credentialName).toBe("DR_LURIE_MCP_TOKEN");
      expect(result.detail).toContain("401");
      expect(result.detail).toContain("DR_LURIE_MCP_TOKEN");
    }
  });

  it("refuses on 403 as well", async () => {
    remoteFetch.mockImplementation(async () => jsonResponse(403));
    const result = await preflightDriverAuth(openaiRun("run-auth-403", "dr-lurie"), repositoryManager.getProjectRepository(), { cache: new RunScopedCache() });
    expect(result.ok).toBe(false);
  });

  // The refusal is reserved for credential verdicts. Everything else says nothing about the token,
  // and turning it into a pre-spend refusal would trade a costly failure for an unavailable pipeline.
  it.each([500, 502, 404, 429])("does not refuse on HTTP %i — that is not a credential verdict", async (status) => {
    remoteFetch.mockImplementation(async () => jsonResponse(status));
    const result = await preflightDriverAuth(openaiRun(`run-auth-${status}`, "dr-lurie"), repositoryManager.getProjectRepository(), { cache: new RunScopedCache() });
    expect(result.ok).toBe(true);
  });

  it("does not refuse when the client is simply unreachable", async () => {
    remoteFetch.mockImplementation(async () => { throw new Error("ECONNREFUSED"); });
    const result = await preflightDriverAuth(openaiRun("run-auth-down", "dr-lurie"), repositoryManager.getProjectRepository(), { cache: new RunScopedCache() });
    expect(result.ok).toBe(true);
  });

  it("exempts mock runs — they make no project MCP call by construction", async () => {
    const result = await preflightDriverAuth({ runId: "run-auth-mock", projectId: "dr-lurie", executionMode: "mock" }, repositoryManager.getProjectRepository(), { cache: new RunScopedCache() });
    expect(result.ok).toBe(true);
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("leaves an unresolved endpoint to the endpoint preflight rather than failing the run", async () => {
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    const projectRepository = repositoryManager.getProjectRepository();
    const config = await projectRepository.get("dr-lurie");
    await projectRepository.save({ ...config!, mcpEndpoint: undefined });

    const result = await preflightDriverAuth(openaiRun("run-auth-noendpoint", "dr-lurie"), projectRepository, { cache: new RunScopedCache() });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skipReason).toBe("endpoint_unresolved");
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("costs one round-trip per run, not one per node", async () => {
    const cache = new RunScopedCache();
    await preflightDriverAuth(openaiRun("run-auth-cached", "dr-lurie"), repositoryManager.getProjectRepository(), { cache });
    await preflightDriverAuth(openaiRun("run-auth-cached", "dr-lurie"), repositoryManager.getProjectRepository(), { cache });
    await preflightDriverAuth(openaiRun("run-auth-cached", "dr-lurie"), repositoryManager.getProjectRepository(), { cache });
    expect(remoteFetch).toHaveBeenCalledTimes(1);
  });

  it("never caches a refusal — the operator's fix must be able to take effect", async () => {
    const cache = new RunScopedCache();
    remoteFetch.mockImplementationOnce(async () => jsonResponse(401));
    expect((await preflightDriverAuth(openaiRun("run-auth-recovers", "dr-lurie"), repositoryManager.getProjectRepository(), { cache })).ok).toBe(false);
    expect((await preflightDriverAuth(openaiRun("run-auth-recovers", "dr-lurie"), repositoryManager.getProjectRepository(), { cache })).ok).toBe(true);
  });
});

describe("T1 acceptance — a bad token blocks the run before any paid dispatch", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    conductorCache.clear();
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "a-token";
    remoteFetch = vi.fn(async () => jsonResponse(200));
    vi.stubGlobal("fetch", remoteFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    conductorCache.clear();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  const startLiveRun = async (store: ExecutionRepository) =>
    (await startDryRun({ projectId: "dr-lurie", input: "a topic", executionMode: "openai" }, store)).runId;

  it("bad token: the run fails by name, no model is dispatched, and nothing is spent", async () => {
    remoteFetch.mockImplementation(async () => jsonResponse(401));
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startLiveRun(store);

    await runNextNode(runId, { executionRepository: store }).catch(() => undefined);
    const run = (await getRun(runId, store))!;

    expect(run.status).toBe("failed");
    expect(run.errors.some((entry) => entry.includes(`${DRIVER_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`))).toBe(true);

    const failed = run.nodes.find((node) => node.status === "failed")!;
    expect(failed.errors?.[0]).toBe(`${DRIVER_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`);
    // Pre-spend: the node never claimed a dispatch and no usage was recorded for it.
    expect(failed.dispatch).toBeUndefined();
    expect(await repositoryManager.getUsageRepository().list({ runId })).toEqual([]);
    // The only client traffic was the preflight read itself.
    expect(remoteFetch).toHaveBeenCalledTimes(1);
  });

  it("good token: behavior is unchanged — the run proceeds past the preflight to the model path", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startLiveRun(store);

    await runNextNode(runId, { executionRepository: store }).catch(() => undefined);
    const run = (await getRun(runId, store))!;

    expect(run.errors.some((entry) => entry.includes(DRIVER_AUTH_FAILED_PREFIX))).toBe(false);
    expect(run.nodes.find((node) => node.status === "failed")?.errors?.[0]).not.toBe(`${DRIVER_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`);
  });
});
