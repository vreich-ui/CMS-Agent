import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { ManagedScopedBearerCredentialRepository } from "../mcp/auth/managedScopedBearerCredentials.js";
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
  netlifySiteName: string;
  status: "planned" | "rotated" | "failed";
  errorCode?: string;
};

type CredentialRepository = Pick<ManagedScopedBearerCredentialRepository, "mint" | "activateAndRetireOtherProjectCredentials" | "revokeCredential">;

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
  // Eligibility is an explicit durable genesis marker or an explicit one-time backfill mapping,
  // never inferred from project status, auth mode alone, or endpoint shape. Internal projects
  // (monetizer/pdf-tool, etc.) have neither. Disabled client sites retain the marker and therefore
  // remain eligible for credential maintenance.
  const projects = (await deps.projectRepository.list()).filter(
    (project) => project.authMode === "bearer_env" && (project.clientSiteBinding || bindings[project.projectId])
  );
  const results: SiteCredentialReconcileResult[] = [];

  for (const project of projects) {
    let siteName = project.clientSiteBinding?.netlifySiteName ?? bindings[project.projectId]!;
    let mintedDigest: string | undefined;
    let credentialInstalled = false;
    let credentials: CredentialRepository | undefined;
    try {
      if (!input.apply) {
        results.push({ projectId: project.projectId, netlifySiteName: siteName, status: "planned" });
        continue;
      }
      const netlify = new NetlifyGenesisClient("live", netlifyToken!, deps.netlifyFetch);
      const site = await netlify.resolveExistingSite(siteName);
      credentials = deps.credentialRepository ?? new ManagedScopedBearerCredentialRepository();
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
        errorCode
      });
    }
  }
  return results;
}
