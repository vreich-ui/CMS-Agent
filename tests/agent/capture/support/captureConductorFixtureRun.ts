// T15.25 (#200) — a reusable, self-resetting driver for ONE fixture run of `capture_conductor`
// (mock execution mode) against the committed Zilberman snapshot, factored out of
// captureConductorMockRun.test.ts's beforeEach/it body (T12.9) so the determinism harness can call it
// twice in a row from a clean process each time and diff what came back.
//
// This changes NO production behaviour: it is the same mock transport shape that test already proves
// correct, wrapped as a function instead of inlined into one `it`. captureConductorMockRun.test.ts is
// untouched — this is new, additional test-support code.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { getRun, runNextNode, startDryRun } from "../../../../src/agent/workspace/executor.js";
import { HALTED_EXECUTION_STATUSES } from "../../../../src/agent/workspace/executionTypes.js";
import { repositoryManager, resetRepositoryManager } from "../../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../../src/agent/projects/projectAdmin.js";

const TARGET = "zilberman-capture-determinism";
const TARGET_ENDPOINT = "https://zilberman-capture-determinism.example/mcp";
const PDF_TOOL_ENDPOINT = "https://pdf-tool-determinism.example/mcp";
const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const JOB_ID = "capture_job_zb_determinism";
const SITE_OBJECT_ID = "site_zb";

const fixturePath = fileURLToPath(new URL("../../../fixtures/capture/zilberman.snapshot.v1.redacted.json", import.meta.url));

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

const respondRaw = (id: number, structuredContent: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent } }) }) as unknown as Response;

/**
 * Drives capture_conductor to completion once, mock mode, against the fixture snapshot. Every
 * external side effect (env vars, global fetch stub, the project repository) is set up fresh and torn
 * down before this resolves, so calling it twice in a row from the same test yields two independently
 * produced runs — exactly "the same URL twice".
 */
export async function runCaptureFixtureOnce(): Promise<{ run: Awaited<ReturnType<typeof startDryRun>>; persistedRun: unknown }> {
  resetRepositoryManager();
  const snapshot = JSON.parse(await readFile(fixturePath, "utf8"));
  let jobPolls = 0;

  process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
  process.env.PDF_TOOL_MCP_TOKEN = "pdf-tool-test-token";
  process.env.ZILBERMAN_CAPTURE_DETERMINISM_MCP_ENDPOINT = TARGET_ENDPOINT;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      if (String(url).startsWith(PDF_TOOL_ENDPOINT)) {
        throw new Error(`pdf-tool must not be called directly by the capture plane: ${name}`);
      }
      if (String(url).startsWith(TARGET_ENDPOINT)) {
        if (name === "create_capture_job") {
          return respond(request.id, { jobId: JOB_ID, status: "pending", siteId: args.site_id, effective_max_pages: 20 });
        }
        if (name === "get_capture_job_status") {
          jobPolls += 1;
          if (jobPolls < 2) return respond(request.id, { jobId: JOB_ID, status: "running" });
          return respond(request.id, {
            jobId: JOB_ID,
            status: "complete",
            result: { snapshotArtifact: { blobKey: `binary/capture_x/${"a".repeat(64)}.json`, sha256: "a".repeat(64), sizeBytes: 4096 }, capturedPages: 1 }
          });
        }
        if (name === "get_capture_snapshot") {
          return respond(request.id, { jobId: JOB_ID, schemaVersion: "snapshot.v1", snapshot });
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
        if (name === "object_checkout") return respondRaw(request.id, { lockToken: `lock_${args.object_id}` });
        // T15.25: a FIXED publish timestamp (not Date.now()) — a live target would return wall-clock
        // truth here, which is exactly why publishedAt/published_time is a documented, allowlisted
        // divergence below rather than something this harness claims to have checked. Fixing it in the
        // mock makes this stub's two runs agree trivially; it does not make the field governed.
        if (name === "object_publish") return respondRaw(request.id, { published: true, published_time: "2026-08-25T00:00:00.000Z", receipt: { commit_sha: "deadbeef" } });
        if (name === "object_checkin") return respondRaw(request.id, { released: true });
        if (name === "release_to_production") return respondRaw(request.id, { released: true, productionConfirmed: true, deployStatus: "ready", targetCommit: "deadbeef" });
        throw new Error(`Unexpected target verb: ${name}`);
      }
      throw new Error(`Unexpected endpoint: ${url}`);
    })
  );

  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: TARGET,
      name: "Zilberman capture determinism target",
      mcpEndpointEnvVar: "ZILBERMAN_CAPTURE_DETERMINISM_MCP_ENDPOINT",
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

  const store = repositoryManager.getExecutionRepository();
  let run = await startDryRun({ projectId: TARGET, workflowId: "capture_conductor", executionMode: "mock", input: { sourceUrl: SOURCE_URL, targetProjectId: TARGET } }, store);
  for (let step = 0; step < 60 && !HALTED_EXECUTION_STATUSES.has(run.status); step += 1) {
    run = await runNextNode(run.runId, { executionRepository: store });
  }
  if (run.status !== "completed") {
    throw new Error(`Fixture run did not complete (status=${run.status}); the determinism harness needs a real run to diff.`);
  }
  const persistedRun = await getRun(run.runId, store);

  vi.unstubAllGlobals();
  delete process.env.PDF_TOOL_MCP_ENDPOINT;
  delete process.env.PDF_TOOL_MCP_TOKEN;
  delete process.env.ZILBERMAN_CAPTURE_DETERMINISM_MCP_ENDPOINT;
  resetRepositoryManager();

  return { run, persistedRun };
}
