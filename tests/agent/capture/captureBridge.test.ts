import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  __test__ as captureInternals,
  captureCrawlStep,
  captureSiteObjectId,
  stripCredentialShapedFields,
  CaptureRefusal,
  CREATE_CAPTURE_JOB_TOOL,
  GET_CAPTURE_JOB_STATUS_TOOL,
  GET_CAPTURE_SNAPSHOT_TOOL
} from "../../../src/agent/capture/captureEngine.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import type { ProjectCapturePolicy, ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// T12.13 — capture.crawl goes through the TARGET SITE'S CAPTURE BRIDGE, and carries no credential.
//
// History this file records, because it is the whole reason the file changed shape: T12.9 shipped a
// fix that fetched `get_pdf_tool_storage_grant` from the target and forwarded it as pdf-tool's
// `storage` argument. That RPC had been DELETED from platform core on 2026-08-02 (commit 7d1640ce) in
// favour of a server-side bridge that mints the grant internally and never returns it, so the fix
// could never have worked live. Wolf ratified the other answer on 2026-08-14 — "option A, same-site
// writes": pdf-tool persists the crawl output into its OWN store, so there is no cross-site credential
// anywhere in the capture plane and MINTING A PER-SITE NETLIFY PAT IS NO LONGER REQUIRED to capture a
// new tenant. What survives from T12.9 is what was actually right about it: the full canonical policy
// travels verbatim, the authority gate runs first, refusals are catalogued, and nothing
// credential-shaped may reach run state.

const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const TARGET_ENDPOINT = "https://zb-test.example/mcp";
const SITE_OBJECT_ID = "site_zb_test";
const JOB_ID = "capture_job_zb_0001";
// Credential-shaped values that must never appear in anything captureCrawlStep hands back.
const LEAKED_TOKEN = "nfp_radioactive_capture_token_do_not_persist";
const LEAKED_SITE_ID = "site-api-id-zb-1234";

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
  objectDialect: {
    siteObjectId: SITE_OBJECT_ID,
    taxonomyRegistryObjectId: "tax_zb",
    objectIdSource: "server_minted",
    requestIdPattern: "^req_[a-z0-9_]+_\\d{8}_\\d{2}$",
    defaultObjectType: "content_item"
  },
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

const loadSnapshot = async () =>
  JSON.parse(await readFile(fileURLToPath(new URL("../../fixtures/capture/zilberman.snapshot.v1.redacted.json", import.meta.url)), "utf8"));

/** The plane: the TARGET site's bridge answers all three capture tools. Nothing else is reachable —
 * a call to any other endpoint throws, which is how this file proves pdf-tool is never called directly. */
const stubBridge = (options: {
  jobStatus?: (poll: number) => Record<string, unknown>;
  snapshot?: Record<string, unknown> | "error";
  createExtras?: Record<string, unknown>;
} = {}) => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as RpcRequest;
    if (request.method !== "tools/call") return respond(request.id, {});
    const tool = request.params?.name ?? "";
    const args = request.params?.arguments ?? {};
    calls.push({ url: String(url), tool, args });
    if (!String(url).startsWith(TARGET_ENDPOINT)) throw new Error(`Unexpected endpoint: ${url} — capture must only ever reach the target's own bridge`);
    if (tool === CREATE_CAPTURE_JOB_TOOL) {
      return respond(request.id, { jobId: JOB_ID, status: "pending", siteId: args.site_id, effective_max_pages: 20, ...(options.createExtras ?? {}) });
    }
    if (tool === GET_CAPTURE_JOB_STATUS_TOOL) {
      const polls = calls.filter((call) => call.tool === GET_CAPTURE_JOB_STATUS_TOOL).length;
      return respond(request.id, options.jobStatus ? options.jobStatus(polls) : { jobId: JOB_ID, status: "running" });
    }
    if (tool === GET_CAPTURE_SNAPSHOT_TOOL) {
      if (options.snapshot === "error") return respondError(request.id, { error: 'Capture job is "running", not complete', errorCode: "CAPTURE_SNAPSHOT_NOT_READY" });
      return respond(request.id, options.snapshot ?? {});
    }
    throw new Error(`Unexpected bridge tool: ${tool}`);
  }));
  return calls;
};

const jobState = () => ({ jobId: JOB_ID, status: "pending", attempts: 0, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" });

const deps = () => ({ projectRepository: stubRepository(projectConfig()) });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZB_TEST_MCP_ENDPOINT;
  delete process.env.PDF_TOOL_MCP_ENDPOINT;
});

const configureEndpoints = () => {
  process.env.ZB_TEST_MCP_ENDPOINT = TARGET_ENDPOINT;
};

describe("capture.crawl goes through the target site's capture bridge and carries no credential", () => {
  it("creates the job on the TARGET's bridge — site-scoped, policy verbatim, and no storage/grant/projectId/requestId argument at all", async () => {
    configureEndpoints();
    const calls = stubBridge();
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps());
    expect(step.phase).toBe("pending");

    // ONE call, to the target's own endpoint. pdf-tool is never contacted (the stub throws otherwise),
    // and there is no grant-fetch hop any more: the T12.9 get_pdf_tool_storage_grant round trip is gone.
    expect(calls).toHaveLength(1);
    const create = calls[0];
    expect(create.tool).toBe(CREATE_CAPTURE_JOB_TOOL);
    expect(create.url.startsWith(TARGET_ENDPOINT)).toBe(true);

    // Site ownership comes from the registry record's objectDialect, never from a caller argument.
    expect(create.args.site_id).toBe(SITE_OBJECT_ID);
    expect(create.args.url).toBe(SOURCE_URL);

    // THE RATIFIED GOAL: no credential of any kind is sent. There is nothing to mint, so a tenant with
    // no PDF_TOOL_STORAGE_TOKEN / PDF_TOOL_STORAGE_SITE_ID is capturable.
    for (const key of ["storage", "grant", "token", "descriptor"]) expect(create.args[key]).toBeUndefined();
    // The bridge derives pdf-tool's tenancy AND idempotency scope server-side; CMS-Agent names neither.
    for (const key of ["projectId", "project_id", "requestId", "request_id"]) expect(create.args[key]).toBeUndefined();

    // KEPT from the T12.9 fix: the FULL canonical policy travels verbatim (a subset is what pdf-tool's
    // parseCapturePolicy rejected), and it came from the registry read, not from the caller.
    expect(create.args.policy).toMatchObject({
      maxPages: 20,
      rights: AUTHORIZED_POLICY.rights,
      fidelity: AUTHORIZED_POLICY.fidelity,
      designReferences: [],
      sameOriginOnly: true,
      respectRobots: true,
      authenticatedAccess: "prohibited"
    });
  });

  it("polls the bridge with the site + job id only, and re-drives without ever caching anything between advances", async () => {
    configureEndpoints();
    const calls = stubBridge();
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(step.phase).toBe("pending");
    expect(calls.map((call) => call.tool)).toEqual([GET_CAPTURE_JOB_STATUS_TOOL]);
    expect(calls[0].args).toEqual({ site_id: SITE_OBJECT_ID, job_id: JOB_ID });

    await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    // Three advances, three bridge calls, zero extra hops — the grant-fetch-per-call hop is gone.
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url.startsWith(TARGET_ENDPOINT))).toBe(true);
  });

  it("sends the owning site as an optional cross-check, and omits it rather than guessing when the registry declares none", async () => {
    expect(captureSiteObjectId(projectConfig())).toBe(SITE_OBJECT_ID);
    // project.create cannot set objectDialect at all, so a freshly registered duplication target has
    // none. The call is still made — the bridge answers for its OWN site, server-side, which is the
    // authoritative value; guessing one here would be strictly worse.
    expect(captureSiteObjectId({ projectId: "zb-test" })).toBeUndefined();

    configureEndpoints();
    const calls = stubBridge();
    const undeclared = { projectRepository: stubRepository(projectConfig({ objectDialect: undefined })) };
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, undeclared);
    expect(step.phase).toBe("pending");
    expect(calls[0].args.site_id).toBeUndefined();
    expect(calls[0].args.url).toBe(SOURCE_URL);
  });
});

describe("the snapshot read path (T12.13 part 3)", () => {
  it("reads the completed snapshot.v1 back through the bridge's get_capture_snapshot — the old capture_snapshot_unavailable dead end is gone", async () => {
    configureEndpoints();
    const snapshot = await loadSnapshot();
    // The completed status payload carries the ArtifactReference ONLY, exactly as pdf-tool's plane does.
    const calls = stubBridge({
      jobStatus: () => ({
        jobId: JOB_ID,
        status: "complete",
        result: { snapshotArtifact: { blobKey: `binary/capture_x/${"a".repeat(64)}.json`, sha256: "a".repeat(64), sizeBytes: 2048 }, capturedPages: 1 }
      }),
      snapshot: { schemaVersion: "snapshot.v1", snapshot }
    });

    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(step.phase).toBe("completed");
    if (step.phase !== "completed") return;
    expect(step.envelope.snapshot.schemaVersion).toBe("snapshot.v1");
    expect(step.envelope.snapshot.pages.length).toBeGreaterThan(0);
    expect(step.envelope.jobId).toBe(JOB_ID);
    // Status poll, then the read — both site-scoped, both on the target's bridge, neither credentialed.
    expect(calls.map((call) => call.tool)).toEqual([GET_CAPTURE_JOB_STATUS_TOOL, GET_CAPTURE_SNAPSHOT_TOOL]);
    const read = calls[1];
    expect(read.args).toEqual({ site_id: SITE_OBJECT_ID, job_id: JOB_ID });
    expect(read.url.startsWith(TARGET_ENDPOINT)).toBe(true);
  });

  it("uses an inline snapshot when the plane supplies one, without a second call", async () => {
    configureEndpoints();
    const snapshot = await loadSnapshot();
    const calls = stubBridge({ jobStatus: () => ({ jobId: JOB_ID, status: "complete", snapshot }) });
    const step = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(step.phase).toBe("completed");
    expect(calls.map((call) => call.tool)).toEqual([GET_CAPTURE_JOB_STATUS_TOOL]);
  });

  it("refuses with capture_snapshot_unavailable when the bridge answers the read with an error, naming the bridge tool and its typed refusals", async () => {
    configureEndpoints();
    stubBridge({ jobStatus: () => ({ jobId: JOB_ID, status: "complete" }), snapshot: "error" });
    const error = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps()).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(CaptureRefusal);
    // The remote's own error text is untrusted, so the remedy is NAMED, not quoted.
    expect((error as CaptureRefusal).code).toBe("project_tool_call_failed");
    expect((error as CaptureRefusal).message).toContain(GET_CAPTURE_SNAPSHOT_TOOL);
  });

  it("refuses with capture_snapshot_unavailable when the bridge returns no document at all", async () => {
    configureEndpoints();
    stubBridge({ jobStatus: () => ({ jobId: JOB_ID, status: "complete" }), snapshot: { jobId: JOB_ID } });
    const error = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps()).catch((thrown) => thrown);
    expect((error as CaptureRefusal).code).toBe("capture_snapshot_unavailable");
    expect((error as CaptureRefusal).message).toContain("CAPTURE_SNAPSHOT_TOO_LARGE");
  });

  it("still quarantines loudly: a completed snapshot with quarantined pages is refused at the stage that owns it", async () => {
    configureEndpoints();
    const snapshot = await loadSnapshot();
    snapshot.diagnostics = { ...(snapshot.diagnostics ?? {}), quarantined: [{ url: SOURCE_URL, reason: "capture_failed" }] };
    stubBridge({ jobStatus: () => ({ jobId: JOB_ID, status: "complete", snapshot }) });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps())).rejects.toMatchObject({
      code: "capture_snapshot_quarantined"
    });
  });
});

describe("radioactivity discipline is kept even though there is no credential left to guard", () => {
  it("strips credential-shaped fields out of anything the bridge echoed, at any depth", () => {
    const stripped = stripCredentialShapedFields({
      jobId: JOB_ID,
      siteId: "site_zb_test",
      storage: { siteId: LEAKED_SITE_ID, token: LEAKED_TOKEN },
      token: LEAKED_TOKEN,
      nested: [{ grant: { token: LEAKED_TOKEN } }, { blobsToken: LEAKED_TOKEN, keep: "yes" }]
    });
    expect(JSON.stringify(stripped)).not.toContain(LEAKED_TOKEN);
    expect(JSON.stringify(stripped)).not.toContain(LEAKED_SITE_ID);
    // Non-credential fields survive untouched — this is a scrubber, not a filter on everything.
    expect(stripped).toMatchObject({ jobId: JOB_ID, siteId: "site_zb_test", nested: [{}, { keep: "yes" }] });
  });

  it("keeps a bridge that echoed a credential out of the pending jobState, the completed envelope, and every note", async () => {
    configureEndpoints();
    const snapshot = await loadSnapshot();
    stubBridge({
      createExtras: { storage: { siteId: LEAKED_SITE_ID, token: LEAKED_TOKEN }, token: LEAKED_TOKEN },
      jobStatus: () => ({ jobId: JOB_ID, status: "complete", snapshot, storage: { token: LEAKED_TOKEN } }),
      snapshot: { snapshot, token: LEAKED_TOKEN }
    });

    const created = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps());
    const polled = await captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps());
    expect(polled.phase).toBe("completed");
    // Everything captureCrawlStep hands back is what the executor persists (jobState -> stageOutputs,
    // envelope -> the stage artifact) and shows (note -> a run warning).
    for (const returned of [created, polled]) {
      expect(JSON.stringify(returned)).not.toContain(LEAKED_TOKEN);
      expect(JSON.stringify(returned)).not.toContain(LEAKED_SITE_ID);
    }
  });
});

describe("bounds and refusals: the authority gate still runs first and is never widened from code", () => {
  it("makes NO bridge call at all when the policy denies capture or the source is out of policy", async () => {
    configureEndpoints();
    const calls = stubBridge();
    const denied = { projectRepository: stubRepository(projectConfig({ capturePolicy: undefined })) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, denied)).rejects.toMatchObject({ code: "capture_policy_denies" });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: "https://prconsulting.net/" }, deps())).rejects.toMatchObject({ code: "capture_source_out_of_policy" });
    await expect(captureCrawlStep({ targetProjectId: "unknown-project", sourceUrl: SOURCE_URL }, deps())).rejects.toMatchObject({ code: "unknown_project" });
    // The gate runs BEFORE any transport, so an unauthorized run never touches the plane.
    expect(calls).toHaveLength(0);
  });

  it("refuses before any transport when the target's registration blocks or holds the bridge tool — the remedy names the tool, and no policy is widened from code", async () => {
    configureEndpoints();
    const calls = stubBridge();
    const blocked = { projectRepository: stubRepository(projectConfig({ defaultToolPolicy: "blocked", toolPolicies: {} })) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, blocked)).rejects.toMatchObject({ code: "project_tool_call_failed" });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, blocked)).rejects.toThrow(new RegExp(CREATE_CAPTURE_JOB_TOOL));

    const held = { projectRepository: stubRepository(projectConfig({ toolPolicies: { [CREATE_CAPTURE_JOB_TOOL]: "needs_approval" } })) };
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, held)).rejects.toMatchObject({ code: "project_tool_call_failed" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a terminal job failure and a nameless job with typed codes, and passes a bridge policy refusal through", async () => {
    configureEndpoints();
    stubBridge({ jobStatus: () => ({ jobId: JOB_ID, status: "failed" }) });
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL, jobState: jobState() }, deps())).rejects.toMatchObject({ code: "capture_job_failed" });

    vi.unstubAllGlobals();
    configureEndpoints();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      return respond(request.id, { status: "pending" });
    }));
    await expect(captureCrawlStep({ targetProjectId: "zb-test", sourceUrl: SOURCE_URL }, deps())).rejects.toMatchObject({ code: "capture_job_id_missing" });
  });

  it("exposes only the bridge seam for tests — no grant fetcher, no token scrubber, because neither exists any more", () => {
    expect(Object.keys(captureInternals).sort()).toEqual([
      "buildAdapterTransport",
      "buildRegenerationAdapter",
      "callCaptureBridge",
      "callProjectTool",
      "readSnapshotThroughBridge"
    ]);
  });
});
