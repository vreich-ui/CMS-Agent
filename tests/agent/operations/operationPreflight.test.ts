import { describe, expect, it, vi } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { preflightOperation } from "../../../src/agent/operations/operationPreflight.js";
import type { TenantCapabilityFacts } from "../../../src/agent/operations/capabilityReadiness.js";

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

// R1: a fully-provisioned dr-lurie fixture — every tool name capabilityReadiness.ts's derivation
// consults, all "registered". Individual tests override just the field they mean to test.
const fullyProvisionedDrLurieFacts = (overrides: Partial<TenantCapabilityFacts> = {}): TenantCapabilityFacts => ({
  tenantId: "dr-lurie",
  projectStatus: "active",
  objectDialectConfigured: true,
  registeredToolNames: [
    "object_inventory", "object_get", "object_create",
    "search_artifacts", "search_images",
    "create_pdf_template", "publish_pdf_template", "render_article_pdf"
  ],
  ...overrides
});
const capabilitySourceFor = (facts: TenantCapabilityFacts) => ({ capabilitySource: (tenantId: string) => (tenantId === facts.tenantId ? facts : undefined) });

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
    const requiredCapabilityGap = result.capabilityGaps.find((gap) => gap.capability === "site_inventory_read");
    expect(requiredCapabilityGap).toMatchObject({ capability: "site_inventory_read", requiredBy: "site_inventory", reason: "not_configured" });
    expect(requiredCapabilityGap?.remedy.length).toBeGreaterThan(0);
    expect(repository.calls).toEqual([]);
  });

  it("no requiredCapability gap is reported once a trusted capabilitySource derives it available (site_inventory is itself unbound, so its own workflow_binding gap remains)", () => {
    const deps = capabilitySourceFor(fullyProvisionedDrLurieFacts());
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } }, deps);
    expect(result.capabilityGaps.some((gap) => gap.capability === "site_inventory_read")).toBe(false);
    expect(result.capabilityGaps.some((gap) => gap.reason === "not_supported")).toBe(true); // workflow_binding, unrelated to R1
  });

  it("an unbound operation (site_inventory) reports executable:false, binding:null, and a not_supported capability gap naming the implementing task", () => {
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" }, configuredCapabilities: ["site_inventory_read"] });
    expect(result.executable).toBe(false);
    expect(result.binding).toBeNull();
    const gap = result.capabilityGaps.find((entry) => entry.reason === "not_supported");
    expect(gap).toBeDefined();
    expect(gap?.requiredBy).toBe("site_inventory");
    expect(gap?.remedy).toContain("A4");
  });

  it("a bound operation (visual_identity_review_change) reports executable:true and its resolved binding", () => {
    const result = preflightOperation({
      operationId: "visual_identity_review_change",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie" },
      configuredCapabilities: ["visual_identity_read", "visual_identity_propose"]
    });
    expect(result.executable).toBe(true);
    expect(result.binding).toEqual({
      operationId: "visual_identity_review_change",
      workflowId: "visual_identity",
      inputMapping: { tenantId: "projectId", autoApply: "apply" }
    });
    expect(result.capabilityGaps.some((gap) => gap.reason === "not_supported")).toBe(false);
  });

  it("an unknown operationId reports executable:false and binding:null alongside its unknown_operation blocker", () => {
    const result = preflightOperation({ operationId: "not_a_real_operation_xyz", tenantId: "dr-lurie", input: {} });
    expect(result.executable).toBe(false);
    expect(result.binding).toBeNull();
  });

  it("a caller-supplied workflowId, binding, or executable field on the request is ignored entirely (executable/binding are resolved only from the registered descriptor's operationId)", () => {
    const plain = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
    const withJunk = preflightOperation({
      operationId: "site_inventory",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie" },
      // Fields a caller might send believing they can steer executability/binding directly — none
      // of them is a field this type declares, and preflightOperation reads none of them.
      ...({
        workflowId: "publishing_conductor",
        binding: { operationId: "site_inventory", workflowId: "publishing_conductor", inputMapping: {} },
        executable: true
      } as Record<string, unknown>)
    } as Parameters<typeof preflightOperation>[0]);
    expect(withJunk).toEqual(plain);
    expect(withJunk.executable).toBe(false);
    expect(withJunk.binding).toBeNull();
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

  describe("R1: capability gaps are derived from trusted facts, never asserted", () => {
    it("a forged/over-claimed configuredCapabilities cannot make an unavailable capability look available (the headline acceptance)", () => {
      // No capabilitySource at all — the caller (a model turn included) supplies only a claim.
      const result = preflightOperation({
        operationId: "site_inventory",
        tenantId: "dr-lurie",
        input: { tenantId: "dr-lurie" },
        configuredCapabilities: ["site_inventory_read", "asset_search", "pdf_render", "visual_identity_read", "visual_identity_propose", "image_search", "image_template_write", "pdf_template_write", "pdf_template_publish"]
      });
      const gap = result.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
      expect(gap).toBeDefined();
      expect(gap?.reason).toBe("not_configured");
    });

    it("a forged configuredCapabilities cannot widen availability even when a trusted source derives it unavailable for a real reason", () => {
      // Trusted facts say this tenant is disabled; the caller's claim tries to override that.
      const facts = fullyProvisionedDrLurieFacts({ projectStatus: "disabled" });
      const result = preflightOperation(
        { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" }, configuredCapabilities: ["site_inventory_read"] },
        capabilitySourceFor(facts)
      );
      const gap = result.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
      expect(gap).toBeDefined();
      expect(gap?.reason).toBe("unavailable");
      expect(gap?.evidence).toMatchObject({ projectStatus: "disabled" });
    });

    it("configuredCapabilities can still narrow a derived-available capability out for one call", () => {
      const facts = fullyProvisionedDrLurieFacts();
      const withoutNarrowing = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } }, capabilitySourceFor(facts));
      expect(withoutNarrowing.capabilityGaps.some((gap) => gap.capability === "site_inventory_read")).toBe(false);

      const narrowed = preflightOperation(
        { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" }, configuredCapabilities: [] },
        capabilitySourceFor(facts)
      );
      const gap = narrowed.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
      expect(gap).toBeDefined();
      expect(gap?.evidence).toMatchObject({ narrowedOutByConfiguredCapabilities: true });
    });

    it("no trusted capabilitySource supplied is conservative: nothing is assumed available, even for a fully-formed request", () => {
      const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
      const gap = result.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
      expect(gap).toBeDefined();
      expect(gap?.reason).toBe("not_configured");
      expect(gap?.evidence).toMatchObject({ capabilitySourceSupplied: false });
    });

    it("a capabilitySource that returns undefined for this specific tenantId is conservative for that tenant, not a throw", () => {
      const result = preflightOperation(
        { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } },
        { capabilitySource: () => undefined }
      );
      expect(result.capabilityGaps.some((gap) => gap.capability === "site_inventory_read")).toBe(true);
    });

    it("each capabilityGap reason (not_configured, not_supported, unavailable) is produced from a real fact, with evidence", () => {
      const notConfigured = preflightOperation(
        { operationId: "asset_lookup_adopt", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", query: "hero image" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts({ registeredToolNames: [] }))
      );
      const notConfiguredGap = notConfigured.capabilityGaps.find((entry) => entry.capability === "asset_search");
      expect(notConfiguredGap?.reason).toBe("not_configured");
      expect(notConfiguredGap?.evidence).toMatchObject({ requiredToolName: "search_artifacts" });

      const notSupported = preflightOperation(
        { operationId: "image_template_revision", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", templateRefs: [{ surface: "web", templateId: "tpl_1", tenantId: "dr-lurie" }] } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts())
      );
      const notSupportedGap = notSupported.capabilityGaps.find((entry) => entry.capability === "image_template_write");
      expect(notSupportedGap?.reason).toBe("not_supported");
      expect(notSupportedGap?.evidence).toBeDefined();

      const unavailable = preflightOperation(
        { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts({ projectStatus: "disabled" }))
      );
      const unavailableGap = unavailable.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
      expect(unavailableGap?.reason).toBe("unavailable");
      expect(unavailableGap?.evidence).toMatchObject({ projectStatus: "disabled" });
    });

    it("visual_identity_review_change stays executable:true with its binding regardless of capability gaps, and the five unbound operations keep their not_supported workflow_binding gap", () => {
      const bound = preflightOperation(
        { operationId: "visual_identity_review_change", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts())
      );
      expect(bound.executable).toBe(true);
      expect(bound.binding).toEqual({ operationId: "visual_identity_review_change", workflowId: "visual_identity", inputMapping: { tenantId: "projectId", autoApply: "apply" } });
      expect(bound.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);

      const unboundIds = ["site_inventory", "pdf_template_family", "document_render", "asset_lookup_adopt", "image_template_revision"];
      for (const operationId of unboundIds) {
        const result = preflightOperation({ operationId, tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
        expect(result.executable).toBe(false);
        expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding" && gap.reason === "not_supported")).toBe(true);
      }
    });
  });
});
