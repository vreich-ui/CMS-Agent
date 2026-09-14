import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFamilyRequestedId,
  buildFamilyLibraryTemplateId,
  pdfTemplateFamilyPlanStep,
  pdfTemplateFamilyMintStep,
  validatePdfRendererPayloadContract,
  filterDesignsByContract,
  buildPdfTemplateFamilyReportStep,
  PDF_FAMILY_ARTIFACTS,
  type PdfTemplateFamilyPlanEnvelope
} from "../../../src/agent/capture/pdfTemplateFamilyEngine.js";
import { TemplateLibraryStore } from "../../../src/agent/library/templateLibraryStore.js";
import { resetTemplateLibraryMemoryStore } from "../../../src/agent/library/templateLibraryBackend.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// A7 — pdfTemplateFamilyEngine.ts's own unit coverage. Maps directly onto the task's stated
// acceptance criteria:
//   * "three standard nonprofit templates reach a reviewable family diff ... without the user
//     teaching any schema" — "expands the seeded nonprofit_standard profile into exactly three
//     variants with no schema input from the caller", below.
//   * "rerunning reuses unchanged templates" / "revisions do not create duplicate families" —
//     the "reuse/revision" describe block, below.
//   * "publish-before-validation is impossible" — the "contract validation" and
//     "pdfTemplateFamilyMintStep" describe blocks: a contract-invalid design is proven to never
//     reach create_pdf_template at all (the wire call throws if attempted).
//   * "failed variants are named individually ... a partial failure is reported as a partial
//     failure" — the "buildPdfTemplateFamilyReportStep" describe block.

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
const respond = (id: number, data: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id, result: { structuredContent: data } }) }) as unknown as Response;

const TARGET = "zilberman-pdf-template-family";

describe("buildFamilyRequestedId / buildFamilyLibraryTemplateId — deterministic identity", () => {
  it("is a pure function of (familyId, variant): same inputs always produce the same id", () => {
    const a = buildFamilyRequestedId({ familyId: "Fall Newsletter Family", variant: "newsletter" });
    const b = buildFamilyRequestedId({ familyId: "Fall Newsletter Family", variant: "newsletter" });
    expect(a).toBe(b);
    expect(a).toBe("family-fall-newsletter-family-newsletter");
  });

  it("differs across variants of the same family, and across families of the same variant", () => {
    const a = buildFamilyRequestedId({ familyId: "fam1", variant: "newsletter" });
    const b = buildFamilyRequestedId({ familyId: "fam1", variant: "article" });
    const c = buildFamilyRequestedId({ familyId: "fam2", variant: "newsletter" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("buildFamilyLibraryTemplateId scopes the requestedId under the source project", () => {
    const id = buildFamilyLibraryTemplateId({ sourceProjectId: "proj_1", requestedId: "family-fam1-newsletter" });
    expect(id).toBe("proj_1::pdf_template::family-fam1-newsletter");
  });
});

describe("pdfTemplateFamilyPlanStep — family expansion, and reuse/revision decided before any design turn", () => {
  beforeEach(() => resetTemplateLibraryMemoryStore());
  afterEach(() => resetTemplateLibraryMemoryStore());

  const brief = (overrides: Record<string, unknown> = {}) => ({
    initialInput: { pdfTemplateFamilyBrief: { siteId: "site_x", familyId: "fall-appeal", useCase: "nonprofit_standard", ...overrides } },
    targetProjectId: TARGET
  });

  it("expands the seeded nonprofit_standard profile into exactly three variants with no schema input from the caller", async () => {
    const envelope = await pdfTemplateFamilyPlanStep(brief());
    expect(envelope.artifact).toBe(PDF_FAMILY_ARTIFACTS.plan);
    expect(envelope.rejectedEntries).toEqual([]);
    expect(envelope.entries).toHaveLength(3);
    expect(envelope.entries.map((entry) => entry.name).sort()).toEqual(["Article Brief", "Downloadable Guide", "Newsletter"].sort());
    expect(envelope.reused).toEqual([]);
    // Every entry's requestedId is the SAME deterministic id buildFamilyRequestedId would compute —
    // never a name-derived slug with a de-dupe suffix (the base branch's own scheme).
    for (const entry of envelope.entries) {
      const variant = envelope.entryVariants[entry.requestedId];
      expect(entry.requestedId).toBe(buildFamilyRequestedId({ familyId: "fall-appeal", variant }));
    }
  });

  it("rejects — by name, never silently — a brief missing familyId/siteId, or naming an unknown useCase", async () => {
    const noFamily = await pdfTemplateFamilyPlanStep({ initialInput: { pdfTemplateFamilyBrief: { siteId: "site_x" } }, targetProjectId: TARGET });
    expect(noFamily.entries).toEqual([]);
    expect(noFamily.rejectedEntries.some((entry) => entry.reason.includes("familyId"))).toBe(true);

    const noSite = await pdfTemplateFamilyPlanStep({ initialInput: { pdfTemplateFamilyBrief: { familyId: "fam1" } }, targetProjectId: TARGET });
    expect(noSite.rejectedEntries.some((entry) => entry.reason.includes("siteId"))).toBe(true);

    const unknownUseCase = await pdfTemplateFamilyPlanStep(brief({ useCase: "not_a_real_profile" }));
    expect(unknownUseCase.entries).toEqual([]);
    expect(unknownUseCase.rejectedEntries.some((entry) => entry.reason.includes("not_a_real_profile"))).toBe(true);
  });

  it("no pdfTemplateFamilyBrief at all names zero entries, never a refusal — the common case for a run with no family work", async () => {
    const envelope = await pdfTemplateFamilyPlanStep({ initialInput: {}, targetProjectId: TARGET });
    expect(envelope.entries).toEqual([]);
    expect(envelope.rejectedEntries).toEqual([]);
    expect(envelope.familyId).toBeNull();
  });

  it("REUSE: a variant already published under this family's deterministic id is reused unchanged, never redesigned", async () => {
    const requestedId = buildFamilyRequestedId({ familyId: "fall-appeal", variant: "newsletter" });
    const templateId = buildFamilyLibraryTemplateId({ sourceProjectId: TARGET, requestedId });
    await new TemplateLibraryStore().publish({
      templateId,
      objectType: "pdf_template",
      name: "Newsletter",
      recipe: { schemas: [{ title: { type: "text" } }] },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://example.org/newsletter", driven: "demand" }
    });

    const envelope = await pdfTemplateFamilyPlanStep(brief());
    expect(envelope.entries).toHaveLength(2); // article + download only — newsletter is reused, not redesigned
    expect(envelope.entries.some((entry) => entry.requestedId === requestedId)).toBe(false);
    expect(envelope.reused).toHaveLength(1);
    expect(envelope.reused[0]).toMatchObject({ variant: "newsletter", requestedId, templateId, version: 1 });
    expect(envelope.revisedVariants).toEqual([]);
  });

  it("RERUN: the identical brief run twice, unchanged, reuses every variant the second time — no duplicate family is minted", async () => {
    const firstPlan = await pdfTemplateFamilyPlanStep(brief());
    expect(firstPlan.entries).toHaveLength(3);
    for (const entry of firstPlan.entries) {
      const templateId = buildFamilyLibraryTemplateId({ sourceProjectId: TARGET, requestedId: entry.requestedId });
      await new TemplateLibraryStore().publish({
        templateId,
        objectType: "pdf_template",
        name: entry.name,
        recipe: { schemas: [{ title: { type: "text" } }] },
        sourceProjectId: TARGET,
        provenance: { sourceUrl: "https://example.org/x", driven: "demand" }
      });
    }

    const secondPlan = await pdfTemplateFamilyPlanStep(brief());
    expect(secondPlan.entries).toEqual([]); // nothing left to design
    expect(secondPlan.reused).toHaveLength(3);
    expect(secondPlan.reused.map((entry) => entry.variant).sort()).toEqual(["article", "download", "newsletter"]);
  });

  it("REVISION: brief.revise naming a variant targets its SAME template id for redesign, never a new family", async () => {
    const requestedId = buildFamilyRequestedId({ familyId: "fall-appeal", variant: "newsletter" });
    const templateId = buildFamilyLibraryTemplateId({ sourceProjectId: TARGET, requestedId });
    await new TemplateLibraryStore().publish({
      templateId,
      objectType: "pdf_template",
      name: "Newsletter",
      recipe: { schemas: [{ title: { type: "text" } }] },
      sourceProjectId: TARGET,
      provenance: { sourceUrl: "https://example.org/newsletter", driven: "demand" }
    });

    const envelope = await pdfTemplateFamilyPlanStep(brief({ revise: ["newsletter"] }));
    // Back in `entries` (needs a fresh design) rather than `reused` — but the SAME requestedId/
    // templateId as before, so the next mint/publish targets that template's NEXT version, never a
    // new family member.
    expect(envelope.entries.some((entry) => entry.requestedId === requestedId)).toBe(true);
    expect(envelope.reused.some((entry) => entry.requestedId === requestedId)).toBe(false);
    expect(envelope.revisedVariants).toEqual(["newsletter"]);
    // The other two variants were never revised, so they still reuse if already published — proven
    // by the sibling REUSE test above; here just confirm this brief's own revise list is scoped to
    // exactly the named variant.
  });
});

describe("validatePdfRendererPayloadContract — the per-renderer structural contract, checked before create_pdf_template", () => {
  it("pdfme requires a schemas array", () => {
    expect(validatePdfRendererPayloadContract({ renderer: "pdfme", templateJson: { schemas: [{ a: 1 }] } })).toEqual({ ok: true });
    const bad = validatePdfRendererPayloadContract({ renderer: "pdfme", templateJson: { notSchemas: [] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("pdf_template_contract_pdfme_schema_invalid");
  });

  it("chromium requires non-empty html and a css string, plus sample data", () => {
    expect(validatePdfRendererPayloadContract({ renderer: "chromium", templateJson: { html: "<div/>", css: "" }, sampleData: { a: 1 } })).toEqual({ ok: true });
    const noHtml = validatePdfRendererPayloadContract({ renderer: "chromium", templateJson: { css: "" }, sampleData: { a: 1 } });
    expect(noHtml.ok).toBe(false);
    if (!noHtml.ok) expect(noHtml.code).toBe("pdf_template_contract_chromium_html_invalid");
    const noSample = validatePdfRendererPayloadContract({ renderer: "chromium", templateJson: { html: "<div/>", css: "" } });
    expect(noSample.ok).toBe(false);
    if (!noSample.ok) expect(noSample.code).toBe("pdf_template_contract_sample_data_missing");
  });

  it("typst requires a non-empty source string", () => {
    expect(validatePdfRendererPayloadContract({ renderer: "typst", templateJson: { source: "= Heading" }, sampleData: { a: 1 } })).toEqual({ ok: true });
    const bad = validatePdfRendererPayloadContract({ renderer: "typst", templateJson: { source: "" }, sampleData: { a: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("pdf_template_contract_typst_source_invalid");
  });

  it("an empty or non-object templateJson is rejected for every renderer before any renderer-specific check", () => {
    const result = validatePdfRendererPayloadContract({ renderer: "pdfme", templateJson: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pdf_template_contract_content_missing");
  });
});

describe("filterDesignsByContract — a contract-invalid design never survives to reach create_pdf_template", () => {
  it("splits designs into validDesigns and named contractRejected", () => {
    const design = {
      designs: [
        { requestedId: "req-1", renderer: "pdfme", templateJson: { schemas: [{ a: 1 }] } }, // valid
        { requestedId: "req-2", renderer: "pdfme", templateJson: { notSchemas: [] } }, // contract-invalid
        { requestedId: "req-3", renderer: "chromium", templateJson: { html: "<div/>", css: "" } } // missing sampleData
      ]
    };
    const { validDesigns, contractRejected } = filterDesignsByContract(design);
    expect(validDesigns).toHaveLength(1);
    expect((validDesigns[0] as { requestedId: string }).requestedId).toBe("req-1");
    expect(contractRejected.map((entry) => entry.requestedId).sort()).toEqual(["req-2", "req-3"]);
    expect(contractRejected.find((entry) => entry.requestedId === "req-2")?.code).toBe("pdf_template_contract_pdfme_schema_invalid");
  });
});

describe("pdfTemplateFamilyMintStep — publish-before-validation is structurally impossible", () => {
  beforeEach(async () => {
    resetRepositoryManager();
    process.env.ZILBERMAN_PDF_TEMPLATE_FAMILY_MCP_ENDPOINT = `https://${TARGET}.example/mcp`;
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({
        projectId: TARGET,
        name: "PDF template family fixture",
        mcpEndpointEnvVar: "ZILBERMAN_PDF_TEMPLATE_FAMILY_MCP_ENDPOINT",
        authMode: "none",
        defaultToolPolicy: "allowed"
      })
    );
  });
  afterEach(() => {
    delete process.env.ZILBERMAN_PDF_TEMPLATE_FAMILY_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const intake = (): PdfTemplateFamilyPlanEnvelope => ({
    artifact: PDF_FAMILY_ARTIFACTS.plan,
    summary: "fixture",
    siteId: "site_x",
    familyId: "fall-appeal",
    useCase: "nonprofit_standard",
    entries: [
      { requestedId: "req-good", name: "Newsletter", renderer: "pdfme", tags: [] },
      { requestedId: "req-bad", name: "Article", renderer: "pdfme", tags: [] }
    ],
    rejectedEntries: [],
    entryVariants: { "req-good": "newsletter", "req-bad": "article" },
    reused: [],
    revisedVariants: []
  });

  it("a contract-invalid design never reaches create_pdf_template — it is filtered before the wire call, not merely discouraged", async () => {
    let createCalled = false;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as RpcRequest;
      if (request.method !== "tools/call") return respond(request.id, {});
      const name = request.params?.name ?? "";
      if (name === "create_pdf_template") {
        const args = request.params?.arguments ?? {};
        // The GOOD design is allowed through; the BAD (contract-invalid) one must never arrive here
        // at all — asserting on requestedId-adjacent content rather than trusting a count alone.
        if ((args.templateJson as Record<string, unknown> | undefined)?.notSchemas !== undefined) {
          createCalled = true; // would only become true if the contract-invalid design leaked through
        }
        return respond(request.id, { templateId: "tpl_good", version: 1, status: "active" });
      }
      throw new Error(`Unexpected verb for this fixture: ${name}`);
    }) as unknown as typeof fetch;

    const design = {
      designs: [
        { requestedId: "req-good", templateJson: { schemas: [{ title: { type: "text" } }] } },
        { requestedId: "req-bad", templateJson: { notSchemas: [] } } // contract-invalid for pdfme
      ]
    };
    const result = await pdfTemplateFamilyMintStep({ targetProjectId: TARGET, intake: intake(), design }, { sleepImpl: async () => {} });

    expect(createCalled).toBe(false); // the invalid design's content never reached the wire
    expect(result.contractRejected).toHaveLength(1);
    expect(result.contractRejected[0].requestedId).toBe("req-bad");
    expect(result.applied.map((entry) => entry.requestedId)).toEqual(["req-good"]);
    // contractRejected entries are ALSO folded into `rejected` — nothing this stage filters is
    // dropped from the envelope's own rejection ledger.
    expect(result.rejected.some((entry) => entry.requestedId === "req-bad")).toBe(true);
  });
});

describe("buildPdfTemplateFamilyReportStep — every variant named exactly once; partial vs. total failure", () => {
  const plan = (): PdfTemplateFamilyPlanEnvelope => ({
    artifact: PDF_FAMILY_ARTIFACTS.plan,
    summary: "fixture",
    siteId: "site_x",
    familyId: "fall-appeal",
    useCase: "nonprofit_standard",
    entries: [],
    rejectedEntries: [{ index: -1, name: "extra", reason: "no name supplied" }],
    // NOTE: "req-reused" is deliberately ABSENT from entryVariants — the real
    // pdfTemplateFamilyPlanStep only ever adds a requestedId to entryVariants for a variant it is
    // actually designing this run (see that function's own source); a reused variant is named
    // exclusively through `reused`, below, never through both.
    entryVariants: { "req-published": "article", "req-contract": "download", "req-mint-fail": "flyer", "req-publish-fail": "poster" },
    reused: [{ variant: "newsletter-existing", requestedId: "req-reused", templateId: "proj::pdf_template::req-reused", version: 2, name: "Newsletter" }],
    revisedVariants: []
  });

  it("reports a PARTIAL run (some succeeded, some failed) as partial — never as fully successful and never as total failure", () => {
    const mint = {
      artifact: "pdf_template_mint.v1" as const,
      summary: "fixture",
      siteId: "site_x",
      applied: [
        { requestedId: "req-published", name: "Article", renderer: "pdfme" as const, templateId: "tpl_a", version: 1, validated: true, tags: [], templateJson: {} },
        { requestedId: "req-publish-fail", name: "Poster", renderer: "pdfme" as const, templateId: "tpl_p", version: 1, validated: true, tags: [], templateJson: {} }
      ],
      rejected: [{ requestedId: "req-mint-fail", name: "Flyer", code: "pdf_template_validation_failed", reason: "pdf-tool said no" }],
      contractRejected: [{ requestedId: "req-contract", name: "Download", code: "pdf_template_contract_pdfme_schema_invalid", reason: "no schemas array" }]
    };
    const publish = {
      artifact: "pdf_template_publish.v1" as const,
      summary: "fixture",
      published: [{ requestedId: "req-published", name: "Article", templateId: "tpl_a", version: 1 }],
      failed: [{ requestedId: "req-publish-fail", name: "Poster", templateId: "tpl_p", version: 1, reason: "pdf-tool publish 500" }]
    };
    const library = { deposited: [{ templateId: "proj::pdf_template::req-published", version: 1, objectId: "tpl_a" }], unchanged: [], refused: [] };

    const report = buildPdfTemplateFamilyReportStep({ plan: plan(), mint, publish, library });

    expect(report.artifact).toBe(PDF_FAMILY_ARTIFACTS.report);
    // Every attempted variant named exactly once.
    const byRequestedId = new Map(report.variants.map((entry) => [entry.requestedId, entry]));
    expect(byRequestedId.get("req-reused")?.outcome).toBe("reused");
    expect(byRequestedId.get("req-published")?.outcome).toBe("published");
    expect(byRequestedId.get("req-contract")?.outcome).toBe("contract_rejected");
    expect(byRequestedId.get("req-mint-fail")?.outcome).toBe("mint_rejected");
    expect(byRequestedId.get("req-publish-fail")?.outcome).toBe("publish_failed");
    expect(report.variants.some((entry) => entry.outcome === "family_plan_rejected" && entry.detail?.includes("no name supplied"))).toBe(true);
    expect(report.variants).toHaveLength(6); // 5 tracked requestedIds + 1 family-level rejection

    // STEP A / STEP B are two SEPARATE blocks, never merged.
    expect(report.templateStorePublication.published).toHaveLength(1);
    expect(report.templateStorePublication.failed).toHaveLength(1);
    expect(report.libraryExport).toMatchObject({ attempted: true, deposited: [{ templateId: "proj::pdf_template::req-published" }] });

    // Some succeeded (reused + published = 2), some failed (contract/mint/publish/plan = 4): partial.
    expect(report.partial).toBe(true);
    expect(report.allFailed).toBe(false);
  });

  it("reports ALL-FAILED honestly when nothing succeeded — never disguised as partial", () => {
    const emptyPlan: PdfTemplateFamilyPlanEnvelope = {
      artifact: PDF_FAMILY_ARTIFACTS.plan,
      summary: "fixture",
      siteId: "site_x",
      familyId: "fall-appeal",
      useCase: "nonprofit_standard",
      entries: [],
      rejectedEntries: [{ index: -1, reason: "brief incomplete" }],
      entryVariants: {},
      reused: [],
      revisedVariants: []
    };
    const report = buildPdfTemplateFamilyReportStep({ plan: emptyPlan });
    expect(report.allFailed).toBe(true);
    expect(report.partial).toBe(false);
    expect(report.variants).toEqual([{ variant: "(family-level)", requestedId: "(family-level)", outcome: "family_plan_rejected", detail: "brief incomplete" }]);
  });

  it("a template published in pdf-tool's own store but refused by the library export is reported as library_export_refused, not published", () => {
    const onePlan: PdfTemplateFamilyPlanEnvelope = {
      artifact: PDF_FAMILY_ARTIFACTS.plan,
      summary: "fixture",
      siteId: "site_x",
      familyId: "fall-appeal",
      useCase: "nonprofit_standard",
      entries: [],
      rejectedEntries: [],
      entryVariants: { "req-x": "newsletter" },
      reused: [],
      revisedVariants: []
    };
    const mint = {
      artifact: "pdf_template_mint.v1" as const,
      summary: "fixture",
      siteId: "site_x",
      applied: [{ requestedId: "req-x", name: "Newsletter", renderer: "pdfme" as const, templateId: "tpl_x", version: 1, validated: true, tags: [], templateJson: {} }],
      rejected: [],
      contractRejected: []
    };
    const publish = { artifact: "pdf_template_publish.v1" as const, summary: "fixture", published: [{ requestedId: "req-x", name: "Newsletter", templateId: "tpl_x", version: 1 }], failed: [] };
    const library = { deposited: [], unchanged: [], refused: [{ objectId: "tpl_x", requestedId: "req-x", code: "template_provenance_unstateable", reason: "no sourceUrl" }] };

    const report = buildPdfTemplateFamilyReportStep({ plan: onePlan, mint, publish, library });
    expect(report.variants).toEqual([{ variant: "newsletter", requestedId: "req-x", outcome: "library_export_refused", detail: "no sourceUrl" }]);
    expect(report.allFailed).toBe(true); // library_export_refused does not count as succeeded
  });
});
