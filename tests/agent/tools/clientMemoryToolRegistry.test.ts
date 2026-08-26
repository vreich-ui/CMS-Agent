import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolRegistry } from "../../../src/agent/tools/toolRegistry.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { ClientMemoryStore } from "../../../src/agent/memory/clientMemoryStore.js";
import { resetClientMemoryStore } from "../../../src/agent/memory/clientMemoryBackend.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema, projectUpdateSchema, updateProject } from "../../../src/agent/projects/projectAdmin.js";
import type { ToolExecutionContext } from "../../../src/agent/tools/toolTypes.js";

// T15.32 (#208; ADR-2026-08-25-structure-studio §5.2) — the two tool-surface additions:
//   - client_memory.list_templates: the READ side both readers the ADR names (client_manager, copy
//     workflows) use — riskLevel "read", never mutates.
//   - library.instantiate_template: unchanged in its own behaviour, but now ALSO writes the
//     instantiation into the RECEIVING tenant's own memory ("cross-tenant instantiations write to the
//     receiving client's memory").

const RECEIVING_TENANT = "receiving-tenant-t1532";
const OTHER_TENANT = "unrelated-tenant-t1532";
const TEMPLATE_ID = "source-tenant::section_template::req_hero";
const context: ToolExecutionContext = { runId: "run_test", nodeId: "node_test" };

const seedLibraryRecord = async () => {
  const result = await new TemplateLibraryStore().publish({
    templateId: TEMPLATE_ID,
    objectType: "section_template",
    name: "Hero",
    recipe: { name: "Hero", blueprint: { type: "hero", data: { headline: "Welcome" } } },
    sourceProjectId: "source-tenant",
    provenance: { sourceUrl: "https://source-tenant.example/", captureRunId: "run_source_1", driven: "clone" }
  });
  return result.record;
};

const createReceivingProject = async () => {
  await createProject(
    repositoryManager.getProjectRepository(),
    projectCreateSchema.parse({
      projectId: RECEIVING_TENANT,
      name: "Receiving tenant fixture",
      mcpEndpointEnvVar: "RECEIVING_TENANT_T1532_MCP_ENDPOINT",
      authMode: "none",
      defaultToolPolicy: "allowed"
    })
  );
  await updateProject(repositoryManager.getProjectRepository(), RECEIVING_TENANT, projectUpdateSchema.parse({ autonomyMode: "autonomous" }));
};

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("toolRegistry: client_memory.list_templates and library.instantiate_template's cross-tenant memory write", () => {
  let calledVerbs: string[];

  // templateInstantiate.ts (#207) reads adapter.callReadTool/callTool's own `.result` field DIRECTLY
  // (readRegisteredSectionTypes: `const payload = read.result`; instantiateLibraryTemplate: `result:
  // call.result`) — unlike cloneEngine.ts's callProjectTool, it does NOT unwrap a `structuredContent`
  // envelope. mcpClient.ts's rpc() returns the JSON-RPC response's `result` field byte-for-byte, so
  // the fixture's `result` must therefore BE the flat payload templateInstantiate.ts expects, matching
  // templateInstantiate.test.ts's own mocks (`{ ok: true, result: { definitions: [...] } }`).
  const respond = (id: number, data: unknown) =>
    ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: data }) }) as unknown as Response;

  const stubFetch = () =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      if (!String(url).startsWith(`https://${RECEIVING_TENANT}.example/mcp`)) throw new Error(`Unexpected endpoint: ${url}`);
      calledVerbs.push(name);
      if (name === "registry_get") return respond(request.id, { definitions: [{ type: "hero" }] });
      if (name === "object_instantiate_section_template") return respond(request.id, { objectId: "page_received_1" });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

  beforeEach(async () => {
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    resetClientMemoryStore();
    calledVerbs = [];
    process.env.RECEIVING_TENANT_T1532_MCP_ENDPOINT = `https://${RECEIVING_TENANT}.example/mcp`;
    await createReceivingProject();
  });

  afterEach(() => {
    delete process.env.RECEIVING_TENANT_T1532_MCP_ENDPOINT;
    resetRepositoryManager();
    resetTemplateLibraryMemoryStore();
    resetClientMemoryStore();
  });

  it("client_memory.list_templates is declared read-only", () => {
    const tool = createToolRegistry().find((t) => t.toolId === "client_memory.list_templates")!;
    expect(tool.riskLevel).toBe("read");
    expect(tool.sideEffect).toBe("none");
  });

  it("library.instantiate_template, on success, records the instantiation in the RECEIVING tenant's own memory", async () => {
    stubFetch();
    const record = await seedLibraryRecord();
    const instantiate = createToolRegistry().find((t) => t.toolId === "library.instantiate_template")!;

    const result = (await instantiate.handler({ projectId: RECEIVING_TENANT, templateId: record.templateId, version: record.version }, context)) as { ok: boolean; data: { ok: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(calledVerbs).toContain("object_instantiate_section_template");

    const memory = await new ClientMemoryStore().listTemplates(RECEIVING_TENANT);
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({
      templateId: record.templateId,
      version: record.version,
      objectType: "section_template",
      instantiatedObjectId: "page_received_1",
      provenance: record.provenance
    });
  });

  it("the receiving tenant's memory write does NOT touch any other tenant's memory", async () => {
    stubFetch();
    const record = await seedLibraryRecord();
    const instantiate = createToolRegistry().find((t) => t.toolId === "library.instantiate_template")!;
    await instantiate.handler({ projectId: RECEIVING_TENANT, templateId: record.templateId, version: record.version }, context);

    expect(await new ClientMemoryStore().listTemplates(OTHER_TENANT)).toEqual([]);
  });

  it("client_memory.list_templates surfaces exactly what was recorded, for the correct project only", async () => {
    stubFetch();
    const record = await seedLibraryRecord();
    const instantiate = createToolRegistry().find((t) => t.toolId === "library.instantiate_template")!;
    await instantiate.handler({ projectId: RECEIVING_TENANT, templateId: record.templateId, version: record.version }, context);

    const list = createToolRegistry().find((t) => t.toolId === "client_memory.list_templates")!;
    const result = (await list.handler({ projectId: RECEIVING_TENANT }, context)) as { ok: boolean; data: { projectId: string; templates: unknown[] } };
    expect(result.data.projectId).toBe(RECEIVING_TENANT);
    expect(result.data.templates).toHaveLength(1);

    const empty = (await list.handler({ projectId: OTHER_TENANT }, context)) as { ok: boolean; data: { templates: unknown[] } };
    expect(empty.data.templates).toEqual([]);
  });

  it("a refused instantiation (unsupported section type) never writes to memory", async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      calledVerbs.push(name);
      if (name === "registry_get") return respond(request.id, { definitions: [{ type: "some_other_type" }] });
      throw new Error(`Unexpected target verb: ${name}`);
    }) as unknown as typeof fetch;

    const record = await seedLibraryRecord();
    const instantiate = createToolRegistry().find((t) => t.toolId === "library.instantiate_template")!;
    const result = (await instantiate.handler({ projectId: RECEIVING_TENANT, templateId: record.templateId, version: record.version }, context)) as { ok: boolean; data: { ok: boolean } };
    expect(result.data.ok).toBe(false);
    expect(calledVerbs).not.toContain("object_instantiate_section_template");
    expect(await new ClientMemoryStore().listTemplates(RECEIVING_TENANT)).toEqual([]);
  });
});
