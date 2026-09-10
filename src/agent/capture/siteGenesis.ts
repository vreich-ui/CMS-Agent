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
//     4. Deterministic env defaults — TRACKING_PROJECT_ID=<slug>, the BARE slug. That is the tracking
//        SINK's partition id: the sink answers `/api/tracking-sink/stats?project_id=<slug>`, and a
//        site that leaves TRACKING_PROJECT_ID unset falls back to its own siteShortId (platform's
//        track-ingest function) — the bare slug again. `trk_<slug>` is a DIFFERENT id: the per-tenant
//        tracking_config OBJECT (platform's site identity calls it trackingProjectId, "tracking
//        project OBJECT id"). Genesis used to install THAT one here, so every genesis-provisioned
//        tenant wrote into a partition nothing ever reads. Derived instead of human-decided;
//        override any time in the Netlify console.
//     4b. Fleet tracking/deploy values — TRACKING_SINK_URL, TRACKING_SINK_TOKEN and NETLIFY_AUTH_TOKEN
//        are installed from THIS deployment's own environment when it holds them (the same var NAME
//        on both sides: "reuse the existing fleet values, never mint per-client copies"). Setting up
//        tracking is part of birth, not a per-tenant paste job. A value this deployment does not
//        hold is never invented and never written empty — the human checklist entry stays as the
//        fallback and says which half is missing.
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
//   pdf-tool storage grant (a new Netlify machine account — no API mints accounts), the tracking
//   sink connection and NETLIFY_AUTH_TOKEN *only when this deployment does not hold the fleet value*
//   (see 4b — when it does, genesis installs them and the checklist entry shrinks accordingly),
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

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createProject } from "../projects/projectAdmin.js";
import type { ProjectCapturePolicy, ProjectSummary } from "../projects/projectTypes.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ManagedScopedBearerCredentialRepository } from "../mcp/auth/managedScopedBearerCredentials.js";
import { TRACKING_SINK_TOKEN_ENV, TRACKING_SINK_URL_ENV } from "../improvement/trackingIngest.js";
import { createSecretVersion } from "../projects/secretManager.js";
import { genesisTenantProfile } from "../projects/genesisTenantProfile.js";
import { genesisEditorialVoiceFallback } from "../projects/genesisEditorialVoice.js";
import {
  activeGenesisPolicy,
  genesisArtifactCliArgs,
  genesisArtifactRefusalMessage,
  genesisArtifactWaysOut,
  missingGenesisArtifacts
} from "./genesisPolicy.js";

const execFileAsync = promisify(execFile);

export const NETLIFY_API_TOKEN_ENV = "NETLIFY_API_TOKEN";
// The tenant site's own fleet-shared Netlify token (T11.7 env table). Distinct from
// NETLIFY_API_TOKEN above, which is genesis's OWN site-create credential.
export const NETLIFY_AUTH_TOKEN_ENV = "NETLIFY_AUTH_TOKEN";
export const PLATFORM_REPO_ROOT_ENV = "PLATFORM_REPO_ROOT";
export const SITE_GENESIS_NETLIFY_MODE_ENV = "SITE_GENESIS_NETLIFY_MODE";
// G1 — where a minted tenant's bearer is taken into custody. Falls back to the reconciler's project
// (the same GCP project every tenant secret already lives in) and then to the ambient Cloud Run
// project, so a correctly-configured plane needs no new variable at all; an unset one degrades to
// the human checklist rather than guessing a project to write secrets into.
export const GENESIS_SECRET_MANAGER_PROJECT_ENV = "GENESIS_SECRET_MANAGER_PROJECT";
// G7 — the DEPLOY binding. A Netlify site with no repo attached builds nothing, so genesis-lab-2 was
// born as a site waiting for a human in the console; the hand path then offers the monorepo "package
// directory", which leaves config resolution at the REPO ROOT and hands the new tenant dr-lurie's
// netlify.toml. That is the whole failure. What the binding must be instead:
//
//     base = sites/<slug>   package_path = ""   cmd = ""   dir/functions_dir from the per-site toml
//
// `base` is what makes Netlify read sites/<slug>/netlify.toml — the scaffolded file says so in its
// own header — and an empty cmd is what lets that file's build command win.
//
// Everything identity-bearing (which repo, which GitHub App installation) is COPIED from a site that
// already builds rather than configured here: the fleet has exactly one repo, and a copied value
// follows it if that ever changes. No GitHub App handshake is needed when the App is already
// installed on the account (proven birthing kugel-fernwell, T14.3-checklist 2026-07-27).
export const GENESIS_DEPLOY_REFERENCE_SITE_ENV = "GENESIS_DEPLOY_REFERENCE_SITE";
export const GENESIS_DEPLOY_REFERENCE_SITE_DEFAULT = "zilbermanfilmfoundation";
const genesisDeployReferenceSite = (env: NodeJS.ProcessEnv): string =>
  env[GENESIS_DEPLOY_REFERENCE_SITE_ENV]?.trim() || GENESIS_DEPLOY_REFERENCE_SITE_DEFAULT;
/** What genesis reads back off a Netlify site to decide whether it is bound, and bound CORRECTLY. */
export type NetlifyBuildSettings = {
  repoPath?: string;
  repoUrl?: string;
  provider?: string;
  installationId?: number;
  base?: string;
  packagePath?: string;
  cmd?: string;
};

/**
 * Is this site attached to SOME repo? Deliberately generous — any of four fields counts.
 *
 * This predicate decides whether genesis is allowed to write, so its failure mode must be "declines
 * to touch a site it should have configured" (a checklist item) and never "overwrites a live
 * tenant's own binding" (an outage). A site linked outside the GitHub App flow can carry repo_url
 * and no repo_path; keying on repo_path alone would read that as unbound and re-point it.
 */
export const isAttachedToRepo = (settings: NetlifyBuildSettings): boolean =>
  Boolean(settings.repoPath || settings.repoUrl || settings.installationId !== undefined || settings.provider);

/** The build binding a tenant is born with. `base` is the load-bearing field. */
export type GenesisDeployBinding = {
  provider: string;
  repoPath: string;
  repoBranch: string;
  installationId?: number;
  base: string;
};
const genesisSecretProject = (env: NodeJS.ProcessEnv): string | undefined =>
  env[GENESIS_SECRET_MANAGER_PROJECT_ENV]?.trim()
  || env.SITE_CREDENTIAL_RECONCILER_GCP_PROJECT?.trim()
  || env.GOOGLE_CLOUD_PROJECT?.trim()
  || undefined;
/** The secret id a tenant's inbound bearer lives under. Matches the convention already in production
 *  (zilberman: projects/cms-agent-503015/secrets/zilberman-mcp-token/versions/latest). */
export const tenantTokenSecretId = (slug: string): string => `${slug}-mcp-token`;
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
// lockstep with Platform's bridge; `siteClientManagerScope.test.ts` pins it.
//
// IT HAPPENED AGAIN (2026-08-24). Platform's W19 approve button — the control on the activity card
// that clears a run waiting at `publication_controller` — calls `workflow_set_operator_publish_decision`
// and `workflow_get_run_cost` from `admin-request-activity.ts`. Neither was here, so both were
// refused at the door with the same opaque 401, and the operator spent the afternoon rotating a
// credential that was never wrong. Note what did NOT help: editing `MCP_SCOPED_TOKENS_JSON`.
// A managed credential SUPERSEDES the static map for its projects
// (`findAnyScopedBearerTokenPolicy`), so for any genesis-owned tenant the env JSON is dead config —
// this constant is the only lever, and widening it requires a reconcile to re-mint.
//
// The rule this keeps re-teaching: adding a `ctx.cmsAgent.callTool(...)` anywhere in Platform is
// half a change. The other half is here.
export const SITE_CLIENT_MANAGER_TOOLS = [
  "agent_resolve",
  "agent_converse",
  "workspace_get_nodes",
  "workflow_start_dry_run",
  "workflow_run_all",
  "workflow_get_run",
  "workflow_get_run_cost",
  "workflow_publish_readiness",
  "workflow_publish_run",
  "workflow_set_operator_publish_decision",
  // A1/D1 (2026-09-04): the narrow site-scoped writer door. Platform's `brand_imagery_propose`
  // calls it. It is here INSTEAD of `node_execute`, which must never reach a tenant bearer —
  // see visualIdentityTools.ts's header and ruling R1.
  "visual_identity_propose",
  // T5 (S-07, partial): two more run-addressed tools, both scoped to the project's own runs the same
  // way workflow_get_run/workflow_get_run_cost already are. Deliberately NOT widened further this
  // wave — workflow_retry_node, workflow_set_node_budget_override and
  // workspace_update_node_model_config (workspace-wide mutation) each need a decision out of scope
  // there.
  "node_get_latest_output",
  "workflow_cancel_run",
  // S-07 (completing T5): Platform's Analytics → Insights tab. Both were previously refused at the
  // door because neither record type carried a project, so there was nothing to partition on and
  // granting them would have returned every tenant's rows. Both record types now carry an optional
  // projectId (improvementTypes.ts, store.ts), both list tools filter on it, and — crucially —
  // mcpEndpoint.ts's PROJECT_REQUIRED_SCOPED_TOOLS refuses either of these from a scoped bearer that
  // supplies no project at all. Without that third piece these two entries would be a leak, not a
  // fix: the unfiltered call returns the whole workspace.
  //
  // playbook_get and optimizer_status STAY OUT, deliberately, and the Insights tab's two remaining
  // cards are being handled on the Platform side instead. Both are keyed by NODE, and nodes are
  // workspace-wide — one shared graph every tenant's runs execute. There is no project to partition
  // by, so "scope it like the other two" is not a smaller version of this change, it is impossible;
  // granting them would hand one tenant the workspace's shared learning state (every other tenant's
  // curated playbook lessons and optimizer proposals).
  "feedback_list",
  "learning_list_observations"
] as const;

export type GenesisNetlifyMode = "dry_run" | "live";

export class SiteGenesisRefusal extends Error {
  // `safeSummary` is the part of a refusal that is safe to REPORT, as opposed to `message`, which
  // may carry an upstream response body. A caller writing a machine-readable result line (the
  // credential reconciler's site_credential_reconcile.v1) can surface this verbatim without
  // breaking the "no bearer, no response body" rule that keeps those lines publishable. Absent by
  // design on refusals that carry no safe detail worth repeating.
  // W3 (Wolf, 2026-09-09): `genesis_artifact_required` needs two more fields to be ACTIONABLE
  // rather than merely classified — WHICH input fields are missing, and the ways out. They are own
  // properties rather than a nested bag, following ConverseError's precedent, because that is the
  // shape `toolKit.codedError` lifts onto the wire envelope. Optional and unused by every other
  // refusal, so nothing else changes shape.
  readonly missing?: string[];
  readonly waysOut?: string[];

  constructor(
    readonly code: string,
    message: string,
    readonly safeSummary?: string,
    details?: { missing?: string[]; waysOut?: string[] }
  ) {
    super(`${code}: ${message}`);
    this.name = "SiteGenesisRefusal";
    if (details?.missing) this.missing = details.missing;
    if (details?.waysOut) this.waysOut = details.waysOut;
  }
}

// One audited genesis action. kind:
//   executed       — really performed (filesystem scaffold, registry write, live Netlify call).
//   dry_run        — the Netlify dry-run mode recorded the exact intended call without network.
//   requires_human — outside account authority in this environment; mirrored verbatim into the
//                    humanChecklist. NEVER silently dropped: absence of capability is itself audited.
//   executed_unverified — the WRITE really happened, but the check that would prove it works cannot
//                    run yet and is deferred to a re-runnable caller (project.test_connection, the
//                    credential reconciler). Introduced for tenant token custody (G1): a freshly
//                    minted tenant has no deployed /mcp at all until its repo tree is committed and
//                    built, and a Netlify functions env var needs a redeploy to take effect anyway.
//                    Verifying inline would therefore fail on EVERY birth and demote a step that
//                    genuinely succeeded back onto the human checklist — which is exactly the
//                    outcome custody was meant to remove. This is a steady state, not a fault.
export type GenesisAction = {
  step: string;
  kind: "executed" | "dry_run" | "requires_human" | "executed_unverified";
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
  // C3: what birth did (or precisely planned) about the site's look and its default PDF template.
  visualIdentity: GenesisVisualIdentityPlan;
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
// FLEET-SHARED VALUES GENESIS INSTALLS (T21.8).
//
// "Setting up tracking for a new tenant has to be part of the genesis process not manually" (Wolf,
// 2026-09-01). These three were a per-tenant copy-paste chore on the human checklist, for no reason
// that survives inspection: they are fleet-shared values — the SAME value on every tenant, already
// present in this deployment's own environment under the SAME name (the T11.7 env table's "reuse the
// existing fleet values, never mint per-client copies"). So genesis reads them from `env` and pushes
// them onto the new site itself. No new config mechanism: the source is the env var NAME genesis is
// already configured with, exactly like NETLIFY_API_TOKEN and CMS_AGENT_PUBLIC_MCP_ENDPOINT.
//
// SCOPES ARE LOAD-BEARING, and their absence caused a live bug. On drluriescience these three were
// scoped `functions` only, so the site repo's `postbuild` step (scripts/tracking-dims-push.mjs,
// which reads TRACKING_SINK_URL/TRACKING_SINK_TOKEN/TRACKING_PROJECT_ID at BUILD time) silently
// no-opped and the tracking `dims` counters sat at zero. Every tracking var genesis installs
// therefore carries setEnvVar's DEFAULT scope set, which includes `builds` as well as `functions` —
// do not narrow these to ["functions"] the way the credential vars below legitimately are.
//
// A value this deployment does not hold is NEVER invented and never written empty: it drops out of
// the provisioning list and its human checklist entry stays, saying which half is missing.
/**
 * INHERITED, NOT COPIED (C-11).
 *
 * `TRACKING_SINK_URL` and `TRACKING_SINK_TOKEN` are ACCOUNT-level Netlify variables on the `vreich`
 * team, scoped to builds and functions across all contexts. Every site in the account already reads
 * them; there is exactly one value, and it is the one the sink itself validates against.
 *
 * Genesis used to write a per-site COPY of each anyway. That copy is not a safety net — it is a
 * second source of truth that silently wins over the first, because a site-level variable overrides
 * the account-level one. On 2026-09-07 that cost a tenant: `drluriescience` carried a site-level
 * `TRACKING_SINK_TOKEN` holding a 20-character value the sink had long since stopped accepting,
 * left behind when the account token was rotated to a different value and the copy was not. The site
 * kept working only because Netlify snapshots env vars into functions at DEPLOY time and it had not
 * been redeployed since — so the next rebuild for any reason, publishing an article included, would
 * have baked in the dead token and stopped that tenant's tracking with nothing reporting it.
 *
 * So genesis no longer writes them. It CHECKS THEM BY NAME against the account and records the
 * result, which is the whole of what a new site needs: the account value is already in scope, and an
 * absent account value is a human step, not something to paper over with a copy that will drift.
 *
 * `NETLIFY_AUTH_TOKEN` is NOT in this class and is still copied per site: it is not an account-level
 * variable on this team, and nothing has established that it should be. Do not move a key here
 * without confirming the account-level variable actually exists — inheriting a value that is not
 * there installs nothing at all.
 */
export const GENESIS_FLEET_ENV_VARS: ReadonlyArray<{ key: string; isSecret: boolean; inherited: boolean; why: string }> = [
  // The sink URL is not a bearer on its own, but the platform scaffold already inherits it as a
  // secret-flagged variable (create-site.mjs's `inheritedEnvKey` block). The flag is retained here so
  // that the account-level variable's own posture is described accurately, even though genesis no
  // longer writes a site-level copy of it.
  { key: TRACKING_SINK_URL_ENV, isSecret: true, inherited: true, why: "tracking sink endpoint (build + function time), account-level" },
  { key: TRACKING_SINK_TOKEN_ENV, isSecret: true, inherited: true, why: "tracking sink bearer, account-level — one value, rotated in one place" },
  { key: NETLIFY_AUTH_TOKEN_ENV, isSecret: true, inherited: false, why: "fleet-shared Netlify token the tenant's own tooling uses" }
];

export type GenesisFleetEnvResolution = {
  /** Fleet vars genesis COPIES onto the new site, because this deployment holds them. */
  provisioned: Array<{ key: string; value: string; isSecret: boolean }>;
  /** Account-level fleet vars the new site INHERITS — verified by name, never written. */
  inherited: string[];
  /** Copied fleet vars this deployment does NOT hold — they stay human checklist items. */
  missing: string[];
};

/**
 * Split the fleet-shared env vars three ways: what genesis copies, what the site inherits from the
 * account, and what stays a human step.
 *
 * An inherited key is never read from this deployment's environment for its VALUE — whether this
 * process happens to hold a copy says nothing about what the account holds, and acting on it is how
 * the two drifted apart in the first place.
 */
export const resolveGenesisFleetEnvVars = (env: NodeJS.ProcessEnv): GenesisFleetEnvResolution => {
  const provisioned: GenesisFleetEnvResolution["provisioned"] = [];
  const inherited: string[] = [];
  const missing: string[] = [];
  for (const { key, isSecret, inherited: isInherited } of GENESIS_FLEET_ENV_VARS) {
    if (isInherited) { inherited.push(key); continue; }
    const value = env[key]?.trim();
    if (value) provisioned.push({ key, value, isSecret });
    else missing.push(key);
  }
  return { provisioned, inherited, missing };
};

// ---------------------------------------------------------------------------------------------
// Netlify API client with a first-class dry-run mode. In dry_run NOTHING touches the network: the
// intended call is recorded on the ledger with a synthetic id. In live mode the calls mirror the
// platform CLI's proven request shapes (create-site.mjs). The bearer token is only ever placed in
// the Authorization header; error bodies from secret-bearing writes are never echoed.
export type NetlifyFetch = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string>; headers?: { get: (name: string) => string | null } }>;

// A non-2xx from Netlify is not one failure mode but two: a REFUSAL (bad credential, invalid
// payload, missing resource) and a WOBBLE (the API is briefly unavailable or rate-limiting).
// Collapsing them into one terminal `netlify_api_failed` is how a short upstream degradation
// turned into a fleet-wide `failed` with exit(1) — indistinguishable, from the outside, from a
// revoked token. 429 and 5xx are retried with backoff; every other status refuses immediately,
// because retrying a 401 or a 422 only delays the same answer.
const isRetryableNetlifyStatus = (status: number): boolean => status === 429 || (status >= 500 && status < 600);
const NETLIFY_REQUEST_MAX_ATTEMPTS = 3;
const NETLIFY_REQUEST_BACKOFF_MS = [250, 1_000];

// METHOD, path and status ONLY. No query string (site ids and key names already travel in the
// result line; nothing else there is worth the risk of a token landing in a query param one day),
// no response body, no headers.
const netlifyCallSummary = (method: string, url: string, status: number): string => `${method} ${new URL(url).pathname} HTTP ${status}`;

// The deploy contexts a SECRET env var may occupy. Netlify refuses a secret written with context
// "all" because "all" includes `dev`, and the dev context forbids secret values — so a secret is
// always written as these three explicit contexts instead. (Learned live: the `all` write is a 4xx
// that says nothing useful about why.)
export const NETLIFY_SECRET_CONTEXTS = ["production", "deploy-preview", "branch-deploy"] as const;

// setEnvVar's default scope set. `builds` is in here and must stay in here for every tracking var:
// the tenant repo's postbuild step reads the tracking env at BUILD time, and a functions-only scope
// makes it silently no-op (the live drluriescience bug — T21.8).
export const NETLIFY_DEFAULT_ENV_SCOPES = ["builds", "functions", "runtime", "post_processing"] as const;

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
    let response!: Awaited<ReturnType<NetlifyFetch>>;
    for (let attempt = 0; attempt < NETLIFY_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (response.ok || !isRetryableNetlifyStatus(response.status)) break;
      const backoff = NETLIFY_REQUEST_BACKOFF_MS[attempt];
      if (backoff === undefined) break;
      await this.sleepImpl(backoff);
    }
    if (!response.ok) {
      const detail = redactErrorBody ? "" : ` ${(await response.text?.().catch(() => "")) ?? ""}`.trimEnd();
      throw new SiteGenesisRefusal(
        "netlify_api_failed",
        `${method} ${new URL(url).pathname} failed: HTTP ${response.status}${detail}`,
        netlifyCallSummary(method, url, response.status)
      );
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

  /**
   * Read the deploy binding of a site that already builds, so a new tenant inherits it.
   *
   * Two reads, not one: the LIST endpoint locates the site by name, and the single-site GET is what
   * the binding is read from. The list projection is not guaranteed to carry `installation_id`, and
   * a repo attached without the GitHub App installation is a site Netlify cannot clone — a failure
   * that looks exactly like a correct binding from every field this code checks.
   */
  async readDeployBinding(referenceSiteName: string): Promise<{ provider: string; repoPath: string; repoBranch: string; installationId: number } | undefined> {
    if (this.mode === "dry_run") return { provider: "github", repoPath: "vreich-ui/platform", repoBranch: "main", installationId: 0 };
    const found = (await this.request("GET", `https://api.netlify.com/api/v1/sites?name=${encodeURIComponent(referenceSiteName)}`)) as unknown;
    const listed = Array.isArray(found) ? (found as Array<Record<string, unknown>>).find((candidate) => candidate.name === referenceSiteName) : undefined;
    const referenceId = typeof listed?.id === "string" ? listed.id : "";
    if (!referenceId) return undefined;
    const site = (await this.request("GET", `https://api.netlify.com/api/v1/sites/${encodeURIComponent(referenceId)}`)) as Record<string, unknown>;
    const settings = site.build_settings && typeof site.build_settings === "object" ? (site.build_settings as Record<string, unknown>) : {};
    const repoPath = typeof settings.repo_path === "string" ? settings.repo_path : "";
    const installationId = typeof settings.installation_id === "number" ? settings.installation_id : undefined;
    // Both or neither. Copying a repo without the installation that grants access to it produces a
    // site that passes every check here and fails every clone.
    if (!repoPath || installationId === undefined) return undefined;
    return {
      provider: typeof settings.provider === "string" ? settings.provider : "github",
      repoPath,
      repoBranch: typeof settings.repo_branch === "string" ? settings.repo_branch : "main",
      installationId
    };
  }

  /**
   * Attach the repo and set the base directory, then RE-READ to confirm the write persisted.
   *
   * Two reasons for the re-read rather than trusting the response. Netlify has at least one
   * documented write on this object that returns success and silently does not persist (the Identity
   * external-provider body, T14.3-checklist), and the PATCH body shape for a build binding is not
   * pinned by any doc we control — so this tries the documented `repo` envelope first and falls back
   * to a flat `build_settings` before giving up. Whichever one the account actually accepts is the
   * one the verification sees.
   *
   * WHAT COUNTS AS BOUND is the whole point, and it is four fields, not one:
   *   repo attached · base = sites/<slug> · NO package directory · NO build command
   * A site with the repo and nothing else is the kugel-genesis-lab-2 failure — it builds, from the
   * repo-root netlify.toml, as another tenant. So "already has a repo" is not a reason to call this
   * done; it is only a reason not to overwrite it.
   */
  async bindRepository(
    siteId: string,
    binding: GenesisDeployBinding
  ): Promise<{ bound: boolean; skipped?: "already_bound"; observed?: NetlifyBuildSettings }> {
    const shape = {
      provider: binding.provider,
      repo: binding.repoPath,
      repo_path: binding.repoPath,
      repo_branch: binding.repoBranch,
      branch: binding.repoBranch,
      installation_id: binding.installationId,
      base: binding.base,
      // The two fields that caused the failure this step exists to prevent: package_path must be
      // EMPTY (a set one moves config resolution to the repo root) and cmd must be EMPTY (so the
      // per-site netlify.toml's real build command is the one that runs). Netlify's framework
      // detection populates cmd on its own when a repo is linked, which is why it is re-checked
      // after the write rather than assumed.
      package_path: "",
      cmd: ""
    };
    const wanted = { repoPath: binding.repoPath, base: binding.base, packagePath: "", cmd: "" };

    if (this.mode === "dry_run") {
      // PLANNED, never `bound`. Nothing was written and nothing was verified, and a checklist that
      // says otherwise sends an operator away from a site that will not build.
      this.record(
        "netlify_deploy_binding",
        `DRY-RUN: would PATCH /api/v1/sites/${siteId} binding ${binding.repoPath}#${binding.repoBranch} with base "${binding.base}", package_path "" and cmd "" (so sites/<slug>/netlify.toml is the config Netlify reads), then re-read to confirm all four persisted.`,
        { siteId, repoPath: binding.repoPath, base: binding.base }
      );
      return { bound: false };
    }

    const before = await this.readSiteBuildSettings(siteId);
    if (isAttachedToRepo(before)) {
      // Never re-point a site that is already attached. createSite is idempotent, so a second genesis
      // run resolves the LIVE tenant — and an operator who moved a base directory, or pointed a
      // tenant at its own repo, must not have that decision silently reverted at re-mint.
      const correct = before.repoPath === binding.repoPath && before.base === binding.base && !before.packagePath && !before.cmd;
      if (correct) {
        this.record("netlify_deploy_binding", `Site ${siteId} is already bound to ${before.repoPath} with base "${before.base}" and no package directory. Left untouched.`, {
          siteId,
          skipped: "already_bound",
          ...before
        });
        return { bound: true, skipped: "already_bound", observed: before };
      }
      // Attached but WRONG — the state a failed first attempt leaves behind, and the state the
      // console's monorepo option produces. Genesis refuses to overwrite it and refuses to call it
      // done; a human decides, because this may equally be a deliberate operator change.
      this.actions.push({
        step: "netlify_deploy_binding",
        kind: "requires_human",
        detail: `Site ${siteId} is already attached to a repo, so genesis did not overwrite it — but the binding is not what this tenant needs. It reads repo "${before.repoPath ?? ""}", base "${before.base ?? ""}", package_path "${before.packagePath ?? ""}", cmd "${before.cmd ?? ""}"; it needs repo "${binding.repoPath}", base "${binding.base}", package directory EMPTY and build command EMPTY. A package directory is what makes Netlify read the repo-root netlify.toml and build another tenant's config.`,
        at: now(),
        data: { siteId, skipped: "already_bound", wanted, observed: before }
      });
      return { bound: false, skipped: "already_bound", observed: before };
    }

    const errors: string[] = [];
    let observed = before;
    for (const body of [{ repo: shape }, { build_settings: shape }]) {
      const envelope = "repo" in body ? "repo" : "build_settings";
      await this.request("PATCH", `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`, body).catch((error: unknown) => {
        // A refusal here is data, not a reason to abort: the second envelope may still be accepted,
        // and if neither is, the operator needs every error — a 403 (the token cannot write build
        // settings) and a 422 (the body was malformed) are different fixes.
        errors.push(`${envelope}: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      });
      observed = await this.readSiteBuildSettings(siteId);
      if (observed.repoPath === binding.repoPath && observed.base === binding.base && !observed.packagePath && !observed.cmd) {
        this.record(
          "netlify_deploy_binding",
          `Bound site ${siteId} to ${binding.repoPath}#${binding.repoBranch} with base "${binding.base}" (package directory and build command both cleared, so sites/${binding.base.split("/").pop()}/netlify.toml supplies the build). Verified by re-reading all four fields.`,
          { siteId, repoPath: binding.repoPath, base: binding.base, envelope }
        );
        return { bound: true, observed };
      }
    }

    this.actions.push({
      step: "netlify_deploy_binding",
      kind: "requires_human",
      detail: `Could not confirm a deploy binding on site ${siteId}: after PATCHing both accepted body shapes the site still reads repo "${observed.repoPath ?? ""}", base "${observed.base ?? ""}", package_path "${observed.packagePath ?? ""}", cmd "${observed.cmd ?? ""}".${errors.length ? ` API errors: ${errors.join(" | ")}.` : ""} Set it in the Netlify console instead — base directory "${binding.base}", package directory EMPTY, build command EMPTY.`,
      at: now(),
      data: { siteId, wanted, observed, ...(errors.length ? { errors } : {}) }
    });
    return { bound: false, observed };
  }

  private async readSiteBuildSettings(siteId: string): Promise<NetlifyBuildSettings> {
    const site = (await this.request("GET", `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`)) as Record<string, unknown>;
    const settings = site.build_settings && typeof site.build_settings === "object" ? (site.build_settings as Record<string, unknown>) : {};
    const text = (key: string): string | undefined => (typeof settings[key] === "string" && settings[key] ? (settings[key] as string) : undefined);
    return {
      repoPath: text("repo_path"),
      repoUrl: text("repo_url"),
      provider: text("provider"),
      installationId: typeof settings.installation_id === "number" ? settings.installation_id : undefined,
      base: typeof settings.base === "string" ? settings.base : undefined,
      packagePath: text("package_path"),
      cmd: text("cmd")
    };
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
  // non-secret deterministic default, a capability URL, or a fleet-shared value flagged isSecret;
  // the ledger records the NAME (plus scopes and contexts), never the value.
  //
  // SECRETS ARE PER-CONTEXT, NEVER `all` — a Netlify constraint hit live: `all` includes the `dev`
  // context, and `dev` forbids secret values, so writing a secret with context "all" is refused by
  // the API. A caller that asks for a secret without naming contexts therefore gets the three
  // contexts a secret may legally occupy (production, deploy-preview, branch-deploy) rather than a
  // request that cannot succeed. Passing `context: "all"` explicitly for a secret is a bug, and is
  // refused here rather than at Netlify with an opaque 4xx.
  /**
   * Does the ACCOUNT-level env var exist, by name (C-11)?
   *
   * Names only. The response body is never read, so the value cannot leak into a ledger, a log or a
   * project record — existence is the entire question. Deliberately queries the account collection
   * WITHOUT `?site_id=`, because with a site id Netlify answers with the value that site would see,
   * which is exactly the site-level copy this check exists to stop relying on.
   *
   * A 404 is a clean "no" rather than a failure: the caller turns it into a human checklist entry.
   * Any other non-2xx is a genuine API problem and refuses, because "we could not tell" must never
   * be recorded as "the tenant is configured".
   */
  async accountEnvVarExists(accountId: string, key: string): Promise<boolean> {
    if (this.mode === "dry_run") {
      this.record("netlify_check_env", `DRY-RUN: would check whether account-level env var ${key} exists (name only; no value is read).`, { key });
      return true;
    }
    const url = `https://api.netlify.com/api/v1/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`;
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (response.status === 404) {
      this.record("netlify_check_env", `Account-level env var ${key} is NOT set on this team.`, { key, present: false });
      return false;
    }
    if (!response.ok) {
      throw new SiteGenesisRefusal(
        "netlify_api_failed",
        `Netlify account env-var lookup failed for ${key}: HTTP ${response.status}`,
        netlifyCallSummary("GET", url, response.status)
      );
    }
    this.record("netlify_check_env", `Account-level env var ${key} is present; the new site inherits it (name only; no value is read).`, { key, present: true });
    return true;
  }

  async setEnvVar(
    accountId: string,
    siteId: string,
    key: string,
    value: string,
    { isSecret = false, scopes = [...NETLIFY_DEFAULT_ENV_SCOPES], context, contexts, onlyIfAbsent = false }: { isSecret?: boolean; scopes?: string[]; context?: string; contexts?: string[]; onlyIfAbsent?: boolean } = {}
  ): Promise<void> {
    const requested = contexts ?? (context ? [context] : undefined);
    const valueContexts = requested ?? (isSecret ? [...NETLIFY_SECRET_CONTEXTS] : ["all"]);
    if (isSecret && valueContexts.includes("all")) {
      throw new SiteGenesisRefusal(
        "netlify_secret_context_invalid",
        `Env var ${key} is secret and cannot be written with context "all" (that includes the dev context, which forbids secrets). Write it per-context: ${NETLIFY_SECRET_CONTEXTS.join(", ")}.`
      );
    }
    if (this.mode === "dry_run") {
      this.record("netlify_set_env", `DRY-RUN: would ${onlyIfAbsent ? "set env var ${key} on site ${siteId} ONLY IF it is not already set" : `set env var ${key} on site ${siteId}`} (name, scopes and contexts recorded; value never logged).`.replace("${key}", key).replace("${siteId}", siteId), { siteId, key, isSecret, scopes, contexts: valueContexts, ...(onlyIfAbsent ? { onlyIfAbsent: true } : {}) });
      return;
    }
    const keyUrl = `https://api.netlify.com/api/v1/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}?site_id=${encodeURIComponent(siteId)}`;
    const collectionUrl = `https://api.netlify.com/api/v1/accounts/${encodeURIComponent(accountId)}/env?site_id=${encodeURIComponent(siteId)}`;
    const existing = await this.fetchImpl(keyUrl, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!existing.ok && existing.status !== 404) {
      throw new SiteGenesisRefusal(
        "netlify_api_failed",
        `Netlify env-var lookup failed for ${key}: HTTP ${existing.status}`,
        netlifyCallSummary("GET", keyUrl, existing.status)
      );
    }
    // G4 — `onlyIfAbsent` exists because createSite is IDEMPOTENT: a second genesis run against the
    // same site name resolves the existing site rather than creating one, so an unconditional write
    // of a genesis-supplied DEFAULT would silently discard whatever the operator curated since birth
    // (extra ingest hosts, co-owners on ADMIN_EMAILS). A default is only a default the first time.
    if (onlyIfAbsent && existing.ok) {
      this.record("netlify_set_env", `Left existing env var ${key} on site ${siteId} untouched: genesis only supplies it as a birth default (name recorded; no value is read or written).`, { siteId, key, skipped: "already_set" });
      return;
    }
    const variable = { key, scopes, values: valueContexts.map((valueContext) => ({ value, context: valueContext })), ...(isSecret ? { is_secret: true } : {}) };
    await this.request(existing.ok ? "PUT" : "POST", existing.ok ? keyUrl : collectionUrl, existing.ok ? variable : [variable], { redactErrorBody: true });
    this.record("netlify_set_env", `Set env var ${key} on site ${siteId} (name, scopes and contexts recorded; value never logged).`, { siteId, key, isSecret, scopes, contexts: valueContexts });
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
// C3 (BRIEF §3.5/§3.2, R2/R7) — VISUAL IDENTITY AT BIRTH: a new site is born with a WRITTEN house
// standard and a published default PDF template, not merely with a derived one and no template.
//
// WHAT PLATFORM ALREADY DOES, AND IS NOT DUPLICATED HERE. `create-site.mjs` (platform task P6) mints
// a tokens-DERIVED house standard as the FLOOR: `vis_<slug>`, `derivedFrom.method:'tokens'`, computed
// from the scaffold's own brandTokens. That is a real standard and genesis never re-mints, re-derives
// or overwrites it. What genesis adds is the two things a derivation cannot produce:
//
//   1. A WRITTEN standard. `visual_identity` in mode:'house' with `brief` = the tenant's niche and
//      audience turns the floor into a look somebody actually decided — a style sentence, negatives,
//      ratios keyed on the site's real policy contexts — with derivedFrom.method:'writer'. Nothing is
//      applied by that: the materializer files a DRAFT (R6's apply verb is owner-gated and separate),
//      so birth never silently changes what the site renders.
//   2. A PUBLISHED default article template. R7's generic `article_brochure_v1`, published the way
//      pdf-tool's own `scripts/publish-article-template.mjs` publishes it, and named in the site's
//      `pdf.defaultTemplateId` block (§3.2). Until that exists, EVERY PDF slot on EVERY run of this
//      tenant is a `no_pdf_template` blocker: artifact_plan chooses templateId only from the site's
//      published templates and never authors one.
//
// WHY BOTH ARE NORMALLY CHECKLIST ITEMS RATHER THAN GENESIS ACTIONS, stated plainly rather than
// discovered later. Both are writes against the NEW TENANT'S OWN MCP, and at the moment genesis runs,
// this deployment cannot reach it: `<SLUG>_MCP_TOKEN` is a secret custody act that is itself a human
// checklist item (see `deploy_side_mcp_env`), and the same is true of the tenant's pdf-tool grant
// (`PDF_TOOL_STORAGE_SITE_ID/_TOKEN`). Inventing a credential to close them would be exactly the
// fabrication R-C5 forbids. So genesis PLANS both precisely — the exact ids, the exact brief, the
// exact verb — records the plan in the audit ledger, and puts the two steps on the checklist with
// enough detail to run them without a decision. When a caller DOES supply a transport for either
// (deps.publishArticlePdfTemplate / deps.runVisualIdentityHouse — the site.duplicate chain can, once
// the tenant is reachable), genesis performs it instead and the checklist item shrinks to a
// confirmation, exactly the way the fleet-env items shrink in T21.8.
export const DEFAULT_ARTICLE_PDF_TEMPLATE_ID = "article_brochure_v1";
export const PUBLISH_ARTICLE_TEMPLATE_SCRIPT = "scripts/publish-article-template.mjs";

/** R2: the house standard is a singleton named after its site, mirroring `voice_<site>`. */
export const houseVisualStandardId = (slug: string): string => `vis_${slug.replace(/-/g, "")}`;

/** The writer's brief for mode:'house' — the tenant's niche and audience, and nothing invented. */
export const genesisHouseBrief = (input: { niche?: string; audience?: string }): string | undefined => {
  const niche = input.niche?.trim();
  const audience = input.audience?.trim();
  if (!niche && !audience) return undefined;
  if (niche && audience) return `${niche}, written for ${audience}.`;
  return `${niche ?? audience}.`;
};

export type GenesisVisualIdentityPlan = {
  houseStandardId: string;
  defaultTemplateId: string;
  /** The brief `visual_identity` mode:'house' would run with; absent when the caller stated neither niche nor audience. */
  brief?: string;
  /** Did platform's create-site report the tokens-derived floor this run builds on? */
  derivedFloorReported: boolean;
  /** Did genesis actually publish the default article template on this run? */
  templatePublished: boolean;
  /** Did genesis actually run `visual_identity` in mode:'house' on this run? */
  houseStandardWritten: boolean;
};

// Read tolerantly off create-site.mjs's own --json result: P6 may report the derived floor under a
// few plausible names, and a scaffold that predates P6 reports none. Absence is recorded as absence —
// it never becomes a claim that the floor exists.
export const readDerivedHouseStandardFromScaffold = (scaffold: Record<string, unknown> | undefined): boolean => {
  if (!scaffold) return false;
  for (const key of ["visualStandardId", "houseVisualStandardId", "visual_standard_id"]) {
    if (typeof scaffold[key] === "string" && (scaffold[key] as string).trim()) return true;
  }
  const nested = scaffold.visualStandard ?? scaffold.houseStandard;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return true;
  const tokens = scaffold.brandTokens;
  return !!tokens && typeof tokens === "object" && !Array.isArray(tokens);
};

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
  // T21.8 — the fleet-shared env vars genesis INSTALLED for this tenant (because this deployment
  // held the fleet value). Each one shrinks the checklist item that used to ask a human to paste it;
  // anything absent from this list is still a human step and says so.
  provisionedFleetEnvVars?: string[];
  // C3 — the visual-identity half of birth (see GenesisVisualIdentityPlan above). Always supplied by
  // runSiteGenesis; optional here only so older callers of this pure builder keep compiling, in which
  // case the two items describe the steps as entirely un-run, which is the truthful default.
  visualIdentity?: GenesisVisualIdentityPlan;
  // G1 — set when genesis MINTED this tenant's bearer and stored it, so the token-custody item is
  // closed rather than merely described. Custody, not connectivity: see the executed_unverified note.
  tenantTokenSecretRef?: string;
  // G4 — the owner address genesis was given (and therefore installed), if any.
  ownerEmail?: string;
  // G7 — set when genesis attached the repo AND verified the base directory by re-reading the site.
  // False leaves the deploy-binding item on the checklist, which is the truthful state: a Netlify
  // site with no repo (or with a package directory set) builds the wrong tenant's config or nothing.
  deployBound?: boolean;
  // G4 — the site env vars genesis derived and set itself.
  derivedEnvVars?: string[];
  netlifySiteId?: string;
}): GenesisHumanChecklistItem[] {
  const { slug, netlifySiteName, envPrefix } = input;
  const derivedEnv = input.derivedEnvVars ?? [];
  const provisionedFleet = input.provisionedFleetEnvVars ?? [];
  const outstandingFleet = (keys: string[]): string[] => keys.filter((key) => !provisionedFleet.includes(key));
  const outstandingSinkVars = outstandingFleet([TRACKING_SINK_URL_ENV, TRACKING_SINK_TOKEN_ENV]);
  const visualIdentity: GenesisVisualIdentityPlan = input.visualIdentity ?? {
    houseStandardId: houseVisualStandardId(slug),
    defaultTemplateId: DEFAULT_ARTICLE_PDF_TEMPLATE_ID,
    derivedFloorReported: false,
    templatePublished: false,
    houseStandardWritten: false
  };
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
      id: "deploy_repo_binding",
      title: input.deployBound && input.netlifyMode === "live"
        ? "Deploy binding — genesis attached the repo and set the base directory (verify the first build)"
        : "Deploy binding — attach vreich-ui/platform and set the BASE DIRECTORY (not a package directory)",
      detail: input.deployBound && input.netlifyMode === "live"
        ? `Genesis PATCHed the Netlify site to vreich-ui/platform with base directory "sites/${slug}", package directory EMPTY and build command EMPTY, and confirmed it by re-reading the site. Nothing to do unless the first build fails — in which case check the log's opening line: it must say "Config file /opt/build/repo/sites/${slug}/netlify.toml". The repo-root netlify.toml appearing there means a package directory came back.`
        : `Netlify site ${input.netlifySiteName} has no verified deploy binding, so it will not build this tenant. In the console: Project configuration → Build & deploy → Build settings. Base directory "sites/${slug}"; package directory EMPTY; build command, publish directory and functions directory all EMPTY — sites/${slug}/netlify.toml supplies those. A PACKAGE directory instead of a BASE directory is the specific misconfiguration that makes Netlify read the repo-root netlify.toml and build another tenant's config (kugel-genesis-lab-2's first build, 2026-09-09).`,
      source: "site-provisioning-runbook.md §3 / T14.3-checklist 2026-07-27"
    },
    {
      id: "github_repo_binding",
      title: "GitHub CONTENT repo binding — create/pick the content repo, mint a scoped write token, set the five vars",
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
      title: input.ownerEmail
        ? "Confirm the bootstrap Owner allowlist genesis installed (ADMIN_EMAILS / ROLE_EMAILS_ADMIN)"
        : "Set ADMIN_EMAILS to the real operator email(s) — bootstrap Owners",
      detail: input.ownerEmail
        ? `Runbook §3a step 2. Genesis was given an owner address and installed it as both ADMIN_EMAILS and ROLE_EMAILS_ADMIN on the new site — the write was always API-capable; what used to make this human was that nobody had told genesis WHICH humans own the tenant. Confirm it is right, and add any co-owners comma-separated. Note this only makes /admin reachable: Netlify Identity itself still has to be enabled in the console (previous item), and the first Owner still has to accept.`
        : "Runbook §3a step 2, verbatim: \"Set ADMIN_EMAILS on the site (Site settings → Environment variables) to the operator's real email address(es), comma-separated. These are bootstrap Owners … Until the first invite exists this is the ONLY way in.\" The env-var write is API-capable but the VALUE is an irreducible human decision — which humans own this tenant. Pass newSite.ownerEmail to site.duplicate and genesis installs it for you.",
      envVars: ["ADMIN_EMAILS", ...(input.ownerEmail ? ["ROLE_EMAILS_ADMIN"] : [])],
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
      title: derivedEnv.includes("ARTIFACT_URL_INGEST_ALLOWED_HOSTS")
        ? "Extend ARTIFACT_URL_INGEST_ALLOWED_HOSTS if this tenant pulls images from anywhere but its own host"
        : "Set ARTIFACT_URL_INGEST_ALLOWED_HOSTS — a policy choice, not a secret",
      detail: derivedEnv.includes("ARTIFACT_URL_INGEST_ALLOWED_HOSTS")
        ? "Runbook §3, verbatim: \"the hosts this client's agents may pull artifact images from — a policy choice, not a secret.\" Genesis set it to this tenant's OWN host, which is the only origin it can state without guessing. Every additional host — a client CDN, a stock library, a legacy domain — is a policy decision and has to be added by hand."
        : "Runbook §3, verbatim: \"the hosts this client's agents may pull artifact images from — a policy choice, not a secret.\"",
      envVars: ["ARTIFACT_URL_INGEST_ALLOWED_HOSTS"],
      source: "site-provisioning-runbook.md §3"
    },
    {
      id: "pdf_tool_storage_grant",
      title: "pdf-tool storage grant — dedicated Netlify machine account + Blobs-scoped PAT for THIS tenant",
      detail: (derivedEnv.includes("PDF_TOOL_STORAGE_SITE_ID") ? `Genesis set PDF_TOOL_STORAGE_SITE_ID to the Netlify site it just created (${input.netlifySiteId ?? "the new site"}) — the half that actually goes wrong by hand, because pasting another tenant's id points this site's PDF artifacts at another tenant's blob stores and nothing complains. Only the TOKEN remains. ` : "") + "Runbook §3, verbatim: \"PDF_TOOL_STORAGE_SITE_ID/_TOKEN are per-site — provision a NEW dedicated Netlify machine account + Blobs-scoped PAT for THIS client (docs/agents/pdf-tool-storage-grant.md's 'Credential provisioning' steps); do not reuse another tenant's value.\" Netlify has no API to create another machine ACCOUNT from a token — account authority. Then probe: node scripts/provision-pdf-tool-stores.mjs (or re-run provisioning with --provision-only --known-tenant-site <each live tenant> for the collision check).",
      // pdf-tool cannot mint this: set_storage_grant ATTACHES a grant the caller already holds and
      // pdf-tool "holds no TENANT storage credentials of its own". The token is a Netlify PAT scoped
      // to this site — account authority, not an API this deployment can exercise.
      envVars: derivedEnv.includes("PDF_TOOL_STORAGE_SITE_ID") ? ["PDF_TOOL_STORAGE_TOKEN"] : ["PDF_TOOL_STORAGE_SITE_ID", "PDF_TOOL_STORAGE_TOKEN"],
      source: "site-provisioning-runbook.md §3 + docs/agents/pdf-tool-storage-grant.md"
    },
    {
      id: "tracking_sink",
      title: outstandingSinkVars.length === 0
        ? "Tracking sink — genesis installed the fleet sink connection; confirm the partition choice"
        : "Tracking sink — point at the shared owner-DB or provision a dedicated sink",
      // The partition id is the BARE slug. `trk_<slug>` is the tracking_config OBJECT id — a
      // different id in a different system — and asserting it here is what taught operators to set
      // a partition the sink never reads.
      detail: `Runbook §3, verbatim: "Tracking sink may be one shared owner-DB (partitioned by TRACKING_PROJECT_ID) or per-site — your call." Genesis set TRACKING_PROJECT_ID deterministically to ${slug} — the BARE slug, which is the sink's partition id (the sink answers /api/tracking-sink/stats?project_id=${slug}, and a site with TRACKING_PROJECT_ID unset falls back to its own siteShortId, the same bare slug). Do NOT set trk_${slug}: that is the per-tenant tracking_config OBJECT id, and pointing the sink at it writes into a partition nothing reads. Override in the Netlify console only if this tenant genuinely needs a different partition. ${outstandingSinkVars.length === 0
        ? `${TRACKING_SINK_URL_ENV} and ${TRACKING_SINK_TOKEN_ENV} were installed by genesis from this deployment's own fleet values (scoped for builds as well as functions, so the repo's postbuild tracking-dims-push step sees them at BUILD time) — nothing to paste unless this tenant needs a DEDICATED sink instead of the fleet one.`
        : `${outstandingSinkVars.join(" and ")} ${outstandingSinkVars.length === 1 ? "is" : "are"} NOT configured on the CMS-Agent deployment that ran genesis, so genesis could not install ${outstandingSinkVars.length === 1 ? "it" : "them"} — an empty value is never written. Set ${outstandingSinkVars.length === 1 ? "it" : "them"} on the new Netlify site by hand with a scope set that includes BUILDS as well as functions (functions-only is why drluriescience's dims counters sat at zero), or configure the fleet value on this deployment so the next genesis installs ${outstandingSinkVars.length === 1 ? "it" : "them"} automatically.`}`,
      ...(outstandingSinkVars.length > 0 ? { envVars: outstandingSinkVars } : {}),
      source: "site-provisioning-runbook.md §3 / T11.7 env table"
    },
    {
      id: "fleet_shared_keys",
      title: "Confirm the remaining fleet-shared AI/integration values are present — reuse, never mint per-client",
      detail: `Runbook §3 + T11.7 env table: ANTHROPIC_API_KEY, OPENAI_API_KEY and ${NETLIFY_AUTH_TOKEN_ENV} are fleet-shared — "reuse the existing fleet values, never mint per-client copies." CMS_AGENT_MCP_ENDPOINT and the site's scoped CMS_AGENT_MCP_TOKEN are installed by genesis and are not human checklist items. ${provisionedFleet.includes(NETLIFY_AUTH_TOKEN_ENV)
        ? `${NETLIFY_AUTH_TOKEN_ENV} is no longer one either: genesis installed it from this deployment's own fleet value. The AI keys remain human because this deployment does not carry the tenant-facing copies.`
        : `${NETLIFY_AUTH_TOKEN_ENV} is NOT configured on the CMS-Agent deployment that ran genesis, so genesis could not install it — an empty value is never written — and it stays a human step here.`}`,
      envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", ...outstandingFleet([NETLIFY_AUTH_TOKEN_ENV])],
      source: "T11.7 env table / site-provisioning-runbook.md §3"
    },
    input.tenantTokenSecretRef
      ? {
        // G1 — CLOSED. Genesis minted this tenant's bearer, installed it on the site and stored it
        // in Secret Manager, and the record carries the reference; every plane resolves it from its
        // own service-account identity with no per-plane, per-tenant variable. What is left is a
        // CHECK, not a custody act, and it cannot pass until the site has actually deployed.
        id: "deploy_side_mcp_env",
        title: `Verify the tenant bearer genesis minted (no ${envPrefix}_MCP_TOKEN needs setting anywhere)`,
        detail: `Registration contract step 2 is closed: genesis minted this tenant's inbound bearer, installed it as the site's MCP_HTTP_AUTH_TOKEN and stored it at ${input.tenantTokenSecretRef}, which the project record now names as tokenSecretRef. Nothing has to be pasted between consoles and no deployment needs editing — ${envPrefix}_MCP_TOKEN remains an OPTIONAL override that wins wherever a plane populates it. The ledger records this as executed_unverified on purpose: a Netlify functions env var takes effect on the next deploy, and this tenant has no published /mcp until its repo tree is committed and built. Once it is live, run project.test_connection to promote it. If that check fails, the fix is to re-run the mint — never to hand-edit the secret.`,
        source: "project.get_registration_contract onboardingSteps 2-6",
        verify: "project.test_connection — succeeds once the tenant has deployed; project.get shows tokenSource \"registry\"."
      }
      : input.registeredMcpEndpoint
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
      // C3 (BRIEF §3.5, R2). The DERIVED floor is platform's (create-site/P6) and is never re-minted
      // here; what this step buys is a look somebody DECIDED, which no derivation from brandTokens
      // can produce — and it is a draft either way, so running it changes nothing the site renders
      // until an Owner applies it through the privileged verb.
      id: "visual_identity_house_standard",
      title: visualIdentity.houseStandardWritten
        ? `Review the WRITTEN house imagery standard genesis produced (${visualIdentity.houseStandardId}) and apply it when it is right`
        : `Write the house imagery standard: run the visual identity workflow in mode 'house' for ${slug}`,
      detail: `${visualIdentity.derivedFloorReported
        ? `create-site.mjs already minted the tokens-DERIVED floor as ${visualIdentity.houseStandardId} (derivedFrom.method 'tokens'), so the site is never without a standard. `
        : `create-site.mjs reported no derived house standard for this run — platform mints ${visualIdentity.houseStandardId} from the scaffold's brandTokens (P6); confirm it exists before writing over it. `}${visualIdentity.houseStandardWritten
        ? `Genesis then ran the visual_identity workflow in mode 'house' and filed a DRAFT written standard on ${visualIdentity.houseStandardId} (derivedFrom.method 'writer'). Nothing was applied: putting a standard on the live site is the privileged, Owner-gated site_apply_brand_imagery verb, deliberately a separate act from writing one.`
        : `Genesis could NOT run it: writing the standard is a call against the new tenant's own MCP, and this deployment holds no ${envPrefix}_MCP_TOKEN yet (see the deploy-side step above) — inventing one is not an option. Once that token is in place, run the visual_identity workflow with mode 'house'${visualIdentity.brief ? ` and brief "${visualIdentity.brief}"` : `, supplying a brief that states this tenant's niche and audience (genesis was given neither, and never invents one)`}, plus any reference images the operator has. The writer proposes; the materializer files a DRAFT; applying it to the live site stays a separate, Owner-gated act through site_apply_brand_imagery.`}`,
      source: "BRIEF §3.5 (visual_identity mode:'house') / R2 / platform create-site P6",
      verify: `object_get(visual_standard, ${visualIdentity.houseStandardId}) — derivedFrom.method reads 'writer' once the written standard is filed, 'tokens' while only the floor exists.`
    },
    {
      // C3 (BRIEF §3.2/R7). Until a published article template exists and the site names it, EVERY
      // PDF slot on every run of this tenant is a no_pdf_template blocker — artifact_plan chooses
      // templateId only from the site's PUBLISHED templates and never authors one.
      id: "pdf_default_template",
      title: visualIdentity.templatePublished
        ? `Confirm the site's default PDF template (${visualIdentity.defaultTemplateId}) — genesis published it`
        : `Publish the default article PDF template (${visualIdentity.defaultTemplateId}) and name it in the site's pdf block`,
      detail: `${visualIdentity.templatePublished
        ? `Genesis published ${visualIdentity.defaultTemplateId} on this tenant and set site.pdf.defaultTemplateId to it. Confirm it renders: list_pdf_templates should show it published with a renderDataSchema and sampleData.`
        : `Run the equivalent of pdf-tool's ${PUBLISH_ARTICLE_TEMPLATE_SCRIPT} against this tenant — create_pdf_template with the generic chromium article brochure (its renderDataSchema mirrors article structure, which is what lets artifact_materializer fill renderData deterministically from the draft at zero model cost), then publish_pdf_template. Genesis could not: the call needs this tenant's own pdf-tool grant (PDF_TOOL_STORAGE_SITE_ID/_TOKEN, itself a human step above) and its MCP token. `}Then set the site's pdf block with set_site_fields: {"pdf": {"defaultTemplateId": "${visualIdentity.defaultTemplateId}"}} — an ordinary agent-writable field (§3.2), not a privileged one. Until BOTH halves are true, every PDF slot on every run for this tenant is reported blocked as no_pdf_template.`,
      source: "BRIEF §3.2 + R7 / pdf-tool " + PUBLISH_ARTICLE_TEMPLATE_SCRIPT,
      verify: "list_pdf_templates shows the template published, and object_get(site).pdf.defaultTemplateId names it."
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
  // C3 (BRIEF §3.5): the two facts `visual_identity` mode:'house' needs as its `brief`. Neither is
  // invented — a run given neither states so on the checklist and asks for one rather than writing a
  // house look for a publication nobody has described.
  niche?: string;
  audience?: string;
  // G4 — the bootstrap Owner. ADMIN_EMAILS is an ordinary Netlify env var with a push mechanism
  // genesis already owns; it stayed a human step only because nobody had asked genesis for the one
  // fact it needs. Supplying it closes set_admin_emails; omitting it leaves that item exactly as it
  // was. Genesis never invents an owner address.
  ownerEmail?: string;
  // W3 (Wolf, 2026-09-09) — the genesis BASELINES, each an optional partial body deep-merged onto
  // the skeleton the platform scaffold would otherwise write. They exist for two reasons and both
  // matter: supplying one flips that baseline's `provenance.set_by` from "genesis_default" to
  // "agent", which is what silences the "needs to be set" warning on every downstream consumer; and
  // they are what makes the genesis policy's "SUPPLY NOW" door real. A refusal that names a field
  // the caller has no way to pass is not a refusal, it is an outage — so the closed artifact enum
  // in genesisPolicy.ts and these five fields are the same list, asserted by that module's test.
  //
  // Genesis does not read or validate the bodies. They travel verbatim to `create-site.mjs` as
  // --editorial-strategy / --editorial-voice / --visual-standard / --logo / --tracking-config,
  // where the platform's own schemas own them; inventing a shape here would be a second, drifting
  // copy of the platform's body schemas.
  editorialStrategy?: Record<string, unknown>;
  editorialVoice?: Record<string, unknown>;
  visualStandard?: Record<string, unknown>;
  logo?: Record<string, unknown>;
  trackingConfig?: Record<string, unknown>;
};

export type SiteGenesisDeps = {
  projectRepository: ProjectRepository;
  env?: NodeJS.ProcessEnv;
  netlifyFetch?: NetlifyFetch;
  credentialFetch?: NetlifyFetch;
  credentialRepository?: Pick<ManagedScopedBearerCredentialRepository, "mint" | "activateAndRetireOtherProjectCredentials" | "revokeCredential">;
  // C3 — the two visual-identity writes, injected rather than assumed. Absent (the normal case at
  // birth, because the tenant's own MCP token is still a human custody step) the steps are PLANNED
  // and put on the checklist; supplied, they are performed and the checklist item shrinks. Either
  // way the ledger records what happened — a capability this deployment lacks is itself audited.
  publishArticlePdfTemplate?: (input: { projectId: string; templateId: string }) => Promise<{ published: boolean; detail: string }>;
  runVisualIdentityHouse?: (input: { projectId: string; mode: "house"; brief: string; visualStandardId: string }) => Promise<{ visualStandardId: string; status: string; detail: string }>;
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

  // W3 (Wolf, 2026-09-09) — THE GENESIS POLICY GATE, before any side effect of any kind.
  //
  // Deliberately here rather than downstream. `create-site.mjs` enforces the same policy at its own
  // buildPlan, but this driver only REACHES the scaffold when a platform checkout is mounted; with
  // none it skips straight past and goes on to create a Netlify site, a build hook, env vars and a
  // registry project. Enforcing only downstream would therefore let the checkout-less path
  // provision live infrastructure for a tenant the policy says may not exist — the refusal has to
  // fire before the first API call, not after.
  //
  // The refusal carries the same code, the same `missing[]` INPUT FIELD names and the same two ways
  // out as the platform's, because an operator meeting it on both surfaces must read one rule, not
  // two failures. See src/agent/capture/genesisPolicy.ts for why the vocabulary is duplicated and
  // what keeps the copies honest.
  const missingArtifacts = missingGenesisArtifacts(activeGenesisPolicy(), input as unknown as Record<string, unknown>);
  if (missingArtifacts.length) {
    throw new SiteGenesisRefusal("genesis_artifact_required", genesisArtifactRefusalMessage(missingArtifacts), undefined, {
      missing: missingArtifacts,
      waysOut: genesisArtifactWaysOut(missingArtifacts)
    });
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
  // Which fleet-shared tracking/deploy values THIS deployment can hand the new tenant (T21.8).
  // Resolved once, up front: it decides both what gets installed and what the checklist still asks a
  // human for — the two must never disagree.
  const genesisFleetEnv = resolveGenesisFleetEnvVars(env);
  // Account-level keys CONFIRMED present, filled in by the provisioning block below. Declared here
  // because the human checklist is assembled after it and must count an inherited key as configured:
  // the new site has it either way, and telling an operator to set a variable that is already in
  // scope is how a checklist stops being read. Empty until the check actually runs, so a genesis that
  // never reached the check errs toward "still a human step" rather than toward silence.
  const inheritedFleetPresent: string[] = [];

  // 1. Scaffold (filesystem, via the platform seam) — when a checkout is mounted.
  let scaffoldExecuted = false;
  // C3: whether platform's create-site reported the tokens-derived house standard it mints (P6). Read
  // off the scaffold's own --json result — never assumed, and never re-derived here.
  let derivedFloorReported = false;
  if (platformRoot) {
    // W3: the supplied baselines travel to the scaffold as its own genesis-input flags, so a tenant
    // minted through this driver is born with authored objects (provenance.set_by "agent") rather
    // than placeholders — and so the platform's own copy of the policy is satisfied by the same
    // inputs that satisfied ours, instead of refusing one layer later for the same reason.
    const scaffold = await runCreateSiteCli(
      platformRoot,
      [
        "--name",
        slug,
        ...(input.netlifySiteName ? ["--netlify-site-name", netlifySiteName] : []),
        ...genesisArtifactCliArgs(input as unknown as Record<string, unknown>)
      ],
      { passToken: false, token }
    );
    scaffoldExecuted = true;
    derivedFloorReported = readDerivedHouseStandardFromScaffold(scaffold);
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
  // STEP 3c — the deploy binding. Ordered BEFORE the build hook deliberately: a build hook on a site
  // with no repo attached is a URL that triggers nothing.
  const deployBase = `sites/${slug}`;
  const referenceSite = genesisDeployReferenceSite(env);
  let deployBound = false;
  {
    const reference = await netlify.readDeployBinding(referenceSite).catch(() => undefined);
    if (!reference) {
      ledger.push({
        step: "netlify_deploy_binding",
        kind: "requires_human",
        detail: `No deploy binding could be read from the reference site "${referenceSite}" (${GENESIS_DEPLOY_REFERENCE_SITE_ENV}), so genesis has no repo or GitHub App installation to copy. Bind ${netlifySiteName} by hand: repo vreich-ui/platform, base directory "${deployBase}", package directory EMPTY, build command EMPTY.`,
        at: now(),
        data: { referenceSite, base: deployBase }
      });
    } else {
      // Uncaught, this could abort a genesis that would otherwise have succeeded: a transient 5xx on
      // the site GET throws out of site.duplicate BEFORE any result is assembled, losing the build
      // hook, every env var, token custody and the project record — and leaving an orphan Netlify
      // site behind. The one step that already has a requires_human fallback must degrade to it.
      const result = await netlify
        .bindRepository(siteId, { ...reference, base: deployBase })
        .catch((error: unknown) => {
          ledger.push({
            step: "netlify_deploy_binding",
            kind: "requires_human",
            detail: `The deploy binding could not be applied to ${netlifySiteName}: ${error instanceof Error ? error.message : String(error)}. Set it in the Netlify console — base directory "${deployBase}", package directory EMPTY, build command EMPTY — or re-run site.duplicate once the API is reachable.`,
            at: now(),
            data: { siteId, base: deployBase }
          });
          return { bound: false };
        });
      deployBound = result.bound;
    }
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
    // The tracking partition id is the BARE slug — see the header note (4). `trk_<slug>` is the
    // tracking_config OBJECT id, not a sink partition, and installing it here wrote every
    // genesis-provisioned tenant's events into a partition nothing reads.
    //
    // Left on setEnvVar's DEFAULT scopes deliberately: `builds` is REQUIRED, because the site repo's
    // postbuild `scripts/tracking-dims-push.mjs` reads TRACKING_PROJECT_ID at BUILD time. Narrowing
    // this (or the sink pair below) to ["functions"] is exactly the live drluriescience bug that
    // left the tracking `dims` counters at zero.
    await netlify.setEnvVar(envAccount, siteId, "TRACKING_PROJECT_ID", slug);

    // The fleet-shared deploy values genesis still COPIES, from THIS deployment's own environment.
    // Same default scopes, same `builds` requirement; secrets are written per-context (never "all" —
    // see setEnvVar). Anything this deployment does not hold is not written at all and stays on the
    // checklist. The tracking pair is NOT here any more — see the inherited block below and C-11.
    for (const fleetVar of genesisFleetEnv.provisioned) {
      await netlify.setEnvVar(envAccount, siteId, fleetVar.key, fleetVar.value, { isSecret: fleetVar.isSecret });
    }

    // The tracking pair is ACCOUNT-level and the new site already reads it. Genesis checks it BY
    // NAME and writes nothing: a site-level copy overrides the account value, so writing one creates
    // a second source of truth that wins silently and then drifts — which is precisely what stranded
    // drluriescience on a dead token (see GENESIS_FLEET_ENV_VARS).
    const inheritedAbsent: string[] = [];
    for (const key of genesisFleetEnv.inherited) {
      if (await netlify.accountEnvVarExists(envAccount, key)) inheritedFleetPresent.push(key);
      else inheritedAbsent.push(key);
    }
    const fleetMissing = [...genesisFleetEnv.missing, ...inheritedAbsent];
    ledger.push({
      step: "tracking_fleet_env",
      kind: fleetMissing.length === 0 ? (mode === "dry_run" ? "dry_run" : "executed") : "requires_human",
      detail: [
        genesisFleetEnv.provisioned.length > 0
          ? `Installed the fleet-shared deploy values on the new site from this deployment's own environment (names only): ${genesisFleetEnv.provisioned.map((fleetVar) => fleetVar.key).join(", ")}. Scoped for builds as well as functions — the repo's postbuild tracking-dims-push step reads them at BUILD time.`
          : "",
        inheritedFleetPresent.length > 0
          ? `Inherited from the account, NOT copied (C-11): ${inheritedFleetPresent.join(", ")}. One value, rotated in one place; a per-site copy would override it and drift, which is how a tenant was left holding a token the sink had stopped accepting.`
          : "",
        inheritedAbsent.length > 0
          ? `NOT set at the account level, so the new site inherits nothing for ${inheritedAbsent.join(", ")} — genesis deliberately does not substitute a per-site copy. Set the ACCOUNT-level variable; every site in the team then has it.`
          : "",
        genesisFleetEnv.missing.length > 0
          ? `NOT configured on this deployment, so genesis could not install ${genesisFleetEnv.missing.join(", ")} — never an empty value: ${genesisFleetEnv.missing.length === 1 ? "it stays" : "they stay"} on the human checklist until the fleet value is present here (or set by hand on the new site).`
          : ""
      ].filter(Boolean).join(" "),
      at: now(),
      data: {
        provisioned: genesisFleetEnv.provisioned.map((fleetVar) => fleetVar.key),
        inherited: inheritedFleetPresent,
        missing: fleetMissing,
        scopes: [...NETLIFY_DEFAULT_ENV_SCOPES]
      }
    });
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
  // 3a. G4 — the checklist items that were only human because nobody had derived them. Each of
  // these is an ordinary Netlify env var whose VALUE genesis already knows; leaving them to a person
  // meant a paste step whose most common failure was a typo'd site id, not a missing decision.
  const derivedSiteEnvVars: string[] = [];
  {
    const envAccount = accountId ?? `dryrun_account_${netlifySiteName}`;
    const derived = derivedSiteEnvVars;

    if (input.ownerEmail?.trim()) {
      const ownerEmail = input.ownerEmail.trim();
      // Both allowlists, deliberately. ADMIN_EMAILS is the bootstrap-Owner list that makes /admin
      // usable at all; ROLE_EMAILS_ADMIN is the role allowlist the same person needs. Setting one
      // and not the other is the shape of half-configured tenant that reads as "Identity is broken".
      await netlify.setEnvVar(envAccount, siteId, "ADMIN_EMAILS", ownerEmail, { onlyIfAbsent: true });
      await netlify.setEnvVar(envAccount, siteId, "ROLE_EMAILS_ADMIN", ownerEmail, { onlyIfAbsent: true });
      derived.push("ADMIN_EMAILS", "ROLE_EMAILS_ADMIN");
    }

    // The tenant's own host is the one ingest origin genesis can state without guessing. Anything
    // else — a client CDN, a stock library — is a decision, and stays on the checklist.
    const canonicalHost = ((): string | undefined => {
      try {
        return siteUrl ? new URL(siteUrl).host : `${netlifySiteName}.netlify.app`;
      } catch {
        return `${netlifySiteName}.netlify.app`;
      }
    })();
    if (canonicalHost) {
      await netlify.setEnvVar(envAccount, siteId, "ARTIFACT_URL_INGEST_ALLOWED_HOSTS", canonicalHost, { onlyIfAbsent: true });
      derived.push("ARTIFACT_URL_INGEST_ALLOWED_HOSTS");
    }

    // PDF-TOOL STORAGE GRANT — the SITE ID half only, and that limit is real rather than caution.
    // pdf-tool's set_storage_grant does not MINT anything: it attaches a grant the caller already
    // holds (`storage.siteId` + `storage.token`), and pdf-tool "holds no TENANT storage credentials
    // of its own". The token half is a Netlify PAT scoped to this site — Netlify account authority,
    // not an API this deployment can exercise — so it stays human. The site id half is the half that
    // actually goes wrong in practice (pasting another tenant's id silently points one site's PDF
    // artifacts at another's blob stores), and genesis has just created the site, so it knows it.
    // NOT onlyIfAbsent: this one is authoritative. A stale or mis-pasted id silently points this
    // tenant's PDF artifacts at another tenant's blob stores, so genesis correcting it is the point.
    await netlify.setEnvVar(envAccount, siteId, "PDF_TOOL_STORAGE_SITE_ID", siteId);
    derived.push("PDF_TOOL_STORAGE_SITE_ID");

    ledger.push({
      step: "derived_site_env",
      kind: mode === "dry_run" ? "dry_run" : "executed",
      detail: `Set the site env vars whose values are derivable at birth (names only): ${derived.join(", ")}.${input.ownerEmail?.trim() ? "" : " No ownerEmail was supplied, so ADMIN_EMAILS/ROLE_EMAILS_ADMIN were NOT set and stay on the checklist — genesis never invents an owner address."} PDF_TOOL_STORAGE_TOKEN is deliberately absent: it is a Netlify PAT scoped to this site, which is account authority no API here holds, and pdf-tool mints nothing (set_storage_grant only ATTACHES a grant the caller already has).`,
      at: now(),
      data: { projectId: slug, keys: derived, ownerEmailSupplied: Boolean(input.ownerEmail?.trim()), pdfToolStorageSiteId: siteId }
    });
  }

  // 3b. G1 — TENANT BEARER CUSTODY. The inverse of step 3: that one mints the credential the SITE
  // presents to CMS-Agent; this one mints the credential CMS-Agent presents to the SITE.
  //
  // Why this had to become a mint rather than a read. create-site.mjs auto-generates the site's
  // MCP_HTTP_AUTH_TOKEN during provisioning and deliberately never prints it ("values never
  // printed" — correct, and not a bug). So the value existed in exactly one place CMS-Agent could
  // not reach, and `deploy_side_mcp_env` asked a human to carry it between two consoles on EVERY
  // birth. Genesis already writes this site's Netlify env vars, so minting the value here means one
  // secret with two homes and nobody in the middle. Written AFTER any create-site provisioning, so
  // this value is the one that survives.
  //
  // Custody is the success condition, NOT connectivity — see the executed_unverified note on
  // GenesisAction. A brand-new tenant has no deployed /mcp to handshake with.
  let tenantTokenSecretRef: string | undefined;
  const secretProject = genesisSecretProject(env);
  const tokenSecretId = tenantTokenSecretId(slug);
  // NEVER ROTATE A LIVE TENANT'S BEARER. createSite is idempotent — a second run against the same
  // site name RESOLVES the existing site rather than creating one — and step 4 below refuses a
  // duplicate registration only AFTER this point. Without this guard, re-running genesis against an
  // established tenant would mint a new bearer, write it to the site (where it takes effect only on
  // the next deploy) and overwrite the stored one, breaking a working tenant on the way to a
  // `project_exists` refusal. Custody already held is custody; genesis has nothing to do here.
  const existingRecord = await deps.projectRepository.get(slug);
  if (existingRecord?.tokenSecretRef) {
    tenantTokenSecretRef = existingRecord.tokenSecretRef;
    ledger.push({
      step: "tenant_mcp_token_custody",
      kind: "executed_unverified",
      detail: `This tenant's bearer is already in custody at ${existingRecord.tokenSecretRef} and genesis did NOT rotate it: re-minting would install a value the live site only picks up on its next deploy, breaking a tenant that currently works. To rotate deliberately, use the credential reconciler.`,
      at: now(),
      data: { projectId: slug, secretId: tokenSecretId, tokenSecretRef: existingRecord.tokenSecretRef, rotated: false }
    });
  } else if (mode === "dry_run") {
    const envAccount = accountId ?? `dryrun_account_${netlifySiteName}`;
    await netlify.setEnvVar(envAccount, siteId, "MCP_HTTP_AUTH_TOKEN", "", { isSecret: true, scopes: ["functions"], context: "production" });
    ledger.push({
      step: "tenant_mcp_token_custody",
      kind: "dry_run",
      detail: `DRY-RUN: would mint this tenant's inbound bearer, install it as the site's MCP_HTTP_AUTH_TOKEN (secret, functions-only), write it as a new version of Secret Manager secret "${tokenSecretId}"${secretProject ? ` in ${secretProject}` : ""}, and register the .../versions/latest reference on the project record as tokenSecretRef. No value would be returned or logged.`,
      at: now(),
      data: { projectId: slug, secretId: tokenSecretId, secretProject: secretProject ?? null }
    });
  } else if (!secretProject) {
    // No custodian configured: do NOT mint. A token written to the site that this deployment cannot
    // store is strictly worse than no token at all — it would overwrite whatever create-site.mjs
    // generated with a value nobody holds, breaking a tenant that would otherwise have worked once
    // a human read the original out of the console.
    ledger.push({
      step: "tenant_mcp_token_custody",
      kind: "requires_human",
      detail: `No Secret Manager project is configured on this deployment (${GENESIS_SECRET_MANAGER_PROJECT_ENV}, SITE_CREDENTIAL_RECONCILER_GCP_PROJECT and GOOGLE_CLOUD_PROJECT are all unset), so genesis did not mint this tenant's bearer: writing one to the site without being able to store it would overwrite the provisioning-generated value with one nobody holds. Custody stays the human step described in the checklist.`,
      at: now(),
      data: { projectId: slug, secretId: tokenSecretId }
    });
  } else {
    const envAccount = accountId ?? await netlify.getSiteAccountId(siteId);
    // 32 bytes, url-safe: the same class of value create-site.mjs generates, and nothing about the
    // slug or the site is recoverable from it.
    const tenantToken = randomBytes(32).toString("base64url");
    const stored = await createSecretVersion({ projectId: secretProject, secretId: tokenSecretId, value: tenantToken }, { env });
    if (!stored.ok) {
      // ORDER MATTERS: the secret write comes FIRST, so a custody failure leaves the site's existing
      // token untouched. Writing Netlify first and failing here would strand a live tenant behind a
      // bearer no plane could resolve.
      ledger.push({
        step: "tenant_mcp_token_custody",
        kind: "requires_human",
        detail: `Genesis could not take custody of this tenant's bearer and therefore did not change the site's MCP_HTTP_AUTH_TOKEN: ${stored.error} Grant this deployment's service account roles/secretmanager.admin (or secretmanager.secrets.create + secretVersionAdder) on ${secretProject} and re-run; until then custody stays the human step in the checklist.`,
        at: now(),
        data: { projectId: slug, secretId: tokenSecretId, secretProject }
      });
    } else {
      await netlify.setEnvVar(envAccount, siteId, "MCP_HTTP_AUTH_TOKEN", tenantToken, { isSecret: true, scopes: ["functions"], context: "production" });
      tenantTokenSecretRef = stored.ref;
      ledger.push({
        step: "tenant_mcp_token_custody",
        kind: "executed_unverified",
        detail: `Minted this tenant's inbound bearer, installed it as the site's MCP_HTTP_AUTH_TOKEN (secret, functions-only) and stored it as ${stored.secretCreated ? "a new secret" : "a new version of the existing secret"} "${tokenSecretId}" in ${secretProject}; the record carries the .../versions/latest reference, so a rotation needs no registry write. NOT yet verified, and deliberately so: a functions env var takes effect on the next deploy, and this tenant has no published /mcp until its repo tree is committed and built. Run project.test_connection (or let the credential reconciler run) to promote this to executed.`,
        at: now(),
        data: { projectId: slug, secretId: tokenSecretId, secretProject, versionName: stored.versionName, tokenSecretRef: stored.ref, verifyWith: "project.test_connection" }
      });
    }
  }

  ledger.push(...netlify.actions);

  // 4. CMS-Agent registration — the registration contract's step 1: the token by env var NAME (a
  // secret value never transits MCP), the DERIVED endpoint stored on the record so no human ever
  // sets <SLUG>_MCP_ENDPOINT, plus the conservative seeded capture policy that authorizes exactly
  // the requested source origin.
  const seededCapturePolicy = seededGenesisCapturePolicy(sourceOrigin);
  const genesisVoice = genesisEditorialVoiceFallback({ slug, ...(input.niche ? { niche: input.niche } : {}), ...(input.audience ? { audience: input.audience } : {}) });
  const mcpEndpoint = input.mcpEndpoint?.trim() || deriveTenantMcpEndpoint(netlifySiteName, siteUrl);
  const project = await createProject(deps.projectRepository, {
    projectId: slug,
    clientSiteBinding: { netlifySiteName, netlifySiteId: siteId },
    name: slug,
    mcpEndpointEnvVar: `${envPrefix}_MCP_ENDPOINT`,
    mcpEndpoint,
    authMode: "bearer_env",
    tokenEnvVar: `${envPrefix}_MCP_TOKEN`,
    // G1 — the token's PREFERRED source, present whenever genesis took custody above. The env var
    // NAME stays alongside it and still wins wherever a plane populates it, so this is additive: an
    // operator keeps the break-glass override, and a plane carrying no tenant environment (the
    // continuation-tick job) now authenticates anyway.
    ...(tenantTokenSecretRef ? { tokenSecretRef: tenantTokenSecretRef } : {}),
    allowedTools: [],
    // G5 — born with the same tool policy the migration will hold it to, so a minted tenant is never
    // a version behind on its first read. Previously this was `defaultToolPolicy: "allowed"` with no
    // policy map: every remote verb permitted by default, including verbs added to the tenant surface
    // after birth. The profile names the emission and publish verbs explicitly instead.
    ...genesisTenantProfile(),
    // G6 tier 1 — a provisional voice ON THE RECORD, so the five voice-prefetch nodes and
    // visual_identity_propose stop running voice-less on every minted tenant. Absent (and correctly
    // so) when genesis was given neither a niche nor an audience: with nothing true to say, a
    // fallback would be boilerplate wearing the tenant's name. Never a voiceObjectId — a DECIDED
    // voice is a written object, and no writer node has run.
    ...(genesisVoice ? { editorialVoiceFallback: genesisVoice } : {}),
    // W4 (2026-09-09, Wolf) — the SINK PARTITION, on the record, at birth. This is the same value
    // written above as the site's own TRACKING_PROJECT_ID env var (the BARE slug; see the header
    // note (4) and the setEnvVar call for why it is not `trk_<slug>`), recorded here so CMS-Agent's
    // registry can answer "which partition belongs to this tenant" without reading the tenant's
    // Netlify environment. Until this existed the answer lived ONLY on the site, so every job that
    // reads the sink could read exactly one partition — whichever one its own deployment named — and
    // the weekly strategy review was a single-tenant job for addressing reasons, not policy ones.
    // Written unconditionally: a minted tenant's partition is never in doubt, genesis just chose it.
    tracking: { projectId: slug },
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

  // 5. C3 — the visual-identity half of birth. Both steps are PLANNED here in full (exact ids, exact
  // brief, exact verb) and PERFORMED only when a caller supplied the transport for them; otherwise
  // each is a `requires_human` ledger entry mirrored into the checklist, never a silent skip. See the
  // long note above GenesisVisualIdentityPlan for why the normal case is the plan and not the call.
  const visualIdentity: GenesisVisualIdentityPlan = {
    houseStandardId: houseVisualStandardId(slug),
    defaultTemplateId: DEFAULT_ARTICLE_PDF_TEMPLATE_ID,
    ...(genesisHouseBrief(input) ? { brief: genesisHouseBrief(input)! } : {}),
    derivedFloorReported,
    templatePublished: false,
    houseStandardWritten: false
  };

  if (deps.publishArticlePdfTemplate) {
    try {
      const published = await deps.publishArticlePdfTemplate({ projectId: slug, templateId: visualIdentity.defaultTemplateId });
      visualIdentity.templatePublished = published.published;
      ledger.push({
        step: "publish_default_pdf_template",
        kind: published.published ? "executed" : "requires_human",
        detail: published.detail,
        at: now(),
        data: { projectId: slug, templateId: visualIdentity.defaultTemplateId, script: PUBLISH_ARTICLE_TEMPLATE_SCRIPT }
      });
    } catch (error) {
      // A failed template publish is never a failed birth: the tenant exists, and the step stays on
      // the checklist with the reason attached.
      ledger.push({
        step: "publish_default_pdf_template",
        kind: "requires_human",
        detail: `Publishing ${visualIdentity.defaultTemplateId} on ${slug} failed and is left to the human checklist: ${error instanceof SiteGenesisRefusal ? error.safeSummary : error instanceof Error ? error.message : String(error)}`,
        at: now(),
        data: { projectId: slug, templateId: visualIdentity.defaultTemplateId }
      });
    }
  } else {
    ledger.push({
      step: "publish_default_pdf_template",
      kind: "requires_human",
      detail: `No pdf-template transport was supplied to this genesis run, and none can be assumed: publishing ${visualIdentity.defaultTemplateId} is a call against the new tenant's own surface, whose ${envPrefix}_MCP_TOKEN and pdf-tool storage grant are both still human custody steps. The step is planned in full on the checklist (pdf_default_template) rather than silently skipped — until it is done, every PDF slot on every run for this tenant is blocked no_pdf_template.`,
      at: now(),
      data: { projectId: slug, templateId: visualIdentity.defaultTemplateId, script: PUBLISH_ARTICLE_TEMPLATE_SCRIPT }
    });
  }

  if (deps.runVisualIdentityHouse && visualIdentity.brief) {
    try {
      const result = await deps.runVisualIdentityHouse({ projectId: slug, mode: "house", brief: visualIdentity.brief, visualStandardId: visualIdentity.houseStandardId });
      visualIdentity.houseStandardWritten = true;
      visualIdentity.houseStandardId = result.visualStandardId || visualIdentity.houseStandardId;
      ledger.push({
        step: "write_house_visual_standard",
        kind: "executed",
        detail: `${result.detail} The standard is a DRAFT: writing a look and putting it on the live site are separate acts, and the second one is the Owner-gated site_apply_brand_imagery verb.`,
        at: now(),
        data: { projectId: slug, visualStandardId: visualIdentity.houseStandardId, mode: "house", status: result.status, derivedFloorReported }
      });
    } catch (error) {
      ledger.push({
        step: "write_house_visual_standard",
        kind: "requires_human",
        detail: `The visual_identity mode:'house' run for ${slug} failed and is left to the human checklist: ${error instanceof SiteGenesisRefusal ? error.safeSummary : error instanceof Error ? error.message : String(error)}. The tokens-derived floor platform mints is unaffected — a failed write never removes a standard.`,
        at: now(),
        data: { projectId: slug, visualStandardId: visualIdentity.houseStandardId, mode: "house" }
      });
    }
  } else {
    ledger.push({
      step: "write_house_visual_standard",
      kind: "requires_human",
      detail: visualIdentity.brief
        ? `No visual_identity transport was supplied to this genesis run: writing the house standard is a call against the new tenant's own MCP, whose ${envPrefix}_MCP_TOKEN is still a human custody step. The run is planned in full on the checklist (visual_identity_house_standard) with brief "${visualIdentity.brief}". The tokens-derived floor platform's create-site mints (${visualIdentity.houseStandardId}) is${derivedFloorReported ? "" : " expected to be"} in place either way, so the site is never without a standard — it is only without a DECIDED one.`
        : `This genesis run was given neither a niche nor an audience, so there is no brief to write a house look from and genesis invents neither. The step is on the checklist (visual_identity_house_standard) asking for one. The tokens-derived floor platform's create-site mints (${visualIdentity.houseStandardId}) still applies, so the site is never without a standard.`,
      at: now(),
      data: { projectId: slug, visualStandardId: visualIdentity.houseStandardId, mode: "house", brief: visualIdentity.brief ?? null, derivedFloorReported }
    });
  }

  const humanChecklist = buildGenesisHumanChecklist({
    slug,
    netlifySiteName,
    envPrefix,
    scaffoldExecuted,
    netlifyMode: mode,
    registeredMcpEndpoint: mcpEndpoint,
    // A key the new site HAS, whether genesis copied it or the account already supplied it (C-11).
    provisionedFleetEnvVars: [...genesisFleetEnv.provisioned.map((fleetVar) => fleetVar.key), ...inheritedFleetPresent],
    ...(tenantTokenSecretRef ? { tenantTokenSecretRef } : {}),
    ...(input.ownerEmail?.trim() ? { ownerEmail: input.ownerEmail.trim() } : {}),
    deployBound,
    derivedEnvVars: derivedSiteEnvVars,
    ...(siteId ? { netlifySiteId: siteId } : {}),
    visualIdentity
  });
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
    humanChecklist,
    visualIdentity
  };
}
