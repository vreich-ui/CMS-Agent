import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { listOperations } from "../../../src/agent/operations/operationCatalog.js";
import { checkOperationIsReadOnly } from "../../../src/agent/mcp/workspace/operationTools.js";
import type { OperationDescriptor } from "../../../src/agent/operations/operationTypes.js";
import "../../../src/agent/operations/registerOperations.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

describe("operation.execute (A4) — READ-ONLY GATED execution entrypoint", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DR_LURIE_MCP_ENDPOINT;
    delete process.env.DR_LURIE_MCP_TOKEN;
  });

  it("advertises operation_execute on the wire", async () => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(response.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("operation_execute");
  });

  // THE GATE — asserted for every non-read operation the catalog registers today, by iterating
  // listOperations() rather than hardcoding five ids: a future operation added to the catalog with a
  // non-read effect is covered by this same loop without anyone editing this test.
  it("refuses EVERY currently-registered operation whose descriptor declares a non-read effect, naming the offending effect(s)", async () => {
    const nonReadOperations = listOperations().filter((descriptor) => descriptor.effects.some((effect) => effect.riskLevel !== "read"));
    // Sanity: this is the five write/publish operations the task brief names, not an empty set that
    // would make the loop below vacuously pass.
    expect(nonReadOperations.map((d) => d.operationId).sort()).toEqual(
      ["asset_lookup_adopt", "document_render", "image_template_revision", "pdf_template_family", "visual_identity_review_change"].sort()
    );

    for (const descriptor of nonReadOperations) {
      const result = await data("operation.execute", { operationId: descriptor.operationId, tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
      expect(result.executed).toBe(false);
      expect(result.result).toBeNull();
      expect(result.refusal.code).toBe("not_read_only");
      expect(result.refusal.evidence.offendingEffects.length).toBeGreaterThan(0);
      for (const effect of result.refusal.evidence.offendingEffects) expect(effect.riskLevel).not.toBe("read");
    }
  });

  it("refuses an unregistered operationId with unknown_operation, never a throw", async () => {
    const result = await data("operation.execute", { operationId: "not_a_real_operation_xyz", tenantId: "dr-lurie", input: {} });
    expect(result.executed).toBe(false);
    expect(result.refusal.code).toBe("unknown_operation");
    expect(result.refusal.evidence.registeredOperationIds).toContain("site_inventory");
  });

  it("refuses site_inventory with a capability gap (never a blind read) when the tenant has no trusted capability facts backing site_inventory_read", async () => {
    // "no-such-tenant" is registered nowhere, so loadTenantCapabilityFacts returns undefined and
    // preflightOperation reports the capability unavailable — the conservative default, never assumed
    // available.
    const result = await data("operation.execute", { operationId: "site_inventory", tenantId: "no-such-tenant", input: { tenantId: "no-such-tenant" } });
    expect(result.executed).toBe(false);
    expect(result.refusal.code).toBe("no_executor_binding");
    expect(result.refusal.evidence.capabilityGaps.length).toBeGreaterThan(0);
    expect(result.refusal.evidence.capabilityGaps.some((gap: { capability: string }) => gap.capability === "site_inventory_read")).toBe(true);
  });

  it("visual_identity_review_change is STILL refused at the gate even with valid input and a capable tenant — the gate runs before capability/executor checks", async () => {
    const result = await data("operation.execute", {
      operationId: "visual_identity_review_change",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie", mode: "house", brief: "Refresh the palette." }
    });
    expect(result.executed).toBe(false);
    expect(result.refusal.code).toBe("not_read_only");
  });

  it("end-to-end: site_inventory executes successfully against a live (stubbed) tenant, returning satisfied inventory_snapshot completion evidence, calling only read verbs", async () => {
    const ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_ENDPOINT = ENDPOINT;
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    const calledTools: string[] = [];
    const remoteFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (request.method !== "tools/call") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }) } as unknown as Response;
      const tool = request.params?.name ?? "";
      const args = request.params?.arguments ?? {};
      calledTools.push(tool);
      const result =
        tool === "object_inventory" && args.object_type === "visual_standard"
          ? { structuredContent: { items: [{ object_id: "vis_drlurie", object_type: "visual_standard", version: 3, content_revision: 2, status: "active", updated_at: "2026-09-01T00:00:00.000Z" }] } }
          : tool === "object_contract" && args.object_type === "visual_standard"
            ? { structuredContent: { contract: { body_schema: { type: "object", required: [], properties: {} } } } }
            : tool === "registry_get"
              ? { structuredContent: { items: [] } }
              : {};
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", remoteFetch);

    const result = await data("operation.execute", { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", objectType: "visual_standard" } });

    expect(result.executed).toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.result.objects).toEqual([
      expect.objectContaining({ objectId: "vis_drlurie", objectType: "visual_standard", status: "active", version: 3, contentRevision: 2 })
    ]);
    const check = result.completion.find((entry: { id: string }) => entry.id === "inventory_snapshot_returned");
    expect(check.satisfied).toBe(true);
    expect(check.evidence.evidenceKind).toBe("inventory_snapshot");

    // Zero write verbs reached the wire across the whole call.
    const WRITE_VERBS = ["object_publish", "object_patch", "object_create", "object_retire", "object_checkin", "object_checkout", "object_discard"];
    for (const tool of calledTools) expect(WRITE_VERBS).not.toContain(tool);
    expect(calledTools).toContain("object_inventory");
  });

  it("a real tenant read failure during execution surfaces as a structured executor_failed refusal, never a throw or a silently empty result", async () => {
    process.env.DR_LURIE_MCP_ENDPOINT = "https://dr-lurie.example/mcp";
    process.env.DR_LURIE_MCP_TOKEN = "secret-token";
    const failingFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as { method: string };
      if (request.method === "initialize") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }) } as unknown as Response;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "service unavailable" } as unknown as Response;
    });
    vi.stubGlobal("fetch", failingFetch);

    const result = await data("operation.execute", { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", objectType: "visual_standard" } });
    expect(result.executed).toBe(false);
    expect(result.refusal.code).toBe("executor_failed");
    expect(result.refusal.evidence.blockers[0].code).toBe("tenant_read_failed");
  });

  it("strictly rejects a payload carrying fields outside operation.execute's own schema", async () => {
    const response = await call("operation.execute", {
      operationId: "site_inventory",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie" },
      approved: true,
      principal: { kind: "human", id: "someone" }
    });
    expect(response.error).toBeDefined();
    expect(response.error.data.error.code).toBe("validation_error");
  });
});

// The gate itself, as a pure function. The wire-level tests above cover every descriptor the live
// catalog actually holds; this block covers the shapes it does NOT hold today, so the gate's
// behaviour on them is pinned rather than incidental.
describe("checkOperationIsReadOnly — the gate as a pure function", () => {
  const descriptorWithEffects = (effects: OperationDescriptor["effects"]): OperationDescriptor => ({
    operationId: "fixture_operation",
    version: 1,
    title: "Fixture",
    summary: "Fixture descriptor used only to exercise the gate.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    defaults: {},
    requiredCapabilities: [],
    effects,
    completion: [],
    intentKeywords: []
  });

  it("passes a descriptor whose every declared effect is read", () => {
    const gate = checkOperationIsReadOnly(descriptorWithEffects([
      { kind: "read_a", targetType: "thing", riskLevel: "read", description: "Reads." },
      { kind: "read_b", targetType: "thing", riskLevel: "read", description: "Also reads." }
    ]));
    expect(gate.readOnly).toBe(true);
  });

  it("refuses a descriptor that declares NO effects at all — an absent claim is never read as a safe one", () => {
    const gate = checkOperationIsReadOnly(descriptorWithEffects([]));
    expect(gate.readOnly).toBe(false);
    if (gate.readOnly) throw new Error("unreachable");
    expect(gate.reason).toBe("no_declared_effects");
    expect(gate.offendingEffects).toEqual([]);
  });

  it("refuses a descriptor mixing read with a single write effect, naming only the offender", () => {
    const gate = checkOperationIsReadOnly(descriptorWithEffects([
      { kind: "read_a", targetType: "thing", riskLevel: "read", description: "Reads." },
      { kind: "write_b", targetType: "thing", riskLevel: "write", description: "Writes." }
    ]));
    expect(gate.readOnly).toBe(false);
    if (gate.readOnly) throw new Error("unreachable");
    expect(gate.reason).toBe("non_read_effects");
    expect(gate.offendingEffects.map((effect) => effect.kind)).toEqual(["write_b"]);
  });
});
