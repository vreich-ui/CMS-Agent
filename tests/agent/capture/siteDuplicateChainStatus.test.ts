import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { runContinuationTick } from "../../../src/agent/workspace/runContinuation.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { CLONE_CONDUCTOR_WORKFLOW_ID } from "../../../src/agent/workspace/cloneConductorWorkflow.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";

// T15.9 (#188) — ONE site.duplicate MCP call, driven ENTIRELY by the production long-run plane
// (runContinuationTick — never a second MCP call), yields a completed capture run AND a chained
// clone run, both observable through the SAME site.duplicate_status call — "URL in -> live site
// out" with no human ever issuing workflow.start_dry_run({workflowId:"clone_conductor", ...}).
// Reuses siteDuplicateOneCall.test.ts's exact fixture harness (T12.9/T12.11): only the project id
// and endpoint env var differ, so this test's capture half is proven correct by that file already —
// this one adds the chain.

const TARGET = "zilberman-chain-e2e";
const TARGET_ENDPOINT = "https://zilberman-chain-e2e.example/mcp";
const PDF_TOOL_ENDPOINT = "https://pdf-tool-chain-e2e.example/mcp";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const JOB_ID = "capture_job_zb_chain_e2e";

const fixturePath = fileURLToPath(new URL("../../fixtures/capture/zilberman.snapshot.v1.redacted.json", import.meta.url));

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const mcpCall = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const parsed = JSON.parse(response.body);
  return { rpcError: parsed.error, structured: parsed.result?.structuredContent };
};

describe("site.duplicate — chains clone_conductor end to end, observed through one site.duplicate_status", () => {
  let snapshot: Record<string, unknown>;
  let jobPolls: number;

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

  beforeEach(async () => {
    resetRepositoryManager();
    snapshot = JSON.parse(await readFile(fixturePath, "utf8"));
    jobPolls = 0;
    process.env.MCP_API_TOKEN = "test-token";
    process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
    process.env.PDF_TOOL_MCP_TOKEN = "pdf-tool-test-token";
    process.env.ZILBERMAN_CHAIN_E2E_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (String(url).startsWith(PDF_TOOL_ENDPOINT)) throw new Error(`pdf-tool must not be called directly: ${name}`);
      if (String(url).startsWith(TARGET_ENDPOINT)) {
        if (name === "create_capture_job") return respond(request.id, { jobId: JOB_ID, status: "pending" });
        if (name === "get_capture_job_status") {
          jobPolls += 1;
          if (jobPolls < 2) return respond(request.id, { jobId: JOB_ID, status: "running" });
          return respond(request.id, { jobId: JOB_ID, status: "complete", result: { snapshotArtifact: { blobKey: `binary/capture_x/${"a".repeat(64)}.json`, sha256: "a".repeat(64), sizeBytes: 4096 }, capturedPages: 1 } });
        }
        if (name === "get_capture_snapshot") return respond(request.id, { jobId: JOB_ID, schemaVersion: "snapshot.v1", snapshot });
        if (name === "object_inventory" && args.object_type === "site") {
          return respond(request.id, { objects: [{ object_type: "site", object_id: "site_zb", status: "active" }] });
        }
        if (name === "object_inventory") return respond(request.id, { objects: [] });
        if (name === "object_contract") return respond(request.id, { contract: { object_type: args.object_type, creation_policy: { agents: "open" } } });
        if (name === "object_validate") return respond(request.id, { summary: { eligible: true } });
        if (name === "object_create") return respond(request.id, { record: { object_id: String(args.requested_id ?? "obj_minted"), publication: { published_time: null } } });
        // T15.7's shared-tail verbs (capture) AND anything clone_intake/mint/theme_bind/restamp might
        // reach (registry_get, object_get, object_patch): every one of these is DELIBERATELY absent
        // here except the ones capture itself needs — a clone stage that reaches one it does not find
        // refuses cleanly (CloneRefusal/"threw") and falls through to a schema-valid mock placeholder
        // in mock execution mode, exactly as siteDuplicateChainClonePublishes.test.ts's withheld test
        // proves directly. This test is about the WIRING (does the chain fire, does status report
        // both runs), not about re-deriving a live clone publish from a full crawl fixture — that is
        // covered, with a controlled fixture, by siteDuplicateChainClonePublishes.test.ts.
        const structuredContentVerbs = ["object_checkout", "object_publish", "object_checkin", "release_to_production"];
        if (structuredContentVerbs.includes(name)) {
          return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: name === "object_checkout" ? { lockToken: `lock_${args.object_id}` } : name === "object_publish" ? { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } } : name === "release_to_production" ? { released: true, productionConfirmed: true, deployStatus: "ready", targetCommit: "deadbeef" } : { released: true } } }) } as unknown as Response;
        }
        throw new Error(`Unexpected target verb: ${name}`);
      }
      throw new Error(`Unexpected endpoint: ${url}`);
    }));

    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Zilberman chain e2e target",
        mcpEndpointEnvVar: "ZILBERMAN_CHAIN_E2E_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed",
        capturePolicy: {
          maxPages: 20,
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
        }
      })
    );
    await updateProject(repositoryManager.getProjectRepository(), TARGET, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCP_API_TOKEN;
    delete process.env.PDF_TOOL_MCP_ENDPOINT;
    delete process.env.PDF_TOOL_MCP_TOKEN;
    delete process.env.ZILBERMAN_CHAIN_E2E_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("one call; ticks drive capture to completion, chain clone_conductor by captureRunId with no second human call, and site.duplicate_status reports both runs", async () => {
    const { rpcError, structured } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: TARGET, executionMode: "mock" });
    expect(rpcError).toBeUndefined();
    expect(structured.ok).toBe(true);
    const captureRunId = (structured.data as { runId: string }).runId;

    // No chain yet: capture is still parked (kicked in-call, handed to the long-run plane).
    const beforeChain = await mcpCall("site_duplicate_status", { runId: captureRunId });
    expect((beforeChain.structured.data as { chain: unknown }).chain).toBeNull();

    // THE LONG-RUN PLANE — production code, never a second MCP call — drives capture home and, on
    // the SAME tick it observes capture reach "completed", chains clone_conductor.
    const executionRepository = repositoryManager.getExecutionRepository();
    let capture = (await executionRepository.getRun(captureRunId))!;
    let cloneRunId: string | undefined;
    for (let tick = 0; tick < 10 && (!HALTED_EXECUTION_STATUSES.has(capture.status) || !cloneRunId); tick += 1) {
      await runContinuationTick({ executionRepository });
      capture = (await executionRepository.getRun(captureRunId))!;
      const clones = await executionRepository.listRuns({ workflowId: CLONE_CONDUCTOR_WORKFLOW_ID, projectId: TARGET });
      if (clones.length > 0) cloneRunId = clones[0].runId;
    }

    expect(capture.status).toBe("completed");
    expect(cloneRunId).toBeTruthy();

    // ONE site.duplicate_status call reports BOTH runs — ids, stage progress, terminal states — as
    // one duplication.
    const status = await mcpCall("site_duplicate_status", { runId: captureRunId });
    const statusData = status.structured.data as {
      state: { status: string };
      chain: { status: string; cloneRunId: string; clone: { runId: string; workflowId: string; status: string; nodes: unknown[] } | null } | null;
    };
    expect(statusData.state.status).toBe("completed");
    expect(statusData.chain).not.toBeNull();
    expect(statusData.chain!.status).toBe("started");
    expect(statusData.chain!.cloneRunId).toBe(cloneRunId);
    expect(statusData.chain!.cloneRunId).not.toBe(captureRunId);
    expect(statusData.chain!.clone?.runId).toBe(cloneRunId);
    expect(statusData.chain!.clone?.workflowId).toBe(CLONE_CONDUCTOR_WORKFLOW_ID);
    expect(Array.isArray(statusData.chain!.clone?.nodes)).toBe(true);
    expect((statusData.chain!.clone!.nodes as unknown[]).length).toBeGreaterThan(0);
  }, 90_000);
});
