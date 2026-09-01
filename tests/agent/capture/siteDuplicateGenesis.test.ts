import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { resolveProjectCapturePolicy } from "../../../src/agent/projects/projectTypes.js";

// T12.11 ACCEPTANCE (newSite half): one site_duplicate call with `newSite` executes EVERY
// automatable genesis step — the create-site scaffold via the platform seam (a stub checkout here,
// proving the subprocess + create_site_result.v1 JSON contract AND that the NETLIFY_API_TOKEN never
// reaches the scaffold child), the Netlify actions through the DRY-RUN Netlify API mode (recorded
// with synthetic ids, zero network calls — asserted by a fetch stub that fails the test on any
// api.netlify.com request), and the project.create registration with env NAMES only + the
// conservative seeded capture policy — and emits the correct human checklist for everything past
// account authority, verbatim from the provisioning runbook. The run starts and is kicked in the
// same call. site_duplicate_status then lists the outstanding human items, resolving the
// deploy-side env item live once the deployment sees the env var NAMES.

const SOURCE_URL = "https://www.zilbermanfilmfoundation.com/";
const PDF_TOOL_ENDPOINT = "https://pdf-tool.example/mcp";
// The minted site's own MCP endpoint — its capture BRIDGE is the only door to the capture plane
// (T12.13); no storage grant is involved on either side.
const NEW_SITE_ENDPOINT = "https://zilbermanfilmfoundation.example/mcp";
const JOB_ID = "capture_job_genesis_0001";

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

// The stub platform checkout: a create-site.mjs that records its invocation (argv + whether the
// Netlify token leaked into its env) and emits the T12.11 platform seam's create_site_result.v1
// contract — the same shape the real `create-site.mjs --json` commit produces.
const STUB_CLI = `
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const marker = fileURLToPath(new URL("../../../invocations.ndjson", import.meta.url));
appendFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), sawNetlifyToken: "NETLIFY_API_TOKEN" in process.env }) + "\\n");
console.log(JSON.stringify({
  contract: "create_site_result.v1", ok: true, mode: "scaffold", slug: "zilberman", dir: "sites/zilberman",
  ids: { siteId: "site_zilberman", taxonomyId: "tax_zilberman", themeId: "thm_zilberman_default" },
  plannedFiles: 80, scaffolded: true, alreadyScaffolded: false, netlify: null
}));
`;

describe("site.duplicate — newSite genesis (dry-run Netlify API mode)", () => {
  let platformRoot: string;
  let netlifyRequests: string[];

  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: { data } } }) }) as unknown as Response;

  beforeEach(async () => {
    resetRepositoryManager();
    netlifyRequests = [];
    platformRoot = await mkdtemp(path.join(tmpdir(), "t1211-platform-"));
    await mkdir(path.join(platformRoot, "packages/core/cli"), { recursive: true });
    await writeFile(path.join(platformRoot, "packages/core/cli/create-site.mjs"), STUB_CLI);

    process.env.MCP_API_TOKEN = "test-token";
    process.env.PDF_TOOL_MCP_ENDPOINT = PDF_TOOL_ENDPOINT;
    process.env.PDF_TOOL_MCP_TOKEN = "pdf-tool-test-token";
    // The standing genesis prerequisite is PRESENT (by name); the dry-run Netlify mode never sends
    // it anywhere — this value exists only to prove presence-gating, and the fetch stub below fails
    // the test if any Netlify API request is ever attempted with it.
    process.env.NETLIFY_API_TOKEN = "netlify-test-token-dry-run-only";
    process.env.PLATFORM_REPO_ROOT = platformRoot;
    // T12.13: capture_crawl calls the TARGET SITE'S OWN capture bridge, so the minted site's MCP
    // endpoint has to be reachable for the crawl to start. Nothing about the per-site pdf-tool storage
    // grant is required any more — that checklist item is no longer a capture blocker.
    process.env.ZILBERMAN_MCP_ENDPOINT = NEW_SITE_ENDPOINT;
    delete process.env.SITE_GENESIS_NETLIFY_MODE; // default = dry_run
    // T21.8: the fleet-shared tracking/deploy values genesis installs when this deployment holds
    // them. Cleared here so the default case in this file is the ABSENT one (checklist fallback);
    // the dedicated case below sets them explicitly rather than depending on the ambient env.
    delete process.env.TRACKING_SINK_URL;
    delete process.env.TRACKING_SINK_TOKEN;
    delete process.env.NETLIFY_AUTH_TOKEN;

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body?: string }) => {
      if (String(url).includes("api.netlify.com")) {
        netlifyRequests.push(String(url));
        throw new Error(`Netlify API must NEVER be called in dry-run mode: ${url}`);
      }
      const request = JSON.parse(init.body ?? "{}") as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      // T12.13: the capture plane is the MINTED SITE'S OWN capture bridge — no credential, no
      // pdf-tool call. pdf-tool answers nothing here, so a regression that calls it fails loudly.
      if (String(url).startsWith(NEW_SITE_ENDPOINT)) {
        if (name === "create_capture_job") return respond(request.id, { jobId: JOB_ID, status: "pending" });
        if (name === "get_capture_job_status") return respond(request.id, { jobId: JOB_ID, status: "running" });
      }
      throw new Error(`Unexpected endpoint/tool: ${url} ${name}`);
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.MCP_API_TOKEN;
    delete process.env.PDF_TOOL_MCP_ENDPOINT;
    delete process.env.PDF_TOOL_MCP_TOKEN;
    delete process.env.NETLIFY_API_TOKEN;
    delete process.env.PLATFORM_REPO_ROOT;
    delete process.env.ZILBERMAN_MCP_ENDPOINT;
    delete process.env.ZILBERMAN_MCP_TOKEN;
    delete process.env.TRACKING_SINK_URL;
    delete process.env.TRACKING_SINK_TOKEN;
    delete process.env.NETLIFY_AUTH_TOKEN;
    await rm(platformRoot, { recursive: true, force: true });
    resetRepositoryManager();
  });

  it("executes every automatable genesis step and emits the runbook-verbatim human checklist", async () => {
    const { rpcError, structured } = await mcpCall("site_duplicate", {
      sourceUrl: SOURCE_URL,
      newSite: { name: "zilberman", netlifySiteName: "zilbermanfilmfoundation" },
      executionMode: "mock"
    });
    expect(rpcError).toBeUndefined();
    const result = structured.data as {
      runId: string;
      statusTool: string;
      humanChecklist: Array<{ id: string; title: string; detail: string; envVars?: string[] }>;
      run: { status: string; projectId: string; workflowId: string };
      kick: { stoppedBecause: string };
      genesis: { projectId: string; netlifyMode: string; netlifySiteName: string; netlifySiteId?: string; envVarNames: { endpoint: string; token: string }; ledger: Array<{ step: string; kind: string; detail: string; data?: Record<string, unknown> }> };
    };

    // ── Genesis: the automatable steps all ran (or were dry-run recorded) — audited on the ledger.
    expect(result.genesis.projectId).toBe("zilberman");
    expect(result.genesis.netlifyMode).toBe("dry_run");
    expect(result.genesis.netlifySiteName).toBe("zilbermanfilmfoundation");
    expect(result.genesis.netlifySiteId).toBe("dryrun_site_zilbermanfilmfoundation");
    expect(result.genesis.envVarNames).toEqual({ endpoint: "ZILBERMAN_MCP_ENDPOINT", token: "ZILBERMAN_MCP_TOKEN" });
    const byStep = new Map(result.genesis.ledger.map((action) => [action.step + ":" + action.kind, action]));
    expect(byStep.has("scaffold:executed")).toBe(true);
    expect(byStep.has("netlify_provision_delegated:dry_run")).toBe(true);
    expect(byStep.has("netlify_create_site:dry_run")).toBe(true);
    expect(byStep.has("netlify_build_hook:dry_run")).toBe(true);
    expect(byStep.has("register_project:executed")).toBe(true);
    expect((byStep.get("register_project:executed") as { data?: { clientSiteBinding?: unknown } }).data?.clientSiteBinding).toEqual({ netlifySiteName: "zilbermanfilmfoundation", netlifySiteId: "dryrun_site_zilbermanfilmfoundation" });
    const envSets = result.genesis.ledger.filter((action) => action.step === "netlify_set_env" && action.kind === "dry_run");
    // No fleet tracking values are configured on THIS deployment (cleared in beforeEach), so genesis
    // installs only what it can derive — never an empty inherited value (T21.8).
    expect(envSets.map((action) => (action as { data?: { key?: string } }).data?.key).sort()).toEqual(["CMS_AGENT_MCP_ENDPOINT", "CMS_AGENT_MCP_TOKEN", "NETLIFY_BUILD_HOOK_URL", "TRACKING_PROJECT_ID"]);
    expect(byStep.get("tracking_fleet_env:requires_human")).toBeDefined();
    expect((byStep.get("tracking_fleet_env:requires_human") as { data?: { missing?: string[] } }).data?.missing).toEqual(["TRACKING_SINK_URL", "TRACKING_SINK_TOKEN", "NETLIFY_AUTH_TOKEN"]);
    expect(byStep.has("cms_agent_client_manager_credential:dry_run")).toBe(true);

    // The scaffold subprocess really ran through the platform seam — with the seam's flags, and
    // WITHOUT the Netlify token in its environment (the scaffold half never needs account authority).
    const invocations = (await readFile(path.join(platformRoot, "invocations.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(1);
    expect(invocations[0].argv).toEqual(["--name", "zilberman", "--netlify-site-name", "zilbermanfilmfoundation", "--json"]);
    expect(invocations[0].sawNetlifyToken).toBe(false);

    // DRY-RUN LAW: not one byte reached the Netlify API.
    expect(netlifyRequests).toEqual([]);

    // ── Registration: the TOKEN by env NAME only, the ENDPOINT derived from the site just minted
    // and stored ON the record (2026-08-18 — no <SLUG>_MCP_ENDPOINT is ever set by hand), plus the
    // conservative seeded capture policy scoped to the source origin.
    const config = (await repositoryManager.getProjectRepository().get("zilberman"))!;
    expect(config.mcpEndpointEnvVar).toBe("ZILBERMAN_MCP_ENDPOINT");
    expect(config.tokenEnvVar).toBe("ZILBERMAN_MCP_TOKEN");
    // Derived from the Netlify site name (dry-run reports https://<siteName>.netlify.app), not typed
    // by anyone and not passed in by the caller: this call carried no mcpEndpoint at all.
    expect(config.mcpEndpoint).toBe("https://zilbermanfilmfoundation.netlify.app/mcp");
    // The registry still cannot hold a secret: the token lives behind a NAME, nothing else.
    expect(JSON.stringify(config)).not.toContain("tenant-token");
    const policy = resolveProjectCapturePolicy(config);
    expect(policy.allowedCrawlOrigins).toEqual(["https://www.zilbermanfilmfoundation.com"]);
    expect(policy.maxPages).toBe(20);
    expect(policy.rights).toEqual({ content: "prohibited", media: "prohibited" });
    expect(policy.respectRobots).toBe(true);
    expect(policy.sameOriginOnly).toBe(true);

    // ── The run started AND was kicked in the same call: the crawl job was created on the pdf-tool
    // plane and the run is parked for the long-run planes (the poll stub never turns terminal here).
    expect(result.runId).toBeTruthy();
    expect(result.run.workflowId).toBe("capture_conductor");
    expect(result.run.projectId).toBe("zilberman");
    expect(result.kick.stoppedBecause).toBe("handed_to_long_run_plane");

    // ── The human checklist: exactly the runbook's non-automatable steps, in runbook order,
    // never silently skipped. (scaffold executed → commit_scaffold; dry-run Netlify → the live
    // provisioning item is surfaced.)
    expect(result.humanChecklist.map((item) => item.id)).toEqual([
      "commit_scaffold",
      "netlify_live_provisioning",
      "github_repo_binding",
      "enable_netlify_identity",
      "set_admin_emails",
      "invite_first_owner",
      "artifact_ingest_hosts",
      "pdf_tool_storage_grant",
      "tracking_sink",
      "fleet_shared_keys",
      "deploy_side_mcp_env",
      "capture_rights_review",
      "dns"
    ]);
    const byId = new Map(result.humanChecklist.map((item) => [item.id, item]));
    expect(byId.has("cms_agent_mcp_token")).toBe(false);
    expect(byId.get("fleet_shared_keys")!.envVars).not.toContain("CMS_AGENT_MCP_ENDPOINT");
    // Verbatim runbook language survives into the checklist.
    expect(byId.get("enable_netlify_identity")!.detail).toContain("Invite only — this is a workspace, not a signup page");
    expect(byId.get("set_admin_emails")!.detail).toContain("Until the first invite exists this is the ONLY way in");
    expect(byId.get("github_repo_binding")!.envVars).toEqual(["GITHUB_REPOSITORY", "GITHUB_BRANCH", "GITHUB_CONTENT_TOKEN", "GITHUB_COMMIT_AUTHOR_EMAIL", "GITHUB_COMMIT_AUTHOR_NAME"]);
    expect(byId.get("pdf_tool_storage_grant")!.envVars).toEqual(["PDF_TOOL_STORAGE_SITE_ID", "PDF_TOOL_STORAGE_TOKEN"]);
    // T21.8 — the tracking partition is the BARE slug (the sink's partition id); `trk_<slug>` is the
    // tracking_config OBJECT id and pointing the sink at it writes where nothing reads. With no fleet
    // sink values on this deployment, the sink pair stays a human item and the detail says why.
    expect(byId.get("tracking_sink")!.detail).toContain("Genesis set TRACKING_PROJECT_ID deterministically to zilberman —");
    expect(byId.get("tracking_sink")!.detail).toContain("Do NOT set trk_zilberman");
    expect(byId.get("tracking_sink")!.envVars).toEqual(["TRACKING_SINK_URL", "TRACKING_SINK_TOKEN"]);
    expect(byId.get("fleet_shared_keys")!.envVars).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NETLIFY_AUTH_TOKEN"]);
    // THE CHECKLIST SHRANK: the endpoint item is gone — genesis registered it — and what remains is
    // the token alone, which is irreducible because it is a secret VALUE in a custodian's keeping.
    expect(byId.get("deploy_side_mcp_env")!.envVars).toEqual(["ZILBERMAN_MCP_TOKEN"]);
    expect(byId.get("deploy_side_mcp_env")!.title).toContain("token only");
    expect(byId.get("deploy_side_mcp_env")!.detail).toContain("https://zilbermanfilmfoundation.netlify.app/mcp");
    expect(byId.get("invite_first_owner")!.detail).toContain("zilbermanfilmfoundation.netlify.app/admin");
    expect(byId.get("dns")!.detail).toContain("CNAME to the generated zilbermanfilmfoundation.netlify.app");

    // No secret value anywhere in the returned document (the dry-run token string must not appear).
    expect(JSON.stringify(structured)).not.toContain("netlify-test-token-dry-run-only");

    // ── Status: outstanding human items listed; the deploy-side env item resolves LIVE.
    const before = await mcpCall("site_duplicate_status", { runId: result.runId });
    const beforeItems = (before.structured.data as { outstandingHumanItems: Array<{ id: string; status: string; observed?: Record<string, unknown> }> }).outstandingHumanItems;
    expect(beforeItems.map((item) => item.id)).toContain("deploy_side_mcp_env");
    const envItemBefore = beforeItems.find((item) => item.id === "deploy_side_mcp_env")!;
    expect(envItemBefore.status).toBe("outstanding");
    // The endpoint is present (this test also sets the env var in beforeEach, which still WINS —
    // that is the backwards-compatible precedence); the tenant token is still missing, so the item
    // stays outstanding and says exactly which half.
    expect(envItemBefore.observed).toEqual({ endpointConfigured: true, endpointSource: "env", tokenConfigured: false });

    // …and with the env var REMOVED entirely, the endpoint still resolves — from the record genesis
    // wrote. This is the whole point: a freshly minted tenant is reachable with nothing added to
    // this deployment, and the one remaining item is the token.
    const savedEndpointEnv = process.env.ZILBERMAN_MCP_ENDPOINT;
    delete process.env.ZILBERMAN_MCP_ENDPOINT;
    const envless = await mcpCall("site_duplicate_status", { runId: result.runId });
    const envlessItem = (envless.structured.data as { outstandingHumanItems: Array<{ id: string; observed?: Record<string, unknown> }> })
      .outstandingHumanItems.find((item) => item.id === "deploy_side_mcp_env")!;
    expect(envlessItem.observed).toEqual({ endpointConfigured: true, endpointSource: "registry", tokenConfigured: false });
    process.env.ZILBERMAN_MCP_ENDPOINT = savedEndpointEnv;

    process.env.ZILBERMAN_MCP_ENDPOINT = "https://zilbermanfilmfoundation.netlify.app/mcp";
    process.env.ZILBERMAN_MCP_TOKEN = "tenant-token";
    const after = await mcpCall("site_duplicate_status", { runId: result.runId });
    const afterItems = (after.structured.data as { outstandingHumanItems: Array<{ id: string; status: string }> }).outstandingHumanItems;
    expect(afterItems.find((item) => item.id === "deploy_side_mcp_env")!.status).toBe("satisfied");
    // Console-only steps stay outstanding — this system cannot observe them and never fakes them.
    expect(afterItems.find((item) => item.id === "enable_netlify_identity")!.status).toBe("outstanding");
  }, 90_000);

  // T15.13 ACCEPTANCE: genesis derives the target's ProjectCapturePolicy from `sourceUrl` alone —
  // no hand-edited policy required — for a source whose origin appears in NO project definition
  // anywhere (unlike SOURCE_URL above, which happens to match platform's own hardcoded, hand-edited
  // Zilberman policy). This proves "URL in, any site" generalizes past the one client that used to
  // be the only one exercised for capture.
  // T21.8 ACCEPTANCE — "setting up tracking for a new tenant has to be part of the genesis process
  // not manually" (Wolf, 2026-09-01). With the fleet values present on THIS deployment, the same one
  // site_duplicate call installs the whole tracking connection on the new tenant: partition id, sink
  // URL, sink token — build-scoped, secrets per-context — and the checklist stops asking for them.
  it("installs the fleet-shared tracking connection on the new tenant when this deployment holds the fleet values", async () => {
    process.env.TRACKING_SINK_URL = "https://sink.example/track";
    process.env.TRACKING_SINK_TOKEN = "fleet-sink-token";
    process.env.NETLIFY_AUTH_TOKEN = "fleet-netlify-token";

    const { rpcError, structured } = await mcpCall("site_duplicate", {
      sourceUrl: SOURCE_URL,
      newSite: { name: "zilberman", netlifySiteName: "zilbermanfilmfoundation" },
      executionMode: "mock"
    });
    expect(rpcError).toBeUndefined();
    const result = structured.data as {
      humanChecklist: Array<{ id: string; title: string; detail: string; envVars?: string[] }>;
      genesis: { ledger: Array<{ step: string; kind: string; data?: Record<string, unknown> }> };
    };

    const envSets = new Map(
      result.genesis.ledger
        .filter((action) => action.step === "netlify_set_env")
        .map((action) => [String((action.data as { key?: string }).key), action.data as { isSecret: boolean; scopes: string[]; contexts: string[] }])
    );
    expect([...envSets.keys()].sort()).toEqual([
      "CMS_AGENT_MCP_ENDPOINT",
      "CMS_AGENT_MCP_TOKEN",
      "NETLIFY_AUTH_TOKEN",
      "NETLIFY_BUILD_HOOK_URL",
      "TRACKING_PROJECT_ID",
      "TRACKING_SINK_TOKEN",
      "TRACKING_SINK_URL"
    ]);
    // BUILDS, not just functions: the tenant repo's postbuild scripts/tracking-dims-push.mjs reads
    // TRACKING_SINK_URL/TOKEN/PROJECT_ID at BUILD time — functions-only is why drluriescience's dims
    // counters sat at zero.
    for (const key of ["TRACKING_PROJECT_ID", "TRACKING_SINK_URL", "TRACKING_SINK_TOKEN", "NETLIFY_AUTH_TOKEN"]) {
      expect(envSets.get(key)!.scopes, `${key} must be build-scoped`).toContain("builds");
    }
    // Secrets per-context; a secret written with context "all" would include `dev`, which Netlify
    // forbids for secrets.
    for (const key of ["TRACKING_SINK_URL", "TRACKING_SINK_TOKEN", "NETLIFY_AUTH_TOKEN"]) {
      expect(envSets.get(key)!.isSecret).toBe(true);
      expect(envSets.get(key)!.contexts).toEqual(["production", "deploy-preview", "branch-deploy"]);
    }

    const byId = new Map(result.humanChecklist.map((entry) => [entry.id, entry]));
    expect(byId.get("tracking_sink")!.envVars).toBeUndefined();
    expect(byId.get("tracking_sink")!.title).toContain("genesis installed the fleet sink connection");
    expect(byId.get("fleet_shared_keys")!.envVars).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

    // Values never travel: not into the ledger, not into the checklist, not into the response.
    const serialized = JSON.stringify(structured);
    expect(serialized).not.toContain("fleet-sink-token");
    expect(serialized).not.toContain("fleet-netlify-token");
    expect(serialized).not.toContain("https://sink.example/track");
  }, 90_000);

  it("derives a working capturePolicy from an arbitrary sourceUrl that names no project definition, with no hand-edited policy", async () => {
    const ARBITRARY_SOURCE_URL = "https://an-example-prospect-site.test/";
    const { rpcError, structured } = await mcpCall("site_duplicate", {
      sourceUrl: ARBITRARY_SOURCE_URL,
      newSite: { name: "zilberman", netlifySiteName: "zilbermanfilmfoundation" },
      executionMode: "mock"
    });
    expect(rpcError).toBeUndefined();
    const result = structured.data as { genesis: { projectId: string } };
    expect(result.genesis.projectId).toBe("zilberman");

    const config = (await repositoryManager.getProjectRepository().get("zilberman"))!;
    const policy = resolveProjectCapturePolicy(config);
    // Derived from the SOURCE, not from the site name or any static project definition.
    expect(policy.allowedCrawlOrigins).toEqual(["https://an-example-prospect-site.test"]);
    expect(policy.maxPages).toBe(20);
    expect(policy.sameOriginOnly).toBe(true);
    expect(policy.respectRobots).toBe(true);
    expect(policy.authenticatedAccess).toBe("prohibited");
    // No rights are presumed by derivation alone — raising them stays an explicit human project.update.
    expect(policy.rights).toEqual({ content: "prohibited", media: "prohibited" });
  }, 90_000);
});
