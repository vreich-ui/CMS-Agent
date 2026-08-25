import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";
import type { ExecutionRepository } from "../../../src/agent/repository/interfaces/ExecutionRepository.js";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { getReducedContract } from "../../../src/agent/workspace/contractPrefetch.js";
import { validateClientObjectOnce, type PublishPayloadValidation } from "../../../src/agent/workspace/publishPayload.js";
import { runArticleBodyValidationLoop } from "../../../src/agent/workspace/articleBodyValidation.js";
import { RunScopedCache, conductorCache } from "../../../src/agent/workspace/conductor.js";
import { CLIENT_AUTH_FAILED_PREFIX } from "../../../src/agent/workspace/driverEnvPreflight.js";
import { mockOutputForNode } from "../../../src/agent/execution/runners/MockNodeRunner.js";
import { getWorkspaceNode } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../../../src/agent/workspace/executionTypes.js";
import * as registry from "../../../src/agent/execution/runnerRegistry.js";

// T2 (autonomous-publish) — run_1787658091131_cv41es, three times at ~$1.45 each.
//
// The conductor is deliberately built to degrade: a deterministic client read that fails hands the
// node a named `prefetchError`, the node writes its own blocker, the artifact stays schema-valid, the
// run continues. That is right for a transient outage. For an AUTH failure it is catastrophic — the
// first client call was refused, every later node produced an empty-but-schema-valid artifact
// carrying blockers[], the run reported `completed`, and not one word of it could ever be published.
// Graceful degradation turned an unrecoverable, instantly-diagnosable configuration error into a
// full-price run whose failure was legible only by opening blockers[] on an artifact nobody had
// reason to open.
//
// These tests lock the distinction at all three layers: the two seams that TALK to the client learn
// to say "the credential was refused" as a typed fact, and the executor turns that one fact — and
// only that one — into a failed node and an aborted run.

const jsonRpc = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
const response = (status: number, result: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => jsonRpc(result), text: async () => "" }) as unknown as Response;

const sampleBody = () => ({ slug: "governed-content-lifecycle", title: "Governed content lifecycle", nodes: [{ id: "n1", type: "paragraph", text: "Body." }] });
const sampleOutput = () => ({
  artifact: "client_object.v1",
  summary: "Client object built to the fetched contract.",
  clientProjectId: "platform",
  clientObjectType: "content_item",
  contractSource: { tool: "object_contract", fetchedAtISO: "2026-08-12T08:00:00.000Z", fingerprint: "fp_sample" },
  body: sampleBody(),
  blockers: []
});

// ------------------------------------------------------------------ seam 1: the contract prefetch

describe("contract prefetch reports an auth failure as its own typed fact", () => {
  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "stale-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it.each([401, 403])("marks a %i refusal authFailed", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(status)));
    const result = await getReducedContract({ runId: `run-prefetch-auth-${status}`, projectId: "dr-lurie" }, { projectRepository: repositoryManager.getProjectRepository(), cache: new RunScopedCache() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authFailed).toBe(true);
      expect(result.httpStatus).toBe(status);
    }
  });

  // The whole value of the flag is that it is NARROW. A client that is down, slow, or rate-limiting
  // says nothing about the credential, and treating it as an auth failure would convert an outage
  // into a dead run.
  it.each([500, 502, 429, 404])("leaves a %i failure unflagged", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(status)));
    const result = await getReducedContract({ runId: `run-prefetch-plain-${status}`, projectId: "dr-lurie" }, { projectRepository: repositoryManager.getProjectRepository(), cache: new RunScopedCache() });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.authFailed).toBeUndefined();
  });
});

// ---------------------------------------------------------------- seam 2: the client-object validate

describe("client object validation reports an auth failure as its own typed fact", () => {
  beforeEach(() => {
    process.env.PLATFORM_MCP_ENDPOINT = "https://platform.example/mcp";
    process.env.PLATFORM_MCP_TOKEN = "stale-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PLATFORM_MCP_ENDPOINT;
    delete process.env.PLATFORM_MCP_TOKEN;
  });

  it("marks a 401 authFailed and does not pretend the body was judged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(401)));
    const validation = await validateClientObjectOnce(
      { projectId: "platform", body: sampleBody(), objectType: "content_item" },
      { projectRepository: repositoryManager.getProjectRepository() }
    );

    expect(validation.authFailed).toBe(true);
    expect(validation.httpStatus).toBe(401);
    // attempted:false is the honest record — the client never spoke ABOUT the object.
    expect(validation.attempted).toBe(false);
    expect(validation.valid).toBe(false);
  });

  // A client correctly refusing to validate an object that does not exist yet is a NORMAL outcome
  // article_body's own prompt names. It must keep its precedence and must never be read as an auth
  // problem.
  it("leaves a requires-existing-object deferral untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, { isError: true, content: [{ type: "text", text: "validate requires either object_id for an existing object or body for a candidate" }] })));
    const validation = await validateClientObjectOnce(
      { projectId: "platform", body: sampleBody(), objectType: "content_item" },
      { projectRepository: repositoryManager.getProjectRepository() }
    );

    expect(validation.authFailed).toBeUndefined();
  });
});

// ------------------------------------------------------------------ seam 3: the article_body loop

describe("article_body validation loop surfaces an auth failure instead of burning a revision turn", () => {
  const authRefused = (): PublishPayloadValidation => ({
    attempted: false,
    tool: "object_validate",
    valid: false,
    issues: [],
    error: "MCP request failed with HTTP 401.",
    authFailed: true,
    httpStatus: 401
  });

  it("reports authFailure, spends no revision turn, and still warns like any other outage", async () => {
    const validate = vi.fn().mockResolvedValue(authRefused());
    const revise = vi.fn();

    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate, revise }))!;

    expect(result.authFailure).toEqual({ error: "MCP request failed with HTTP 401.", httpStatus: 401 });
    // Handing the model "the client rejected your body" when the client rejected our CREDENTIAL is
    // how a revision turn gets spent 'fixing' a body that was never judged.
    expect(revise).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((warning) => warning.startsWith("article_body_validation_unavailable"))).toBe(true);
  });

  it("leaves an ordinary unavailable verdict without an authFailure", async () => {
    const validate = vi.fn().mockResolvedValue({ attempted: false, tool: "object_validate", valid: false, issues: [], error: "client_unreachable" } satisfies PublishPayloadValidation);
    const result = (await runArticleBodyValidationLoop(sampleOutput(), { validate }))!;

    expect(result.authFailure).toBeUndefined();
    expect(result.warnings.some((warning) => warning.startsWith("article_body_validation_unavailable"))).toBe(true);
  });
});

// ---------------------------------------------- the acceptance replay: run_1787658091131_cv41es

describe("T2 acceptance — replaying the doomed run's conditions aborts instead of completing", () => {
  let remoteFetch: ReturnType<typeof vi.fn>;
  let runnerSpy: { mockRestore: () => void };
  const dispatched: string[] = [];

  beforeEach(() => {
    repositoryManager.getUsageRepository().clear();
    conductorCache.clear();
    dispatched.length = 0;
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "stale-token";

    // The credential passes the T1 preflight (registry_get answers 200) and is then refused by every
    // real read. That is not a contrivance — it is the mid-run rotation case, and it is the only way
    // to exercise T2 at all now that T1 catches an already-dead credential before the first dispatch.
    remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string } };
      if (request.method === "tools/call" && request.params?.name === "registry_get") return response(200, { structuredContent: { ok: true } });
      return response(401);
    });
    vi.stubGlobal("fetch", remoteFetch);

    // A stub runner so "openai" mode needs no provider. Every dispatch is recorded, which is how the
    // "nothing downstream ran" half of the acceptance is proven rather than assumed.
    const emptyRun = { stageOutputs: {} } as unknown as WorkflowExecutionRecord;
    runnerSpy = vi.spyOn(registry, "getNodeRunner").mockReturnValue({
      supports: () => true,
      validateConfiguration: () => ({ ok: true as const }),
      run: async ({ node }: { node: WorkspaceNode }) => {
        dispatched.push(node.id);
        return { ok: true as const, output: mockOutputForNode(node, emptyRun) };
      }
    } as never);
  });

  afterEach(() => {
    runnerSpy.mockRestore();
    vi.unstubAllGlobals();
    conductorCache.clear();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  // Seed every node before `target` as completed so the run arrives at exactly the node under test
  // without paying for the seventeen ahead of it. The live (openai) deterministic stages refuse mock
  // placeholders by design — placement_resolver blocks on aggression_signals_missing — so driving the
  // real DAG from the start is not a way to reach a late node in a live run.
  const startAt = async (store: ExecutionRepository, target: string, executionMode: "openai" | "mock") => {
    const started = await startDryRun({ executionMode, projectId: "dr-lurie", input: "T2 replay", budgetUsd: 100 }, store);
    const run = (await getRun(started.runId, store))!;
    const index = run.nodes.findIndex((node) => node.nodeId === target);
    for (const state of run.nodes.slice(0, index)) {
      const output = mockOutputForNode(getWorkspaceNode(state.nodeId)!, run);
      state.status = "completed";
      state.output = output;
      run.stageOutputs[state.nodeId] = output;
    }
    await store.saveRun(run);
    return started.runId;
  };

  it("contract prefetch: fails the node by credential name, dispatches no model, and stops the run", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startAt(store, "contract_intelligence", "openai");

    await runNextNode(runId, { executionRepository: store }).catch(() => undefined);
    const run = (await getRun(runId, store))!;
    const state = run.nodes.find((node) => node.nodeId === "contract_intelligence")!;

    expect(state.status).toBe("failed");
    expect(state.errors?.[0]).toBe(`${CLIENT_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`);
    expect(run.status).toBe("failed");
    expect(run.errors).toContain(`contract_intelligence:${CLIENT_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`);

    // The shape this whole task exists to eliminate: NOT completed, and no empty-but-schema-valid
    // artifact carrying blockers[].
    expect(run.artifacts.some((artifact) => artifact.nodeId === "contract_intelligence")).toBe(false);
    expect(run.stageOutputs.contract_intelligence).toBeUndefined();

    // Nothing was spent. No model ran, so no usage was recorded, and the only client traffic was the
    // single refused read.
    expect(dispatched).toEqual([]);
    expect(await repositoryManager.getUsageRepository().list({ runId })).toEqual([]);
    expect(remoteFetch).toHaveBeenCalledTimes(1);

    // Downstream never dispatches: the run is terminal, so a further advance changes nothing.
    await runNextNode(runId, { executionRepository: store }).catch(() => undefined);
    const after = (await getRun(runId, store))!;
    expect(after.nodes.filter((node) => node.status === "completed").map((node) => node.nodeId)).toEqual(
      run.nodes.filter((node) => node.status === "completed").map((node) => node.nodeId)
    );
    expect(dispatched).toEqual([]);
  });

  it("client validation: an unjudged body fails the node instead of completing with a blocker", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startAt(store, "article_body", "openai");

    await runNextNode(runId, { executionRepository: store }).catch(() => undefined);
    const run = (await getRun(runId, store))!;
    const state = run.nodes.find((node) => node.nodeId === "article_body")!;

    expect(state.status).toBe("failed");
    expect(state.errors?.[0]).toBe(`${CLIENT_AUTH_FAILED_PREFIX}DR_LURIE_MCP_TOKEN`);
    expect(run.status).toBe("failed");
    // The body the model produced is NOT carried forward as a stage output: publish_payload reusing a
    // recorded verdict that never happened is how "validated" became a fiction downstream.
    expect(run.stageOutputs.article_body).toBeUndefined();
  });

  it("a mock run is untouched: the refusal cannot reach it and nothing fails", async () => {
    const store = new RepositoryManager().getExecutionRepository();
    const runId = await startAt(store, "contract_intelligence", "mock");

    await runNextNode(runId, { executionRepository: store }).catch(() => undefined);
    const run = (await getRun(runId, store))!;

    expect(run.errors.some((entry) => entry.includes(CLIENT_AUTH_FAILED_PREFIX))).toBe(false);
    expect(run.nodes.find((node) => node.errors?.[0]?.includes(CLIENT_AUTH_FAILED_PREFIX))).toBeUndefined();
  });
});
