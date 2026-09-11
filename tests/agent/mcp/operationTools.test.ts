import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../../netlify/functions/mcp.mjs";
import { resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return JSON.parse(response.body ?? "{}");
};
const data = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).result.structuredContent.data;

describe("operation.* MCP tools (read-only operation catalog surface)", () => {
  beforeEach(() => {
    process.env.MCP_API_TOKEN = "test-token";
    resetRepositoryManager();
  });

  it("advertises operation_list, operation_get, operation_preflight on the wire", async () => {
    const response = await handler({ httpMethod: "POST", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = JSON.parse(response.body ?? "{}").result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ["operation_list", "operation_get", "operation_preflight"]) expect(names).toContain(name);
  });

  it("operation.list returns the six registered operations, sorted by operationId, with no duplicates", async () => {
    const result = await data("operation.list");
    const ids = result.operations.map((op: { operationId: string }) => op.operationId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["site_inventory", "visual_identity_review_change", "pdf_template_family", "document_render", "asset_lookup_adopt", "image_template_revision"]));
  });

  it("operation.get returns a known descriptor with its registered versions", async () => {
    const result = await data("operation.get", { operationId: "site_inventory" });
    expect(result.known).toBe(true);
    expect(result.descriptor.operationId).toBe("site_inventory");
    expect(result.descriptor.version).toBe(1);
    expect(result.registeredVersions).toEqual([1]);
  });

  it("operation.get on an unregistered id returns a structured unknown-operation result, not a pass-through or an error", async () => {
    const result = await data("operation.get", { operationId: "definitely_not_registered" });
    expect(result.known).toBe(false);
    expect(result.descriptor).toBeNull();
    expect(result.registeredOperationIds).toContain("site_inventory");
    expect(result.registeredOperationIds).not.toContain("definitely_not_registered");
  });

  it("operation.preflight is read-only and round-trips defaults/effects/completion for a known operation", async () => {
    const first = await data("operation.preflight", { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(first.appliedDefaults).toEqual({ includeRetired: false });
    expect(first.selectedVersion).toBe(1);
    expect(first.blockers).toEqual([]);
    expect(first.effects.length).toBeGreaterThan(0);

    // Calling it again with identical arguments is byte-identical — no clock, no hidden state,
    // and nothing about the call itself was written anywhere for a second call to pick up.
    const second = await data("operation.preflight", { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(second).toEqual(first);
  });

  it("operation.preflight strictly rejects a model-proposed-plan-shaped payload carrying fields outside its schema", async () => {
    const response = await call("operation.preflight", {
      operationId: "site_inventory",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie" },
      approved: true,
      principal: { kind: "human", id: "someone" }
    });
    expect(response.error).toBeDefined();
    expect(response.error.data.error.code).toBe("validation_error");
  });

  it("operation.preflight on an unknown operation returns a structured blocking result rather than throwing", async () => {
    const result = await data("operation.preflight", { operationId: "not_registered_at_all", tenantId: "dr-lurie", input: {} });
    expect(result.blockers[0].code).toBe("unknown_operation");
    expect(result.blockers[0].blocking).toBe(true);
  });
});
