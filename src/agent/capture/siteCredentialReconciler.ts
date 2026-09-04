import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ManagedScopedBearerCredentialRepository, type ManagedScopedBearerMetadata } from "../mcp/auth/managedScopedBearerCredentials.js";
import {
  CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV,
  NETLIFY_API_TOKEN_ENV,
  NetlifyGenesisClient,
  SITE_CLIENT_MANAGER_TOOLS,
  SiteGenesisRefusal,
  resolveCmsAgentPublicMcpEndpoint,
  verifyCmsAgentScopedCredential,
  type NetlifyFetch
} from "./siteGenesis.js";

export const CMS_AGENT_SITE_BINDINGS_ENV = "CMS_AGENT_SITE_BINDINGS_JSON";

export type SiteCredentialReconcileResult = {
  projectId: string;
  // Absent only for status "unmanaged": there is no bound (or backfill-mapped) Netlify site to
  // name for a project the reconciler cannot act on at all.
  netlifySiteName?: string;
  // "unmanaged" (2026-09-04): a bearer_env project with NO usable binding. THE FIX this type exists
  // for — such a project used to be filtered out before the loop below and never appear in
  // `results` at all, which read as "nothing to do" and is exactly what let dr-lurie and platform
  // sit on stale credentials while every visual_identity_propose call 401'd and the operator,
  // reading an empty diff, called the fleet healthy. No mint, no env write, no rebuild happens for
  // an "unmanaged" row in either dry-run or apply — it is reporting only.
  status: "planned" | "current" | "rotated" | "failed" | "unmanaged";
  errorCode?: string;
  // The safe half of the underlying refusal — `METHOD /path HTTP nnn`, never a response body. A
  // bare errorCode cannot distinguish "the credential is revoked" (401) from "Netlify wobbled"
  // (503), and the operator reading this line is exactly the person who needs to know which. Also
  // carries the plain-language reason for an "unmanaged" row (see above) — there is no HTTP call to
  // summarize there, so this is the only field with anything to say.
  errorDetail?: string;
};

type CredentialRepository = Pick<ManagedScopedBearerCredentialRepository, "mint" | "activateAndRetireOtherProjectCredentials" | "revokeCredential" | "findActiveCredentialForProject">;

// Order-independent set equality for tool allowlists. SITE_CLIENT_MANAGER_TOOLS and a stored
// credential's toolAllowlist are both "the set of tools this bearer may call" — nothing about a
// scoped bearer's authorization depends on array order — so an array-equality comparison here
// would rotate (mint + rebuild) a tenant on every run purely because JSON key/array ordering
// differs from a historical write, which defeats the whole point of the idempotency check below.
const toolAllowlistsMatch = (a: readonly string[], b: readonly string[]): boolean => {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const tool of setA) if (!setB.has(tool)) return false;
  return true;
};

const parseBindings = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const raw = env[CMS_AGENT_SITE_BINDINGS_ENV]?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const bindings: Record<string, string> = {};
    for (const [projectId, siteName] of Object.entries(parsed)) {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectId) || typeof siteName !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(siteName)) throw new Error("invalid");
      bindings[projectId] = siteName;
    }
    return bindings;
  } catch {
    throw new SiteGenesisRefusal("site_bindings_invalid", `${CMS_AGENT_SITE_BINDINGS_ENV} must be a JSON object mapping project ids to Netlify site names; it contains no credentials.`);
  }
};

export async function reconcileSiteClientManagerCredentials(input: { apply: boolean }, deps: {
  projectRepository: ProjectRepository;
  env?: NodeJS.ProcessEnv;
  netlifyFetch?: NetlifyFetch;
  credentialFetch?: NetlifyFetch;
  credentialRepository?: CredentialRepository;
}): Promise<SiteCredentialReconcileResult[]> {
  const env = deps.env ?? process.env;
  const netlifyToken = env[NETLIFY_API_TOKEN_ENV]?.trim();
  if (input.apply && !netlifyToken) throw new SiteGenesisRefusal("netlify_token_missing", `${NETLIFY_API_TOKEN_ENV} is required for apply; reconciliation never accepts or prints token values as arguments.`);
  const publicEndpoint = input.apply ? resolveCmsAgentPublicMcpEndpoint(env) : env[CMS_AGENT_PUBLIC_MCP_ENDPOINT_ENV]?.trim() || "https://cms-agent.example/mcp";
  const bindings = parseBindings(env);
  // Population is authMode alone now — every bearer_env project is WALKED, not pre-filtered, so
  // one with no binding is reported (see "unmanaged" on the result type) instead of silently
  // disappearing before the loop even starts. Binding eligibility (an explicit durable genesis
  // marker, or an explicit one-time backfill mapping) still decides what gets ACTED on inside the
  // loop; it just no longer decides what gets REPORTED. Internal projects (monetizer, pdf-tool,
  // etc.) have neither a marker nor a mapping and will show up as "unmanaged" too — see the
  // module-level comment for why that noise is the accepted trade. Disabled client sites retain the
  // marker and therefore remain eligible for credential maintenance.
  const projects = (await deps.projectRepository.list()).filter((project) => project.authMode === "bearer_env");
  const results: SiteCredentialReconcileResult[] = [];

  for (const project of projects) {
    const siteName = project.clientSiteBinding?.netlifySiteName ?? bindings[project.projectId];
    if (!siteName) {
      results.push({
        projectId: project.projectId,
        status: "unmanaged",
        errorDetail: `No client-site binding for "${project.projectId}": no credential can be minted or installed for it. If this is a client site, set one with project.update ({ clientSiteBinding: { netlifySiteName: "<netlify-site-name>" } }); if it is an internal service project (e.g. monetizer, pdf-tool) rather than a client site, no action is needed.`
      });
      continue;
    }
    let mintedDigest: string | undefined;
    let credentialInstalled = false;
    let credentials: CredentialRepository | undefined;
    try {
      if (!input.apply) {
        // A dry run never calls Netlify (it must be safe to run with no token and no network
        // access at all), so it has no way to freshly resolve the site id the way apply does. The
        // project's durable clientSiteBinding — written by the last successful apply — is the best
        // stand-in available: comparing against it is what lets an operator trust the plan enough
        // to skip a needless apply, even though a stale/never-applied binding just means the plan
        // conservatively falls back to "planned" below.
        // Construct the registry rather than optional-chaining `deps.credentialRepository`:
        // production (reconcileSiteCredentialsMain) passes only a projectRepository, so an
        // optional chain would leave `activeCredential` undefined on every real run and make the
        // current/planned distinction inert in exactly the place an operator reads it — the plan
        // they use to decide whether an apply (and its fleet-wide republish) is needed at all.
        // Reading the credential registry is the same blob store the project list above already
        // came from, so this adds no new dependency; it is still zero Netlify calls. A registry
        // that cannot be read degrades to "planned": a dry run must never fail, and over-reporting
        // work is the safe direction to be wrong in.
        let activeCredential: ManagedScopedBearerMetadata | undefined;
        try {
          const registry = deps.credentialRepository ?? new ManagedScopedBearerCredentialRepository();
          activeCredential = await registry.findActiveCredentialForProject(project.projectId);
        } catch {
          activeCredential = undefined;
        }
        const resolvedSiteId = project.clientSiteBinding?.netlifySiteId;
        const isCurrent = !!activeCredential && !!resolvedSiteId && activeCredential.netlifySiteId === resolvedSiteId
          && toolAllowlistsMatch(activeCredential.toolAllowlist, SITE_CLIENT_MANAGER_TOOLS);
        results.push({ projectId: project.projectId, netlifySiteName: siteName, status: isCurrent ? "current" : "planned" });
        continue;
      }
      const netlify = new NetlifyGenesisClient("live", netlifyToken!, deps.netlifyFetch);
      const site = await netlify.resolveExistingSite(siteName);
      credentials = deps.credentialRepository ?? new ManagedScopedBearerCredentialRepository();
      // Idempotency skip. Every eligible project used to be re-minted, re-installed and rebuilt on
      // every run with no check at all — the whole fleet's production sites republished on a
      // routine pass, which is why this job could never be scheduled or wired into deploy. If the
      // project's active (non-pending) credential already carries the current tool allowlist and
      // already targets the site we just resolved, there is nothing to change: skip the mint, the
      // env write, the verification handshake, and the rebuild, and leave the existing credential
      // (and its digest) exactly as it is.
      const activeCredential = await credentials.findActiveCredentialForProject(project.projectId);
      if (activeCredential && activeCredential.netlifySiteId === site.siteId && toolAllowlistsMatch(activeCredential.toolAllowlist, SITE_CLIENT_MANAGER_TOOLS)) {
        results.push({ projectId: project.projectId, netlifySiteName: siteName, status: "current" });
        continue;
      }
      const minted = await credentials.mint({ projectId: project.projectId, toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS], netlifySiteId: site.siteId, netlifySiteName: siteName });
      mintedDigest = minted.digest;
      await netlify.setEnvVar(site.accountId, site.siteId, "CMS_AGENT_MCP_ENDPOINT", publicEndpoint, { scopes: ["functions"] });
      await netlify.setEnvVar(site.accountId, site.siteId, "CMS_AGENT_MCP_TOKEN", minted.token, { isSecret: true, scopes: ["functions"], context: "production" });
      credentialInstalled = true;
      await verifyCmsAgentScopedCredential(publicEndpoint, minted.token, deps.credentialFetch);
      await netlify.rebuildAndWaitForPublishedDeploy(site.siteId);
      if (project.clientSiteBinding?.netlifySiteName !== siteName || project.clientSiteBinding?.netlifySiteId !== site.siteId) {
        await deps.projectRepository.save({ ...project, clientSiteBinding: { netlifySiteName: siteName, netlifySiteId: site.siteId } });
      }
      await credentials.activateAndRetireOtherProjectCredentials(project.projectId, minted.digest);
      results.push({ projectId: project.projectId, netlifySiteName: siteName, status: "rotated" });
    } catch (error) {
      let errorCode = error instanceof SiteGenesisRefusal ? error.code : "credential_reconcile_failed";
      // Captured from the ORIGINAL failure, before the cleanup below can overwrite errorCode: when
      // a revoke also fails, the operator still needs to see what went wrong first.
      const errorDetail = error instanceof SiteGenesisRefusal ? error.safeSummary : undefined;
      // Before the site env write succeeds the generated digest is safe to revoke. Afterwards a
      // timeout is ambiguous: Netlify may still publish that deploy, so the pending digest must
      // remain recognized until a later successful retry atomically replaces it.
      if (credentials && mintedDigest && !credentialInstalled) {
        try {
          await credentials.revokeCredential(mintedDigest);
        } catch {
          errorCode = "credential_cleanup_failed";
        }
      }
      results.push({
        projectId: project.projectId,
        netlifySiteName: siteName,
        status: "failed",
        errorCode,
        ...(errorDetail ? { errorDetail } : {})
      });
    }
  }
  return results;
}
