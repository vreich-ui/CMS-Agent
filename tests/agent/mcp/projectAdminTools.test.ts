import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const ENDPOINT = "https://acme-daily.example/mcp";
const SECRET = "acme-super-secret-token";

const call = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
};
const toolCall = (name: string, args: Record<string, unknown> = {}, id = 1) => call({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const structured = (response: Awaited<ReturnType<typeof call>>) => response.json.result.structuredContent;
// Tool failures surface either as { error: { message } } (thrown Errors) or as
// { error: { code: "validation_error", issues } } (Zod). Serialize the whole payload so
// assertions work for both shapes.
const toolErrorMessage = (response: Awaited<ReturnType<typeof call>>) => JSON.stringify(response.json.error.data);

const acme = {
  projectId: "acme-daily",
  name: "Acme Daily",
  mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT",
  authMode: "bearer_env",
  tokenEnvVar: "ACME_DAILY_MCP_TOKEN",
  allowedTools: ["ping"]
};

describe("agentic project registration tools", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  afterEach(() => {
    delete process.env.ACME_DAILY_MCP_ENDPOINT;
    delete process.env.ACME_DAILY_MCP_TOKEN;
    vi.unstubAllGlobals();
  });

  it("advertises the registration tools with Anthropic-safe names", async () => {
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = response.json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["project_get_registration_contract", "project_create", "project_update", "project_delete"]));
  });

  it("publishes a machine-readable registration contract for agents", async () => {
    const { data } = structured(await toolCall("project.get_registration_contract"));
    expect(data.contract.version).toBe("project_registration.v1");
    expect(data.contract.fields.projectId.pattern).toBeTruthy();
    expect(data.contract.onboardingSteps.length).toBeGreaterThanOrEqual(5);
    expect(data.contract.publishingPolicy).toContain("publishEnabled=false");
  });

  it("creates a new publishing client and lists it alongside dr-lurie", async () => {
    const created = structured(await toolCall("project.create", { project: acme })).data.project;
    expect(created).toMatchObject({
      projectId: "acme-daily",
      name: "Acme Daily",
      authMode: "bearer_env",
      allowedTools: ["ping"],
      status: "active",
      contentContract: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" },
      publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true },
      connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "ACME_DAILY_MCP_ENDPOINT", tokenEnvVar: "ACME_DAILY_MCP_TOKEN" }
    });

    const listed = structured(await toolCall("project.list")).data.projects.map((project: { projectId: string }) => project.projectId);
    expect(listed).toEqual(expect.arrayContaining(["acme-daily", "dr-lurie"]));
  });

  it("rejects duplicate ids, malformed ids, and bearer_env without a token env var", async () => {
    await toolCall("project.create", { project: acme });
    expect(toolErrorMessage(await toolCall("project.create", { project: acme }))).toContain("project_exists");
    expect(toolErrorMessage(await toolCall("project.create", { project: { ...acme, projectId: "Acme Daily!" } }))).toContain("kebab-case");
    expect(toolErrorMessage(await toolCall("project.create", { project: { ...acme, projectId: "acme-2", tokenEnvVar: undefined } }))).toContain("token_env_var_required");
  });

  it("refuses secret-shaped values where env var NAMES belong, so credentials cannot persist", async () => {
    const url = await toolCall("project.create", { project: { ...acme, projectId: "acme-3", mcpEndpointEnvVar: ENDPOINT } });
    const token = await toolCall("project.create", { project: { ...acme, projectId: "acme-4", tokenEnvVar: SECRET } });
    expect(toolErrorMessage(url)).toContain("environment variable NAME");
    expect(toolErrorMessage(token)).toContain("environment variable NAME");
    // Neither attempt may leave a partial record behind.
    const listed = structured(await toolCall("project.list")).data.projects.map((project: { projectId: string }) => project.projectId);
    expect(listed).not.toEqual(expect.arrayContaining(["acme-3", "acme-4"]));
  });

  it("reports connection state from env without ever returning values", async () => {
    await toolCall("project.create", { project: acme });
    const before = structured(await toolCall("project.get", { projectId: "acme-daily" })).data.project;
    expect(before.connection).toMatchObject({ endpointConfigured: false, tokenConfigured: false });

    process.env.ACME_DAILY_MCP_ENDPOINT = ENDPOINT;
    process.env.ACME_DAILY_MCP_TOKEN = SECRET;
    const after = await toolCall("project.get", { projectId: "acme-daily" });
    expect(structured(after).data.project.connection).toMatchObject({ endpointConfigured: true, tokenConfigured: true });
    expect(JSON.stringify(after.json)).not.toContain(ENDPOINT);
    expect(JSON.stringify(after.json)).not.toContain(SECRET);
  });

  it("completes the full agentic onboarding flow: create → configure env → test_connection → call_tool", async () => {
    const remoteMethods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      remoteMethods.push(request.method);
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "acme-mcp", version: "1.0.0" } }
        : request.method === "tools/call" ? { pong: true } : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    }));

    await toolCall("project.create", { project: acme });
    process.env.ACME_DAILY_MCP_ENDPOINT = ENDPOINT;
    process.env.ACME_DAILY_MCP_TOKEN = SECRET;

    const connection = structured(await toolCall("project.test_connection", { projectId: "acme-daily" })).data.connection;
    expect(connection.ok).toBe(true);
    expect(connection.server).toMatchObject({ name: "acme-mcp" });

    const allowed = structured(await toolCall("project.call_tool", { projectId: "acme-daily", tool: "ping", arguments: {} })).data.call;
    expect(allowed.ok).toBe(true);

    const blocked = structured(await toolCall("project.call_tool", { projectId: "acme-daily", tool: "publish_article", arguments: {} })).data.call;
    expect(blocked.ok).toBe(false);
    expect(remoteMethods).toEqual(["initialize", "tools/call"]);
  });

  it("updates safe fields and enforces auth-mode consistency", async () => {
    await toolCall("project.create", { project: acme });

    const updated = structured(await toolCall("project.update", { projectId: "acme-daily", patch: { allowedTools: ["ping", "registry_get"], status: "disabled", name: "Acme Daily (paused)" } })).data.project;
    expect(updated).toMatchObject({ name: "Acme Daily (paused)", status: "disabled", allowedTools: ["ping", "registry_get"] });
    expect(updated.publishingPolicy.publishEnabled).toBe(false);

    // Removing the token while staying on bearer_env is inconsistent and refused.
    expect(toolErrorMessage(await toolCall("project.update", { projectId: "acme-daily", patch: { tokenEnvVar: null } }))).toContain("token_env_var_required");
    // Switching to authMode none may drop the token.
    const anonymous = structured(await toolCall("project.update", { projectId: "acme-daily", patch: { authMode: "none", tokenEnvVar: null } })).data.project;
    expect(anonymous.connection.tokenEnvVar).toBeUndefined();

    expect(toolErrorMessage(await toolCall("project.update", { projectId: "missing", patch: { name: "X" } }))).toContain("unknown_project");
  });

  it("deletes agent-registered projects but protects code-defined defaults", async () => {
    await toolCall("project.create", { project: acme });
    expect(structured(await toolCall("project.delete", { projectId: "acme-daily" })).data).toMatchObject({ deleted: true, projectId: "acme-daily" });

    const listed = structured(await toolCall("project.list")).data.projects.map((project: { projectId: string }) => project.projectId);
    expect(listed).not.toContain("acme-daily");

    expect(toolErrorMessage(await toolCall("project.delete", { projectId: "dr-lurie" }))).toContain("default_project_protected");
    expect(toolErrorMessage(await toolCall("project.delete", { projectId: "never-existed" }))).toContain("unknown_project");
  });
});
