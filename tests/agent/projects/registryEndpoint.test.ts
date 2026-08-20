// The registry-stored MCP endpoint (2026-08-18, Wolf: "setting ZILBERMAN_MCP_ENDPOINT in every new
// clone or even generally client genesis by hand does not work for me").
//
// What this file pins:
//   1. BACKWARDS COMPATIBILITY. Every project registered today — the five code-defined defaults
//      (dr-lurie, fernwell, monetizer, pdf-tool, platform) and the persisted zilberman record, none
//      of which carries a stored endpoint — resolves EXACTLY as it did before this field existed.
//   2. Precedence: the env var WINS whenever it is populated, so an operator keeps a break-glass
//      override and no existing deployment's behavior can shift under it.
//   3. The registry record answers when the env var does not — the entire point.
//   4. The security posture is unchanged where it matters: the TOKEN is still env-var-NAME-only,
//      and a stored endpoint must be provably credential-free (https, no user:password@, no query,
//      no fragment) or the write is refused. The registry still physically cannot hold a credential.
import { describe, expect, it } from "vitest";
import { MemoryProjectRepository } from "../../../src/agent/repository/memory/MemoryProjectRepository.js";
import { defaultProjectConnections } from "../../../src/agent/projects/defaultProjects.js";
import { createProject, updateProject, ProjectAdminError, projectCreateSchema, projectUpdateSchema } from "../../../src/agent/projects/projectAdmin.js";
import { resolveProjectConnection, toConnectionState } from "../../../src/agent/projects/projectMcpAdapter.js";
import { deriveTenantMcpEndpoint } from "../../../src/agent/capture/siteGenesis.js";
import type { ProjectConnectionConfig } from "../../../src/agent/projects/projectTypes.js";

// The zilberman record as it exists in the live registry today: registered by genesis through
// project.create with env var NAMES only, no stored endpoint. Reconstructed here (it is a persisted
// record, not a code-defined default) so the compatibility proof covers all SIX live projects.
const zilbermanAsRegisteredToday: ProjectConnectionConfig = {
  projectId: "zilberman",
  name: "zilberman",
  mcpEndpointEnvVar: "ZILBERMAN_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "ZILBERMAN_MCP_TOKEN",
  allowedTools: [],
  defaultToolPolicy: "allowed",
  contentContract: { contentContract: "content_source.v1" },
  publishingPolicy: { publishEnabled: true, requiresExplicitPublish: false, description: "genesis default" },
  status: "active"
};

const liveProjects = (): ProjectConnectionConfig[] => [...defaultProjectConnections, zilbermanAsRegisteredToday];

describe("registry-stored MCP endpoint — backwards compatibility", () => {
  it("resolves all six currently-registered projects exactly as before: env var populated → endpoint from env", () => {
    const projects = liveProjects();
    expect(projects.map((project) => project.projectId).sort()).toEqual(["dr-lurie", "fernwell", "monetizer", "pdf-tool", "platform", "zilberman"]);

    for (const project of projects) {
      // None of them carries a stored endpoint — this field is opt-in and nothing was migrated.
      expect(project.mcpEndpoint).toBeUndefined();

      const env = {
        [project.mcpEndpointEnvVar]: `https://${project.projectId}.example/mcp`,
        ...(project.tokenEnvVar ? { [project.tokenEnvVar]: "super-secret-token" } : {})
      } as unknown as NodeJS.ProcessEnv;

      const resolved = resolveProjectConnection(project, env);
      expect(resolved.endpoint).toBe(`https://${project.projectId}.example/mcp`);
      expect(resolved.endpointConfigured).toBe(true);
      expect(resolved.endpointSource).toBe("env");
      expect(resolved.tokenConfigured).toBe(Boolean(project.tokenEnvVar));

      // The safe view still leaks neither the endpoint VALUE from env nor the token.
      const state = toConnectionState(project, env);
      expect(state.mcpEndpoint).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain("super-secret-token");
      expect(JSON.stringify(state)).not.toContain(`https://${project.projectId}.example/mcp`);
    }
  });

  it("resolves all six as unconfigured with an empty environment — the old failure mode is intact", () => {
    for (const project of liveProjects()) {
      const resolved = resolveProjectConnection(project, {} as NodeJS.ProcessEnv);
      expect(resolved).toMatchObject({ endpointConfigured: false, tokenConfigured: false, endpoint: undefined, endpointSource: "unset", token: undefined });
    }
  });
});

describe("registry-stored MCP endpoint — resolution", () => {
  const withStoredEndpoint: ProjectConnectionConfig = { ...zilbermanAsRegisteredToday, mcpEndpoint: "https://zilbermanfilmfoundation.netlify.app/mcp" };

  it("uses the stored endpoint when the env var is absent", () => {
    const resolved = resolveProjectConnection(withStoredEndpoint, {} as NodeJS.ProcessEnv);
    expect(resolved.endpoint).toBe("https://zilbermanfilmfoundation.netlify.app/mcp");
    expect(resolved.endpointConfigured).toBe(true);
    expect(resolved.endpointSource).toBe("registry");
  });

  it("lets the env var WIN when both are present — the break-glass override, and why no live project changes", () => {
    const env = { ZILBERMAN_MCP_ENDPOINT: "https://override.example/mcp" } as unknown as NodeJS.ProcessEnv;
    const resolved = resolveProjectConnection(withStoredEndpoint, env);
    expect(resolved.endpoint).toBe("https://override.example/mcp");
    expect(resolved.endpointSource).toBe("env");
  });

  it("treats a blank env var as absent rather than as an override", () => {
    const env = { ZILBERMAN_MCP_ENDPOINT: "   " } as unknown as NodeJS.ProcessEnv;
    expect(resolveProjectConnection(withStoredEndpoint, env).endpointSource).toBe("registry");
  });

  it("returns the stored endpoint in the safe connection view — it is configuration, not a secret", () => {
    const state = toConnectionState(withStoredEndpoint, {} as NodeJS.ProcessEnv);
    expect(state).toEqual({
      endpointConfigured: true,
      tokenConfigured: false,
      mcpEndpointEnvVar: "ZILBERMAN_MCP_ENDPOINT",
      tokenEnvVar: "ZILBERMAN_MCP_TOKEN",
      endpointSource: "registry",
      tokenSource: "unset",
      mcpEndpoint: "https://zilbermanfilmfoundation.netlify.app/mcp"
    });
  });
});

describe("registry-stored MCP endpoint — the registry still cannot hold a credential", () => {
  const base = { projectId: "acme-daily", name: "Acme Daily", mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT", tokenEnvVar: "ACME_DAILY_MCP_TOKEN" };

  const rejected = [
    ["credentials in userinfo", "https://user:s3cr3t@acme-daily.netlify.app/mcp"],
    ["a token in the query string", "https://acme-daily.netlify.app/mcp?token=s3cr3t"],
    ["a fragment", "https://acme-daily.netlify.app/mcp#s3cr3t"],
    ["plain http", "http://acme-daily.netlify.app/mcp"],
    ["a non-URL string", "ACME_DAILY_MCP_ENDPOINT"]
  ] as const;

  for (const [why, endpoint] of rejected) {
    it(`refuses ${why}`, () => {
      const parsed = projectCreateSchema.safeParse({ ...base, mcpEndpoint: endpoint });
      expect(parsed.success).toBe(false);
    });
  }

  it("refuses a bad endpoint even from an in-process caller that skipped the MCP schema", async () => {
    const repository = new MemoryProjectRepository();
    await expect(createProject(repository, {
      ...base,
      mcpEndpoint: "https://user:s3cr3t@acme-daily.netlify.app/mcp",
      authMode: "bearer_env",
      allowedTools: [],
      contentContract: { contentContract: "content_source.v1" },
      status: "active"
    })).rejects.toBeInstanceOf(ProjectAdminError);
    expect(await repository.get("acme-daily")).toBeUndefined();
  });

  it("still requires the TOKEN as an env var NAME — a token value is not storable by any route", () => {
    expect(projectCreateSchema.safeParse({ ...base, tokenEnvVar: "super-secret-token" }).success).toBe(false);
    expect(projectUpdateSchema.safeParse({ tokenEnvVar: "super-secret-token" }).success).toBe(false);
  });

  it("accepts a plain https endpoint and persists it, and update null clears it back to env-only", async () => {
    const repository = new MemoryProjectRepository();
    const created = await createProject(repository, {
      ...base,
      mcpEndpoint: "https://acme-daily.netlify.app/mcp",
      authMode: "bearer_env",
      allowedTools: [],
      contentContract: { contentContract: "content_source.v1" },
      status: "active"
    });
    expect(created.connection.mcpEndpoint).toBe("https://acme-daily.netlify.app/mcp");
    expect(created.connection.endpointConfigured).toBe(true);
    expect((await repository.get("acme-daily"))!.mcpEndpoint).toBe("https://acme-daily.netlify.app/mcp");

    const cleared = await updateProject(repository, "acme-daily", { mcpEndpoint: null });
    expect(cleared.connection.mcpEndpoint).toBeUndefined();
    expect(cleared.connection.endpointSource).toBe("unset");
    expect((await repository.get("acme-daily"))!.mcpEndpoint).toBeUndefined();

    const set = await updateProject(repository, "acme-daily", { mcpEndpoint: "https://acme-daily.example.org/mcp" });
    expect(set.connection.mcpEndpoint).toBe("https://acme-daily.example.org/mcp");
  });

  it("registers an EXISTING tenant's endpoint without touching the deployment (the zilberman case)", async () => {
    const repository = new MemoryProjectRepository();
    await repository.save(zilbermanAsRegisteredToday);

    const updated = await updateProject(repository, "zilberman", { mcpEndpoint: "https://zilbermanfilmfoundation.netlify.app/mcp" });
    expect(updated.connection.endpointSource).toBe("registry");
    // Env-var-name reference and token handling are untouched by the patch.
    expect(updated.connection.mcpEndpointEnvVar).toBe("ZILBERMAN_MCP_ENDPOINT");
    expect(updated.connection.tokenEnvVar).toBe("ZILBERMAN_MCP_TOKEN");
    expect(updated.connection.tokenConfigured).toBe(false);
  });
});

describe("genesis endpoint derivation — deterministic, no model call, no human input", () => {
  it("derives <site>.netlify.app/mcp when Netlify reported no URL", () => {
    expect(deriveTenantMcpEndpoint("zilbermanfilmfoundation")).toBe("https://zilbermanfilmfoundation.netlify.app/mcp");
  });

  it("prefers the origin Netlify reported for the site (custom serving name included)", () => {
    expect(deriveTenantMcpEndpoint("acme-daily", "https://acme-daily-prod.netlify.app")).toBe("https://acme-daily-prod.netlify.app/mcp");
  });

  it("takes only the ORIGIN, so a path/query/credential in the API response can never reach a record", () => {
    expect(deriveTenantMcpEndpoint("acme-daily", "https://acme.example/some/path?x=1#y")).toBe("https://acme.example/mcp");
    expect(deriveTenantMcpEndpoint("acme-daily", "https://user:pass@acme.example")).toBe("https://acme-daily.netlify.app/mcp");
    expect(deriveTenantMcpEndpoint("acme-daily", "http://acme.example")).toBe("https://acme-daily.netlify.app/mcp");
    expect(deriveTenantMcpEndpoint("acme-daily", "not a url")).toBe("https://acme-daily.netlify.app/mcp");
  });

  it("is a pure function of its inputs — the same site always yields the same endpoint", () => {
    expect(deriveTenantMcpEndpoint("acme-daily")).toBe(deriveTenantMcpEndpoint("acme-daily"));
  });
});
