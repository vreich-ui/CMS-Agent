import { describe, expect, it, vi } from "vitest";
import { defaultProjectConfigs } from "../../../src/agent/projects/defaultMigration.js";
import type { ProjectRepository } from "../../../src/agent/repository/interfaces/ProjectRepository.js";
import { reconcileSiteClientManagerCredentials } from "../../../src/agent/capture/siteCredentialReconciler.js";

const projectRepository = (): ProjectRepository => {
  const platform = defaultProjectConfigs().find((project) => project.projectId === "platform")!;
  const record = { ...platform, mcpEndpoint: "https://kugel-platform.netlify.app/mcp", status: "active" as const };
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
      { projectRepository: projectRepository(), env: {}, netlifyFetch: netlifyFetch as never, credentialRepository: { mint, retireOtherProjectCredentials: vi.fn() } }
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
    const retire = vi.fn(async () => undefined);
    const results = await reconcileSiteClientManagerCredentials(
      { apply: true },
      {
        projectRepository: projectRepository(),
        env: { NETLIFY_API_TOKEN: "netlify-hidden", CMS_AGENT_PUBLIC_MCP_ENDPOINT: "https://cms-agent.example/mcp" },
        netlifyFetch: netlifyFetch as never,
        credentialFetch: credentialFetch as never,
        credentialRepository: { mint, retireOtherProjectCredentials: retire }
      }
    );

    expect(results).toEqual([{ projectId: "platform", netlifySiteName: "kugel-platform", status: "rotated" }]);
    expect(JSON.stringify(results)).not.toContain("raw-token-never-reported");
    expect(retire).toHaveBeenCalledWith("platform", "d".repeat(64));
    const envPosts = netlifyCalls.filter((call) => call.init?.method === "POST" && call.url.includes("/env?site_id="));
    const variables = envPosts.flatMap((call) => JSON.parse(call.init!.body as string));
    expect(variables.map((variable: { key: string }) => variable.key).sort()).toEqual(["CMS_AGENT_MCP_ENDPOINT", "CMS_AGENT_MCP_TOKEN"]);
    expect(variables.find((variable: { key: string }) => variable.key === "CMS_AGENT_MCP_TOKEN")).toMatchObject({ is_secret: true, scopes: ["functions"], values: [{ context: "all" }] });
    expect(credentialFetch).toHaveBeenCalledOnce();
  });
});
