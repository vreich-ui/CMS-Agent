import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { projectCreateSchema, projectUpdateSchema } from "../../../src/agent/projects/projectAdmin.js";

// T12.20 gave a tenant's TOKEN a second, plane-independent source: tokenSecretRef, a Secret Manager
// version resource name resolved with the executing plane's own identity. The registration contract
// calls it the PREFERRED way to supply a token, precisely because the alternative — the env var —
// has to exist on EVERY plane that executes work, and one of them (the continuation-tick Cloud Run
// job) deliberately carries no tenant environment at all.
//
// The field was accepted by projectCreateSchema/projectUpdateSchema from the start and was never
// advertised by either tool's inputSchema. The consequence was not cosmetic: a strict client builds
// its arguments from tools/list, so the preferred credential source was undiscoverable and, for a
// validating client, unsendable. Four of the five registered tenants were still env-var-only on
// 2026-08-27, and every one of their runs that the continuation-tick job picked up died at the first
// node with `driver_auth_failed:<VAR>` — "the credential this driver presented came from nowhere".
//
// So: the advertised schema must carry the credential fields the validator accepts.
const post = async (body: unknown) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(body) });
  return JSON.parse(response.body ?? "{}");
};

// Keys the validators accept that the advertised schema deliberately does NOT expose. capturePolicy
// is a large nested policy object written by site genesis and by the Access UI, and raising its
// `rights` is documented as an explicit human act — widening the advertised surface for it is a
// separate decision, not a side effect of this test. Listed rather than silently tolerated so the
// omission stays a choice someone made instead of drift nobody noticed.
const DELIBERATELY_UNADVERTISED = new Set(["capturePolicy"]);

const advertised = async (toolName: string): Promise<any> => {
  const tools: Array<{ name: string; inputSchema: any }> = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  const schema = tools.find((tool) => tool.name === toolName)?.inputSchema;
  expect(schema, `${toolName} is missing from tools/list`).toBeDefined();
  return schema;
};

describe("project.create / project.update advertise the credential fields they accept", () => {
  beforeEach(() => { process.env.MCP_API_TOKEN = "test-token"; resetRepositoryManager(); });

  it("advertises tokenSecretRef on project.create", async () => {
    const schema = await advertised("project_create");
    expect(schema.properties.project.properties, "project.create must advertise tokenSecretRef").toHaveProperty("tokenSecretRef");
  });

  it("advertises tokenSecretRef on project.update, nullable so it can be cleared", async () => {
    const schema = await advertised("project_update");
    const field: any = (schema.properties as any).patch.properties.tokenSecretRef;
    expect(field, "project.update must advertise tokenSecretRef").toBeDefined();
    expect(field.oneOf.some((member: any) => member.type === "null"), "tokenSecretRef must be clearable").toBe(true);
  });

  it("advertises every key its validator accepts, except the documented omissions", async () => {
    const createSchema = await advertised("project_create");
    const updateSchema = await advertised("project_update");
    const createProps = Object.keys((createSchema.properties as any).project.properties);
    const updateProps = Object.keys((updateSchema.properties as any).patch.properties);

    for (const key of Object.keys(projectCreateSchema.shape)) {
      if (DELIBERATELY_UNADVERTISED.has(key)) continue;
      expect(createProps, `project.create accepts "${key}" but does not advertise it`).toContain(key);
    }
    for (const key of Object.keys(projectUpdateSchema.shape)) {
      if (DELIBERATELY_UNADVERTISED.has(key)) continue;
      expect(updateProps, `project.update accepts "${key}" but does not advertise it`).toContain(key);
    }
  });

  it("accepts a tokenSecretRef built only from the advertised pattern, and refuses a token VALUE in that field", async () => {
    const created = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_create", arguments: { project: {
      projectId: "schema-fixture-tenant",
      name: "Schema Fixture Tenant",
      mcpEndpointEnvVar: "SCHEMA_FIXTURE_MCP_ENDPOINT",
      mcpEndpoint: "https://schema-fixture.example.com/mcp",
      tokenSecretRef: "projects/cms-agent-503015/secrets/schema-fixture-mcp-token/versions/latest"
    } } } });
    expect(created.error, `project.create rejected a schema-conformant tokenSecretRef: ${JSON.stringify(created.error)}`).toBeUndefined();
    expect(created.result.structuredContent.ok).toBe(true);
    // The record stores a POINTER; the connection view may name it but must never carry a value.
    const connection = created.result.structuredContent.data.project.connection;
    expect(connection.tokenSecretRef).toBe("projects/cms-agent-503015/secrets/schema-fixture-mcp-token/versions/latest");
    expect(connection.tokenConfigured).toBe(true);

    // A raw secret in the field is the failure this pattern exists to prevent.
    const smuggled = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_update", arguments: {
      projectId: "schema-fixture-tenant",
      patch: { tokenSecretRef: "sk-live-not-a-resource-name" }
    } } });
    const refused = smuggled.error !== undefined || smuggled.result?.structuredContent?.ok === false;
    expect(refused, "a token VALUE must never be storable in tokenSecretRef").toBe(true);
  });

  // The widened rule, in both directions: bearer_env needs A token source, and still needs one.
  it("refuses a bearer project that names no token source at all", async () => {
    const created = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project_create", arguments: { project: {
      projectId: "sourceless-tenant",
      name: "Sourceless Tenant",
      mcpEndpointEnvVar: "SOURCELESS_MCP_ENDPOINT",
      mcpEndpoint: "https://sourceless.example.com/mcp"
    } } } });
    const message = JSON.stringify(created.error ?? created.result?.structuredContent ?? {});
    expect(message).toContain("token_env_var_required");
  });

  // Clearing the env var used to be legal only by also dropping to authMode "none" — which would
  // have forced a tenant off bearer auth just to move it onto the preferred credential source.
  it("lets a project drop tokenEnvVar once tokenSecretRef stands", async () => {
    const call = async (name: string, args: Record<string, unknown>) => post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    await call("project_create", { project: {
      projectId: "migrating-tenant",
      name: "Migrating Tenant",
      mcpEndpointEnvVar: "MIGRATING_MCP_ENDPOINT",
      mcpEndpoint: "https://migrating.example.com/mcp",
      tokenEnvVar: "MIGRATING_MCP_TOKEN"
    } });
    const migrated = await call("project_update", { projectId: "migrating-tenant", patch: {
      tokenSecretRef: "projects/cms-agent-503015/secrets/migrating-mcp-token/versions/latest",
      tokenEnvVar: null
    } });
    expect(migrated.error, `migration off the env var was refused: ${JSON.stringify(migrated.error)}`).toBeUndefined();
    const connection = migrated.result.structuredContent.data.project.connection;
    expect(connection.tokenEnvVar).toBeUndefined();
    expect(connection.tokenSecretRef).toBe("projects/cms-agent-503015/secrets/migrating-mcp-token/versions/latest");
    expect(connection.tokenConfigured).toBe(true);
    expect(connection.tokenSource).toBe("secret");
  });
});
