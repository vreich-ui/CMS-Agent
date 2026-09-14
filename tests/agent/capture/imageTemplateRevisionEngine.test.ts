// A9 — unit coverage for imageTemplateRevisionEngine.ts's own pure/total pieces: geometry (aspect-ratio
// preservation, header-band reservation with field shifting, explicit-vs-defaulted dimensions), source
// resolution (tag ambiguity/not-found, checksum, captureRequestId-as-provenance-only), target-version
// fetch (the "web" surface's named capability gap), requestedId derivation (the "revision never mints a
// new template" mechanism), and checkpoint carry-forward. The full multi-stage, multi-template
// acceptance scenario (the Zilberman brief) lives in imageTemplateRevisionWorkflow.test.ts, driven
// through runCloneStage exactly as pdfTemplateStudioWorkflow.test.ts drives A7's own stages — this file
// is deliberately narrower and does not touch runCloneStage, the repository layer, or any wire call.
import { describe, expect, it } from "vitest";
import {
  contentDigest,
  computeAspectFitBox,
  computeTopRightImageBox,
  compileRecurringHeaderImageEdit,
  resolveSourceImageStep,
  fetchTargetTemplateVersionStep,
  deriveRequestedIdFromTemplateId,
  runImageRevisionCompilePreviewBatch,
  buildImageTemplateRevisionReportStep,
  DEFAULT_PAGE_SIZE,
  DEFAULT_IMAGE_PLACEMENT,
  type ResolvedSourceAsset,
  type AssetCatalogSource,
  type ImageRevisionIntakeEnvelope,
  type ImageRevisionItemLedgerEntry
} from "../../../src/agent/capture/imageTemplateRevisionEngine.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";

describe("contentDigest — pure, order-independent", () => {
  it("is identical for two objects with the same fields in a different key order", () => {
    expect(contentDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(contentDigest({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("differs when a field's value differs", () => {
    expect(contentDigest({ a: 1 })).not.toBe(contentDigest({ a: 2 }));
  });
});

describe("computeAspectFitBox — preserves the source image's own aspect ratio, never stretches or crops", () => {
  it("fits a wide (2:1) source inside a square box by width, shrinking height proportionally", () => {
    const fitted = computeAspectFitBox({ widthPx: 800, heightPx: 400 }, { width: 120, height: 120 });
    expect(fitted.width).toBe(120);
    expect(fitted.height).toBeCloseTo(60, 5);
    expect(fitted.width / fitted.height).toBeCloseTo(800 / 400, 5);
  });
  it("fits a tall (1:2) source inside a square box by height, shrinking width proportionally", () => {
    const fitted = computeAspectFitBox({ widthPx: 400, heightPx: 800 }, { width: 120, height: 120 });
    expect(fitted.height).toBe(120);
    expect(fitted.width).toBeCloseTo(60, 5);
    expect(fitted.width / fitted.height).toBeCloseTo(400 / 800, 5);
  });
  it("throws on a non-positive source dimension rather than silently dividing by zero", () => {
    expect(() => computeAspectFitBox({ widthPx: 0, heightPx: 400 }, { width: 120, height: 120 })).toThrow();
    expect(() => computeAspectFitBox({ widthPx: 400, heightPx: -1 }, { width: 120, height: 120 })).toThrow();
  });
  it("throws on a non-positive placement box dimension", () => {
    expect(() => computeAspectFitBox({ widthPx: 400, heightPx: 400 }, { width: 0, height: 120 })).toThrow();
  });
});

describe("computeTopRightImageBox — explicit-or-defaulted physical dimensions, never inferred implicitly at render time", () => {
  it("places the box against the page's right margin, honoring the DEFAULT placement when none is supplied", () => {
    const result = computeTopRightImageBox({ pageSize: DEFAULT_PAGE_SIZE, source: { widthPx: 800, heightPx: 400 } });
    expect(result.marginPt).toBe(DEFAULT_IMAGE_PLACEMENT.marginPt);
    expect(result.headerReservePt).toBe(DEFAULT_IMAGE_PLACEMENT.headerReservePt);
    // Right edge sits exactly marginPt from the page's own width; y sits exactly marginPt from the top edge.
    expect(result.box.x + result.box.width).toBeCloseTo(DEFAULT_PAGE_SIZE.widthPt - DEFAULT_IMAGE_PLACEMENT.marginPt, 5);
    expect(result.box.y).toBe(DEFAULT_IMAGE_PLACEMENT.marginPt);
  });
  it("an explicit placement overrides the default and is carried through untouched — never a silently-inferred size", () => {
    const explicit = { widthPt: 80, heightPt: 80, marginPt: 10, headerReservePt: 60 } as const;
    const result = computeTopRightImageBox({ pageSize: DEFAULT_PAGE_SIZE, source: { widthPx: 100, heightPx: 100 }, placement: explicit });
    expect(result.marginPt).toBe(10);
    expect(result.headerReservePt).toBe(60);
    expect(result.maxWidthPt).toBe(80);
    expect(result.maxHeightPt).toBe(80);
    expect(result.box.width).toBeCloseTo(80, 5);
    expect(result.box.height).toBeCloseTo(80, 5);
  });
});

describe("compileRecurringHeaderImageEdit — every page, header band reserved, aspect ratio preserved, nothing mutated in place", () => {
  const threePagePdfme = {
    schemas: [
      [{ name: "title_p1", type: "text", position: { x: 10, y: 20 } }, { name: "body_p1", type: "text", position: { x: 10, y: 200 } }],
      [{ name: "title_p2", type: "text", position: { x: 10, y: 30 } }],
      [{ name: "title_p3", type: "text", position: { x: 10, y: 500 } }]
    ]
  };

  it("places one image field on every page and reserves the header band by shifting any field whose y falls inside it", () => {
    const result = compileRecurringHeaderImageEdit({
      templateJson: threePagePdfme,
      pageSize: DEFAULT_PAGE_SIZE,
      source: { widthPx: 800, heightPx: 400 },
      sourceImageRef: "asset://zilberman-hero/v1"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.pages).toHaveLength(3);
    for (const page of result.edit.pages) expect(page.imagePlaced).toBe(true);

    const schemas = result.edit.templateJson.schemas as unknown[][];
    expect(schemas).toHaveLength(3);
    // Page 1: title_p1 (y:20) is inside the default 96pt header band and must be shifted down by
    // exactly headerReservePt; body_p1 (y:200) is outside it and must be untouched.
    const page1 = schemas[0] as Array<Record<string, unknown>>;
    const title1 = page1.find((field) => field.name === "title_p1") as { position: { y: number } };
    const body1 = page1.find((field) => field.name === "body_p1") as { position: { y: number } };
    expect(title1.position.y).toBe(20 + DEFAULT_IMAGE_PLACEMENT.headerReservePt);
    expect(body1.position.y).toBe(200);
    expect(result.edit.pages[0].shiftedFieldNames).toEqual(["title_p1"]);
    // Every page carries exactly one image field, named after the shared prefix + its own page number.
    for (let i = 0; i < 3; i += 1) {
      const imageField = (schemas[i] as Array<Record<string, unknown>>).find((field) => field.type === "image") as { name: string; content: string; width: number; height: number };
      expect(imageField).toBeDefined();
      expect(imageField.name).toBe(`${result.edit.imageFieldNamePrefix}_p${i + 1}`);
      expect(imageField.content).toBe("asset://zilberman-hero/v1");
      // Aspect ratio preserved: a 2:1 source never renders as a square.
      expect(imageField.width / imageField.height).toBeCloseTo(2, 5);
    }
  });

  it("never mutates the input templateJson — returns a fresh object/array tree", () => {
    const original = structuredClone(threePagePdfme);
    compileRecurringHeaderImageEdit({ templateJson: threePagePdfme, pageSize: DEFAULT_PAGE_SIZE, source: { widthPx: 800, heightPx: 400 }, sourceImageRef: "asset://x" });
    expect(threePagePdfme).toEqual(original);
  });

  it("refuses a non-pdfme (schemas-less) recipe as a named capability gap, not a silent no-op", () => {
    const result = compileRecurringHeaderImageEdit({ templateJson: { notSchemas: [] }, pageSize: DEFAULT_PAGE_SIZE, source: { widthPx: 800, heightPx: 400 }, sourceImageRef: "asset://x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_unsupported_renderer");
  });

  it("refuses a template with a zero-page schemas array", () => {
    const result = compileRecurringHeaderImageEdit({ templateJson: { schemas: [] }, pageSize: DEFAULT_PAGE_SIZE, source: { widthPx: 800, heightPx: 400 }, sourceImageRef: "asset://x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_no_pages");
  });
});

describe("resolveSourceImageStep — never guesses: ambiguous or absent is a named blocker", () => {
  const asset = (over: Partial<ResolvedSourceAsset> = {}): ResolvedSourceAsset => ({
    assetId: "asset_1", checksum: "sha256-fixed", tags: ["zilberman-hero"], widthPx: 800, heightPx: 400,
    reference: "asset://zilberman-hero/v1", provenance: { captureRequestId: null }, ...over
  });

  it("resolves a uniquely-tagged asset", async () => {
    const catalog: AssetCatalogSource = {
      resolveByTag: async () => [asset()],
      resolveByChecksum: async () => undefined,
      resolveByCaptureRequestId: async () => undefined
    };
    const result = await resolveSourceImageStep({ tenantId: "zilberman", ref: { tag: "zilberman-hero" } }, { assetCatalog: catalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.assetId).toBe("asset_1");
  });

  it("refuses (never silently picks) when a tag matches more than one asset", async () => {
    const catalog: AssetCatalogSource = {
      resolveByTag: async () => [asset({ assetId: "a1" }), asset({ assetId: "a2" })],
      resolveByChecksum: async () => undefined,
      resolveByCaptureRequestId: async () => undefined
    };
    const result = await resolveSourceImageStep({ tenantId: "zilberman", ref: { tag: "zilberman-hero" } }, { assetCatalog: catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_source_tag_ambiguous");
  });

  it("refuses when a tag matches no asset", async () => {
    const catalog: AssetCatalogSource = { resolveByTag: async () => [], resolveByChecksum: async () => undefined, resolveByCaptureRequestId: async () => undefined };
    const result = await resolveSourceImageStep({ tenantId: "zilberman", ref: { tag: "nope" } }, { assetCatalog: catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_source_tag_not_found");
  });

  it("resolves by checksum, taking priority over tag when both are supplied", async () => {
    let tagCalled = false;
    const catalog: AssetCatalogSource = {
      resolveByTag: async () => { tagCalled = true; return []; },
      resolveByChecksum: async (_tenant, checksum) => (checksum === "sha256-fixed" ? asset() : undefined),
      resolveByCaptureRequestId: async () => undefined
    };
    const result = await resolveSourceImageStep({ tenantId: "zilberman", ref: { checksum: "sha256-fixed", tag: "zilberman-hero" } }, { assetCatalog: catalog });
    expect(result.ok).toBe(true);
    expect(tagCalled).toBe(false);
  });

  it("resolves by captureRequestId strictly as PROVENANCE for an asset — the resolved asset carries no article/content_item reference of any kind", async () => {
    const catalog: AssetCatalogSource = {
      resolveByTag: async () => [],
      resolveByChecksum: async () => undefined,
      resolveByCaptureRequestId: async (_tenant, id) => (id === "capreq_42" ? asset({ provenance: { captureRequestId: "capreq_42" } }) : undefined)
    };
    const result = await resolveSourceImageStep({ tenantId: "zilberman", ref: { captureRequestId: "capreq_42" } }, { assetCatalog: catalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.provenance.captureRequestId).toBe("capreq_42");
    expect(Object.keys(result.asset)).not.toContain("articleId");
    expect(Object.keys(result.asset)).not.toContain("contentItemId");
  });

  it("refuses when sourceAsset supplies none of tag/checksum/captureRequestId", async () => {
    const catalog: AssetCatalogSource = { resolveByTag: async () => [], resolveByChecksum: async () => undefined, resolveByCaptureRequestId: async () => undefined };
    const result = await resolveSourceImageStep({ tenantId: "zilberman", ref: {} }, { assetCatalog: catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_source_ref_missing");
  });
});

describe("fetchTargetTemplateVersionStep — 'pdf' only today; 'web' is a named capability gap, never a silent mis-handling", () => {
  it("refuses a 'web' surface ref by name, without ever touching the template library", async () => {
    let libraryTouched = false;
    const store = new (class extends TemplateLibraryStore {
      override async getLatest() { libraryTouched = true; return undefined; }
    })();
    const result = await fetchTargetTemplateVersionStep({ surface: "web", templateId: "tpl_1", tenantId: "zilberman" }, { templateLibraryStore: store });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_surface_unsupported");
    expect(libraryTouched).toBe(false);
  });

  it("reports a named not-found for a 'pdf' ref absent from the library, rather than throwing", async () => {
    resetTemplateLibraryMemoryStore();
    const result = await fetchTargetTemplateVersionStep({ surface: "pdf", templateId: "zilberman::pdf_template::does-not-exist", tenantId: "zilberman" }, { templateLibraryStore: new TemplateLibraryStore() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_revision_template_not_found");
  });

  it("fetches a real deposited pdf template's current version, deriving pageCount from its own schemas array", async () => {
    resetTemplateLibraryMemoryStore();
    const store = new TemplateLibraryStore();
    await store.publish({
      templateId: "zilberman::pdf_template::newsletter",
      objectType: "pdf_template",
      name: "Newsletter",
      recipe: { schemas: [[{ name: "a", type: "text", position: { x: 1, y: 1 } }], [{ name: "b", type: "text", position: { x: 1, y: 1 } }]] },
      sourceProjectId: "zilberman",
      provenance: { sourceUrl: "https://zilberman.example/newsletter", driven: "demand" }
    });
    const result = await fetchTargetTemplateVersionStep({ surface: "pdf", templateId: "zilberman::pdf_template::newsletter", tenantId: "zilberman" }, { templateLibraryStore: store });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.pageCount).toBe(2);
    expect(result.template.version).toBe(1);
  });
});

describe("deriveRequestedIdFromTemplateId — the mechanism that makes a revision land as the NEXT version of the SAME library templateId, never a new one", () => {
  it("strips the exact sourceProjectId::pdf_template:: prefix", () => {
    expect(deriveRequestedIdFromTemplateId("zilberman::pdf_template::newsletter", "zilberman")).toBe("newsletter");
  });
  it("returns undefined (never a guess) for a templateId not shaped with this project's own prefix", () => {
    expect(deriveRequestedIdFromTemplateId("other-tenant::pdf_template::newsletter", "zilberman")).toBeUndefined();
    expect(deriveRequestedIdFromTemplateId("not-even-shaped-right", "zilberman")).toBeUndefined();
  });
});

describe("runImageRevisionCompilePreviewBatch — checkpointing: a successful preview is never re-rendered on an unchanged retry", () => {
  const intake = (over: Partial<ImageRevisionIntakeEnvelope> = {}): ImageRevisionIntakeEnvelope => ({
    artifact: "image_revision_intake.v1",
    summary: "fixture",
    tenantId: "zilberman",
    sourceAsset: { assetId: "a1", checksum: "c1", tags: ["zilberman-hero"], widthPx: 800, heightPx: 400, reference: "asset://x", provenance: { captureRequestId: null } },
    sourceAssetError: null,
    placement: {},
    items: [
      { templateRef: { surface: "pdf", templateId: "zilberman::pdf_template::newsletter", tenantId: "zilberman" }, current: { templateId: "zilberman::pdf_template::newsletter", version: 1, objectType: "pdf_template", recipe: { schemas: [[{ name: "t", type: "text", position: { x: 1, y: 1 } }]] }, pageSize: DEFAULT_PAGE_SIZE, pageCount: 1 } }
    ],
    ...over
  });

  it("carries a prior successful preview forward verbatim (same digest) without calling previewTemplateVariant again", async () => {
    let calls = 0;
    const previewTemplateVariant = async () => { calls += 1; return { beforeRef: "before://1", afterRef: "after://1" }; };
    const first = await runImageRevisionCompilePreviewBatch(intake(), { previewTemplateVariant });
    expect(first.items[0].outcome).toBe("previewed");
    expect(calls).toBe(1);

    const second = await runImageRevisionCompilePreviewBatch(intake(), { previewTemplateVariant }, first.items);
    expect(calls).toBe(1); // NOT re-rendered
    expect(second.items[0]).toEqual(first.items[0]);
  });

  it("re-renders when the input digest changed (e.g. the source asset changed) even though a prior successful entry exists", async () => {
    let calls = 0;
    const previewTemplateVariant = async () => { calls += 1; return { beforeRef: `before://${calls}`, afterRef: `after://${calls}` }; };
    const first = await runImageRevisionCompilePreviewBatch(intake(), { previewTemplateVariant });
    expect(calls).toBe(1);

    const changedSource = intake({ sourceAsset: { assetId: "a1", checksum: "c2-different", tags: ["zilberman-hero"], widthPx: 900, heightPx: 400, reference: "asset://x-v2", provenance: { captureRequestId: null } } });
    const second = await runImageRevisionCompilePreviewBatch(changedSource, { previewTemplateVariant }, first.items);
    expect(calls).toBe(2); // re-rendered — the prior checkpoint was stale
    expect(second.items[0].afterRef).toBe("after://2");
  });

  it("does not checkpoint a failed item: a retry with no preview dependency still names the failure, not a silent success", async () => {
    const first = await runImageRevisionCompilePreviewBatch(intake(), {});
    expect(first.items[0].outcome).toBe("preview_failed");
    const second = await runImageRevisionCompilePreviewBatch(intake(), {}, first.items);
    expect(second.items[0].outcome).toBe("preview_failed");
  });
});

describe("buildImageTemplateRevisionReportStep — partial/allFailed computed FROM the ledger, never asserted independently; errors never become 'all done'", () => {
  const ref = (id: string) => ({ surface: "pdf" as const, templateId: `zilberman::pdf_template::${id}`, tenantId: "zilberman" });
  const entry = (id: string, outcome: ImageRevisionItemLedgerEntry["outcome"]): ImageRevisionItemLedgerEntry => ({ templateRef: ref(id), outcome, inputDigest: contentDigest({ id }) });

  const intakeWith = (ids: string[]): ImageRevisionIntakeEnvelope => ({
    artifact: "image_revision_intake.v1",
    summary: "fixture",
    tenantId: "zilberman",
    sourceAsset: null,
    sourceAssetError: null,
    placement: {},
    items: ids.map((id) => ({ templateRef: ref(id) }))
  });

  it("reports partial:true, allFailed:false when at least one item succeeded and at least one failed — never reported as fully successful", () => {
    const applied = { artifact: "image_revision_apply.v1" as const, summary: "fixture", items: [entry("newsletter", "verified"), entry("flyer", "verified"), entry("order-form", "target_fetch_failed")] };
    const report = buildImageTemplateRevisionReportStep({ intake: intakeWith(["newsletter", "flyer", "order-form"]), applied });
    expect(report.partial).toBe(true);
    expect(report.allFailed).toBe(false);
    expect(report.items).toHaveLength(3);
    // Every templateRef this run named appears exactly once.
    expect(report.items.map((item) => item.templateRef.templateId).sort()).toEqual(["zilberman::pdf_template::flyer", "zilberman::pdf_template::newsletter", "zilberman::pdf_template::order-form"]);
  });

  it("reports allFailed:true when every named item failed", () => {
    const applied = { artifact: "image_revision_apply.v1" as const, summary: "fixture", items: [entry("newsletter", "publish_failed")] };
    const report = buildImageTemplateRevisionReportStep({ intake: intakeWith(["newsletter"]), applied });
    expect(report.allFailed).toBe(true);
    expect(report.partial).toBe(false);
  });

  it("reports partial:false, allFailed:false when every named item succeeded — the only shape that may read as fully successful", () => {
    const applied = { artifact: "image_revision_apply.v1" as const, summary: "fixture", items: [entry("newsletter", "verified"), entry("flyer", "verified")] };
    const report = buildImageTemplateRevisionReportStep({ intake: intakeWith(["newsletter", "flyer"]), applied });
    expect(report.partial).toBe(false);
    expect(report.allFailed).toBe(false);
  });

  it("names an item this run attempted but never reached compile/apply for (e.g. a target fetch error) rather than dropping it", () => {
    const intake = intakeWith(["newsletter"]);
    intake.items[0].error = { code: "image_revision_template_not_found", reason: "fixture" };
    const report = buildImageTemplateRevisionReportStep({ intake });
    expect(report.items).toHaveLength(1);
    expect(report.items[0].outcome).toBe("target_fetch_failed");
    expect(report.allFailed).toBe(true);
  });
});
