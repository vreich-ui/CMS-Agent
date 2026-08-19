import { describe, expect, it, vi } from "vitest";
import { defaultProjectConfigs } from "../../../src/agent/projects/defaultMigration.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import { reconcileSiteClientManagerCredentials } from "../../../src/agent/capture/siteCredentialReconciler.js";

const projectRepository = (): ProjectRepository => {
  const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
  const record = { ...platform, mcpEndpoint: "https://kugel-platform.netlify.app/mcp", clientSiteBinding: { netlifySiteName: "kugel-platform", netlifySiteId: "site_platform" }, status: "active" as const };
  return {
    list: async () => [record],
    get: async () => record,
    save: async (value) => value,
    delete: async () => false,
    health: async () => ({ readable: true, writable: true, backend: "memory", version: "memory.v1" })
  } as ProjectRepository;
};

const response = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("existing-fleet Client Manager credential reconciliation", () => {
  it("is dry-run by default and performs no mint or network write", async () => {
    const netlifyFetch = vi.fn();
    const mint = vi.fn();
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      { projectRepository: projectRepository(), env: {}, netlifyFetch: netlifyFetch as never, credentialRepository: { mint, activateAndRetireOtherProjectCredentials: vi.fn(), revokeCredential: vi.fn() } }
    );
    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "planned" }]);
    expect(netlifyFetch).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints internally, installs secret/function-only env, verifies, then retires the old digest", async () => {
    const netlifyCalls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const netlifyFetch = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      netlifyCalls.push({ url, init });
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1", ssl_url: "https://kugel-platform.netlify.app" }]);
      if (url.includes("/env/CMS_AGENT_MCP_")) return response(404);
      if (url.includes("/env?site_id=site_platform")) return response(200);
      throw new Error(`unexpected ${url}`);
    });
    const credentialFetch = vi.fn(async () => response(200, { jsonrpc: "2.0", id: "genesis-credential-check", result: {} }));
    const mint = vi.fn(async () => ({ token: "raw-token-never-reported", digest: "d".repeat(64), policy: { projects: ["platform"], toolAllowlist: ["agent_resolve", "agent_converse"] } }));
    const activate = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialFetch: credentialFetch as never,
        credentialRepository: { mint, activateAndRetireOtherProjectCredentials: activate, revokeCredential: revoke }
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "rotated" }]);
    expect(JSON.stringify(results)).not.toContain("raw-token-never-reported");
    expect(activate).toHaveBeenCalledWith("platform", "d".repeat(64));
    expect(revoke).not.toHaveBeenCalled();
    const envPosts = netlifyCalls.filter((call) => call.init?.method === "POST" && call.url.includes("/env?site_id="));
    const variables = envPosts.flatMap((call) => JSON.parse(call.init!.body as string));
    expect(variables.map((variable: { key: string }) => variable.key).sort()).toEqual(["CMS_AGENT_MCP_ENDPOINT", "CMS_AGENT_MCP_TOKEN"]);
    expect(variables.find((variable: { key: string }) => variable.key === "CMS_AGENT_MCP_TOKEN")).toMatchObject({ is_secret: true, scopes: ["functions"], values: [{ context: "production" }] });
    expect(credentialFetch).toHaveBeenCalledOnce();
  });

  it("includes disabled marked client sites and excludes unmarked internal projects", async () => {
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const disabledClient = { ...platform, projectId: "fernwell", mcpEndpoint: "https://fernwell.netlify.app/mcp", clientSiteBinding: { netlifySiteName: "fernwell" }, status: "disabled" as const };
    const internal = { ...platform, projectId: "pdf-tool", mcpEndpoint: "https://internal.example/mcp", status: "active" as const };
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      { projectRepository: { ...projectRepository(), list: async () => [disabledClient, internal] } as ProjectRepository, env: {} }
    );
    expect(results).toEqual([{ projectId: "fernwell", netlifySiteName: "fernwell", status: "planned" }]);
  });

  it("uses an explicit backfill map for existing clients without marking internal projects", async () => {
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const existingClient = { ...platform, projectId: "dr-lurie", status: "active" as const };
    const internal = { ...platform, projectId: "pdf-tool", status: "active" as const };
    const results = await reconcileSiteClientManagerCredentials(
      { apply: false },
      {
        projectRepository: { ...projectRepository(), list: async () => [existingClient, internal] } as ProjectRepository,
        env: { CMS_AGENT_SITE_BINDINGS_JSON: JSON.stringify({ "dr-lurie": "drluriescience" }) }
      }
    );
    expect(results).toEqual([{ projectId: "dr-lurie", netlifySiteName: "drluriescience", status: "planned" }]);
  });

  it("persists the durable binding after a mapped credential is installed and verified", async () => {
    const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
    const existingClient = { ...platform, projectId: "dr-lurie", status: "active" as const };
    const save = vi.fn(async (value) => value);
    const repository = { ...projectRepository(), list: async () => [existingClient], save } as ProjectRepository;
    const netlifyFetch = vi.fn(async (url: string) => {
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_drlurie", name: "drluriescience", account_id: "acct_1", ssl_url: "https://drluriescience.netlify.app" }]);
      if (url.includes("/env/CMS_AGENT_MCP_")) return response(404);
      if (url.includes("/env?site_id=site_drlurie")) return response(200);
      throw new Error(`unexpected ${url}`);
    });
    await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: repository,
        env: {
          NETLIFY_API_TOKEN: "netlify-hidden",
          CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp",
          CMS_AGENT_SITE_BINDINGS_JSON: JSON.stringify({ "dr-lurie": "drluriescience" })
        },
        netlifyFetch: netlifyFetch as never,
        credentialFetch: vi.fn(async () => response(200)) as never,
        credentialRepository: {
          mint: vi.fn(async () => ({ token: "raw-token-never-reported", digest: "d".repeat(64), policy: { projects: ["dr-lurie"], toolAllowlist: ["agent_resolve", "agent_converse"] } })),
          activateAndRetireOtherProjectCredentials: vi.fn(async () => undefined),
          revokeCredential: vi.fn(async () => undefined)
        }
      }
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "dr-lurie",
      clientSiteBinding: { netlifySiteName: "drluriescience", netlifySiteId: "site_drlurie" }
    }));
  });

  it("revokes the pending digest and leaves the project unmodified when Netlify rejects the secret write", async () => {
    const save = vi.fn();
    const repository = { ...projectRepository(), save } as ProjectRepository;
    const netlifyFetch = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      if (url.includes("/sites?name=")) return response(200, [{ id: "site_platform", name: "kugel-platform", account_id: "acct_1" }]);
      if (url.includes("/env/CMS_AGENT_MCP_ENDPOINT")) return response(200, { key: "CMS_AGENT_MCP_ENDPOINT" });
      if (url.includes("/env/CMS_AGENT_MCP_TOKEN") && !init?.method) return response(200, { key: "CMS_AGENT_MCP_TOKEN" });
      if (url.includes("/env/CMS_AGENT_MCP_ENDPOINT") && init?.method === "PUT") return response(200);
      if (url.includes("/env/CMS_AGENT_MCP_TOKEN") && init?.method === "PUT") return response(422, { message: "redacted" });
      throw new Error(`unexpected ${url}`);
    });
    const activate = vi.fn();
    const revoke = vi.fn(async () => undefined);
    const digest = "e".repeat(64);

    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: repository,
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialRepository: {
          mint: vi.fn(async () => ({ token: "raw-token-never-reported", digest, policy: { projects: ["platform"], toolAllowlist: ["agent_resolve", "agent_converse"] } })),
          activateAndRetireOtherProjectCredentials: activate,
          revokeCredential: revoke
        }
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "failed", errorCode: "netlify_api_failed" }]);
    expect(revoke).toHaveBeenCalledWith(digest);
    expect(activate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain("raw-token-never-reported");
  });
});
