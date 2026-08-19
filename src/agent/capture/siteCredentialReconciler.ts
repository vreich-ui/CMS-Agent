import { resolveProjectConnection } from "../projects/projectMcpAdapter.js";
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

type CredentialRepository = Pick<ManagedScopedBearerCredentialRepository, "mint" | "retireOtherProjectCredentials">;

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

export const netlifySiteNameForProject = (projectId: string, endpoint: string | undefined, bindings: Record<string, string>): string => {
  if (bindings[projectId]) return bindings[projectId];
  if (endpoint) {
    try {
      const hostname = new URL(endpoint).hostname.toLowerCase();
      if (hostname.endsWith(".netlify.app")) return hostname.slice(0, -".netlify.app".length);
    } catch {
      // The project registry validates endpoints. Collapse any legacy malformed value below.
    }
  }
  throw new SiteGenesisRefusal("netlify_site_binding_missing", `Project "${projectId}" does not use a netlify.app endpoint and has no non-secret ${CMS_AGENT_SITE_BINDINGS_ENV} entry.`);
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
  const projects = (await deps.projectRepository.list()).filter((project) => project.status === "active" && project.authMode === "bearer_env");
  const results: SiteCredentialReconcileResult[] = [];

  for (const project of projects) {
    let siteName = bindings[project.projectId] ?? project.projectId;
    try {
      const connection = resolveProjectConnection(project, env);
      siteName = netlifySiteNameForProject(project.projectId, connection.endpoint, bindings);
      if (!input.apply) {
        results.push({ projectId: project.projectId, netlifySiteName: siteName, status: "planned" });
        continue;
      }
      const netlify = new NetlifyGenesisClient("live", netlifyToken!, deps.netlifyFetch);
      const site = await netlify.resolveExistingSite(siteName);
      const credentials = deps.credentialRepository ?? new ManagedScopedBearerCredentialRepository();
      const minted = await credentials.mint({ projectId: project.projectId, toolAllowlist: [...SITE_CLIENT_MANAGER_TOOLS], netlifySiteId: site.siteId, netlifySiteName: siteName });
      await netlify.setEnvVar(site.accountId, site.siteId, "CMS_AGENT_MCP_ENDPOINT", publicEndpoint, { scopes: ["functions"] });
      await netlify.setEnvVar(site.accountId, site.siteId, "CMS_AGENT_MCP_TOKEN", minted.token, { isSecret: true, scopes: ["functions"] });
      await verifyCmsAgentScopedCredential(publicEndpoint, minted.token, deps.credentialFetch);
      await credentials.retireOtherProjectCredentials(project.projectId, minted.digest);
      results.push({ projectId: project.projectId, netlifySiteName: siteName, status: "rotated" });
    } catch (error) {
      results.push({
        projectId: project.projectId,
        netlifySiteName: siteName,
        status: "failed",
        errorCode: error instanceof SiteGenesisRefusal ? error.code : "credential_reconcile_failed"
      });
    }
  }
  return results;
}
