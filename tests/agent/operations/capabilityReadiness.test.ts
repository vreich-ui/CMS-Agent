import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { listOperations, registerOperation, __resetOperationCatalogForTests } from "../../../src/agent/operations/operationCatalog.js";
import { registerBuiltInOperations } from "../../../src/agent/operations/registerOperations.js";
import { listCapabilityIds, isKnownCapability, getCapability } from "../../../src/agent/operations/capabilityVocabulary.js";
import {
  CAPABILITY_EVIDENCE_TOOL_NAMES,
  deriveTenantCapabilityAvailability,
  type TenantCapabilityFacts
} from "../../../src/agent/operations/capabilityReadiness.js";
import type { OperationDescriptor } from "../../../src/agent/operations/operationTypes.js";

const baseFacts = (overrides: Partial<TenantCapabilityFacts> = {}): TenantCapabilityFacts => ({
  tenantId: "dr-lurie",
  projectStatus: "active",
  objectDialectConfigured: true,
  registeredToolNames: [...CAPABILITY_EVIDENCE_TOOL_NAMES],
  ...overrides
});

describe("capabilityVocabulary", () => {
  it("is a closed, non-empty, deterministically-sorted list", () => {
    const first = listCapabilityIds();
    const second = listCapabilityIds();
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort((a, b) => a.localeCompare(b)));
    expect(first.length).toBeGreaterThan(0);
  });

  it("carries every capability the nine required-by the six live descriptors require, nothing invented", () => {
    const expected = [
      "site_inventory_read",
      "visual_identity_read",
      "visual_identity_propose",
      "asset_search",
      "pdf_render",
      "pdf_template_write",
      "pdf_template_publish",
      "image_search",
      "image_template_write"
    ].sort();
    expect(listCapabilityIds()).toEqual(expected);
  });

  it("every entry carries a non-empty description and evidence statement", () => {
    for (const id of listCapabilityIds()) {
      const entry = getCapability(id);
      expect(entry).toBeDefined();
      expect(entry?.description.length).toBeGreaterThan(0);
      expect(entry?.evidence.length).toBeGreaterThan(0);
    }
  });

  it("isKnownCapability is false for a capability nobody registered", () => {
    expect(isKnownCapability("not_a_real_capability_xyz")).toBe(false);
  });

  it("the six built-in descriptors all validate against the vocabulary (registerBuiltInOperations did not throw at import)", () => {
    const requiredCapabilities = listOperations().flatMap((descriptor) => descriptor.requiredCapabilities);
    expect(requiredCapabilities.length).toBeGreaterThan(0);
    for (const capability of requiredCapabilities) {
      expect(isKnownCapability(capability)).toBe(true);
    }
  });

  it("registering a descriptor requiring an out-of-vocabulary capability throws, and the catalog is left registrable afterwards", () => {
    __resetOperationCatalogForTests();
    try {
      const badDescriptor: OperationDescriptor = {
        operationId: "bogus_operation",
        version: 1,
        title: "Bogus",
        summary: "A descriptor requiring a capability nobody defined.",
        surface: null,
        inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
        defaults: {},
        requiredCapabilities: ["not_a_real_capability_xyz"],
        effects: [],
        completion: [],
        intentKeywords: []
      };
      expect(() => registerOperation(badDescriptor)).toThrow(/unknown capability/i);
    } finally {
      // Leave the module-level registry exactly as every other test file expects it: the six
      // production descriptors, re-registered into the freshly-cleared catalog.
      __resetOperationCatalogForTests();
      registerBuiltInOperations();
    }
  });
});

describe("deriveTenantCapabilityAvailability", () => {
  it("is pure: identical facts in always yields an identical result out", () => {
    const facts = baseFacts();
    expect(deriveTenantCapabilityAvailability(facts)).toEqual(deriveTenantCapabilityAvailability(facts));
  });

  it("covers every vocabulary capability id, with no extras", () => {
    const result = deriveTenantCapabilityAvailability(baseFacts());
    expect(Object.keys(result).sort()).toEqual(listCapabilityIds());
  });

  it("a fully-provisioned, active tenant is available for every tool-backed capability", () => {
    const result = deriveTenantCapabilityAvailability(baseFacts());
    for (const id of listCapabilityIds()) {
      if (id === "image_template_write") continue; // categorically unsupported, see below
      expect(result[id]).toMatchObject({ available: true });
    }
  });

  it("image_template_write is always not_supported — no tenant configuration can close it", () => {
    const fullyProvisioned = deriveTenantCapabilityAvailability(baseFacts());
    const emptyTenant = deriveTenantCapabilityAvailability(baseFacts({ registeredToolNames: [], objectDialectConfigured: false }));
    expect(fullyProvisioned.image_template_write).toMatchObject({ available: false, reason: "not_supported" });
    expect(emptyTenant.image_template_write).toMatchObject({ available: false, reason: "not_supported" });
    expect(fullyProvisioned.image_template_write.evidence).toBeDefined();
  });

  it("reason not_configured comes from a missing registered tool name, named in the evidence", () => {
    const result = deriveTenantCapabilityAvailability(baseFacts({ registeredToolNames: [] }));
    expect(result.asset_search).toMatchObject({ available: false, reason: "not_configured" });
    expect(result.asset_search.evidence).toMatchObject({ requiredToolName: "search_artifacts", registeredToolNames: [] });
  });

  it("reason not_configured also fires for a dialect-requiring capability with no object dialect, even with the tool allowed", () => {
    const result = deriveTenantCapabilityAvailability(baseFacts({ objectDialectConfigured: false }));
    expect(result.visual_identity_read).toMatchObject({ available: false, reason: "not_configured" });
    expect(result.visual_identity_read.evidence).toMatchObject({ objectDialectConfigured: false });
    expect(result.visual_identity_propose).toMatchObject({ available: false, reason: "not_configured" });
  });

  it("reason unavailable fires for every capability when the project is disabled, naming the real projectStatus fact", () => {
    const result = deriveTenantCapabilityAvailability(baseFacts({ projectStatus: "disabled" }));
    for (const id of listCapabilityIds()) {
      if (id === "image_template_write") continue; // categorical, not tenant-state-derived
      expect(result[id]).toMatchObject({ available: false, reason: "unavailable" });
      expect(result[id].evidence).toMatchObject({ projectStatus: "disabled" });
    }
  });

  it("disabled takes priority over a missing tool/dialect: the reason is unavailable, not not_configured", () => {
    const result = deriveTenantCapabilityAvailability(baseFacts({ projectStatus: "disabled", registeredToolNames: [], objectDialectConfigured: false }));
    expect(result.asset_search).toMatchObject({ available: false, reason: "unavailable" });
    expect(result.visual_identity_read).toMatchObject({ available: false, reason: "unavailable" });
  });

  it("CAPABILITY_EVIDENCE_TOOL_NAMES is the exact, deduplicated, sorted set of tool names the derivation consults", () => {
    expect(CAPABILITY_EVIDENCE_TOOL_NAMES).toEqual([...CAPABILITY_EVIDENCE_TOOL_NAMES].sort());
    expect(new Set(CAPABILITY_EVIDENCE_TOOL_NAMES).size).toBe(CAPABILITY_EVIDENCE_TOOL_NAMES.length);
    // Every tool-backed capability's evidence tool name is in the set; image_template_write (the one
    // "unsupported" capability) contributes none.
    expect(CAPABILITY_EVIDENCE_TOOL_NAMES).toEqual(
      expect.arrayContaining(["object_inventory", "object_get", "object_create", "search_artifacts", "render_article_pdf", "create_pdf_template", "publish_pdf_template", "search_images"])
    );
  });
});
