import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  __test__ as captureInternals,
  captureCrawlStep,
  captureJobRequestId,
  redactStorageGrant,
  CaptureRefusal,
  CREATE_CAPTURE_JOB_TOOL,
  GET_CAPTURE_JOB_STATUS_TOOL,
  GET_STORAGE_GRANT_TOOL
} from "../../../src/agent/capture/captureEngine.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectCapturePolicy, ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// T12.9 fix — the LIVE defect this file exists for: captureCrawlStep called pdf-tool's
// create_capture_job / get_capture_job_status with NO `storage` argument, so pdf-tool refused every
// call (errorCode STORAGE_GRANT_REQUIRED — it holds no storage credentials of its own) and
// run_1786965304795_ifxxvk blocked at capture_crawl for $0. The grant is fetched FRESH from the
// TARGET project's own bridge per pdf-tool call and forwarded as `storage`; its token is radioactive
// and must never reach run state, an artifact, a warning, or an error string.

const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const TARGET_ENDPOINT = "https://zb-test.example/mcp";
const PDF_TOOL_ENDPOINT = "https://pdf-tool.example/mcp";
const JOB_ID = "capture_job_zb_0001";
// A token-shaped value that is unique enough that finding it anywhere is proof of a leak.
const GRANT_TOKEN = "nfp_radioactive_capture_token_do_not_persist";
const SITE_ID = "site-api-id-zb-1234";

const AUTHORIZED_POLICY: ProjectCapturePolicy = {
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
};

const projectConfig = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => ({
  projectId: "zb-test",
  name: "Zilberman capture test",
  mcpEndpointEnvVar: "ZB_TEST_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  defaultToolPolicy: "allowed",
  contentContract: { contentContract: "content_source.v1" },
  capturePolicy: structuredClone(AUTHORIZED_POLICY),
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
  status: "active",
  ...overrides
});

const pdfToolConfig = (overrides: Partial<ProjectConnectionConfig> = {}): ProjectConnectionConfig => ({
  projectId: "pdf-tool",
  name: "PDF Tool",
  mcpEndpointEnvVar: "PDF_TOOL_MCP_ENDPOINT",
  authMode: "none",
  allowedTools: [],
  toolPolicies: { create_capture_job: "allowed", get_capture_job_status: "allowed" },
  contentContract: { contentContract: "content_source.v1" },
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "test" },
  status: "active",
  ...overrides
});

const stubRepository = (...configs: ProjectConnectionConfig[]): ProjectRepository => ({
  list: async () => configs,
  get: async (projectId: string) => configs.find((config) => config.projectId === projectId),
  save: async (value) => value,
  delete: async () => false,
  health: async () => ({ backend: "memory", details: {} } as never)
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type Call = { url: string; tool: string; args: Record<string, unknown> };

const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

const respondError = (id: number, error: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error } })
  }) as unknown as Response;

const liveGrant = (overrides: Record<string, unknown> = {}) => ({
  grantVersion: 1,
  grantType: "netlify-pat",
  projectId: "zb-tenant",
  siteId: SITE_ID,
  token: GRANT_TOKEN,
  stores: { artifacts: "artifacts", artifactIndex: "artifact-index", templates: "pdf-templates", imageSearch: "image-search", renderData: "pdf-render-data", jobs: "pdf-tool-jobs" },
  limits: { maxImageBytes: 1_500_000, preferredImageFormat: "webp" },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...overrides
});

// The plane: the target project answers get_pdf_tool_storage_grant, pdf-tool answers the two capture
// tools. Every call is recorded so the forwarded arguments can be asserted exactly.
const stubPlane = (options: {
  grant?: Record<string, unknown> | "error";
  jobStatus?: (poll: number) => Record<string, unknown>;
} = {}) => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as RpcRequest;
    if (request.method !== "tools/call") return respond(request.id, {});
    const tool = request.params?.name ?? "";
    const args = request.params?.arguments ?? {};
    calls.push({ url: String(url), tool, args });
    if (String(url).startsWith(TARGET_ENDPOINT)) {
      if (tool !== GET_STORAGE_GRANT_TOOL) throw new Error(`Unexpected target tool: ${tool}`);
      if (options.grant === "error") return respondError(request.id, { error: "pdf-tool storage grants are not configured on this server.", error_code: "pdf_tool_storage_grant_not_configured" });
      return respond(request.id, options.grant ?? liveGrant());
    }
    if (String(url).startsWith(PDF_TOOL_ENDPOINT)) {
      if (tool === CREATE_CAPTURE_JOB_TOOL) return respond(request.id, { job: { jobId: JOB_ID, status: "pending" } });
      if (tool === GET_CAPTURE_JOB_STATUS_TOOL) {
        const polls = calls.filter((call) => call.tool === GET_CAPTURE_JOB_STATUS_TOOL).length;
        return respond(request.id, { job: options.jobStatus ? options.jobStatus(polls) : { jobId: JOB_ID, status: "running" } });
      }
      throw new Error(`Unexpected pdf-tool tool: ${tool}`);
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  }));
  return calls;
};

const jobState = () => ({ jobId: JOB_ID, status: "pending", attempts: 0, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" });

const deps = () => ({ projectRepository: stubRepository(projectConfig(), pdfToolConfig()) });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZB_TEST_MCP_ENDPOINT;
  delete process.env.PDF_TOOL_MCP_ENDPOINT;
});

const configureEndpoints = () => {
  process.env.ZB_TEST_MCP_ENDPOINT = TARGET_ENDPOINT;
  process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
};

describe("the pdf-tool capture plane is grant-gated on BOTH tools", () => {
  it("fetches the grant from the TARGET project and forwards it as `storage` on create_capture_job", async () => {
    configureEndpoints();
    const calls = stubPlane();
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps());
    expect(step.phase).toBe("pending");

    // The grant came from the TARGET project's own endpoint — never from pdf-tool, never from env.
    const grantCalls = calls.filter((call) => call.tool === GET_STORAGE_GRANT_TOOL);
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0].url.startsWith(TARGET_ENDPOINT)).toBe(true);

    const create = calls.find((call) => call.tool === CREATE_CAPTURE_JOB_TOOL)!;
    expect(create.url.startsWith(PDF_TOOL_ENDPOINT)).toBe(true);
    expect(create.args.storage).toMatchObject({ grantType: "netlify-pat", siteId: SITE_ID, token: GRANT_TOKEN });
    // No `descriptor`: pdf-tool's own contract says a grant alone is a complete call.
    expect(create.args.descriptor).toBeUndefined();
    // pdf-tool's create_capture_job schema is strict: projectId (from the grant, the authority on
    // which tenant's stores are opened) + requestId (its idempotency scope) + url + policy verbatim.
    expect(create.args.projectId).toBe("zb-tenant");
    expect(create.args.requestId).toBe(captureJobRequestId("zb-test", SOURCE_URL));
    expect(create.args.url).toBe(SOURCE_URL);
    expect(create.args.policy).toMatchObject({ maxPages: 20, rights: AUTHORIZED_POLICY.rights, fidelity: AUTHORIZED_POLICY.fidelity, designReferences: [] });
    expect(create.args.targetProjectId).toBeUndefined();
  });

  it("forwards a SEPARATE fresh grant as `storage` on get_capture_job_status", async () => {
    configureEndpoints();
    const calls = stubPlane();
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(step.phase).toBe("pending");

    const poll = calls.find((call) => call.tool === GET_CAPTURE_JOB_STATUS_TOOL)!;
    expect(poll.args.storage).toMatchObject({ siteId: SITE_ID, token: GRANT_TOKEN });
    expect(poll.args.projectId).toBe("zb-tenant");
    expect(poll.args.jobId).toBe(JOB_ID);
    // The grant was fetched for THIS call — the create-side grant is never cached across advances.
    expect(calls.map((call) => call.tool)).toEqual([GET_STORAGE_GRANT_TOOL, GET_CAPTURE_JOB_STATUS_TOOL]);
  });

  it("re-fetches a grant on every advance — one per pdf-tool call, never reused across nodes", async () => {
    configureEndpoints();
    const calls = stubPlane();
    await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps());
    await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(calls.filter((call) => call.tool === GET_STORAGE_GRANT_TOOL)).toHaveLength(3);
    expect(calls.filter((call) => call.url.startsWith(PDF_TOOL_ENDPOINT))).toHaveLength(3);
  });

  it("keeps the requestId stable so a re-driven create re-attaches instead of starting a parallel crawl", () => {
    expect(captureJobRequestId("zb-test", SOURCE_URL)).toBe(captureJobRequestId("zb-test", SOURCE_URL));
    expect(captureJobRequestId("zb-test", SOURCE_URL)).not.toBe(captureJobRequestId("other", SOURCE_URL));
    expect(captureJobRequestId("zb-test", SOURCE_URL)).not.toBe(captureJobRequestId("zb-test", "https://www.zilbermanfilmfoundation.com/about"));
  });
});

describe("the grant token is radioactive — it never lands anywhere durable or visible", () => {
  it("is absent from the pending jobState, the completed snapshot envelope, and every note", async () => {
    configureEndpoints();
    const snapshot = JSON.parse(await readFile(fileURLToPath(new URL("../../fixtures/capture/zilberman.snapshot.v1.redacted.json", import.meta.url)), "utf8"));
    stubPlane({ jobStatus: () => ({ jobId: JOB_ID, status: "complete", snapshot }) });

    const created = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps());
    const polled = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(polled.phase).toBe("completed");

    // Everything captureCrawlStep hands back is what the executor persists (jobState -> stageOutputs,
    // envelope -> the stage artifact) and shows (note -> a run warning).
    for (const returned of [created, polled]) {
      expect(JSON.stringify(returned)).not.toContain(GRANT_TOKEN);
      expect(JSON.stringify(returned)).not.toContain(SITE_ID);
    }
  });

  it("is scrubbed out of a response that echoed it — a remote cannot make us persist it", async () => {
    configureEndpoints();
    // A (buggy or hostile) plane echoing the grant back inside the job record and the status string.
    stubPlane({ jobStatus: () => ({ jobId: JOB_ID, status: `running ${GRANT_TOKEN}`, echoedStorage: { token: GRANT_TOKEN } }) });
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(step.phase).toBe("pending");
    const serialized = JSON.stringify(step);
    expect(serialized).not.toContain(GRANT_TOKEN);
    // The status is lowercased by the job-status reader, so the mask is matched case-insensitively.
    expect(serialized.toUpperCase()).toContain("[REDACTED]");
  });

  it("is scrubbed out of a refusal message raised by a grant-carrying call", async () => {
    configureEndpoints();
    stubPlane({ jobStatus: () => ({ jobId: JOB_ID, status: "failed", detail: GRANT_TOKEN }) });
    const error = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps()).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(CaptureRefusal);
    expect((error as CaptureRefusal).code).toBe("capture_job_failed");
    expect((error as CaptureRefusal).message).not.toContain(GRANT_TOKEN);
    expect(captureInternals.scrubGrantToken(`boom ${GRANT_TOKEN}`, GRANT_TOKEN)).toBe("boom [REDACTED]");
  });

  it("redactStorageGrant is the only view of a grant that may leave the module", () => {
    const redacted = redactStorageGrant({ grantType: "netlify-pat", projectId: "zb-tenant", siteId: SITE_ID, token: GRANT_TOKEN, expiresAt: "2026-08-17T01:00:00.000Z" });
    expect(redacted.token).toBe("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain(GRANT_TOKEN);
  });
});

describe("grant refusals are catalogued, never generic", () => {
  it("capture_storage_grant_not_permitted when the target's registration does not allow the tool (no transport)", async () => {
    configureEndpoints();
    const calls = stubPlane();
    const blocked = { projectRepository: stubRepository(projectConfig({ defaultToolPolicy: "blocked", toolPolicies: {} }), pdfToolConfig()) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, blocked)).rejects.toMatchObject({ code: "capture_storage_grant_not_permitted" });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, blocked)).rejects.toThrow(new RegExp(GET_STORAGE_GRANT_TOOL));
    // Refused before any wire call — and capture never widens the project's policy from code.
    expect(calls).toHaveLength(0);
  });

  it("capture_storage_grant_not_permitted when the tool is held for approval", async () => {
    configureEndpoints();
    stubPlane();
    const held = { projectRepository: stubRepository(projectConfig({ toolPolicies: { [GET_STORAGE_GRANT_TOOL]: "needs_approval" } }), pdfToolConfig()) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, held)).rejects.toMatchObject({ code: "capture_storage_grant_not_permitted" });
  });

  it("capture_storage_grant_unavailable when the target's MCP endpoint cannot be reached", async () => {
    process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
    stubPlane();
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps())).rejects.toMatchObject({ code: "capture_storage_grant_unavailable" });
  });

  it("capture_storage_grant_refused when the target answers the tool with an MCP error result", async () => {
    configureEndpoints();
    stubPlane({ grant: "error" });
    const error = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps()).catch((thrown) => thrown);
    expect(error).toMatchObject({ code: "capture_storage_grant_refused" });
    // Env var NAMES, never values — and never the remote's untrusted error text.
    expect((error as CaptureRefusal).message).toContain("PDF_TOOL_STORAGE_TOKEN");
  });

  it("capture_storage_grant_invalid when required fields are missing, naming the fields only", async () => {
    configureEndpoints();
    const { token: _dropped, ...withoutToken } = liveGrant();
    stubPlane({ grant: withoutToken });
    const error = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps()).catch((thrown) => thrown);
    expect(error).toMatchObject({ code: "capture_storage_grant_invalid" });
    expect((error as CaptureRefusal).message).toContain("token");
    expect((error as CaptureRefusal).message).not.toContain(SITE_ID);
  });

  it("capture_storage_grant_invalid for an already-expired grant (never retried with a stale one)", async () => {
    configureEndpoints();
    stubPlane({ grant: liveGrant({ expiresAt: new Date(Date.now() - 1_000).toISOString() }) });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps())).rejects.toMatchObject({ code: "capture_storage_grant_invalid" });
  });

  it("mints NO grant at all when the policy denies capture or the source is out of policy", async () => {
    configureEndpoints();
    const calls = stubPlane();
    const denied = { projectRepository: stubRepository(projectConfig({ capturePolicy: undefined }), pdfToolConfig()) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, denied)).rejects.toMatchObject({ code: "capture_policy_denies" });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: "https://prconsulting.net/" }, deps())).rejects.toMatchObject({ code: "capture_source_out_of_policy" });
    // The authority gate runs FIRST: a run that may not crawl never causes a credential to be issued.
    expect(calls).toHaveLength(0);
  });

  it("falls back to the registry target projectId only when the grant declares none", async () => {
    configureEndpoints();
    const { projectId: _none, ...unscoped } = liveGrant();
    const calls = stubPlane({ grant: unscoped });
    await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps());
    expect(calls.find((call) => call.tool === CREATE_CAPTURE_JOB_TOOL)!.args.projectId).toBe("zb-test");
  });
});
