import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { ScopedBearerConfigurationError, parseScopedBearerTokenPolicies, validateScopedBearerTokenConfiguration } from "../../../src/agent/mcp/auth/scopedBearerTokens.js";
import { repositoryManager } from "../../../src/agent/runtime/repositories.js";

const CONFIG_ENV = "MCP_SCOPED_TOKENS_JSON";
const SCOPED_TOKEN = "scoped-platform-synthetic";
const savedEnv = { ...process.env };

const policy = (toolAllowlist = ["agent_resolve", "agent_converse"]) => JSON.stringify({
  [SCOPED_TOKEN]: { projects: ["platform"], toolAllowlist }
});

const request = async (body: unknown, token = SCOPED_TOKEN) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: `Bearer ${token}`, host: "site.example" }, body: JSON.stringify(body) });
  return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
};

const resolve = (project_id: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_resolve", arguments: { role: "client_manager", project_id } } });
const converse = (project_id: string) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_converse", arguments: { agent_ref: "agt_client_manager@1", project_id, conversation_id: "chat_scoped", turn_id: "turn_scoped", actor: { kind: "human", id: "usr_scoped" }, context: { site_id: "site_platform" }, messages: [{ role: "user", text: "Hello" }], tools: [], constraints: { max_tokens: 1000, timeout_ms: 5000 } } } });

describe("CA4 scoped MCP bearer tokens", () => {
  beforeEach(() => {
    delete process.env.MCP_API_TOKEN;
    process.env[CONFIG_ENV] = policy();
    repositoryManager.getUsageRepository().clear();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("allows the pinned project and exposes only its canonical allowlisted tools", async () => {
    const initialized = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(initialized.statusCode).toBe(200);

    const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["agent_resolve", "agent_converse"]);

    const allowed = await request(resolve("platform"));
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json.result.structuredContent).toMatchObject({ ok: true, data: { status: "active" } });
  });

  it("denies cross-project agent_resolve and agent_converse before either tool executes", async () => {
    const crossProjectResolve = await request(resolve("dr-lurie"));
    const crossProjectConverse = await request(converse("dr-lurie"));
    expect(crossProjectResolve.statusCode).toBe(401);
    expect(crossProjectConverse.statusCode).toBe(401);
    expect(crossProjectResolve.body).toBe(crossProjectConverse.body);
    expect(crossProjectResolve.json).toEqual({ error: { code: "unauthorized", message: "Missing or invalid bearer token." } });
  });

  it("denies a non-agent tool outside the allowlist without disclosing whether it exists", async () => {
    const disallowed = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project_get", arguments: { projectId: "platform" } } });
    const unknown = await request(resolve("platform"), "unknown-synthetic-token");
    const workspaceMetadata = await request({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    expect(disallowed.statusCode).toBe(401);
    expect(workspaceMetadata.statusCode).toBe(401);
    expect(disallowed.body).toBe(unknown.body);
    expect(disallowed.body).not.toContain("project_get");
    expect(disallowed.body).not.toContain("platform");
  });

  it("permits an explicitly allowlisted non-agent tool only for the pinned project", async () => {
    process.env[CONFIG_ENV] = policy(["agent_resolve", "agent_converse", "project_get"]);
    const allowed = await request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project_get", arguments: { projectId: "platform" } } });
    const crossProject = await request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "project_get", arguments: { projectId: "dr-lurie" } } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json.result.structuredContent.ok).toBe(true);
    expect(crossProject.statusCode).toBe(401);
  });

  it("preserves the legacy MCP_API_TOKEN success and failure path", async () => {
    process.env.MCP_API_TOKEN = "legacy-synthetic-token";
    const legacy = await request({ jsonrpc: "2.0", id: 6, method: "tools/list" }, "legacy-synthetic-token");
    const wrong = await request({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "wrong-legacy-synthetic-token");
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json.result.tools.map((tool: { name: string }) => tool.name)).toContain("workspace_get_nodes");
    expect(wrong.statusCode).toBe(401);
  });

  it("rejects malformed, ambiguous, and colliding scoped configuration without exposing parser detail", async () => {
    const invalid = [
      "not-json",
      JSON.stringify({ [SCOPED_TOKEN]: { projects: [], toolAllowlist: ["agent_resolve"] } }),
      JSON.stringify({ [SCOPED_TOKEN]: { projects: ["platform", "platform"], toolAllowlist: ["agent_resolve"] } }),
      JSON.stringify({ [SCOPED_TOKEN]: { projects: ["platform"], toolAllowlist: ["agent.resolve"] } })
    ];
    for (const raw of invalid) {
      process.env[CONFIG_ENV] = raw;
      expect(() => parseScopedBearerTokenPolicies()).toThrow(ScopedBearerConfigurationError);
      const denied = await request(resolve("platform"));
      expect(denied.statusCode).toBe(401);
      expect(denied.body).not.toContain("Scoped MCP bearer");
    }

    process.env.MCP_API_TOKEN = SCOPED_TOKEN;
    process.env[CONFIG_ENV] = policy();
    expect(() => validateScopedBearerTokenConfiguration()).toThrow(ScopedBearerConfigurationError);
  });
});

describe("CA4 deploy script regression guard", () => {
  it("keeps automated and manual deploy wiring aligned with merge-style scoped and Fernwell bindings", async () => {
    const script = await readFile(new URL("../../../scripts/deploy-mcp.sh", import.meta.url), "utf8");
    const cloudBuild = await readFile(new URL("../../../cloudbuild.deploy.yaml", import.meta.url), "utf8");
    const commandLines = script.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    const cloudBuildCommandLines = cloudBuild.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(commandLines.some((line) => /--set-(?:env-vars|secrets)\b/.test(line))).toBe(false);
    expect(cloudBuildCommandLines.some((line) => /--set-(?:env-vars|secrets)\b/.test(line))).toBe(false);
    expect(script).toContain("--update-env-vars");
    expect(script).toContain("--update-secrets");
    expect(script).toContain("MCP_SCOPED_TOKENS_JSON=$SCOPED_TOKENS_SECRET:latest");
    expect(cloudBuild).toContain("MCP_SCOPED_TOKENS_JSON=mcp-scoped-tokens-json:latest");
    expect(script).toContain("FERNWELL_MCP_ENDPOINT=https://kugel-fernwell.netlify.app/mcp");
    expect(cloudBuild).toContain("FERNWELL_MCP_ENDPOINT=https://kugel-fernwell.netlify.app/mcp");
    expect(script).toContain("FERNWELL_MCP_TOKEN=fernwell-mcp-token:latest");
    expect(cloudBuild).toContain("FERNWELL_MCP_TOKEN=fernwell-mcp-token:latest");
    expect(cloudBuild).toContain("for VAR in MCP_SCOPED_TOKENS_JSON DR_LURIE_MCP_ENDPOINT DR_LURIE_MCP_TOKEN PDF_TOOL_MCP_ENDPOINT PDF_TOOL_MCP_TOKEN PLATFORM_MCP_ENDPOINT PLATFORM_MCP_TOKEN FERNWELL_MCP_ENDPOINT FERNWELL_MCP_TOKEN; do");
  });
});
