import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T12.11 ACCEPTANCE: refusals are CATALOGUED error codes, each surfaced on the real MCP wire
// (rpcError.data.error.code — the typed-envelope path every coded Error takes), and none of them
// mints a run:
//   duplicate_target_unreachable — unknown project / endpoint env unconfigured / initialize failing
//   capture_policy_denies        — the registry's deny-all default (and any non-authorizing policy)
//   capture_source_out_of_policy — a source outside the target's authorized origins
//   netlify_token_missing        — newSite genesis without the standing NETLIFY_API_TOKEN
//   budget_exceeded              — a budgetUsd no first node could ever dispatch under

const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const TARGET_ENDPOINT = "https://refusal-target.example/mcp";

type RpcRequest = { id: number; method: string };

const mcpCall = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const parsed = JSON.parse(response.body);
  return { rpcError: parsed.error, structured: parsed.result?.structuredContent };
};

const authorizedPolicy = {
  maxPages: 5,
  allowedCrawlOrigins: ["https://www.zilbermanfilmfoundation.com"],
  allowedPathPrefixes: ["/"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 0,
  authenticatedAccess: "prohibited",
  rights: { content: "retain_allowed_origin_content", media: "prohibited" },
  designReferences: [],
  fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
};

const registerTarget = async (projectId: string, overrides: Record<string, unknown> = {}) =>
  createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId,
      name: `Refusal case ${projectId}`,
      mcpEndpointEnvVar: "REFUSAL_TARGET_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed",
      ...overrides
    })
  );

const runCount = async () => (await repositoryManager.getExecutionRepository().listRuns({})).length;

describe("site.duplicate — catalogued refusals", () => {
  beforeEach(() => {
    resetRepositoryManager();
    process.env.MCP_API_TOKEN = "test-token";
    process.env.REFUSAL_TARGET_MCP_ENDPOINT = TARGET_ENDPOINT;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body?: string }) => {
      const request = JSON.parse(init.body ?? "{}") as RpcRequest;
      // A healthy target: initialize (and anything else) answers 200 with a result.
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: {} }) } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCP_API_TOKEN;
    delete process.env.REFUSAL_TARGET_MCP_ENDPOINT;
    delete process.env.NETLIFY_API_TOKEN;
    resetRepositoryManager();
  });

  it("unknown target project → duplicate_target_unreachable, no run minted", async () => {
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: "no-such-project" });
    expect(rpcError.data.error.code).toBe("duplicate_target_unreachable");
    expect(rpcError.data.error.message).toContain("no-such-project");
    expect(await runCount()).toBe(0);
  });

  it("endpoint env unconfigured → duplicate_target_unreachable naming the env var", async () => {
    delete process.env.REFUSAL_TARGET_MCP_ENDPOINT;
    await registerTarget("refusal-unconfigured", { capturePolicy: authorizedPolicy });
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: "refusal-unconfigured" });
    expect(rpcError.data.error.code).toBe("duplicate_target_unreachable");
    expect(rpcError.data.error.message).toContain("REFUSAL_TARGET_MCP_ENDPOINT");
    expect(await runCount()).toBe(0);
  });

  it("target MCP initialize failing → duplicate_target_unreachable", async () => {
    await registerTarget("refusal-down", { capturePolicy: authorizedPolicy });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: "refusal-down" });
    expect(rpcError.data.error.code).toBe("duplicate_target_unreachable");
    expect(await runCount()).toBe(0);
  });

  it("deny-all default capture policy → capture_policy_denies (reachable is not authorized)", async () => {
    // No capturePolicy supplied: the registry's fail-closed default (maxPages 0, no origins).
    await registerTarget("refusal-deny-all");
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: "refusal-deny-all" });
    expect(rpcError.data.error.code).toBe("capture_policy_denies");
    expect(await runCount()).toBe(0);
  });

  it("source outside the authorized origins → capture_source_out_of_policy", async () => {
    await registerTarget("refusal-out-of-policy", { capturePolicy: authorizedPolicy });
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: "https://somewhere-else.example/", targetProjectId: "refusal-out-of-policy" });
    expect(rpcError.data.error.code).toBe("capture_source_out_of_policy");
    expect(await runCount()).toBe(0);
  });

  it("newSite without NETLIFY_API_TOKEN → netlify_token_missing (the standing prerequisite)", async () => {
    delete process.env.NETLIFY_API_TOKEN;
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, newSite: { name: "acme" } });
    expect(rpcError.data.error.code).toBe("netlify_token_missing");
    expect(rpcError.data.error.message).toContain("NETLIFY_API_TOKEN");
    // Nothing was registered and nothing ran.
    expect(await repositoryManager.getProjectRepository().get("acme")).toBeUndefined();
    expect(await runCount()).toBe(0);
  });

  it("budgetUsd below the entry-node reservation → budget_exceeded, no run minted", async () => {
    await registerTarget("refusal-budget", { capturePolicy: authorizedPolicy });
    const { rpcError } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: "refusal-budget", budgetUsd: 0.01 });
    expect(rpcError.data.error.code).toBe("budget_exceeded");
    expect(rpcError.data.error.message).toContain("capture_crawl");
    expect(await runCount()).toBe(0);
  });

  it("both targetProjectId and newSite (or neither) → validation_error", async () => {
    const both = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: "x", newSite: { name: "y" } });
    expect(both.rpcError.data.error.code).toBe("validation_error");
    const neither = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL });
    expect(neither.rpcError.data.error.code).toBe("validation_error");
  });

  it("site_duplicate_status for a nonexistent run → unknown_run", async () => {
    const { rpcError } = await mcpCall("site_duplicate_status", { runId: "run_does_not_exist" });
    expect(rpcError.data.error.code).toBe("unknown_run");
  });
});
