import { describe, expect, it, vi } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { preflightOperation } from "../../../src/agent/operations/operationPreflight.js";
import { UNBOUND_OPERATION_IMPLEMENTING_TASK } from "../../../src/agent/operations/operationWorkflowBindings.js";
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
    "create_pdf_template", "publish_pdf_template", "document_render"
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

  it("no requiredCapability gap is reported once a trusted capabilitySource derives it available (A4: site_inventory now has a registered EXECUTOR, so once capability readiness passes it reports executable:true with zero gaps at all)", () => {
    const deps = capabilitySourceFor(fullyProvisionedDrLurieFacts());
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } }, deps);
    expect(result.capabilityGaps.some((gap) => gap.capability === "site_inventory_read")).toBe(false);
    expect(result.capabilityGaps).toEqual([]);
    expect(result.executable).toBe(true);
    expect(result.binding).toBeNull();
    expect(result.executorBinding).not.toBeNull();
    expect(result.executorBinding?.executorId).toBe("site_inventory_executor");
  });

  it("site_inventory reports executable:false and a not_configured capability gap (never not_supported) when no trusted capabilitySource is supplied — its executor binding EXISTS and its own input contract is satisfied, so the only thing missing is capability readiness", () => {
    const result = preflightOperation({ operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" }, configuredCapabilities: ["site_inventory_read"] });
    expect(result.executable).toBe(false);
    expect(result.binding).toBeNull();
    expect(result.executorBinding).toBeNull();
    const gap = result.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
    expect(gap).toBeDefined();
    expect(gap?.reason).toBe("not_configured");
    expect(result.capabilityGaps.some((entry) => entry.reason === "not_supported")).toBe(false);
  });

  // A5 (Milestone A remainder, runner 3c) — asset_lookup_adopt was the LAST genuinely unbound
  // operation, and this test pinned the honest executable:false + "A5" remedy it reported. It is now
  // bound to asset_lookup_studio, so what is asserted here is the two facts that replaced it: the
  // unbound map is EMPTY (every catalog operation has a workflow binding or an executor), and this
  // operation now reports no workflow_binding gap at all. The not_supported MECHANISM is unchanged
  // and still reachable — it simply has no operation left to fire on, which is the point.
  it("the implementing-task map holds exactly the operations registered ahead of their implementation (T3's image_annotation), and asset_lookup_adopt reports a real binding rather than a not_supported gap", () => {
    // T3 (2026-09-16 annotate-bridge plan) — image_annotation is registered as a CONTRACT ahead of
    // the executor T4 will ship, so it is the one entry here. Every A-milestone operation is still
    // bound; this map is again doing the job its own header describes.
    expect(UNBOUND_OPERATION_IMPLEMENTING_TASK).toEqual({ image_annotation: "T4 of the 2026-09-16 annotate-bridge plan" });
    // With its one capability derived available from trusted facts, the binding resolves — preflight
    // only ever hands back a binding it would actually run (effectiveBinding).
    const provisioned = preflightOperation(
      { operationId: "asset_lookup_adopt", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", query: "logo" } },
      capabilitySourceFor(fullyProvisionedDrLurieFacts())
    );
    expect(provisioned.binding).toMatchObject({
      operationId: "asset_lookup_adopt",
      workflowId: "asset_lookup_studio",
      inputMapping: {},
      initialInputBuilder: { builderId: "asset_lookup_adopt_brief_builder.v1", providesInitialInputFields: ["assetLookupBrief"], requiredOperationFields: ["tenantId", "query"] }
    });
    expect(provisioned.executable).toBe(true);

    // ...and with NO capabilitySource nothing is assumed available: still not executable, but the
    // reason is now a real capability gap, never "no implementation exists".
    const result = preflightOperation({ operationId: "asset_lookup_adopt", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", query: "logo" } });
    expect(result.capabilityGaps.some((gap) => gap.reason === "not_supported")).toBe(false);
    expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
    expect(result.executable).toBe(false);
    expect(result.capabilityGaps.some((gap) => gap.capability === "asset_search")).toBe(true);
  });

  // R1c, flipped by the Milestone A remainder (A6): this binding used to EXIST but map only
  // {projectId, apply}, which could never satisfy brand_imagery_writer's required `mode` or its
  // references/brief anyOf, and this test pinned the honest executable:false. The binding now
  // declares visualIdentityBriefBuilder.ts, which constructs projectId/mode/brief/apply from the
  // operation's own guaranteed fields (tenantId required; focus and autoApply defaulted), so
  // preflight reports executable:true WITH the builder's declaration on the binding — the same
  // checked reason image_template_revision reports it (imageTemplateRevisionDispatch.test.ts).
  it("R1c (repaired): visual_identity_review_change's builder-backed binding satisfies brand_imagery_writer's input contract, so preflight reports executable:true and the binding with its builder", () => {
    const result = preflightOperation({
      operationId: "visual_identity_review_change",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie" }
    }, capabilitySourceFor(fullyProvisionedDrLurieFacts()));
    expect(result.capabilityGaps).toEqual([]);
    expect(result.binding).toMatchObject({
      operationId: "visual_identity_review_change",
      workflowId: "visual_identity",
      inputMapping: {},
      initialInputBuilder: { builderId: "visual_identity_review_change_brief_builder.v1", providesInitialInputFields: ["projectId", "mode", "brief", "apply"], requiredOperationFields: ["tenantId", "focus", "autoApply"] }
    });
    // The defaults the builder relies on were applied by preflight itself, on the record.
    expect(result.appliedDefaults).toMatchObject({ focus: "full_review", autoApply: false });
    expect(result.executable).toBe(true);
  });

  it("R1c (repaired): pdf_template_family's builder-backed binding satisfies pdf_template_intake's named brief, so preflight reports executable:true", () => {
    const result = preflightOperation({
      operationId: "pdf_template_family",
      tenantId: "dr-lurie",
      input: { tenantId: "dr-lurie", familyId: "nonprofit-core" }
    }, capabilitySourceFor(fullyProvisionedDrLurieFacts()));
    expect(result.capabilityGaps).toEqual([]);
    expect(result.binding).toMatchObject({
      operationId: "pdf_template_family",
      workflowId: "pdf_template_studio",
      inputMapping: {},
      initialInputBuilder: { builderId: "pdf_template_family_brief_builder.v1", providesInitialInputFields: ["pdfTemplateFamilyBrief"], requiredOperationFields: ["tenantId", "familyId"] }
    });
    expect(result.executable).toBe(true);
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

    // A10 — retitled: not_supported is no longer produced by any CAPABILITY derivation (nothing in
    // REQUIREMENTS claims `kind:"unsupported"` any more), so this test covers the two reasons
    // capability derivation still produces. not_supported itself is still produced, and still
    // asserted, by the R1c binding-contract gap in the block below.
    it("each capability-derived gap reason (not_configured, unavailable) is produced from a real fact, with evidence", () => {
      const notConfigured = preflightOperation(
        { operationId: "asset_lookup_adopt", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", query: "hero image" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts({ registeredToolNames: [] }))
      );
      const notConfiguredGap = notConfigured.capabilityGaps.find((entry) => entry.capability === "asset_search");
      expect(notConfiguredGap?.reason).toBe("not_configured");
      expect(notConfiguredGap?.evidence).toMatchObject({ requiredToolName: "search_artifacts" });

      // A10 — this used to assert a "not_supported" image_template_write gap for a FULLY
      // PROVISIONED tenant, on the grounds that no tenant configuration could ever close it. A9
      // shipped the implementation and A10 made the capability tool-backed (create_pdf_template,
      // the write verb image_revision_apply actually performs), so a fully-provisioned tenant now
      // derives it AVAILABLE and carries no gap at all. The "not_supported" reason itself is still
      // produced, and still asserted — by the R1c workflow_binding gap in the block below, for a
      // binding that genuinely cannot deliver its entry node's input. A tenant MISSING the grant
      // reports not_configured, which is the honest reading: a configuration gap, not a systemic one.
      const provisioned = preflightOperation(
        { operationId: "image_template_revision", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", sourceAsset: { tag: "hero" }, templateRefs: [{ surface: "web", templateId: "tpl_1", tenantId: "dr-lurie" }] } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts())
      );
      expect(provisioned.capabilityGaps.some((entry) => entry.capability === "image_template_write")).toBe(false);
      const withoutGrant = preflightOperation(
        { operationId: "image_template_revision", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", sourceAsset: { tag: "hero" }, templateRefs: [{ surface: "web", templateId: "tpl_1", tenantId: "dr-lurie" }] } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts({ registeredToolNames: ["search_images"] }))
      );
      const withoutGrantGap = withoutGrant.capabilityGaps.find((entry) => entry.capability === "image_template_write");
      expect(withoutGrantGap?.reason).toBe("not_configured");
      expect(withoutGrantGap?.evidence).toMatchObject({ requiredToolName: "create_pdf_template" });

      const unavailable = preflightOperation(
        { operationId: "site_inventory", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts({ projectStatus: "disabled" }))
      );
      const unavailableGap = unavailable.capabilityGaps.find((entry) => entry.capability === "site_inventory_read");
      expect(unavailableGap?.reason).toBe("unavailable");
      expect(unavailableGap?.evidence).toMatchObject({ projectStatus: "disabled" });
    });

    // R1c superseded this test's former claim that visual_identity_review_change "stays
    // executable:true ... regardless of capability gaps" — capability derivation (R1, this block) and
    // the binding's own input-contract soundness (R1c) are orthogonal axes, and this operation fails
    // the SECOND one regardless of what R1 derives for the first. R1's own behavior (capability gaps
    // are derived from trusted facts, never asserted) is otherwise unaffected — this operation simply
    // ALSO carries the R1c workflow_binding gap on top, same as every unbound operation already did.
    it("R1's capability derivation is unaffected by R1c: visual_identity_review_change still carries no visual_identity_read/propose capability gap once derived available, even though it now also carries R1c's workflow_binding gap; the four still-unbound operations (A4's site_inventory excluded — see its own tests) keep their not_supported workflow_binding gap", () => {
      const bound = preflightOperation(
        { operationId: "visual_identity_review_change", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts())
      );
      expect(bound.capabilityGaps.some((gap) => gap.capability === "visual_identity_read" || gap.capability === "visual_identity_propose")).toBe(false);
      // R1c, repaired (Milestone A remainder): the binding is builder-backed and satisfies its entry
      // node's input contract (see the dedicated R1c test above), so with the capabilities derived
      // available there is nothing left to refuse on — executable:true, no workflow_binding gap.
      expect(bound.executable).toBe(true);
      expect(bound.binding).not.toBeNull();
      expect(bound.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);

      // A4: site_inventory is deliberately EXCLUDED here — it is no longer unbound (it has a
      // registered executor), so it no longer carries a "workflow_binding" not_supported gap; see
      // the dedicated site_inventory tests above for its own (different) current behavior. A7's
      // pdf_template_family and A9's image_template_revision are ALSO excluded here — both are
      // BOUND (to pdf_template_studio / image_template_revision_studio respectively) and, since the
      // Milestone A remainder, both builder-backed and satisfied, like visual_identity_review_change
      // above — not like the genuinely still-unbound ids this loop covers.
      // A8 (Milestone A remainder) — document_render left this loop: it is bound to
      // document_render_studio and builder-backed, so it has no workflow_binding gap at all. Its own
      // current behaviour is asserted immediately after this loop, beside pdf_template_family's.
      // A5 (Milestone A remainder) — this loop was EMPTY: asset_lookup_adopt, the last operation in
      // it, is bound to asset_lookup_studio and builder-backed. The loop was kept, over the live map
      // rather than a hand-written list, so the day an operation is added to the catalog ahead of
      // its workflow this test would cover it without being edited. T3 is that day, and it did.
      // T3 — the loop is live again, over the map rather than a hand-written list: image_annotation
      // is registered ahead of its implementation, so it reports the honest executable:false plus a
      // not_supported workflow_binding gap naming T4.
      const unboundIds = Object.keys(UNBOUND_OPERATION_IMPLEMENTING_TASK);
      expect(unboundIds).toEqual(["image_annotation"]);
      for (const operationId of unboundIds) {
        const result = preflightOperation({ operationId, tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
        expect(result.executable).toBe(false);
        expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding" && gap.reason === "not_supported")).toBe(true);
      }

      // A5 — asset_lookup_adopt's own current behaviour, in place of the loop entry it left: bound,
      // builder-backed, no workflow_binding gap, and executable once its one capability is derived
      // available from trusted facts.
      const assetLookup = preflightOperation(
        { operationId: "asset_lookup_adopt", tenantId: "dr-lurie", input: { tenantId: "dr-lurie", query: "logo" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts())
      );
      expect(assetLookup.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
      expect(assetLookup.executable).toBe(true);

      // A8 — document_render is BOUND and builder-backed: no workflow_binding gap. Still not
      // executable on a bare {tenantId} dispatch, for the same input_schema reason as
      // pdf_template_family right below — here the missing required field is `documentRef`.
      const documentRender = preflightOperation({ operationId: "document_render", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
      expect(documentRender.executable).toBe(false);
      expect(documentRender.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
      expect(documentRender.blockers.some((blocker) => blocker.code === "input_schema_invalid")).toBe(true);

      // Milestone A remainder — pdf_template_family is BOUND (A7) and now builder-backed
      // (pdfTemplateFamilyBriefBuilder.ts); its entry node names the brief it requires, so R1c's
      // contract is satisfied and the workflow_binding gap is GONE, exactly like
      // image_template_revision right below. Still not executable with NO capabilitySource (nothing
      // is assumed available), and for the same input_schema reason as any dispatch missing a
      // required field — here `familyId`.
      const pdfFamily = preflightOperation({ operationId: "pdf_template_family", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
      expect(pdfFamily.executable).toBe(false);
      expect(pdfFamily.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
      expect(pdfFamily.blockers.some((blocker) => blocker.code === "input_schema_invalid")).toBe(true);

      // A10 — image_template_revision NO LONGER behaves like pdf_template_family here: its binding
      // declares an initial-input builder (verified against the descriptor's own guaranteed fields)
      // and its entry node names the brief it requires, so R1c's contract is satisfied and the
      // workflow_binding gap is GONE. It is still not executable with no capabilitySource, and for a
      // different, honest reason — the workflow branch is now gated on capability readiness too, so
      // "nothing trusted was supplied about this tenant" keeps it false, exactly as it does for
      // site_inventory's executor branch.
      const imageRevisionNoFacts = preflightOperation({ operationId: "image_template_revision", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } });
      expect(imageRevisionNoFacts.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
      expect(imageRevisionNoFacts.capabilityGaps.every((gap) => gap.reason === "not_configured")).toBe(true);
      expect(imageRevisionNoFacts.executable).toBe(false);

      // With the tenant's own trusted facts, the same call is executable — and THAT is the green
      // this task earned: a registered workflow, an input contract that genuinely reaches its entry
      // node, and the capabilities the operation declares derived available.
      const imageRevision = preflightOperation(
        { operationId: "image_template_revision", tenantId: "dr-lurie", input: { tenantId: "dr-lurie" } },
        capabilitySourceFor(fullyProvisionedDrLurieFacts())
      );
      expect(imageRevision.capabilityGaps).toEqual([]);
      expect(imageRevision.executable).toBe(true);
      expect(imageRevision.binding?.workflowId).toBe("image_template_revision_studio");
    });
  });
});
