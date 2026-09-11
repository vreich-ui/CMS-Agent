import { describe, expect, it, vi } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { preflightOperation } from "../../../src/agent/operations/operationPreflight.js";

// A repository double whose every method — read AND write — throws if called, plus a call log.
// preflightOperation is documented as performing zero I/O of its own; this double lets a test prove
// that by construction rather than by accident (see operationPreflight.ts's module header).
const throwingRepositoryDouble = () => {
  const calls: string[] = [];
  const method = (name: string) => vi.fn(() => { calls.push(name); throw new Error(`${name} must never be called by preflightOperation`); });
  return {
    calls,
    get: method("get"),
    list: method("list"),
    set: method("set"),
    update: method("update"),
    delete: method("delete")
  };
};

describe("preflightOperation", () => {
  it("reports every applied default explicitly", () => {
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(result.appliedDefaults).toEqual({ includeRetired: false });
    expect(result.missingRequired).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it("reports missingRequired for an input missing a required field", () => {
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: {} });
    expect(result.missingRequired).toContain("tenantId");
    expect(result.blockers.some((b) => b.code === "input_schema_invalid")).toBe(true);
  });

  it("pins and reports selectedVersion", () => {
    const explicit = preflightOperation({ operationId: "site_inventory", version: 1, tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(explicit.selectedVersion).toBe(1);
    const implicit = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(implicit.selectedVersion).toBe(1);
  });

  it("returns effects and completion straight from the registered descriptor", () => {
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    expect(result.effects).toEqual([
      { kind: "read_site_inventory", targetType: "site_object_index", riskLevel: "read", description: "Reads the tenant's current object inventory and its recorded change history. Writes nothing." }
    ]);
    expect(result.completion).toHaveLength(1);
    expect(result.completion[0].id).toBe("inventory_snapshot_returned");
  });

  it("an unknown operationId returns a structured unknown-operation blocker naming the registered alternatives", () => {
    const result = preflightOperation({ operationId: "not_a_real_operation_xyz", tenantId: "dr-lurie", input: {} });
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].code).toBe("unknown_operation");
    expect(result.blockers[0].blocking).toBe(true);
    expect(result.blockers[0].remedy).toContain("site_inventory");
    expect(result.effects).toEqual([]);
    expect(result.completion).toEqual([]);
  });

  it("reports a capability gap with a remedy for an unmet requiredCapability, performing zero probing calls", () => {
    const repository = throwingRepositoryDouble();
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } }, { repository });
    expect(result.capabilityGaps).toHaveLength(1);
    expect(result.capabilityGaps[0]).toMatchObject({ capability: "site_inventory_read", requiredBy: "site_inventory", reason: "not_configured" });
    expect(result.capabilityGaps[0].remedy.length).toBeGreaterThan(0);
    expect(repository.calls).toEqual([]);
  });

  it("no capability gap is reported once configuredCapabilities covers requiredCapabilities", () => {
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" }, configuredCapabilities: ["site_inventory_read"] });
    expect(result.capabilityGaps).toEqual([]);
  });

  it("is read-only: completes normally against a repository double whose every write method throws, and calls none of it", () => {
    const repository = throwingRepositoryDouble();
    expect(() => preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } }, { repository })).not.toThrow();
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } }, { repository });
    expect(result.blockers).toEqual([]);
    expect(repository.get).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.set).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
    expect(repository.calls).toEqual([]);
  });

  it("refuses a cross-tenant reference embedded in input with a blocker, not a throw", () => {
    const result = preflightOperation({
      operationId: "document_render",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie", documentRef: { objectType: "article", objectId: "obj_1", tenantId: "other-tenant" } }
    });
    const refBlocker = result.blockers.find((b) => b.code === "reference_tenant_mismatch");
    expect(refBlocker).toBeDefined();
    expect(refBlocker?.blocking).toBe(true);
  });

  it("a same-tenant reference embedded in input produces no reference blocker", () => {
    const result = preflightOperation({
      operationId: "document_render",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie", documentRef: { objectType: "article", objectId: "obj_1", tenantId: "dr-lurie" } }
    });
    expect(result.blockers.some((b) => b.code === "reference_tenant_mismatch")).toBe(false);
  });

  it("a model-proposed plan carrying an arbitrary tool name, approved:true, a principal, and a widened scope changes nothing: the resolved effects/completion are identical to the plain request's", () => {
    const plain = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    const withJunk = preflightOperation({
      operationId: "site_inventory",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie" },
      // Fields no real caller of this type would send, appended to simulate a model-proposed plan.
      ...({ approved: true, tool: "workflow_publish_run", principal: { kind: "human", id: "someone" }, scope: "admin" } as Record<string, unknown>)
    } as Parameters<typeof preflightOperation>[0]);
    expect(withJunk).toEqual(plain);
  });
});
