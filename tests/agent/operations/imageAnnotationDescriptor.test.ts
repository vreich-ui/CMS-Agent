// T3 (2026-09-16 annotate-bridge plan) — image_annotation, the CONTRACT. No executor exists yet
// (T4), so nothing here runs an annotation: these tests pin the three things registering the
// contract was supposed to buy, each of which was structurally impossible while the operation had no
// id at all.
//   1. the catalog holds it, so planner_plan / operation_preflight can select it;
//   2. preflight reports the honest executable:false with a remedy naming T4, rather than silence —
//      SUPERSEDED BY T5, which shipped that implementation (image_annotation_studio); the test below
//      now pins the flipped fact (executable:true, a real binding, no workflow_binding gap), which is
//      what "the remedy was named and then delivered" looks like from the other side. The RUN itself
//      is exercised in imageAnnotationStudio.test.ts; nothing here still runs an annotation;
//   3. THE POINT — operation_list_capability_gaps can finally RECORD a gap for this capability,
//      because a gap record is keyed on (tenant, operationId@version, capability) and
//      capabilityGapRecorder.ts additionally drops any gap whose capability the closed vocabulary
//      does not know. Before this task both halves of that key were missing.
import { describe, expect, it } from "vitest";
import "../../../src/agent/operations/registerOperations.js";
import { getOperation, listOperationIds } from "../../../src/agent/operations/operationCatalog.js";
import { preflightOperation } from "../../../src/agent/operations/operationPreflight.js";
import { isKnownCapability } from "../../../src/agent/operations/capabilityVocabulary.js";
import { deriveTenantCapabilityAvailability, type TenantCapabilityFacts } from "../../../src/agent/operations/capabilityReadiness.js";
import { recordGenuineCapabilityGaps } from "../../../src/agent/operations/capabilityGapRecorder.js";
import { MemoryCapabilityGapRepository } from "../../../src/agent/repository/memory/MemoryCapabilityGapRepository.js";

// dr-lurie as it actually is: defaultToolPolicy "allowed" (drLurie/definition.ts), so
// effectiveToolPermission resolves annotate_image "allowed" without an explicit row.
const drLurieFacts = (overrides: Partial<TenantCapabilityFacts> = {}): TenantCapabilityFacts => ({
  tenantId: "dr-lurie",
  projectStatus: "active",
  objectDialectConfigured: true,
  registeredToolNames: ["object_inventory", "object_get", "object_create", "search_artifacts", "search_images", "create_pdf_template", "publish_pdf_template", "document_render", "annotate_image"],
  ...overrides
});
const capabilitySourceFor = (facts: TenantCapabilityFacts) => ({ capabilitySource: (tenantId: string) => (tenantId === facts.tenantId ? facts : undefined) });

const validInput = {
  tenantId: "dr-lurie",
  image: { requestId: "req_2026_09_16_hero", sha256: "a".repeat(64) },
  annotations: [{ text: "Barrier repair, step by step", role: "title" }]
};

describe("image_annotation — the registered contract", () => {
  it("is in the catalog, at v1, with surface null (it serves both web and pdf)", () => {
    expect(listOperationIds()).toContain("image_annotation");
    const lookup = getOperation("image_annotation");
    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error("unreachable");
    expect(lookup.descriptor.version).toBe(1);
    expect(lookup.descriptor.surface).toBeNull();
    expect(lookup.descriptor.requiredCapabilities).toEqual(["image_annotate"]);
  });

  it("declares the real pair of effects: analyze_image_layout reads, annotate_image writes a new artifact", () => {
    const lookup = getOperation("image_annotation");
    if (!lookup.found) throw new Error("unreachable");
    expect(lookup.descriptor.effects.map((effect) => [effect.kind, effect.riskLevel])).toEqual([
      ["analyze_image_layout", "read"],
      ["annotate_image", "write"]
    ]);
  });

  // The completion criterion is the check_image_text {mode:"expect"} receipt itself. Nothing in this
  // descriptor turns that check — warn-only by design platform-wide — into a gate, and nothing
  // declares a blocking warning: a descriptor is not a gate (operationTypes.ts's own header).
  it("projects completion from the post-render text check, and declares no blocker of its own", () => {
    const lookup = getOperation("image_annotation");
    if (!lookup.found) throw new Error("unreachable");
    expect(lookup.descriptor.completion).toEqual([
      { id: "annotation_text_verified", description: expect.any(String), evidenceKind: "image_text_check" }
    ]);
    const preflight = preflightOperation({ operationId: "image_annotation", tenantId: "dr-lurie", input: validInput }, capabilitySourceFor(drLurieFacts()));
    expect(preflight.blockers).toEqual([]);
  });

  it("accepts either image spelling — requestId+sha256 or publicPath — and refuses a half-named reference", () => {
    const byPath = preflightOperation(
      { operationId: "image_annotation", tenantId: "dr-lurie", input: { ...validInput, image: { publicPath: "/images/hero.png" } } },
      capabilitySourceFor(drLurieFacts())
    );
    expect(byPath.blockers).toEqual([]);

    // A lone requestId is not a usable reference: refused HERE, not one bridge call later.
    const halfNamed = preflightOperation(
      { operationId: "image_annotation", tenantId: "dr-lurie", input: { ...validInput, image: { requestId: "req_1" } } },
      capabilitySourceFor(drLurieFacts())
    );
    expect(halfNamed.blockers.some((blocker) => blocker.code === "input_schema_invalid")).toBe(true);
  });

  it("refuses an annotation role outside AnnotationSpec's own four text styles rather than rendering it at the default", () => {
    const result = preflightOperation(
      { operationId: "image_annotation", tenantId: "dr-lurie", input: { ...validInput, annotations: [{ text: "hi", role: "subtitle" }] } },
      capabilitySourceFor(drLurieFacts())
    );
    expect(result.blockers.some((blocker) => blocker.code === "input_schema_invalid")).toBe(true);
  });

  it("applies deviceScaleFactor's declared default explicitly, the way every other operation's defaults are echoed", () => {
    const result = preflightOperation({ operationId: "image_annotation", tenantId: "dr-lurie", input: validInput }, capabilitySourceFor(drLurieFacts()));
    expect(result.appliedDefaults).toEqual({ deviceScaleFactor: 1 });
  });

  it("derives image_annotate from the tenant's own annotate_image grant: available on dr-lurie, not_configured (never not_supported) without it", () => {
    expect(isKnownCapability("image_annotate")).toBe(true);
    expect(deriveTenantCapabilityAvailability(drLurieFacts()).image_annotate).toMatchObject({ available: true });
    const withoutGrant = deriveTenantCapabilityAvailability(drLurieFacts({ registeredToolNames: [] })).image_annotate;
    expect(withoutGrant).toMatchObject({ available: false, reason: "not_configured" });
    expect(withoutGrant.evidence).toMatchObject({ requiredToolName: "annotate_image" });
  });

  // T3 pinned the honest executable:false here, with a not_supported workflow_binding gap naming T4:
  // the capability was there and the implementation was not. T5 shipped that implementation
  // (image_annotation -> image_annotation_studio, operationWorkflowBindings.ts), so this assertion
  // FLIPS — and what it now asserts is the same fact from the other side: there is no
  // workflow_binding gap left to report, because there is a registered workflow preflight would
  // genuinely run. The gap MECHANISM is unchanged and still exercised by bindingInputContract's own
  // tests; it simply has no complaint to make about this operation any more.
  it("reports executable:true and a real binding on a fully-capable tenant, with no workflow_binding gap left", () => {
    const result = preflightOperation({ operationId: "image_annotation", tenantId: "dr-lurie", input: validInput }, capabilitySourceFor(drLurieFacts()));
    expect(result.executable).toBe(true);
    expect(result.binding).toMatchObject({ operationId: "image_annotation", workflowId: "image_annotation_studio", inputMapping: {} });
    expect(result.executorBinding).toBeNull();
    // The CAPABILITY was never the thing missing — that was T3's whole point, and it still holds.
    expect(result.capabilityGaps.some((gap) => gap.capability === "image_annotate")).toBe(false);
    expect(result.capabilityGaps.some((gap) => gap.capability === "workflow_binding")).toBe(false);
  });

  // THE ACCEPTANCE THIS TASK EXISTS FOR. A tenant that cannot annotate now produces a DURABLE,
  // keyed ledger record — the thing that was structurally impossible while there was no operationId
  // to key it on, and the reason a shipped capability went unnoticed for ten days.
  it("a tenant missing the annotate_image grant produces a durable capability-gap record keyed on image_annotation@1", async () => {
    const result = preflightOperation(
      { operationId: "image_annotation", tenantId: "dr-lurie", input: validInput },
      capabilitySourceFor(drLurieFacts({ registeredToolNames: [] }))
    );
    const gap = result.capabilityGaps.find((entry) => entry.capability === "image_annotate");
    expect(gap).toMatchObject({ reason: "not_configured", requiredBy: "image_annotation" });

    const repository = new MemoryCapabilityGapRepository();
    const recorded = await recordGenuineCapabilityGaps({
      tenantId: "dr-lurie",
      operationId: result.operationId,
      operationVersion: result.selectedVersion,
      capabilityGaps: result.capabilityGaps,
      repository,
      sourceRef: "t3-acceptance"
    });
    expect(recorded.map((record) => record.capability)).toContain("image_annotate");

    const listed = await repository.listForTenant("dr-lurie");
    const record = listed.find((entry) => entry.capability === "image_annotate");
    expect(record).toMatchObject({ operationId: "image_annotation", operationVersion: 1, reason: "not_configured" });
    // The workflow_binding finding is NOT a tenant capability gap and is correctly dropped by the
    // recorder — it describes an unimplemented operation, not a missing tenant capability.
    expect(listed.some((entry) => entry.capability === "workflow_binding")).toBe(false);
  });
});
