import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { runContinuationTick } from "../../../src/agent/workspace/runContinuation.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { CAPTURE_AI_NODE_IDS } from "../../../src/agent/workspace/captureConductorNodes.js";
import { SITE_DUPLICATION_REQUEST_STAGE_KEY } from "../../../src/agent/mcp/workspace/siteDuplicationTools.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T12.11 ACCEPTANCE (existing-target half): ONE MCP call — tools/call site_duplicate — against an
// EXISTING registered project drives sourceUrl → scored never-released drafts END TO END on the
// T12.9 fixture. The call itself performs target verification (reachability + capture authority),
// starts the capture_conductor run, and KICKS the long-run plane: the pdf-tool capture job is
// created inside the one call, and the tool parks the run the moment an advance makes no forward
// progress (the crawl pending) — polling inside a tool window is the exact thing R-C3 forbids.
// From there the PRODUCTION long-run plane code (runContinuationTick — the scheduled tick, not an
// MCP call) re-drives the run to the terminal report. No second MCP round-trip exists anywhere in
// the start+run path; site_duplicate_status (read-only observation) then reflects the final state.
//
// Harness: T12.9's mock harness, extended — pdf-tool job plane + target MCP mocked at the fetch
// boundary, model in "mock" execution mode, every deterministic stage running REAL vendored engine
// code against the redacted Zilberman snapshot fixture.

const TARGET = "zilberman-capture";
const TARGET_ENDPOINT = "https://zilberman-capture.example/mcp";
const PDF_TOOL_ENDPOINT = "https://pdf-tool.example/mcp";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const JOB_ID = "capture_job_zb_0001";

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

describe("site.duplicate — one call against an existing project (fixture end-to-end)", () => {
  let snapshot: Record<string, unknown>;
  let jobPolls: number;
  let createdJobs: Array<Record<string, unknown>>;
  let targetVerbs: string[];

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

  beforeEach(async () => {
    resetRepositoryManager();
    snapshot = JSON.parse(await readFile(fixturePath, "utf8"));
    jobPolls = 0;
    createdJobs = [];
    targetVerbs = [];
    process.env.MCP_API_TOKEN = "test-token";
    process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
    process.env.PDF_TOOL_MCP_TOKEN = "pdf-tool-test-token";
    process.env.ZILBERMAN_CAPTURE_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (String(url).startsWith(PDF_TOOL_ENDPOINT)) {
        // T12.13: capture reaches the plane only through the target's own bridge, never pdf-tool.
        throw new Error(`pdf-tool must not be called directly by the capture plane: ${name}`);
      }
      if (String(url).startsWith(TARGET_ENDPOINT)) {
        targetVerbs.push(name);
        // T12.13: the target's capture bridge — no credential in, snapshot read back through it.
        if (name === "create_capture_job") {
          createdJobs.push(args);
          return respond(request.id, { jobId: JOB_ID, status: "pending" });
        }
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
        if (name === "object_create") {
          return respond(request.id, { record: { object_id: String(args.requested_id ?? "obj_minted"), publication: { published_time: null } } });
        }
        throw new Error(`Unexpected target verb: ${name}`);
      }
      throw new Error(`Unexpected endpoint: ${url}`);
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

  it("one MCP call starts + kicks the run; the long-run plane finishes URL → scored drafts", async () => {
    // ═══ THE ONE CALL ═══
    const { rpcError, structured } = await mcpCall("site_duplicate", {
      sourceUrl: SOURCE_URL,
      targetProjectId: TARGET,
      executionMode: "mock"
    });
    expect(rpcError).toBeUndefined();
    expect(structured.ok).toBe(true);
    const result = structured.data as {
      runId: string;
      statusTool: string;
      humanChecklist: unknown[];
      run: { status: string; workflowId: string; projectId: string };
      kick: { steps: number; stoppedBecause: string };
    };
    expect(result.runId).toBeTruthy();
    expect(result.statusTool).toBe("site.duplicate_status");
    // Existing reachable target: nothing is human-required to observe or unblock this run.
    expect(result.humanChecklist).toEqual([]);
    expect(result.run.workflowId).toBe("capture_conductor");
    expect(result.run.projectId).toBe(TARGET);

    // THE KICK happened INSIDE the one call: the pdf-tool capture job exists (created with the
    // REGISTRY policy — both-sides enforcement), and the tool parked the run at the first
    // no-progress advance instead of polling inside its own request window.
    expect(createdJobs).toHaveLength(1);
    expect((createdJobs[0].policy as Record<string, unknown>).maxPages).toBe(20);
    expect(result.kick.stoppedBecause).toBe("handed_to_long_run_plane");
    expect(HALTED_EXECUTION_STATUSES.has(result.run.status as never)).toBe(false);

    // ═══ THE LONG-RUN PLANE (production code, NOT an MCP call) ═══ — the scheduled
    // run-continuation tick re-drives the parked run to its terminal state.
    const executionRepository = repositoryManager.getExecutionRepository();
    let run = (await executionRepository.getRun(result.runId))!;
    for (let tick = 0; tick < 5 && !HALTED_EXECUTION_STATUSES.has(run.status); tick += 1) {
      await runContinuationTick({ executionRepository });
      run = (await executionRepository.getRun(result.runId))!;
    }
    expect(run.status).toBe("completed");

    // The crawl was re-driven across dispatches (create → pending poll → terminal poll).
    const crawl = run.nodes.find((node) => node.nodeId === "capture_crawl")!;
    expect(crawl.status).toBe("completed");
    expect((crawl.warnings ?? []).filter((warning) => warning === `capture_crawl_pending:${JOB_ID}`)).toHaveLength(2);
    expect(jobPolls).toBe(2);

    // VALIDATE-CLEAN DRAFTS, scored + reported — the T12.9 acceptance shape, reached from ONE call.
    const emission = run.stageOutputs.capture_emit_live as { artifact: string; report: { createdObjects: Array<{ draftVerified: boolean }>; validationStates: Array<{ valid: boolean }>; quarantines: unknown[]; assetBindings: unknown[]; assetGaps: Array<{ why: string }>; mediaPolicy?: { mediaRetention: string; materialized: number; declined: number } } };
    expect(emission.artifact).toBe("capture_emission_run.v1");
    expect(emission.report.createdObjects.length).toBeGreaterThan(0);
    expect(emission.report.createdObjects.every((object) => object.draftVerified === true)).toBe(true);
    expect(emission.report.validationStates.every((state) => state.valid === true)).toBe(true);
    // T12.14: the ONLY quarantine permitted here is the recorded media-rights one.
    // This fixture's project policy sets rights.media = "prohibited", so the
    // repeated-media section_template recipe cannot bind a first-party artifact and
    // is quarantined rather than shipped with an empty gallery — and every planned
    // asset section is a recorded gap, never a hotlink and never a coerced field.
    // TWO now, not one: T12.31's `composition` gives repeated mixed-content shapes a type of their
    // own, so a second recipe has an asset-bearing blueprint that cannot bind in this fixture (no
    // artifact bridge is wired here). Recipes group by shape fingerprint (T12.23), so this counts
    // distinct SHAPES, not occurrences. What matters is unchanged: an unbindable recipe is
    // quarantined whole rather than shipped with an empty gallery.
    expect(emission.report.quarantines).toEqual([
      { objectType: "section_template", reason: "asset_binding_unresolved", requestedId: expect.stringMatching(/^stpl_capture_/) },
      { objectType: "section_template", reason: "asset_binding_unresolved", requestedId: expect.stringMatching(/^stpl_capture_/) }
    ]);
    expect(emission.report.assetBindings).toEqual([]);
    expect(emission.report.assetGaps.length).toBeGreaterThan(0);
    expect(emission.report.assetGaps.every((gap) => gap.why === "asset_binding_unresolved")).toBe(true);
    expect(emission.report.mediaPolicy?.mediaRetention).toBe("prohibited");
    expect(emission.report.mediaPolicy?.materialized).toBe(0);
    for (const verb of targetVerbs) {
      // T14.5 — object_checkout/object_publish/object_checkin/release_to_production join the set
      // because capture now publishes. trigger_netlify_build and deploy are deliberately ABSENT and
      // must stay absent: this list is the contract for what a capture run may touch on a live site.
      expect([
        "create_capture_job", "get_capture_job_status", "get_capture_snapshot",
        "object_inventory", "object_contract", "object_validate", "object_create", "object_get",
        "object_checkout", "object_publish", "object_checkin", "release_to_production"
      ]).toContain(verb);
    }
    const report = run.stageOutputs.capture_report as { artifact: string; publication: { attempted: boolean } };
    expect(report.artifact).toBe("capture_run_report.v1");
    // T14.5 — the fixture now runs the publish tail end to end: the report states what went live
    // rather than asserting publication is unreachable. Every object the emission wrote is either
    // published or named in `withheld`; neither list may be silently short.
    expect(report.publication.attempted).toBe(true);

    // The duplication request record was persisted on the run before any advance.
    const request = run.stageOutputs[SITE_DUPLICATION_REQUEST_STAGE_KEY] as { artifact: string; sourceUrl: string };
    expect(request.artifact).toBe("site_duplication.v1");
    expect(request.sourceUrl).toBe(SOURCE_URL);

    // Spend law unchanged: usage exists only for the AI nodes that dispatched; actual spend zero.
    const usageRecords = await repositoryManager.getUsageRepository().list({ runId: result.runId });
    for (const record of usageRecords) {
      expect(CAPTURE_AI_NODE_IDS as readonly string[]).toContain(record.nodeId ?? "");
      expect(record.status).toBe("estimated");
    }

    // ═══ OBSERVATION ═══ site_duplicate_status reflects the terminal state + report refs.
    const status = await mcpCall("site_duplicate_status", { runId: result.runId });
    expect(status.rpcError).toBeUndefined();
    const statusData = status.structured.data as {
      state: { status: string };
      reports: Record<string, { present: boolean }>;
      spend: { ledger: { totalCostUsdEstimate: number } };
      outstandingHumanItems: unknown[];
    };
    expect(statusData.state.status).toBe("completed");
    expect(statusData.reports.drafts.present).toBe(true);
    expect(statusData.reports.fidelity.present).toBe(true);
    expect(statusData.reports.runReport.present).toBe(true);
    expect(statusData.spend.ledger.totalCostUsdEstimate).toBeGreaterThanOrEqual(0);
    expect(statusData.outstandingHumanItems).toEqual([]);
  }, 90_000);
});
