import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { runNextNode, updateRunStatus } from "../../../src/agent/workspace/executor.js";
import { decideRunContinuation } from "../../../src/agent/workspace/runContinuation.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T12.11 ACCEPTANCE: site.duplicate_status reflects a REAL mid-run state. A duplication run is
// kicked by one site_duplicate call, advanced partway (crawl completed through the pdf-tool plane,
// downstream still queued), then PAUSED — and the status tool reports the paused state, the exact
// per-node progress (completed crawl with its two re-drive warnings, queued mapper), the spend
// ledger, and that no report exists yet. A paused run is also pinned as untouchable by the
// unattended continuation plane (skip_not_active) — pausing really stops the machine.

const TARGET = "zilberman-capture";
const TARGET_ENDPOINT = "https://zilberman-capture.example/mcp";
const PDF_TOOL_ENDPOINT = "https://pdf-tool.example/mcp";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const JOB_ID = "capture_job_midrun_0001";

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

describe("site.duplicate_status — a real mid-run (paused) state", () => {
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
    process.env.ZILBERMAN_CAPTURE_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      // T12.13: the capture plane is the TARGET's own capture bridge; no grant is fetched or sent.
      if (String(url).startsWith(TARGET_ENDPOINT)) {
        if (name === "create_capture_job") return respond(request.id, { jobId: JOB_ID, status: "pending" });
        if (name === "get_capture_job_status") {
          jobPolls += 1;
          if (jobPolls < 2) return respond(request.id, { jobId: JOB_ID, status: "running" });
          return respond(request.id, { jobId: JOB_ID, status: "complete", result: { snapshotArtifact: { blobKey: `binary/capture_x/${"a".repeat(64)}.json`, sha256: "a".repeat(64), sizeBytes: 4096 }, capturedPages: 1 } });
        }
        if (name === "get_capture_snapshot") return respond(request.id, { jobId: JOB_ID, schemaVersion: "snapshot.v1", snapshot });
      }
      throw new Error(`Unexpected endpoint/tool in mid-run test: ${url} ${name}`);
    }));

    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "Zilberman capture acceptance target",
        mcpEndpointEnvVar: "ZILBERMAN_CAPTURE_MCP_ENDPOINT",
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCP_API_TOKEN;
    delete process.env.PDF_TOOL_MCP_ENDPOINT;
    delete process.env.PDF_TOOL_MCP_TOKEN;
    delete process.env.ZILBERMAN_CAPTURE_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("reports paused status, per-node progress, spend, absent reports, and the tick honors the pause", async () => {
    const { structured } = await mcpCall("site_duplicate", { sourceUrl: SOURCE_URL, targetProjectId: TARGET, executionMode: "mock" });
    const runId = (structured.data as { runId: string }).runId;

    // Advance partway on the long-run plane's own entry point: two more polls complete the crawl,
    // one more advance completes the mapper. Downstream stays queued.
    const executionRepository = repositoryManager.getExecutionRepository();
    await runNextNode(runId, { executionRepository }); // poll 1 → still pending, re-queued
    await runNextNode(runId, { executionRepository }); // poll 2 → terminal, crawl completes
    await runNextNode(runId, { executionRepository }); // capture_map completes
    const paused = (await updateRunStatus(runId, "paused", executionRepository))!;
    expect(paused.status).toBe("paused");

    const { rpcError, structured: statusStructured } = await mcpCall("site_duplicate_status", { runId });
    expect(rpcError).toBeUndefined();
    const status = statusStructured.data as {
      state: { status: string; stall: unknown };
      nodes: Array<{ nodeId: string; status: string; warnings?: string[] }>;
      spend: { ledger: { totalCostUsdEstimate: number; budget?: unknown } };
      reports: Record<string, { present: boolean }>;
      humanGate: { publishReachable: boolean };
    };

    // Run state: really paused, mid-run.
    expect(status.state.status).toBe("paused");

    // Per-node progress: the crawl completed WITH its two re-drive warnings (the long-run contract
    // visible in the status), the mapper completed, everything downstream still queued.
    const nodeById = new Map(status.nodes.map((node) => [node.nodeId, node]));
    expect(nodeById.get("capture_crawl")!.status).toBe("completed");
    expect((nodeById.get("capture_crawl")!.warnings ?? []).filter((warning) => warning === `capture_crawl_pending:${JOB_ID}`)).toHaveLength(2);
    expect(nodeById.get("capture_map")!.status).toBe("completed");
    expect(nodeById.get("capture_theme")!.status).toBe("queued");
    expect(nodeById.get("capture_emit_live")!.status).toBe("queued");
    expect(nodeById.get("capture_report")!.status).toBe("queued");

    // Spend: a real ledger, zero actual spend (deterministic stages record no usage).
    expect(status.spend.ledger.totalCostUsdEstimate).toBe(0);

    // Reports: nothing downstream exists yet — present:false, never fabricated.
    expect(status.reports.emissionPlan.present).toBe(false);
    expect(status.reports.drafts.present).toBe(false);
    expect(status.reports.fidelity.present).toBe(false);
    expect(status.reports.runReport.present).toBe(false);

    // The human gate statement rides every status answer.
    expect(status.humanGate.publishReachable).toBe(false);

    // And the pause is REAL to the unattended plane: the continuation tick's verdict for this run
    // is skip_not_active — a stop an operator put there is never advanced by a schedule.
    const record = (await executionRepository.getRun(runId))!;
    const verdict = decideRunContinuation(record);
    expect(verdict.reenter).toBe(false);
    expect(verdict.code).toBe("skip_not_active");
  }, 60_000);
});
