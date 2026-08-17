import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRun, runNextNode, startDryRun } from "../../../src/agent/workspace/executor.js";
import { HALTED_EXECUTION_STATUSES } from "../../../src/agent/workspace/executionTypes.js";
import { CAPTURE_AI_NODE_IDS } from "../../../src/agent/workspace/captureConductorNodes.js";
import { CAPTURE_CRAWL_JOB_STAGE_KEY } from "../../../src/agent/workspace/captureConductorRoutes.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";
import { summarizeModelUsage } from "../../../src/agent/observability/modelUsage.js";

// T12.9 ACCEPTANCE (mock-mode half): a fixture run END TO END through the real executor —
// workflow.start_dry_run({workflowId:"capture_conductor"}) + the run_next_node advance loop — with
// the pdf-tool job plane and the target project's MCP both MOCKED at the fetch boundary (the same
// boundary contractPrefetchIntegration mocks) and model calls in "mock" execution mode. Every
// deterministic stage runs REAL vendored engine code; the run must end COMPLETED with
// validate-clean drafts + reports, the crawl must be re-driven across advances (never awaited
// inside one dispatch), and usage accounting must show zero model spend outside the three AI nodes.
//
// The LIVE half of this criterion — the same flow against the DEPLOYED T12.8 plane and real model
// calls — is explicitly pending (T12.8 is a parallel lane, not deployed) and is recorded as such.

const TARGET = "zilberman-capture";
const TARGET_ENDPOINT = "https://zilberman-capture.example/mcp";
const PDF_TOOL_ENDPOINT = "https://pdf-tool.example/mcp";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const JOB_ID = "capture_job_zb_0001";
const SITE_OBJECT_ID = "site_zb";
// T12.13: the capture plane is reached ONLY through the TARGET's own capture bridge, and carries no
// credential — pdf-tool writes its own store (Wolf, 2026-08-14, "option A, same-site writes"). This
// harness therefore serves the three capture tools from the TARGET endpoint, REFUSES a call that
// arrives carrying a `storage` argument (the bridge has no use for one and accepting it silently is
// how the T12.9 dead end survived a green suite), and the pdf-tool endpoint answers NOTHING at all —
// so a regression that calls pdf-tool directly fails loudly here.
//
// The credential-shaped values below are what the harness asserts NEVER appear in a persisted run: the
// bridge echoes them back deliberately, and nothing may carry them through.
const ECHOED_TOKEN = "nfp_mock_run_radioactive_token";
const ECHOED_SITE_ID = "site-api-id-zilberman";

const fixturePath = fileURLToPath(new URL("../../fixtures/capture/zilberman.snapshot.v1.redacted.json", import.meta.url));

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("capture_conductor fixture run end-to-end (mock mode)", () => {
  let snapshot: Record<string, unknown>;
  let jobPolls: number;
  let createdJobs: Array<Record<string, unknown>>;
  let polledJobs: Array<Record<string, unknown>>;
  let snapshotReads: Array<Record<string, unknown>>;
  let targetVerbs: string[];

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

  // The real bridge's shape: it mints nothing and accepts no credential, so a call that arrives with a
  // `storage` / `grant` / `token` argument is a defect and is refused here rather than tolerated.
  const refuseCredential = (id: number, args: Record<string, unknown>): Response | undefined => {
    const offending = ["storage", "grant", "token", "projectId", "requestId"].filter((key) => args[key] !== undefined);
    if (offending.length === 0) return undefined;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "CAPTURE_BRIDGE_ARGUMENT_REFUSED" }], structuredContent: { error: `the capture bridge accepts no ${offending.join("/")} argument: it resolves the project and request scope server-side and needs no credential`, errorCode: "CAPTURE_BRIDGE_ARGUMENT_REFUSED" } } })
    } as unknown as Response;
  };
  // Credential-shaped noise the bridge echoes back on every capture answer, so the run-record
  // assertions below are proving something real.
  const echoed = { storage: { siteId: ECHOED_SITE_ID, token: ECHOED_TOKEN }, token: ECHOED_TOKEN };

  beforeEach(async () => {
    resetRepositoryManager();
    snapshot = JSON.parse(await readFile(fixturePath, "utf8"));
    jobPolls = 0;
    createdJobs = [];
    polledJobs = [];
    snapshotReads = [];
    targetVerbs = [];
    process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
    process.env.PDF_TOOL_MCP_TOKEN = "pdf-tool-test-token";
    process.env.ZILBERMAN_CAPTURE_MCP_ENDPOINT = TARGET_ENDPOINT;

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (String(url).startsWith(PDF_TOOL_ENDPOINT)) {
        // T12.13: capture never calls pdf-tool directly again. Any call here is a regression.
        throw new Error(`pdf-tool must not be called directly by the capture plane: ${name}`);
      }
      if (String(url).startsWith(TARGET_ENDPOINT)) {
        targetVerbs.push(name);
        if (name === "create_capture_job") {
          const refusal = refuseCredential(request.id, args);
          if (refusal) return refusal;
          createdJobs.push(args);
          return respond(request.id, { jobId: JOB_ID, status: "pending", siteId: args.site_id, effective_max_pages: 20, ...echoed });
        }
        if (name === "get_capture_job_status") {
          const refusal = refuseCredential(request.id, args);
          if (refusal) return refusal;
          polledJobs.push(args);
          jobPolls += 1;
          // First poll: still running (the long-run plane must re-drive the node). Second: terminal —
          // and a terminal status carries the snapshot ARTIFACT REFERENCE, never the document.
          if (jobPolls < 2) return respond(request.id, { jobId: JOB_ID, status: "running", ...echoed });
          return respond(request.id, {
            jobId: JOB_ID,
            status: "complete",
            result: { snapshotArtifact: { blobKey: `binary/capture_x/${"a".repeat(64)}.json`, sha256: "a".repeat(64), sizeBytes: 4096 }, capturedPages: 1 },
            ...echoed
          });
        }
        if (name === "get_capture_snapshot") {
          const refusal = refuseCredential(request.id, args);
          if (refusal) return refusal;
          snapshotReads.push(args);
          return respond(request.id, { jobId: JOB_ID, schemaVersion: "snapshot.v1", snapshot, ...echoed });
        }
        if (name === "object_inventory" && args.object_type === "site") {
          return respond(request.id, { objects: [{ object_type: "site", object_id: SITE_OBJECT_ID, status: "active" }] });
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
          // Content retained (so copy_regenerator is deterministically SKIPPED); media prohibited
          // (so no asset probes leave this test).
          rights: { content: "retain_allowed_origin_content", media: "prohibited" },
          designReferences: [],
          fidelity: { mode: "design_inspired", sourceDesignTreatment: "source_content_with_design_inspiration_only" }
        }
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PDF_TOOL_MCP_ENDPOINT;
    delete process.env.PDF_TOOL_MCP_TOKEN;
    delete process.env.ZILBERMAN_CAPTURE_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  it("drives sourceUrl -> scored draft clone with zero model spend outside the three AI nodes", async () => {
    const store = repositoryManager.getExecutionRepository();
    const started = await startDryRun(
      { projectId: TARGET, workflowId: "capture_conductor", executionMode: "mock", input: { sourceUrl: SOURCE_URL, targetProjectId: TARGET } },
      store
    );
    expect(started.workflowId).toBe("capture_conductor");
    expect(started.nodes.map((node) => node.nodeId)).toContain("capture_crawl");

    let run = started;
    for (let step = 0; step < 60 && !HALTED_EXECUTION_STATUSES.has(run.status); step += 1) {
      run = await runNextNode(run.runId, { executionRepository: store });
    }
    expect(run.status).toBe("completed");

    // THE LONG-RUN CONTRACT: one create-or-poll per dispatch, re-queued between them — the crawl
    // node was re-driven across advances, never awaited inside one dispatch window.
    const crawl = run.nodes.find((node) => node.nodeId === "capture_crawl")!;
    expect(crawl.status).toBe("completed");
    const pendingWarnings = (crawl.warnings ?? []).filter((warning) => warning === `capture_crawl_pending:${JOB_ID}`);
    expect(pendingWarnings.length).toBe(2); // once after create, once after the non-terminal poll
    expect(jobPolls).toBe(2);
    expect(createdJobs).toHaveLength(1);
    // The job carries the REGISTRY policy (both-sides enforcement), not caller-shaped bounds.
    expect((createdJobs[0].policy as Record<string, unknown>).maxPages).toBe(20);
    expect((run.stageOutputs[CAPTURE_CRAWL_JOB_STAGE_KEY] as Record<string, unknown>).jobId).toBe(JOB_ID);

    // T12.13 — THE PER-SITE PAT IS GONE: every capture call went to the TARGET's own bridge (the
    // pdf-tool endpoint throws if touched) and carried NO credential and no server-resolved scope
    // argument (the stub refuses one), so this whole run completed with nothing a per-site Netlify PAT
    // could have been needed for.
    for (const call of [...createdJobs, ...polledJobs, ...snapshotReads]) {
      for (const key of ["storage", "grant", "token", "descriptor", "projectId", "requestId"]) {
        expect(call[key]).toBeUndefined();
      }
    }
    expect(polledJobs).toHaveLength(2);
    // The snapshot came back through the bridge's read path, not inline off the status poll.
    expect(snapshotReads).toHaveLength(1);
    expect(snapshotReads[0].job_id).toBe(JOB_ID);

    // RADIOACTIVITY DISCIPLINE, KEPT: the bridge echoed credential-shaped fields on every answer and
    // NONE of them reached persisted run state (stage outputs, node records, warnings, errors) or any
    // stage artifact — the whole persisted run record is searched, not a sample.
    const persistedRun = JSON.stringify(await getRun(run.runId, store));
    expect(persistedRun).not.toContain(ECHOED_TOKEN);
    expect(persistedRun).not.toContain(ECHOED_SITE_ID);
    for (const [, output] of Object.entries(run.stageOutputs)) {
      expect(JSON.stringify(output)).not.toContain(ECHOED_TOKEN);
    }

    // Deterministic stages produced REAL engine artifacts (not mock placeholders).
    const crawlOut = run.stageOutputs.capture_crawl as Record<string, unknown>;
    expect(crawlOut.artifact).toBe("capture_snapshot.v1");
    const mapOut = run.stageOutputs.capture_map as { artifact: string; declinedBlocks: unknown[]; coverage: { relevantBlocks: number } };
    expect(mapOut.artifact).toBe("capture_map.v1");
    expect(mapOut.declinedBlocks.length).toBeGreaterThan(0);
    const refined = run.stageOutputs.capture_map_refine as { artifact: string; coverageDelta: { delta: number } };
    expect(refined.artifact).toBe("capture_map_refined.v1");
    // Mock classifier emits zero suggestions, so the refined mapping equals the baseline: the delta
    // is recorded and it is exactly zero. Raising it takes a REAL classifier (pending LIVE proof) or
    // the fixture classifier exercised by the gap-replay harness test.
    expect(refined.coverageDelta.delta).toBe(0);
    expect((run.stageOutputs.capture_theme as Record<string, unknown>).artifact).toBe("capture_theme.v1");
    expect((run.stageOutputs.capture_emit_dry as Record<string, unknown>).artifact).toBe("capture_emission_plan.v1");

    // copy_regenerator was deterministically SKIPPED (rights retain extracted copy) — $0, recorded.
    const regenerator = run.nodes.find((node) => node.nodeId === "copy_regenerator")!;
    expect(regenerator.status).toBe("skipped");
    expect((regenerator.skip?.predicate as { when?: string } | undefined)?.when).toBe("capture_rights_allow_extracted_copy");

    // block_classifier RAN (there were declined blocks) as a real (mock-runner) model dispatch.
    expect(run.nodes.find((node) => node.nodeId === "block_classifier")!.status).toBe("completed");

    // VALIDATE-CLEAN DRAFTS: live emission created drafts, all verified unpublished, every
    // validation clean, nothing quarantined — and no forbidden verb ever reached the wire.
    const emission = run.stageOutputs.capture_emit_live as { artifact: string; report: { createdObjects: Array<{ draftVerified: boolean }>; validationStates: Array<{ valid: boolean }>; quarantines: unknown[]; assetBindings: unknown[]; assetGaps: Array<{ why: string }>; mediaPolicy?: { mediaRetention: string; materialized: number; declined: number } } };
    expect(emission.artifact).toBe("capture_emission_run.v1");
    expect(emission.report.createdObjects.length).toBeGreaterThan(0);
    expect(emission.report.createdObjects.every((object) => object.draftVerified === true)).toBe(true);
    expect(emission.report.validationStates.length).toBeGreaterThan(0);
    expect(emission.report.validationStates.every((state) => state.valid === true)).toBe(true);
    // T12.14: the ONLY quarantine permitted here is the recorded media-rights one.
    // This fixture's project policy sets rights.media = "prohibited", so the
    // repeated-media section_template recipe cannot bind a first-party artifact and
    // is quarantined rather than shipped with an empty gallery — and every planned
    // asset section is a recorded gap, never a hotlink and never a coerced field.
    expect(emission.report.quarantines).toEqual([
      { objectType: "section_template", reason: "asset_binding_unresolved", requestedId: expect.stringMatching(/^stpl_capture_/) }
    ]);
    expect(emission.report.assetBindings).toEqual([]);
    expect(emission.report.assetGaps.length).toBeGreaterThan(0);
    expect(emission.report.assetGaps.every((gap) => gap.why === "asset_binding_unresolved")).toBe(true);
    expect(emission.report.mediaPolicy?.mediaRetention).toBe("prohibited");
    expect(emission.report.mediaPolicy?.materialized).toBe(0);
    for (const verb of targetVerbs) {
      expect(["create_capture_job", "get_capture_job_status", "get_capture_snapshot", "object_inventory", "object_contract", "object_validate", "object_create", "object_get"]).toContain(verb);
    }

    // Scored + reported: governed rubric verdict, gaps enumerated into the W10 evidence feed, and
    // the human gate stated on the terminal artifact.
    const fidelity = run.stageOutputs.capture_score as { artifact: string; rubric: { verdict: string; gapsEnumerated: { met: boolean } }; report: { gapReport: { entries: unknown[] } } };
    expect(fidelity.artifact).toBe("capture_fidelity.v1");
    expect(fidelity.rubric.gapsEnumerated.met).toBe(true);
    const report = run.stageOutputs.capture_report as { artifact: string; w10EvidenceFeed: unknown[]; humanGate: { publishReachable: boolean }; humanSummary: string };
    expect(report.artifact).toBe("capture_run_report.v1");
    expect(report.w10EvidenceFeed.length).toBe(fidelity.report.gapReport.entries.length);
    expect(report.w10EvidenceFeed.length).toBeGreaterThan(0);
    expect(report.humanGate.publishReachable).toBe(false);
    expect(report.humanSummary.length).toBeGreaterThan(0);

    // USAGE / SPEND ACCOUNTING: model usage exists ONLY for the AI nodes that actually dispatched
    // (block_classifier + gap_adjudicator here; copy_regenerator was skipped for $0), every record
    // is a mock-mode estimate, and ACTUAL spend is zero everywhere.
    const usageRecords = await repositoryManager.getUsageRepository().list({ runId: run.runId });
    expect(usageRecords.length).toBeGreaterThan(0);
    for (const record of usageRecords) {
      expect(CAPTURE_AI_NODE_IDS as readonly string[]).toContain(record.nodeId ?? "");
      expect(record.status).toBe("estimated");
    }
    const dispatchedAiNodes = new Set(usageRecords.map((record) => record.nodeId));
    expect([...dispatchedAiNodes].sort()).toEqual(["block_classifier", "gap_adjudicator"]);
    const summary = await summarizeModelUsage({ runId: run.runId });
    expect(summary.actualCostUsdEstimate).toBe(0);

    // The persisted record round-trips (a fresh read agrees).
    const persisted = await getRun(run.runId, store);
    expect(persisted?.status).toBe("completed");
  }, 60_000);
});
