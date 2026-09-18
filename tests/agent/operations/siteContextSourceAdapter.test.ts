import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "../../../src/agent/repository/RepositoryManager.js";
import { ProjectMcpAdapter, READ_TOOL_ALLOWLIST, type CallToolResult } from "../../../src/agent/projects/projectMcpAdapter.js";
import type { McpTransport } from "../../../src/agent/projects/mcpClient.js";
import { captureSiteSnapshot } from "../../../src/agent/operations/siteContext.js";
import {
  ProjectSiteContextSourceAdapter,
  SiteContextSourceReadError,
  SiteContextSourceUnknownTenantError
} from "../../../src/agent/operations/siteContextSourceAdapter.js";
import { LIVE_PAGE_GET_SUMMARY, LIVE_SECTION_TYPES } from "./fixtures/liveObjectContractCapture.js";

const jsonResponse = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) }) as unknown as Response;

type ParsedRequest = { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

// A wire double: tracks every tools/call this adapter actually makes (tool name + args), and answers
// initialize unconditionally so ProjectMcpAdapter's connection path succeeds. `responders` supplies a
// per-tool response function; a tool with no responder answers `{}` (empty, never invented content).
function makeTenantDouble(responders: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const transport: McpTransport = async (_input, init) => {
    const request = JSON.parse(init.body) as ParsedRequest;
    if (request.method === "initialize") return jsonResponse({ protocolVersion: "2024-11-05", serverInfo: { name: "tenant-double" } });
    if (request.method !== "tools/call") return jsonResponse({});
    const tool = request.params!.name!;
    const args = request.params!.arguments ?? {};
    calls.push({ tool, args });
    const responder = responders[tool];
    return jsonResponse(responder ? responder(args) : {});
  };
  return { transport, calls };
}

describe("ProjectSiteContextSourceAdapter (production SiteContextSource, A4)", () => {
  beforeEach(() => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "a-token";
  });
  afterEach(() => {
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
    vi.restoreAllMocks();
  });

  const buildAdapter = (transport: McpTransport) =>
    new ProjectSiteContextSourceAdapter({
      projectRepository: new RepositoryManager().getProjectRepository(),
      tenantContext: { adapterDeps: { transport } }
    });

  it("listObjects calls exactly object_inventory({object_type}) in LIST mode (no object_id) and normalizes a real inventory row", async () => {
    const { transport, calls } = makeTenantDouble({
      object_inventory: () => ({
        structuredContent: {
          items: [
            { object_id: "vis_drlurie", object_type: "visual_standard", version: 4, content_revision: 2, published_time: null, status: "active" },
            { object_id: "vis_drlurie_old", version: 1, content_revision: 1, review_state: "changes_requested" }
          ]
        }
      })
    });
    const adapter = buildAdapter(transport);
    const objects = await adapter.listObjects({ tenantId: "dr-lurie", objectType: "visual_standard" });

    expect(calls).toEqual([{ tool: "object_inventory", args: { object_type: "visual_standard" } }]);
    expect(objects).toEqual([
      { objectId: "vis_drlurie", objectType: "visual_standard", status: "active", version: 4, contentRevision: 2, publishedTime: null, updatedAt: "", fields: {} },
      // No `status`/`object_type` reported: falls back to review_state / the REQUESTED object type —
      // never fabricated, never left as the wrong value.
      { objectId: "vis_drlurie_old", objectType: "visual_standard", status: "changes_requested", version: 1, contentRevision: 1, publishedTime: null, updatedAt: "", fields: {} }
    ]);
  });

  // REGRESSION -- adversarial review of PR #387 (2026-09-18) found `fields` hardcoded to `{}` for
  // every page, because object_inventory's LIST-mode summary rows never carry field content (confirmed
  // live) and nothing backfilled it. This made a page's own inline sections invisible to
  // siteContentObjectCompiler.ts's patch-diffing — every "patch" compiled as if the page had none.
  it("backfills a page row's `fields` from a real object_get, on top of the object_inventory listing (live-captured response)", async () => {
    const { transport, calls } = makeTenantDouble({
      object_inventory: () => ({ structuredContent: { items: [{ object_id: "page_home", object_type: "page", version: 21, content_revision: 6, status: "active" }] } }),
      object_get: () => ({ structuredContent: LIVE_PAGE_GET_SUMMARY })
    });
    const adapter = buildAdapter(transport);
    const objects = await adapter.listObjects({ tenantId: "dr-lurie", objectType: "page" });

    expect(calls).toEqual([
      { tool: "object_inventory", args: { object_type: "page" } },
      { tool: "object_get", args: { object_type: "page", object_id: "page_home", projection: "summary" } }
    ]);
    expect(objects).toHaveLength(1);
    expect(objects[0]!.fields).toEqual(LIVE_PAGE_GET_SUMMARY.record.body);
    expect((objects[0]!.fields as { sections: unknown[] }).sections).toHaveLength(2);
  });

  it("never enriches a non-page object type -- fields stays `{}` exactly as before this fix", async () => {
    const { transport, calls } = makeTenantDouble({
      object_inventory: () => ({ structuredContent: { items: [{ object_id: "vis_drlurie", object_type: "visual_standard", version: 1, content_revision: 1, status: "active" }] } })
    });
    const adapter = buildAdapter(transport);
    const objects = await adapter.listObjects({ tenantId: "dr-lurie", objectType: "visual_standard" });

    expect(calls).toEqual([{ tool: "object_inventory", args: { object_type: "visual_standard" } }]);
    expect(objects[0]!.fields).toEqual({});
  });

  it("throws SiteContextSourceReadError, never a silently-empty fields object, when a page's own object_get read fails at the transport", async () => {
    // A genuine TRANSPORT failure (non-200), matching how this file's other "surfaces structurally"
    // tests simulate a real read failure -- `callReadTool`'s own `ok` reflects the transport, not an
    // MCP-level `isError` (see clientToolResult.ts's header on that distinction); this adapter's reads
    // have never inspected `isError` and this fix does not start doing so for object_get either.
    const transport: McpTransport = async (_input, init) => {
      const request = JSON.parse(init.body) as ParsedRequest;
      if (request.method === "initialize") return jsonResponse({ protocolVersion: "2024-11-05" });
      if (request.method === "tools/call" && request.params?.name === "object_inventory") {
        return jsonResponse({ structuredContent: { items: [{ object_id: "page_home", object_type: "page", version: 21, content_revision: 6, status: "active" }] } });
      }
      return { ok: false, status: 503, json: async () => ({}), text: async () => "service unavailable" } as unknown as Response;
    };
    const adapter = buildAdapter(transport);
    await expect(adapter.listObjects({ tenantId: "dr-lurie", objectType: "page" })).rejects.toThrow(SiteContextSourceReadError);
  });

  it("getObjectContract extracts the real, top-level `section_types` registry into `sectionTypes` (live-captured shape)", async () => {
    const { transport, calls } = makeTenantDouble({
      object_contract: () => ({
        structuredContent: {
          contract: {
            object_type: "section",
            body_schema: { type: "object", properties: { tracking: { type: "object" }, section: { oneOf: [] } } },
            section_types: LIVE_SECTION_TYPES
          }
        }
      })
    });
    const adapter = buildAdapter(transport);
    const contract = await adapter.getObjectContract({ tenantId: "dr-lurie", objectType: "section" });

    expect(calls).toEqual([{ tool: "object_contract", args: { object_type: "section" } }]);
    expect(contract?.sectionTypes).toEqual(LIVE_SECTION_TYPES.map((entry) => entry.type));
  });

  it("getObjectContract calls exactly object_contract({object_type}) and reduces body_schema to {objectType, required, schema}", async () => {
    const { transport, calls } = makeTenantDouble({
      object_contract: () => ({ structuredContent: { contract: { object_type: "visual_standard", body_schema: { type: "object", required: ["primaryColor"], properties: { primaryColor: { type: "string" } } } } } })
    });
    const adapter = buildAdapter(transport);
    const contract = await adapter.getObjectContract({ tenantId: "dr-lurie", objectType: "visual_standard" });

    expect(calls).toEqual([{ tool: "object_contract", args: { object_type: "visual_standard" } }]);
    expect(contract).toEqual({ objectType: "visual_standard", required: ["primaryColor"], schema: { type: "object", required: ["primaryColor"], properties: { primaryColor: { type: "string" } } } });
  });

  it("getObjectContract returns null (a legitimate 'no contract') on a not_found body, never a throw", async () => {
    const { transport } = makeTenantDouble({ object_contract: () => ({ not_found: true }) });
    const adapter = buildAdapter(transport);
    expect(await adapter.getObjectContract({ tenantId: "dr-lurie", objectType: "unknown_type" })).toBeNull();
  });

  it("getRegistries calls registry_get for visual_standard, pdf_template and image_policy_context, normalizing each independently", async () => {
    const { transport, calls } = makeTenantDouble({
      registry_get: (args) => {
        if (args.registry === "visual_standard") return { structuredContent: { items: [{ id: "vis_drlurie", kind: "house", label: "House" }] } };
        if (args.registry === "pdf_template") return { structuredContent: { items: [{ templateId: "tmpl_1", kind: "brochure", isDefault: true }] } };
        if (args.registry === "image_policy_context") return { structuredContent: { items: ["article_header", "article_body"] } };
        return {};
      }
    });
    const adapter = buildAdapter(transport);
    const registries = await adapter.getRegistries({ tenantId: "dr-lurie" });

    expect(calls.map((call) => call.args.registry).sort()).toEqual(["image_policy_context", "pdf_template", "visual_standard"]);
    expect(registries).toEqual({
      visualStandards: [{ id: "vis_drlurie", kind: "house", label: "House" }],
      pdfTemplates: [{ templateId: "tmpl_1", kind: "brochure", isDefault: true }],
      imagePolicyContexts: ["article_header", "article_body"]
    });
  });

  it("getRegistries degrades EACH registry independently to an empty list on an unrecognized/failed read, never throwing", async () => {
    const { transport } = makeTenantDouble({
      registry_get: (args) => {
        if (args.registry === "visual_standard") return { structuredContent: { items: [{ id: "vis_drlurie", kind: "house" }] } };
        // pdf_template and image_policy_context: unrecognized shape (no items/objects/... key) ->
        // extractListItems returns [] -> normalized to an empty list, not a thrown error.
        return { somethingElse: true };
      }
    });
    const adapter = buildAdapter(transport);
    const registries = await adapter.getRegistries({ tenantId: "dr-lurie" });
    expect(registries.visualStandards).toEqual([{ id: "vis_drlurie", kind: "house" }]);
    expect(registries.pdfTemplates).toEqual([]);
    expect(registries.imagePolicyContexts).toEqual([]);
  });

  it("getRevisionId always returns null, regardless of what the tenant is asked or returns", async () => {
    const { transport, calls } = makeTenantDouble({});
    const adapter = buildAdapter(transport);
    expect(await adapter.getRevisionId({ tenantId: "dr-lurie" })).toBeNull();
    // No tenant call at all — there is nothing to probe for a revision that does not exist.
    expect(calls).toEqual([]);
  });

  it("a real object_inventory read failure surfaces structurally as SiteContextSourceReadError, never a silently empty list", async () => {
    const transport: McpTransport = async (_input, init) => {
      const request = JSON.parse(init.body) as ParsedRequest;
      if (request.method === "initialize") return jsonResponse({ protocolVersion: "2024-11-05" });
      return { ok: false, status: 503, json: async () => ({}), text: async () => "service unavailable" } as unknown as Response;
    };
    const adapter = buildAdapter(transport);
    await expect(adapter.listObjects({ tenantId: "dr-lurie", objectType: "visual_standard" })).rejects.toThrow(SiteContextSourceReadError);
  });

  it("a real object_contract read failure surfaces structurally as SiteContextSourceReadError, never a silent null", async () => {
    const transport: McpTransport = async (_input, init) => {
      const request = JSON.parse(init.body) as ParsedRequest;
      if (request.method === "initialize") return jsonResponse({ protocolVersion: "2024-11-05" });
      return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" } as unknown as Response;
    };
    const adapter = buildAdapter(transport);
    await expect(adapter.getObjectContract({ tenantId: "dr-lurie", objectType: "visual_standard" })).rejects.toThrow(SiteContextSourceReadError);
  });

  it("throws SiteContextSourceUnknownTenantError for a tenantId naming no registered project", async () => {
    const { transport } = makeTenantDouble({});
    const adapter = buildAdapter(transport);
    await expect(adapter.listObjects({ tenantId: "no-such-tenant", objectType: "visual_standard" })).rejects.toThrow(SiteContextSourceUnknownTenantError);
  });

  // THE STRUCTURAL PROOF: `callTool` on ProjectMcpAdapter is the SHARED underlying transport method for
  // both writes and reads-after-allowlist-gate (`callReadTool` delegates to it once `name` clears
  // READ_TOOL_ALLOWLIST — see projectMcpAdapter.ts). A spy that throws unconditionally on `callTool`
  // therefore cannot distinguish "this adapter tried to write" from "this adapter tried to read" — it
  // was tried here first and rejected every legitimate read too. The correct write-throwing double is
  // one that only throws for a tool name OUTSIDE the read allowlist, and lets every allowlisted name
  // through to the real implementation: this is exactly "a tenant that throws on any write", since by
  // construction nothing in READ_TOOL_ALLOWLIST can mutate tenant state (object_publish, object_patch,
  // object_create, etc. are all excluded from it — see projectMcpAdapter.ts). Two independent proofs:
  // (1) the spy itself never sees a non-allowlisted name across a full snapshot capture, and (2) the
  // wire-level double's own recorded `calls` are every one of them inside READ_TOOL_ALLOWLIST.
  it("performs ZERO write calls across a full snapshot capture — proven by a callTool spy that throws on any non-read-allowlisted tool name", async () => {
    const { transport, calls } = makeTenantDouble({
      object_inventory: () => ({ structuredContent: { items: [{ object_id: "vis_drlurie", object_type: "visual_standard", version: 1, content_revision: 1, status: "active" }] } }),
      object_contract: () => ({ structuredContent: { contract: { body_schema: { type: "object", required: [], properties: {} } } } }),
      registry_get: () => ({ structuredContent: { items: [] } })
    });
    const readAllowlist = new Set<string>(READ_TOOL_ALLOWLIST as readonly string[]);
    const originalCallTool = ProjectMcpAdapter.prototype.callTool;
    const callToolSpy = vi
      .spyOn(ProjectMcpAdapter.prototype, "callTool")
      .mockImplementation(async function (this: ProjectMcpAdapter, name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
        if (!readAllowlist.has(name)) {
          throw new Error(`write-throwing tenant double: "${name}" is not in READ_TOOL_ALLOWLIST — a SiteContextSource adapter must never call it`);
        }
        return originalCallTool.call(this, name, args, signal);
      });

    const adapter = buildAdapter(transport);
    const snapshot = await captureSiteSnapshot(adapter, { tenantId: "dr-lurie", objectTypes: ["visual_standard"] });

    expect(snapshot.objects.byType.visual_standard).toHaveLength(1);
    expect(snapshot.revisionId).toBeNull();
    // Proof 1: the spy was exercised (the adapter did call through callTool) but never with a
    // non-allowlisted name — it never threw.
    expect(callToolSpy).toHaveBeenCalled();
    // Proof 2: independently, every wire-level call this adapter actually issued names a read verb.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(readAllowlist.has(call.tool)).toBe(true);
  });
});
