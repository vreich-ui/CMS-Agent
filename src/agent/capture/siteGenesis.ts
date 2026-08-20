// T12.11 — the genesis driver behind `site.duplicate({newSite})`: birth a new landing tenant
// AUTOMATED TO THE LIMIT OF ACCOUNT AUTHORITY (R-C5), with everything past that limit surfaced as a
// precise human checklist — never silently skipped, never faked.
//
// The authority boundary, concretely (platform runbook `site-provisioning-runbook.md` + the T12.12
// prep analysis of which steps the Netlify API can absorb):
//   AUTOMATED HERE (or dry-run-proven here):
//     1. Repo scaffold — `create-site.mjs --json` (the T12.11 platform seam) invoked as a subprocess
//        against a platform checkout named by the PLATFORM_REPO_ROOT env var. Filesystem only.
//     2. Netlify site create + blob-store probe + auto-mintable secrets — delegated to
//        `create-site.mjs --provision-only --json` under NETLIFY_API_TOKEN when a checkout exists
//        (that path is already automated upstream); the driver's own Netlify API client covers the
//        site-create primitive when no checkout is mounted.
//     3. Build hook (POST /api/v1/sites/{id}/build_hooks) + NETLIFY_BUILD_HOOK_URL — the runbook's
//        by-hand step the T12.12 §6 analysis marked API-capable; closed here.
//     4. Deterministic env defaults — TRACKING_PROJECT_ID=trk_<slug> (the documented convention,
//        derived instead of human-decided; override any time in the Netlify console).
//     5. CMS-Agent registration — project.create with the <SLUG>_MCP_TOKEN env NAME (a secret value
//        NEVER transits MCP), the tenant's MCP ENDPOINT derived from the Netlify site this run just
//        created and stored on the record, and a conservative seeded capture policy (rights all
//        "prohibited": copy is regenerated, media is never imported — raising rights is an explicit
//        human project.update, never a default).
//     6. The endpoint half of the deploy-side connection — closed here (Wolf, 2026-08-18: "setting
//        ZILBERMAN_MCP_ENDPOINT in every new clone ... by hand does not work for me"). The endpoint
//        is a deterministic function of the site that was just minted (https://<site>/mcp — every
//        scaffold routes /mcp to its own mcp function, see create-site.mjs's redirects), so nobody
//        types or sets it: it is derived and persisted on the registry record. An endpoint URL is
//        not a secret; the TOKEN still is, and stays an env var NAME reference on the checklist.
//   HUMAN (the checklist): NETLIFY_API_TOKEN custody itself, GitHub repo binding + content token,
//   enabling Netlify Identity, ADMIN_EMAILS, the first-Owner sign-in, artifact ingest hosts, the
//   pdf-tool storage grant (a new Netlify machine account — no API mints accounts), tracking sink,
//   fleet-shared AI keys, the
//   deploy-side <SLUG>_MCP_TOKEN value (secret custody: Secret Manager + the Cloud Run
//   --update-secrets list; the ENDPOINT half is no longer a human step), and DNS.
//
//   GENESIS-OWNED CLIENT-MANAGER CREDENTIAL: the Platform site -> CMS-Agent bearer is minted here,
//   stored only as a digest in the durable workspace store, installed directly in Netlify as a
//   secret/function-only CMS_AGENT_MCP_TOKEN, verified against the public MCP endpoint, and then
//   discarded. The raw bearer never enters MCP, the ledger, stdout, a checklist, or source control.
//
// NETLIFY DRY-RUN MODE (SITE_GENESIS_NETLIFY_MODE, default "dry_run"): every Netlify API action is
// recorded in the audit ledger with synthetic ids and NO network call — the proof mode this
// environment runs in, because no real NETLIFY_API_TOKEN exists here and inventing one is
// forbidden. "live" performs the real calls. Either way the token env var must be PRESENT: it is
// the standing genesis prerequisite (T11.7), and its absence is a catalogued refusal, not a skip.
//
// AUDIT: every action — executed, dry-run, or handed to a human — lands in the returned ledger,
// which site.duplicate persists on the run record (stageOutputs) so site.duplicate_status can
// replay exactly what genesis did and what remains. Entries carry ids and env var NAMES only;
// secret values never appear in the ledger by construction.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createProject } from "../projects/projectAdmin.js";
import type { ProjectCapturePolicy, ProjectSummary } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ManagedScopedBearerCredentialRepository } from "../mcp/auth/managedScopedBearerCredentials.js";

const execFileAsync = promisify(execFile);

export const NETLIFY_API_TOKEN_ENV = "NETLIFY_API_TOKEN";
export const PLATFORM_REPO_ROOT_ENV = "PLATFORM_REPO_ROOT";
export const SITE_GENESIS_NETLIFY_MODE_ENV = "SITE_GENESIS_NETLIFY_MODE";
export const CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV = "CMS_AGENT_PUBLIC_MCP_ENDPOINT";
export const CREATE_SITE_CLI_RELATIVE_PATH = "packages/core/cli/create-site.mjs";
// The EXACT CMS-Agent tool surface a tenant's admin chat needs, and nothing more — this list IS
// the per-tenant scoped bearer's allowlist, so anything missing here is a 401 at the door and
// anything extra is blast radius.
//
// Derived from Platform's callers, not from intent. Every entry below is a live
// `ctx.cmsAgent.callTool(...)` site in platform `packages/core/server/lib/agent/tools.ts`:
//
//   agent_resolve             engine.ts        — resolve client_manager, every turn
//   agent_converse            engine.ts        — the turn itself
//   workspace_get_nodes       list_workspace_nodes
//   workflow_start_dry_run    run_workspace_workflow      (start a run)
//   workflow_run_all          run_workspace_workflow      (advance a run)
//   workflow_get_run          get_workspace_run
//   workflow_publish_readiness check_workspace_run_readiness
//   workflow_publish_run      publish_workspace_run
//
// `release_workspace_run` is deliberately absent: it rides Platform's own operational bridge
// (release_to_production + deploy_status locally), never this one.
//
// HISTORY — why this was wrong. The list shipped as [agent_resolve, agent_converse] when
// admin chat could only converse. PF4 then added the three workspace-orchestration tools and
// PF4b/D2a (2026-08-17) added readiness/publish, but this constant was never widened. Because
// `reconcileSiteClientManagerCredentials` re-mints EVERY registered tenant from it and retires the
// previous credential, the rotation silently narrowed tenants whose bearer had been minted by hand
// with a wider scope — turning a working `run_workspace_workflow` into an opaque 401. Keep this in
// lockstep with Platform's bridge; `siteGenesis.test.ts` pins it.
export const SITE_CLIENT_MANAGER_TOOLS = [
  "agent_resolve",
  "agent_converse",
  "workspace_get_nodes",
  "workflow_start_dry_run",
  "workflow_run_all",
  "workflow_get_run",
  "workflow_publish_readiness",
  "workflow_publish_run"
] as const;

export type GenesisNetlifyMode = "dry_run" | "live";

export class SiteGenesisRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SiteGenesisRefusal";
  }
}

// One audited genesis action. kind:
//   executed       — really performed (filesystem scaffold, registry write, live Netlify call).
//   dry_run        — the Netlify dry-run mode recorded the exact intended call without network.
//   requires_human — outside account authority in this environment; mirrored verbatim into the
//                    humanChecklist. NEVER silently dropped: absence of capability is itself audited.
export type GenesisAction = {
  step: string;
  kind: "executed" | "dry_run" | "requires_human";
  detail: string;
  at: string;
  data?: Record<string, unknown>;
};

export type GenesisHumanChecklistItem = {
  id: string;
  title: string;
  detail: string;
  envVars?: string[];
  source: string;
  // How completion becomes observable to this system, when it does at all.
  verify?: string;
};

export type SiteGenesisResult = {
  projectId: string;
  netlifyMode: GenesisNetlifyMode;
  netlifySiteName: string;
  netlifySiteId?: string;
  envVarNames: { endpoint: string; token: string };
  // The endpoint registered ON the record (derived from the minted site, or the caller's override).
  // The <SLUG>_MCP_ENDPOINT env var named above stays an optional override, not a prerequisite.
  mcpEndpoint: string;
  seededCapturePolicy: ProjectCapturePolicy;
  project: ProjectSummary;
  ledger: GenesisAction[];
  humanChecklist: GenesisHumanChecklistItem[];
};

const now = () => new Date().toISOString();

// slug -> SCREAMING_SNAKE env prefix, matching the registration contract's <CLIENT>_MCP_* convention.
export const envPrefixForSlug = (slug: string): string => slug.toUpperCase().replace(/-/g, "_");

// The tenant's MCP endpoint, DERIVED — never typed by a human, never asked for.
//
// It is a deterministic function of the Netlify site genesis just created: every scaffold ships the
// same `/mcp -> /.netlify/functions/mcp` redirect (create-site.mjs's netlify.toml template), so the
// endpoint is simply <site origin>/mcp. Prefer the origin the Netlify API itself reported for the
// site (ssl_url — correct even when the serving name differs from the slug, and the same field
// create-site's --json result exposes as siteUrl); fall back to the deterministic
// <netlifySiteName>.netlify.app when the API returned nothing usable.
//
// Only the ORIGIN is taken from the reported URL, so a surprising path/query/credential in an API
// response can never end up on a registry record (projectAdmin re-validates regardless).
export const deriveTenantMcpEndpoint = (netlifySiteName: string, reportedSiteUrl?: string): string => {
  const reported = reportedSiteUrl?.trim();
  if (reported) {
    try {
      const url = new URL(reported);
      if (url.protocol === "https:" && !url.username && !url.password) return `${url.origin}/mcp`;
    } catch {
      // Unparseable — fall through to the deterministic default rather than storing garbage.
    }
  }
  return `https://${netlifySiteName}.netlify.app/mcp`;
};

// The conservative seeded capture policy for a genesis target. Deliberately narrow:
//   - only the source origin, same-origin, robots honored, single-connection polite crawl;
//   - rights ALL "prohibited" — extracted copy is regenerated (copy_regenerator) and media is never
//     imported. Duplication must not presume content/media rights the operator has not asserted;
//     raising rights is an explicit human project.update, surfaced on the checklist.
export const seededGenesisCapturePolicy = (sourceOrigin: string): ProjectCapturePolicy => ({
  maxPages: 20,
  allowedCrawlOrigins: [sourceOrigin],
  allowedPathPrefixes: ["/"],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1000,
  authenticatedAccess: "prohibited",
  rights: { content: "prohibited", media: "prohibited" },
  designReferences: [],
  fidelity: { mode: "source_faithful", sourceDesignTreatment: "source_content_and_design" }
});

export const resolveGenesisNetlifyMode = (env: NodeJS.ProcessEnv = process.env): GenesisNetlifyMode =>
  (env[SITE_GENESIS_NETLIFY_MODE_ENV] ?? "").trim().toLowerCase() === "live" ? "live" : "dry_run";

// ---------------------------------------------------------------------------------------------
// Netlify API client with a first-class dry-run mode. In dry_run NOTHING touches the network: the
// intended call is recorded on the ledger with a synthetic id. In live mode the calls mirror the
// platform CLI's proven request shapes (create-site.mjs). The bearer token is only ever placed in
// the Authorization header; error bodies from secret-bearing writes are never echoed.
export type NetlifyFetch = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string>; headers?: { get: (name: string) => string | null } }>;

export class NetlifyGenesisClient {
  readonly actions: GenesisAction[] = [];
  constructor(
    private readonly mode: GenesisNetlifyMode,
    private readonly token: string,
    private readonly fetchImpl: NetlifyFetch = fetch as unknown as NetlifyFetch,
    private readonly sleepImpl: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  private record(step: string, detail: string, data?: Record<string, unknown>): void {
    this.actions.push({ step, kind: this.mode === "dry_run" ? "dry_run" : "executed", detail, at: now(), ...(data ? { data } : {}) });
  }

  private async request(method: string, url: string, body?: unknown, { redactErrorBody = false }: { redactErrorBody?: boolean } = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const detail = redactErrorBody ? "" : ` ${(await response.text?.().catch(() => "")) ?? ""}`.trimEnd();
      throw new SiteGenesisRefusal("netlify_api_failed", `${method} ${new URL(url).pathname} failed: HTTP ${response.status}${detail}`);
    }
    return response.json().catch(() => ({}));
  }

  async createSite(siteName: string): Promise<{ siteId: string; accountId?: string; url?: string }> {
    if (this.mode === "dry_run") {
      const siteId = `dryrun_site_${siteName}`;
      this.record("netlify_create_site", `DRY-RUN: would POST /api/v1/sites {name: "${siteName}"} (idempotent: an existing site of that name is reused).`, { siteName, siteId });
      return { siteId, accountId: `dryrun_account_${siteName}`, url: `https://${siteName}.netlify.app` };
    }
    // Idempotent, matching create-site.mjs: look up by name before creating a duplicate.
    const found = (await this.request("GET", `https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(siteName)}`)) as unknown;
    const existing = Array.isArray(found) ? (found as Array<Record<string, unknown>>).find((site) => site.name === siteName) : undefined;
    const site = (existing ?? (await this.request("POST", "https://api.netlify.com/api/v1/sites", { name: siteName }))) as Record<string, unknown>;
    const siteId = String(site.id ?? site.site_id ?? "");
    if (!siteId) throw new SiteGenesisRefusal("netlify_api_failed", "Netlify site create/lookup returned no site id.");
    this.record("netlify_create_site", `${existing ? "Resolved existing" : "Created"} Netlify site "${siteName}".`, { siteName, siteId });
    return { siteId, accountId: typeof site.account_id === "string" ? site.account_id : undefined, url: typeof site.ssl_url === "string" ? site.ssl_url : undefined };
  }

  async resolveExistingSite(siteName: string): Promise<{ siteId: string; accountId: string; url?: string }> {
    if (this.mode === "dry_run") return { siteId: `dryrun_site_${siteName}`, accountId: `dryrun_account_${siteName}`, url: `https://${siteName}.netlify.app` };
    const found = (await this.request("GET", `https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(siteName)}`)) as unknown;
    const site = Array.isArray(found) ? (found as Array<Record<string, unknown>>).find((candidate) => candidate.name === siteName) : undefined;
    const siteId = typeof site?.id === "string" ? site.id : "";
    const accountId = typeof site?.account_id === "string" ? site.account_id : "";
    if (!siteId || !accountId) throw new SiteGenesisRefusal("netlify_site_not_found", `No existing Netlify site named "${siteName}" could be resolved; reconciliation never creates replacement sites.`);
    this.record("netlify_resolve_site", `Resolved existing Netlify site "${siteName}".`, { siteName, siteId });
    return { siteId, accountId, url: typeof site?.ssl_url === "string" ? site.ssl_url : undefined };
  }

  async createBuildHook(siteId: string, title: string): Promise<{ hookId: string; url?: string }> {
    if (this.mode === "dry_run") {
      const hookId = `dryrun_hook_${siteId}`;
      this.record("netlify_build_hook", `DRY-RUN: would POST /api/v1/sites/${siteId}/build_hooks {title: "${title}"} and set NETLIFY_BUILD_HOOK_URL from the response (URL treated as a secret capability value — never logged).`, { siteId, hookId });
      return { hookId };
    }
    const hook = (await this.request("POST", `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/build_hooks`, { title }, { redactErrorBody: true })) as Record<string, unknown>;
    const hookId = String(hook.id ?? "");
    if (!hookId) throw new SiteGenesisRefusal("netlify_api_failed", "Netlify build-hook create returned no hook id.");
    this.record("netlify_build_hook", `Created build hook "${title}" on site ${siteId}.`, { siteId, hookId });
    // Netlify's response carries the hook's trigger URL; when absent it is derivable from the id.
    const url = typeof hook.url === "string" && hook.url ? hook.url : `https://api.netlify.com/build_hooks/${hookId}`;
    return { hookId, url };
  }

  async getSiteAccountId(siteId: string): Promise<string> {
    if (this.mode === "dry_run") return `dryrun_account_${siteId}`;
    const site = (await this.request("GET", `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`)) as Record<string, unknown>;
    const accountId = typeof site.account_id === "string" ? site.account_id : "";
    if (!accountId) throw new SiteGenesisRefusal("netlify_api_failed", `Netlify site ${siteId} carries no account id; env vars cannot be set without one.`);
    return accountId;
  }

  // Netlify injects changed environment variables into Functions only on a new deploy. A direct
  // credential handshake proves CMS-Agent recognizes the bearer, but the editor UI cannot use it
  // until a fresh production deploy is both ready and actually published for the site.
  async rebuildAndWaitForPublishedDeploy(
    siteId: string,
    { maxAttempts = 61, pollIntervalMs = 3_000 }: { maxAttempts?: number; pollIntervalMs?: number } = {}
  ): Promise<{ deployId: string }> {
    if (this.mode === "dry_run") {
      const deployId = `dryrun_deploy_${siteId}`;
      this.record("netlify_credential_rebuild", `DRY-RUN: would schedule and wait for a fresh published production deploy on site ${siteId} so Functions receive the generated credential.`, { siteId, deployId });
      return { deployId };
    }
    const build = (await this.request(
      "POST",
      `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/builds?title=${encodeURIComponent("CMS-Agent credential rotation")}`,
      undefined,
      { redactErrorBody: true }
    )) as Record<string, unknown>;
    const deployId = typeof build.deploy_id === "string" ? build.deploy_id : "";
    if (!deployId) throw new SiteGenesisRefusal("netlify_build_failed", "Netlify scheduled the credential rebuild without returning a deploy id.");

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const deploy = (await this.request("GET", `https://api.netlify.com/api/v1/deploys/${encodeURIComponent(deployId)}`)) as Record<string, unknown>;
      const state = typeof deploy.state === "string" ? deploy.state : "unknown";
      if (["error", "failed", "canceled", "rejected"].includes(state)) {
        throw new SiteGenesisRefusal("netlify_build_failed", `Netlify credential rebuild ${deployId} reached terminal state ${state}.`);
      }
      if (state === "ready") {
        const site = (await this.request("GET", `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`)) as Record<string, unknown>;
        const published = site.published_deploy && typeof site.published_deploy === "object" ? site.published_deploy as Record<string, unknown> : undefined;
        if (published?.id === deployId && published.state === "ready") {
          this.record("netlify_credential_rebuild", `Published fresh production deploy ${deployId} on site ${siteId} after the credential update.`, { siteId, deployId });
          return { deployId };
        }
      }
      if (attempt + 1 < maxAttempts) await this.sleepImpl(pollIntervalMs);
    }
    throw new SiteGenesisRefusal("netlify_build_not_published", `Netlify credential rebuild ${deployId} did not become the published production deploy within the wait budget.`);
  }

  // Env-var set mirrors create-site.mjs's proven check-then-POST/PUT shape. `value` is only ever a
  // non-secret deterministic default or a capability URL flagged isSecret; the ledger records the
  // NAME, never the value.
  async setEnvVar(
    accountId: string,
    siteId: string,
    key: string,
    value: string,
    { isSecret = false, scopes = ["builds", "functions", "runtime", "post_processing"], context = "all" }: { isSecret?: boolean; scopes?: string[]; context?: string } = {}
  ): Promise<void> {
    if (this.mode === "dry_run") {
      this.record("netlify_set_env", `DRY-RUN: would set env var ${key} on site ${siteId} (name recorded; value never logged).`, { siteId, key, isSecret });
      return;
    }
    const keyUrl = `https://api.netlify.com/api/v1/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}?site_id=${encodeURIComponent(siteId)}`;
    const collectionUrl = `https://api.netlify.com/api/v1/accounts/${encodeURIComponent(accountId)}/env?site_id=${encodeURIComponent(siteId)}`;
    const existing = await this.fetchImpl(keyUrl, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!existing.ok && existing.status !== 404) throw new SiteGenesisRefusal("netlify_api_failed", `Netlify env-var lookup failed for ${key}: HTTP ${existing.status}`);
    const variable = { key, scopes, values: [{ value, context }], ...(isSecret ? { is_secret: true } : {}) };
    await this.request(existing.ok ? "PUT" : "POST", existing.ok ? keyUrl : collectionUrl, existing.ok ? variable : [variable], { redactErrorBody: true });
    this.record("netlify_set_env", `Set env var ${key} on site ${siteId} (name recorded; value never logged).`, { siteId, key, isSecret });
  }
}

// ---------------------------------------------------------------------------------------------
// The scaffold subprocess: `create-site.mjs --json` (the platform seam). stdout is ONE JSON line
// (create_site_result.v1). The child NEVER receives NETLIFY_API_TOKEN unless this driver is
// deliberately delegating the provisioning half (live mode with a checkout).
type CreateSiteJsonResult = Record<string, unknown> & { contract?: string; ok?: boolean; mode?: string };

async function runCreateSiteCli(platformRoot: string, args: string[], { passToken, token }: { passToken: boolean; token: string }): Promise<CreateSiteJsonResult> {
  const cliPath = path.join(platformRoot, CREATE_SITE_CLI_RELATIVE_PATH);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[NETLIFY_API_TOKEN_ENV];
  if (passToken) env[NETLIFY_API_TOKEN_ENV] = token;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [cliPath, ...args, "--json"], { env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Subprocess stderr may carry paths but never secrets (create-site redacts secret-bearing error
    // bodies itself); the message is safe to surface.
    throw new SiteGenesisRefusal("genesis_scaffold_failed", `create-site.mjs failed: ${message}`);
  }
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed: CreateSiteJsonResult;
  try {
    parsed = JSON.parse(lastLine) as CreateSiteJsonResult;
  } catch {
    throw new SiteGenesisRefusal("genesis_scaffold_failed", "create-site.mjs --json did not emit a parseable JSON result line.");
  }
  if (parsed.contract !== "create_site_result.v1") {
    throw new SiteGenesisRefusal("genesis_scaffold_failed", `create-site.mjs emitted an unexpected contract: ${String(parsed.contract)}.`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// The human checklist — verbatim from the provisioning runbook (site-provisioning-runbook.md §2/§3/§3a
// + the T11.7 env table), concretized for this tenant. Order follows the runbook.
export function buildGenesisHumanChecklist(input: {
  slug: string;
  netlifySiteName: string;
  envPrefix: string;
  scaffoldExecuted: boolean;
  netlifyMode: GenesisNetlifyMode;
  // The endpoint genesis derived and stored on the registry record. Present = the endpoint half of
  // the deploy-side connection is DONE and the checklist item shrinks to the token alone.
  registeredMcpEndpoint?: string;
}): GenesisHumanChecklistItem[] {
  const { slug, netlifySiteName, envPrefix } = input;
  const items: GenesisHumanChecklistItem[] = [];
  if (!input.scaffoldExecuted) {
    items.push({
      id: "scaffold_site_tree",
      title: `Scaffold sites/${slug}/ in the platform repo (no platform checkout is mounted for this deployment)`,
      detail: `Runbook §1: "node packages/core/cli/create-site.mjs --name ${slug} --dry-run   # review the plan first" then "node packages/core/cli/create-site.mjs --name ${slug}". Then: run npm install at the repo root and COMMIT package-lock.json (a new site is a new npm workspace; without it every npm ci fails). Alternatively set ${PLATFORM_REPO_ROOT_ENV} on this deployment and re-run site.duplicate to automate this step.`,
      source: "site-provisioning-runbook.md §1"
    });
  } else {
    items.push({
      id: "commit_scaffold",
      title: `Commit the scaffolded sites/${slug}/ tree + package-lock.json`,
      detail: "create-site.mjs NEXT step, verbatim: \"run `npm install` at the repo root and COMMIT package-lock.json. A new site is a new npm workspace; without it every `npm ci` fails.\" Committing to the platform repo is a git/review act outside this driver's authority.",
      source: "create-site.mjs NEXT step / runbook §1"
    });
  }
  if (input.netlifyMode === "dry_run") {
    items.push({
      id: "netlify_live_provisioning",
      title: "Execute the Netlify provisioning LIVE (this run recorded it in dry-run mode only)",
      detail: `Runbook §2: "node packages/core/cli/create-site.mjs --name ${slug} --netlify-token $NETLIFY_API_TOKEN" (add --provision-only if sites/${slug}/ already exists, and --netlify-site-name ${netlifySiteName} for the serving name). This creates/resolves the Netlify site, probes the blob stores (write→read→delete), and auto-mints + pushes PUBLISH_SECRET, MCP_HTTP_AUTH_TOKEN, ARTIFACT_UPLOAD_TOKEN_SECRET, TRACKING_SALT, NETLIFY_SITE_ID, PDF_TOOL_BASE_URL, PDF_TOOL_AGENT_RUN_TOKEN — values never printed. Or set ${SITE_GENESIS_NETLIFY_MODE_ENV}=live on this deployment and re-run site.duplicate.`,
      source: "site-provisioning-runbook.md §2"
    });
  }
  items.push(
    {
      id: "github_repo_binding",
      title: "GitHub repo binding — create/pick the content repo, mint a scoped write token, set the five vars",
      detail: "Runbook §3, verbatim: \"create or pick the client's content repo, mint a write token scoped to it (a fleet machine account with per-repo scope is fine — T11.10 decides the final posture), set the four vars on the new Netlify site.\" Creating the repo and minting the token is GitHub account authority — a second system no Netlify token reaches. Set the repo string directly in the Netlify console; never paste it into committed content.",
      envVars: ["GITHUB_REPOSITORY", "GITHUB_BRANCH", "GITHUB_CONTENT_TOKEN", "GITHUB_COMMIT_AUTHOR_EMAIL", "GITHUB_COMMIT_AUTHOR_NAME"],
      source: "site-provisioning-runbook.md §3"
    },
    {
      id: "enable_netlify_identity",
      title: "Enable Netlify Identity (GoTrue) on the new site — console-only",
      detail: "Runbook §3a step 1, verbatim: \"Netlify console → the site → Integrations → Identity → Enable (on older console versions: Site configuration → Identity). … Registration preference: Invite only — this is a workspace, not a signup page.\" No public API endpoint for enabling Identity is documented anywhere in the platform repo; this is a standing non-automatable gate.",
      source: "site-provisioning-runbook.md §3a step 1"
    },
    {
      id: "set_admin_emails",
      title: "Set ADMIN_EMAILS to the real operator email(s) — bootstrap Owners",
      detail: "Runbook §3a step 2, verbatim: \"Set ADMIN_EMAILS on the site (Site settings → Environment variables) to the operator's real email address(es), comma-separated. These are bootstrap Owners … Until the first invite exists this is the ONLY way in.\" The env-var write is API-capable but the VALUE is an irreducible human decision — which humans own this tenant.",
      envVars: ["ADMIN_EMAILS"],
      source: "site-provisioning-runbook.md §3a step 2"
    },
    {
      id: "invite_first_owner",
      title: "First-Owner sign-in / invite",
      detail: `Runbook §3a step 3, verbatim: "Sign in at https://${netlifySiteName}.netlify.app/admin with an ADMIN_EMAILS address (Identity → your first login), then /admin/settings/admins → Invite (email + role Owner). … A team of one can stop after step 2; ADMIN_EMAILS alone is a complete bootstrap." Rides GoTrue with a real signed-in human identity — the point of the gate.`,
      source: "site-provisioning-runbook.md §3a step 3"
    },
    {
      id: "artifact_ingest_hosts",
      title: "Set ARTIFACT_URL_INGEST_ALLOWED_HOSTS — a policy choice, not a secret",
      detail: "Runbook §3, verbatim: \"the hosts this client's agents may pull artifact images from — a policy choice, not a secret.\"",
      envVars: ["ARTIFACT_URL_INGEST_ALLOWED_HOSTS"],
      source: "site-provisioning-runbook.md §3"
    },
    {
      id: "pdf_tool_storage_grant",
      title: "pdf-tool storage grant — dedicated Netlify machine account + Blobs-scoped PAT for THIS tenant",
      detail: "Runbook §3, verbatim: \"PDF_TOOL_STORAGE_SITE_ID/_TOKEN are per-site — provision a NEW dedicated Netlify machine account + Blobs-scoped PAT for THIS client (docs/agents/pdf-tool-storage-grant.md's 'Credential provisioning' steps); do not reuse another tenant's value.\" Netlify has no API to create another machine ACCOUNT from a token — account authority. Then probe: node scripts/provision-pdf-tool-stores.mjs (or re-run provisioning with --provision-only --known-tenant-site <each live tenant> for the collision check).",
      envVars: ["PDF_TOOL_STORAGE_SITE_ID", "PDF_TOOL_STORAGE_TOKEN"],
      source: "site-provisioning-runbook.md §3 + docs/agents/pdf-tool-storage-grant.md"
    },
    {
      id: "tracking_sink",
      title: "Tracking sink — point at the shared owner-DB or provision a dedicated sink",
      detail: `Runbook §3, verbatim: "Tracking sink may be one shared owner-DB (partitioned by TRACKING_PROJECT_ID) or per-site — your call." Genesis set TRACKING_PROJECT_ID deterministically to trk_${slug} (the documented trk_<shortId> convention); override in the Netlify console if this tenant needs a different partition.`,
      envVars: ["TRACKING_SINK_URL", "TRACKING_SINK_TOKEN"],
      source: "site-provisioning-runbook.md §3 / T11.7 env table"
    },
    {
      id: "fleet_shared_keys",
      title: "Confirm the remaining fleet-shared AI/integration values are present — reuse, never mint per-client",
      detail: "Runbook §3 + T11.7 env table: ANTHROPIC_API_KEY, OPENAI_API_KEY and NETLIFY_AUTH_TOKEN are fleet-shared — \"reuse the existing fleet values, never mint per-client copies.\" CMS_AGENT_MCP_ENDPOINT and the site's scoped CMS_AGENT_MCP_TOKEN are installed by genesis and are not human checklist items.",
      envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NETLIFY_AUTH_TOKEN"],
      source: "T11.7 env table / site-provisioning-runbook.md §3"
    },
    input.registeredMcpEndpoint
      ? {
        // The endpoint half is CLOSED: genesis derived it from the site it just created and stored
        // it on the registry record, so nothing has to be set for it on this deployment (Wolf,
        // 2026-08-18). What is left is irreducibly a secret-custody act: the token VALUE lives in a
        // secret store, and no endpoint-shaped derivation can produce it.
        id: "deploy_side_mcp_env",
        title: `Provision ${envPrefix}_MCP_TOKEN on THIS CMS-Agent deployment (the endpoint is already registered — token only)`,
        detail: `Registration contract step 2: the ENDPOINT needed no deployment change — genesis registered it on the project record as ${input.registeredMcpEndpoint} (an endpoint URL is not a secret). Only the bearer TOKEN remains, and only because it is a secret VALUE: take the new site's MCP_HTTP_AUTH_TOKEN (auto-minted during provisioning, never printed), store it in the secret custodian, and expose it to this deployment as ${envPrefix}_MCP_TOKEN — on Cloud Run that is a Secret Manager entry plus an --update-secrets pair in cloudbuild.deploy.yaml. Then complete contract steps 3–6: project.get → project.test_connection → project.list_tools + allow-list → project.validate_handoff (agent-runnable). Setting ${envPrefix}_MCP_ENDPOINT is OPTIONAL and only ever an override (it wins over the registered value) — e.g. after moving this tenant to a custom domain; project.update {mcpEndpoint} does the same with no deploy.`,
        envVars: [`${envPrefix}_MCP_TOKEN`],
        source: "project.get_registration_contract onboardingSteps 2–6",
        verify: "project.get — connection.endpointConfigured is already true (endpointSource \"registry\"); tokenConfigured turns true once the deploy sees the token."
      }
      : {
        id: "deploy_side_mcp_env",
        title: `Set ${envPrefix}_MCP_ENDPOINT + ${envPrefix}_MCP_TOKEN on THIS CMS-Agent deployment`,
        detail: `Registration contract step 2, verbatim: "Configure the referenced environment variables in the Netlify deployment (values never pass through MCP)." No endpoint could be derived for this run, so the project was registered with env var NAMES only; until the deployment sees values, project.test_connection reports the endpoint unconfigured and the run's emission stage cannot reach the new site. After setting them, complete contract steps 3–6: project.get → project.test_connection → project.list_tools + allow-list → project.validate_handoff (agent-runnable).`,
        envVars: [`${envPrefix}_MCP_ENDPOINT`, `${envPrefix}_MCP_TOKEN`],
        source: "project.get_registration_contract onboardingSteps 2–6",
        verify: "project.get — connection.endpointConfigured/tokenConfigured turn true once the deploy sees the env vars."
      },
    {
      id: "capture_rights_review",
      title: "Capture rights were seeded CONSERVATIVE — raise only if the operator holds rights",
      detail: "Genesis seeded capturePolicy.rights = {content: \"prohibited\", media: \"prohibited\"}: every extracted body is regenerated (copy_regenerator) and no source media is imported. If this account holds rights to the source content/media, raise them explicitly via project.update — a rights assertion is a human act, never a default.",
      source: "R-C2 / T12.9 rights law"
    },
    {
      id: "dns",
      title: "DNS — point the client's domain at the Netlify site (skip if serving at netlify.app)",
      detail: `Runbook §3, verbatim: "point the client's domain at the Netlify site (custom_domain in Netlify site settings, or a CNAME to the generated ${netlifySiteName}.netlify.app), then update sites/${slug}/site.config.ts's canonicalHost and data/site/site.json's urls.canonicalHost to match once the domain resolves."`,
      source: "site-provisioning-runbook.md §3"
    }
  );
  return items;
}

// ---------------------------------------------------------------------------------------------
export type SiteGenesisInput = {
  name: string;
  // The <name> in <name>.netlify.app when it must differ from the repo slug (e.g. R-C4's
  // zilberman tree serving at zilbermanfilmfoundation.netlify.app). Defaults to the slug.
  netlifySiteName?: string;
  sourceUrl: string;
  // OPTIONAL endpoint override for the tenant being minted — for a client that will serve its /mcp
  // from a custom domain from day one. Omit it (the normal path): genesis DERIVES the endpoint from
  // the Netlify site it just created, so nobody passes or sets anything. Validated credential-free
  // by projectAdmin before it can reach a record.
  mcpEndpoint?: string;
};

export type SiteGenesisDeps = {
  projectRepository: ProjectRepository;
  env?: NodeJS.ProcessEnv;
  netlifyFetch?: NetlifyFetch;
  credentialFetch?: NetlifyFetch;
  credentialRepository?: Pick<ManagedScopedBearerCredentialRepository, "mint" | "activateAndRetireOtherProjectCredentials" | "revokeCredential">;
};

export const resolveCmsAgentPublicMcpEndpoint = (env: NodeJS.ProcessEnv = process.env): string => {
  const raw = env[CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV]?.trim();
  if (!raw) throw new SiteGenesisRefusal("cms_agent_public_endpoint_missing", `${CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV} is required for live genesis so the generated site can be wired and its credential verified without human handling.`);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("invalid");
    return url.toString();
  } catch {
    throw new SiteGenesisRefusal("cms_agent_public_endpoint_invalid", `${CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV} must be a credential-free https URL whose path is exactly /mcp.`);
  }
};

export async function verifyCmsAgentScopedCredential(endpoint: string, token: string, fetchImpl: NetlifyFetch = fetch as unknown as NetlifyFetch): Promise<void> {
  let response: Awaited<ReturnType<NetlifyFetch>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "genesis-credential-check", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cms-agent-genesis", version: "1" } } })
    });
  } catch {
    throw new SiteGenesisRefusal("cms_agent_credential_verification_failed", "The generated CMS-Agent credential could not be verified; genesis stopped without exposing it.");
  }
  if (!response.ok) throw new SiteGenesisRefusal("cms_agent_credential_verification_failed", `The generated CMS-Agent credential was rejected during initialize (HTTP ${response.status}); genesis stopped without exposing it.`);

  // `initialize` is allowed for ANY scoped bearer regardless of its tool allowlist
  // (mcpEndpoint.isScopedMessageAllowed lets the handshake through unconditionally), so a
  // credential that cannot call a single workflow tool still passes the check above. That is how a
  // too-narrow allowlist reached production reporting success. `tools/list` IS filtered by the
  // allowlist (workspace/server.ts isAllowedForContext), so listing under the new token shows
  // exactly what it may call — assert that covers the bridge.
  //
  // Degrades rather than blocks: the endpoint needs the Mcp-Session-Id from initialize, and a
  // stateless deployment (or a fetch stub without headers) may not issue one. No session id, no
  // probe — this must never turn a working genesis into a refusal over a missing header.
  const sessionId = response.headers?.get("mcp-session-id") ?? undefined;
  if (!sessionId) return;

  let listed: Awaited<ReturnType<NetlifyFetch>>;
  try {
    listed = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: "genesis-scope-check", method: "tools/list", params: {} })
    });
  } catch {
    return;
  }
  if (!listed.ok) return;

  let names: string[];
  try {
    const payload = (await listed.json()) as { result?: { tools?: { name?: unknown }[] } };
    const tools = payload?.result?.tools;
    if (!Array.isArray(tools)) return;
    names = tools.map((tool) => tool?.name).filter((name): name is string => typeof name === "string");
  } catch {
    return;
  }

  const missing = SITE_CLIENT_MANAGER_TOOLS.filter((tool) => !names.includes(tool));
  if (missing.length > 0) {
    throw new SiteGenesisRefusal(
      "cms_agent_credential_scope_incomplete",
      `The generated CMS-Agent credential cannot reach ${missing.join(", ")} — admin chat would fail with an opaque 401 on those tools. Genesis stopped without exposing it.`
    );
  }
}

export async function runSiteGenesis(input: SiteGenesisInput, deps: SiteGenesisDeps): Promise<SiteGenesisResult> {
  const env = deps.env ?? process.env;
  const slug = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    throw new SiteGenesisRefusal("genesis_name_invalid", `newSite.name must be a lowercase kebab-case slug (e.g. "zilberman"); got "${input.name}".`);
  }
  const netlifySiteName = (input.netlifySiteName ?? slug).trim();
  const envPrefix = envPrefixForSlug(slug);
  const sourceOrigin = new URL(input.sourceUrl).origin;

  // The standing genesis prerequisite (T11.7 / runbook §2): a NETLIFY_API_TOKEN with site-create
  // rights, configured by NAME in this deployment. Missing is a catalogued refusal even in dry-run
  // mode — the dry run proves the sequence, not the absence of the prerequisite.
  const token = env[NETLIFY_API_TOKEN_ENV]?.trim();
  if (!token) {
    throw new SiteGenesisRefusal(
      "netlify_token_missing",
      `${NETLIFY_API_TOKEN_ENV} is not configured in this deployment. It is the standing genesis prerequisite (a Netlify personal access token with site-create rights on the target team — Netlify → User settings → Applications → New access token). Configure the value in the deployment environment; it never passes through MCP.`
    );
  }

  const mode = resolveGenesisNetlifyMode(env);
  // Validate the public endpoint before genesis performs any live side effect. In dry-run mode a
  // synthetic endpoint is sufficient because no credential is minted or sent anywhere.
  const cmsAgentPublicMcpEndpoint = mode === "live" ? resolveCmsAgentPublicMcpEndpoint(env) : env[CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV]?.trim() || "https://cms-agent.example/mcp";
  const ledger: GenesisAction[] = [];
  const platformRoot = env[PLATFORM_REPO_ROOT_ENV]?.trim();

  // 1. Scaffold (filesystem, via the platform seam) — when a checkout is mounted.
  let scaffoldExecuted = false;
  if (platformRoot) {
    const scaffold = await runCreateSiteCli(platformRoot, ["--name", slug, ...(input.netlifySiteName ? ["--netlify-site-name", netlifySiteName] : [])], { passToken: false, token });
    scaffoldExecuted = true;
    ledger.push({
      step: "scaffold",
      kind: "executed",
      detail: `create-site.mjs --json scaffolded (or found) sites/${slug}/: mode "${String(scaffold.mode)}", ${String(scaffold.plannedFiles)} planned files, ids ${JSON.stringify(scaffold.ids ?? {})}.`,
      at: now(),
      data: { mode: scaffold.mode, plannedFiles: scaffold.plannedFiles, ids: scaffold.ids, alreadyScaffolded: scaffold.alreadyScaffolded ?? null }
    });
  } else {
    ledger.push({
      step: "scaffold",
      kind: "requires_human",
      detail: `No platform checkout is mounted (${PLATFORM_REPO_ROOT_ENV} unset): the repo scaffold cannot run from this deployment and is surfaced on the human checklist — never silently skipped.`,
      at: now()
    });
  }

  // 2. Netlify half. Live mode with a checkout delegates the whole proven unit (site create + store
  // probe + auto-secrets) to create-site.mjs --provision-only; otherwise the driver's own client
  // performs (or dry-run records) the site-create primitive. Build hook + deterministic env defaults
  // are always the driver's own calls — the runbook steps T12.12 §6 marked API-capable.
  const netlify = new NetlifyGenesisClient(mode, token, deps.netlifyFetch);
  let siteId: string | undefined;
  let accountId: string | undefined;
  // The site's own serving URL as Netlify reported it; the tenant's MCP endpoint is derived from it.
  let siteUrl: string | undefined;
  if (mode === "live" && platformRoot) {
    const provision = await runCreateSiteCli(platformRoot, ["--name", slug, "--provision-only", ...(input.netlifySiteName ? ["--netlify-site-name", netlifySiteName] : [])], { passToken: true, token });
    const netlifyResult = (provision.netlify ?? null) as Record<string, unknown> | null;
    siteId = typeof netlifyResult?.siteId === "string" ? (netlifyResult.siteId as string) : undefined;
    // create_site_result.v1's safe projection already carries the site's serving URL (ssl_url||url) —
    // the endpoint is derived from it, so the delegated path needs no extra API call.
    if (typeof netlifyResult?.siteUrl === "string") siteUrl = netlifyResult.siteUrl as string;
    ledger.push({
      step: "netlify_provision_delegated",
      kind: "executed",
      detail: `create-site.mjs --provision-only provisioned the Netlify site + blob stores + auto-mintable secrets (names only): set ${JSON.stringify(netlifyResult?.secretsSet ?? [])}, failures ${JSON.stringify(netlifyResult?.secretsFailed ?? [])}.`,
      at: now(),
      data: { siteId: siteId ?? null, secretsSet: netlifyResult?.secretsSet ?? [], storeFailures: netlifyResult?.storeFailures ?? [] }
    });
  } else {
    const site = await netlify.createSite(netlifySiteName);
    siteId = site.siteId;
    accountId = site.accountId;
    siteUrl = site.url;
    if (mode === "dry_run") {
      // The delegated store-probe + auto-secret unit is create-site's; in dry-run it is recorded as
      // the intended follow-on rather than re-implemented (re-implementing secret minting here would
      // be drift by construction).
      ledger.push({
        step: "netlify_provision_delegated",
        kind: "dry_run",
        detail: `DRY-RUN: would run create-site.mjs --name ${slug} --provision-only --json under ${NETLIFY_API_TOKEN_ENV} to probe the blob stores and auto-mint + push PUBLISH_SECRET, MCP_HTTP_AUTH_TOKEN, ARTIFACT_UPLOAD_TOKEN_SECRET, TRACKING_SALT, NETLIFY_SITE_ID, PDF_TOOL_BASE_URL, PDF_TOOL_AGENT_RUN_TOKEN (values never printed or persisted).`,
        at: now()
      });
    }
  }
  if (!siteId) {
    // Only reachable on the delegated live path returning a malformed result; genesis must not
    // continue past a site whose identity it cannot name.
    throw new SiteGenesisRefusal("netlify_api_failed", "Provisioning returned no Netlify site id; build hook and env defaults cannot be applied to an unnamed site.");
  }
  {
    // Build hook (the runbook by-hand step T12.12 §6 marked API-capable — closed here) + the
    // deterministic tenancy default. In live mode without a site-level accountId (delegated
    // provisioning path), the account is resolved from the site record first.
    const hook = await netlify.createBuildHook(siteId, `site.duplicate genesis (${slug})`);
    if (mode === "live" && !accountId) {
      accountId = await netlify.getSiteAccountId(siteId);
    }
    const envAccount = accountId ?? `dryrun_account_${netlifySiteName}`;
    // NETLIFY_BUILD_HOOK_URL is a capability URL — set secret-flagged, recorded by NAME only. In
    // dry-run mode setEnvVar records the intent without a value ever existing.
    await netlify.setEnvVar(envAccount, siteId, "NETLIFY_BUILD_HOOK_URL", hook.url ?? "", { isSecret: true, scopes: ["functions"], context: "production" });
    await netlify.setEnvVar(envAccount, siteId, "TRACKING_PROJECT_ID", `trk_${slug}`);
  }

  // 3. Platform site -> CMS-Agent Client Manager credential. This is part of birth, not a human
  // checklist: mint inside the process, register only its digest, install the raw value directly in
  // Netlify, verify the CMS-Agent auth handshake, then revoke superseded managed digests. Rotation
  // overlap means an interrupted write cannot invalidate the previously installed credential.
  if (mode === "dry_run") {
    const envAccount = accountId ?? `dryrun_account_${netlifySiteName}`;
    await netlify.setEnvVar(envAccount, siteId, "CMS_AGENT_MCP_ENDPOINT", cmsAgentPublicMcpEndpoint, { scopes: ["functions"] });
    await netlify.setEnvVar(envAccount, siteId, "CMS_AGENT_MCP_TOKEN", "", { isSecret: true, scopes: ["functions"], context: "production" });
    ledger.push({
      step: "cms_agent_client_manager_credential",
      kind: "dry_run",
      detail: "DRY-RUN: would mint a per-site scoped bearer internally, persist only its digest and Client Manager policy, install CMS_AGENT_MCP_ENDPOINT plus secret/function-only CMS_AGENT_MCP_TOKEN in Netlify, verify initialize, and retire superseded managed credentials. No token would be returned or logged.",
      at: now(),
      data: { projectId: slug, toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS], netlifySiteId: siteId }
    });
  } else {
    const envAccount = accountId ?? await netlify.getSiteAccountId(siteId);
    const credentials = deps.credentialRepository ?? new ManagedScopedBearerCredentialRepository();
    const minted = await credentials.mint({ projectId: slug, toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS], netlifySiteId: siteId, netlifySiteName });
    try {
      await netlify.setEnvVar(envAccount, siteId, "CMS_AGENT_MCP_ENDPOINT", cmsAgentPublicMcpEndpoint, { scopes: ["functions"] });
      await netlify.setEnvVar(envAccount, siteId, "CMS_AGENT_MCP_TOKEN", minted.token, { isSecret: true, scopes: ["functions"], context: "production" });
      await verifyCmsAgentScopedCredential(cmsAgentPublicMcpEndpoint, minted.token, deps.credentialFetch);
      await credentials.activateAndRetireOtherProjectCredentials(slug, minted.digest);
    } catch (error) {
      try {
        await credentials.revokeCredential(minted.digest);
      } catch {
        throw new SiteGenesisRefusal("credential_cleanup_failed", "The generated CMS-Agent credential could not be installed and its pending registry entry could not be revoked. Genesis stopped without exposing it.");
      }
      throw error;
    }
    ledger.push({
      step: "cms_agent_client_manager_credential",
      kind: "executed",
      detail: "Minted, installed, and verified the site's scoped Client Manager credential; only its digest and authorization policy were persisted. Superseded managed credentials were retired.",
      at: now(),
      data: { projectId: slug, toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS], netlifySiteId: siteId }
    });
  }
  ledger.push(...netlify.actions);

  // 4. CMS-Agent registration — the registration contract's step 1: the token by env var NAME (a
  // secret value never transits MCP), the DERIVED endpoint stored on the record so no human ever
  // sets <SLUG>_MCP_ENDPOINT, plus the conservative seeded capture policy that authorizes exactly
  // the requested source origin.
  const seededCapturePolicy = seededGenesisCapturePolicy(sourceOrigin);
  const mcpEndpoint = input.mcpEndpoint?.trim() || deriveTenantMcpEndpoint(netlifySiteName, siteUrl);
  const project = await createProject(deps.projectRepository, {
    projectId: slug,
    clientSiteBinding: { netlifySiteName, netlifySiteId: siteId },
    name: slug,
    mcpEndpointEnvVar: `${envPrefix}_MCP_ENDPOINT`,
    mcpEndpoint,
    authMode: "bearer_env",
    tokenEnvVar: `${envPrefix}_MCP_TOKEN`,
    allowedTools: [],
    // The emission stage's governed verbs (drafts-only; the forbidden publish/release/build/deploy
    // verbs are refused pre-transport regardless of this list — see captureEngine).
    defaultToolPolicy: "allowed",
    contentContract: { contentContract: "content_source.v1" },
    capturePolicy: seededCapturePolicy,
    status: "active"
  });
  ledger.push({
    step: "register_project",
    kind: "executed",
    detail: `project.create registered "${slug}" with the endpoint ${mcpEndpoint} stored ON the record (${input.mcpEndpoint ? "supplied by the caller" : "derived from the minted Netlify site"} — an endpoint URL is not a secret, so no ${envPrefix}_MCP_ENDPOINT has to be set on this deployment; that env var stays an override) and the bearer token by NAME only (${envPrefix}_MCP_TOKEN — a secret value never transits MCP), plus a conservative capture policy scoped to ${sourceOrigin} (rights prohibited: copy regenerated, media never imported).`,
    at: now(),
    data: { projectId: slug, mcpEndpoint, mcpEndpointSource: input.mcpEndpoint ? "caller_supplied" : "derived_from_netlify_site", mcpEndpointEnvVar: `${envPrefix}_MCP_ENDPOINT`, tokenEnvVar: `${envPrefix}_MCP_TOKEN`, clientSiteBinding: { netlifySiteName, netlifySiteId: siteId }, allowedCrawlOrigins: [sourceOrigin] }
  });

  const humanChecklist = buildGenesisHumanChecklist({ slug, netlifySiteName, envPrefix, scaffoldExecuted, netlifyMode: mode, registeredMcpEndpoint: mcpEndpoint });
  return {
    projectId: slug,
    netlifyMode: mode,
    netlifySiteName,
    ...(siteId ? { netlifySiteId: siteId } : {}),
    envVarNames: { endpoint: `${envPrefix}_MCP_ENDPOINT`, token: `${envPrefix}_MCP_TOKEN` },
    mcpEndpoint,
    seededCapturePolicy,
    project,
    ledger,
    humanChecklist
  };
}
