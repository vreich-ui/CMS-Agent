import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCloneDelta } from "../../../src/agent/capture/engine/clone.mjs";
import type { CloneIntake } from "../../../src/agent/capture/engine/clone.mjs";
import { observeImagery } from "../../../src/agent/capture/engine/theme.mjs";
import { buildCloneVisualStandardDraft, cloneThemeBindStep } from "../../../src/agent/capture/cloneEngine.js";
import { visualIdentityNodes } from "../../../src/agent/workspace/visualIdentityNodes.js";
import { validateOutput } from "../../../src/agent/execution/outputValidator.js";
import { repositoryManager, resetRepositoryManager } from "../../../src/agent/runtime/repositories.js";
import { createProject, projectCreateSchema } from "../../../src/agent/projects/projectAdmin.js";

// C3 (BRIEF §3.1, R1, derivedFrom.method 'clone') — CLONED IMAGERY BECOMES A DRAFT, NOT A DROPPED LINE.
//
// theme.mjs used to end its gap list with "Imagery style is intentionally not written to
// brandImagery; review separately", because the only place a look could live was `site.brandImagery`
// and writing THAT from a crawl is exactly what R6's owner-gated apply verb exists to prevent. R1's
// `visual_standard` is that somewhere, and its `derivedFrom.method` carries 'clone' for this case.
//
// The two properties pinned here are the two that matter: the observations produce a DRAFT object
// payload, and the run never emits `set_site_brand_imagery` (nor `site_apply_brand_imagery`, nor any
// other write to the site) while doing it.

const PALETTE = { colors: { "brand-primary": "rgb(46 111 149)", accent: "#C2A878" }, fonts: { body: "Inter, sans-serif" } };

const IMAGERY = {
  observed: true,
  imageCount: 24,
  pagesWithImages: 4,
  backgroundImageBlocks: 2,
  extensions: ["jpg", "png"],
  aspectRatios: ["16:9", "4:5"],
  medium: null
};

// The same source, but every asset a vector — the one case theme.mjs can quantize a medium from, and
// therefore the only case where a snapshot evidences every field visual_standard.v1 REQUIRES.
const VECTOR_IMAGERY = { ...IMAGERY, extensions: ["svg"], medium: "flat_vector" as const };

// The frozen `brandImagery` shape, as this repo mirrors it verbatim from platform's site-v1.ts
// (visualIdentityNodes.ts's own note on why the mirror exists). Validating against it here is what
// makes the assertions below about a REAL schema rather than about this test's own opinion.
const writerNode = visualIdentityNodes.find((node) => node.id === "brand_imagery_writer")!;
const BRAND_IMAGERY_SCHEMA = ((writerNode.outputSchema as Record<string, unknown>).properties as Record<string, unknown>).brandImagery;

const intakeFixture = (overrides: Record<string, unknown> = {}): CloneIntake =>
  ({
    artifact: "clone_intake.v1",
    summary: "Fixture briefing.",
    entryMode: "clone",
    captureRunId: "run_capture_fixture",
    sourceUrl: null,
    target: "fixture-target",
    site: { objectId: "site_1", palette: PALETTE },
    theme: { objectId: "thm_1", name: "Captured", palette: PALETTE },
    registry: { sectionTypes: {}, pageTypes: {} },
    pages: [],
    recipes: { section_template: [], template: [] },
    budget: { chars: 0, cap: 48000, truncated: [] },
    imagery: IMAGERY,
    ...overrides
  }) as unknown as CloneIntake;

describe("theme.mjs observes imagery instead of dropping it", () => {
  const snapshot = (blocks: unknown[]) => ({
    schemaVersion: "snapshot.v1",
    pages: [{ blocks }],
    diagnostics: { quarantined: [] }
  });

  it("counts distinct assets, background-image blocks and quantized ratios — structurally, never by content", () => {
    const result = observeImagery(snapshot([
      { assetUrls: ["https://src.test/a.jpg", "https://src.test/b.png", "https://src.test/a.jpg"], boundingBoxes: { desktop: { width: 1600, height: 900 } }, computedStyles: {} },
      { assetUrls: [], computedStyles: { desktop: { backgroundImage: 'url("https://src.test/hero.webp")' } }, boundingBoxes: { desktop: { width: 1000, height: 1000 } } },
      // A stylesheet is not imagery; a link is not imagery. Neither is counted.
      { assetUrls: ["https://src.test/site.css"], computedStyles: {}, boundingBoxes: { desktop: { width: 100, height: 100 } } }
    ]));

    expect(result.observed).toBe(true);
    expect(result.imageCount).toBe(2);
    expect(result.pagesWithImages).toBe(1);
    expect(result.backgroundImageBlocks).toBe(1);
    expect(result.aspectRatios).toEqual(["16:9", "1:1"]);
    // A medium is a decision, not a file-extension guess — unless every asset really is a vector.
    expect(result.medium).toBeNull();
    expect(observeImagery(snapshot([{ assetUrls: ["https://src.test/logo.svg"], computedStyles: {}, boundingBoxes: { desktop: { width: 400, height: 400 } } }])).medium).toBe("flat_vector");
  });

  it("reports a text-only source as unobserved — a fact about the source, never a failure", () => {
    const result = observeImagery(snapshot([{ assetUrls: [], computedStyles: { desktop: { backgroundImage: null } } }]));
    expect(result.observed).toBe(false);
    expect(result.imageCount).toBe(0);
  });
});

describe("buildCloneVisualStandardDraft — evidence or absence, never invention", () => {
  it("produces a DRAFT visual_standard payload with derivedFrom.method 'clone'", () => {
    const draft = buildCloneVisualStandardDraft({ siteId: "site_1", themeId: "thm_1", palette: PALETTE, imagery: IMAGERY })!;

    expect(draft.objectType).toBe("visual_standard");
    expect(draft.requestedId).toBe("vis_1_cloned");
    expect(draft.body.status).toBe("draft");
    expect(draft.body.derivedFrom).toEqual({ method: "clone", themeId: "thm_1" });
    // R1's rule 4 neighbourhood: a cloned look is a proposal, never the site's declared house look.
    expect(draft.body.kind).toBe("template");

    const brandImagery = draft.body.brandImagery as Record<string, unknown>;
    // The palette is the site's own colors, hex-normalized — every swatch traceable to a live token.
    expect(brandImagery.palette).toEqual(["#2E6F95", "#C2A878"]);
    // Ratios are the observed ones, keyed on the conservative pair the writer's own prompt names when
    // the site's real image-policy contexts are unavailable — a convention followed, not invented.
    expect(brandImagery.aspectRatios).toEqual({ article_header: "16:9", article_body: "4:5" });
    // Deterministic: the same site proposes the SAME seed instead of re-rolling every image the site
    // would regenerate, and a different site gets a different one.
    expect(typeof brandImagery.seedBase).toBe("number");
    const again = buildCloneVisualStandardDraft({ siteId: "site_1", themeId: "thm_1", palette: PALETTE, imagery: IMAGERY })!;
    expect((again.body.brandImagery as Record<string, unknown>).seedBase).toBe(brandImagery.seedBase);
    const other = buildCloneVisualStandardDraft({ siteId: "site_2", palette: PALETTE, imagery: IMAGERY })!;
    expect((other.body.brandImagery as Record<string, unknown>).seedBase).not.toBe(brandImagery.seedBase);
    // Unobservable fields are ABSENT and named as gaps, never filled with a plausible default...
    expect(brandImagery.medium).toBeUndefined();
    expect(draft.gaps.join(" ")).toMatch(/medium/);
    expect(draft.gaps.join(" ")).toMatch(/sampleSubjects/);
    // ...and because `medium` and `styleSentence` are fields visual_standard.v1 REQUIRES, a draft
    // missing them is NOT FILEABLE. It is not a body to send and have refused; it is a review
    // artifact that stays on the envelope. This is the half the original assertions inverted: they
    // pinned an absent `sampleSubjects` as correct, when absent is exactly what the schema refuses.
    expect(draft.fileable).toBe(false);
    expect(draft.missing).toEqual(["brandImagery.medium", "brandImagery.styleSentence"]);
  });

  // REVIEW — the assertion the original file had no equivalent of: does the body this builder
  // produces actually satisfy the frozen schema it will be validated against?
  it("produces a body visual_standard.v1 ACCEPTS when the snapshot evidenced every required field", () => {
    const draft = buildCloneVisualStandardDraft({ siteId: "site_1", themeId: "thm_1", palette: PALETTE, imagery: VECTOR_IMAGERY })!;

    expect(draft.fileable).toBe(true);
    expect(draft.missing).toBeUndefined();
    // R2's id grammar: the SITE SLUG, so a clone of site_1 files beside that site's own vis_1.
    expect(draft.requestedId).toBe("vis_1_cloned");

    // sampleSubjects is REQUIRED by the body schema and legal as [] only for a draft — which is the
    // only status this builder produces. Absent is not "honest", it is invalid.
    expect(draft.body.sampleSubjects).toEqual([]);
    expect(draft.body.status).toBe("draft");
    expect(draft.body.references).toEqual([]);

    const brandImagery = draft.body.brandImagery as Record<string, unknown>;
    const validation = validateOutput(brandImagery, BRAND_IMAGERY_SCHEMA);
    expect(validation.ok, JSON.stringify(validation.ok ? [] : validation.errors)).toBe(true);
    expect(brandImagery.medium).toBe("flat_vector");
    // The style sentence is derived from the medium and states its own limits. It names no subject,
    // no scene and no object — R4's separation holds.
    expect(brandImagery.styleSentence).toMatch(/still to be decided/);
    expect(String(brandImagery.styleSentence).length).toBeLessThanOrEqual(400);
  });

  it("proposes nothing at all for a source that showed no imagery", () => {
    expect(buildCloneVisualStandardDraft({ siteId: "site_1", palette: PALETTE, imagery: { ...IMAGERY, observed: false } })).toBeUndefined();
    expect(buildCloneVisualStandardDraft({ siteId: "site_1", palette: PALETTE, imagery: undefined })).toBeUndefined();
  });

  it("drops an unreadable color rather than approximating one", () => {
    const draft = buildCloneVisualStandardDraft({ siteId: "site_1", palette: { colors: { a: "var(--brand)", b: "rgb(1 2 3)" } }, imagery: IMAGERY })!;
    expect((draft.body.brandImagery as Record<string, unknown>).palette).toEqual(["#010203"]);
  });
});

type RpcRequest = { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

describe("theme_bind files the cloned imagery as a draft and applies nothing", () => {
  const TARGET = "clone-imagery-target";
  let calls: Array<{ name: string; args: Record<string, unknown> }>;

  beforeEach(async () => {
    resetRepositoryManager();
    calls = [];
    process.env.CLONE_IMAGERY_MCP_ENDPOINT = "https://clone-imagery.example/mcp";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        const name = request.params?.name ?? "";
        if (request.method === "tools/call") calls.push({ name, args: request.params?.arguments ?? {} });
        const record =
          name === "object_get"
            ? { record: { object_id: "site_1", body: { name: "Site", brandTokens: PALETTE, tokens: PALETTE } } }
            : name === "object_create"
              ? { record: { object_id: "vis_1_cloned" } }
              : {};
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data: record } } }) } as unknown as Response;
      })
    );
    await createProject(
      repositoryManager.getProjectRepository(),
      projectCreateSchema.parse({ projectId: TARGET, name: "Clone imagery fixture", mcpEndpointEnvVar: "CLONE_IMAGERY_MCP_ENDPOINT", authMode: "none", defaultToolPolicy: "allowed" })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLONE_IMAGERY_MCP_ENDPOINT;
    resetRepositoryManager();
  });

  const gatedIntake = (overrides: Record<string, unknown> = {}) =>
    applyCloneDelta(intakeFixture({ target: TARGET, ...overrides }) as never, { pages: [] });

  it("object_creates a draft visual_standard and NEVER emits set_site_brand_imagery", async () => {
    const envelope = await cloneThemeBindStep({ targetProjectId: TARGET, intake: { ...gatedIntake(), imagery: VECTOR_IMAGERY }, themeProposal: undefined });

    const create = calls.find((call) => call.name === "object_create")!;
    expect(create).toBeDefined();
    expect(create.args.object_type ?? create.args.objectType).toBe("visual_standard");
    const body = (create.args.body ?? {}) as Record<string, unknown>;
    expect(body.status).toBe("draft");
    expect(body.derivedFrom).toMatchObject({ method: "clone" });

    // THE LAW. A cloned look is a proposal. Nothing in this run applies one.
    const verbs = calls.map((call) => call.name);
    expect(verbs).not.toContain("set_site_brand_imagery");
    expect(verbs).not.toContain("site_apply_brand_imagery");
    expect(verbs).not.toContain("object_patch");
    expect(verbs).not.toContain("object_publish");

    expect(envelope.imageryDraft).toMatchObject({ visualStandardId: "vis_1_cloned", created: true, status: "draft" });
    expect(envelope.summary).toContain("never applied");
  });

  it("creates nothing when the capture observed no imagery", async () => {
    const envelope = await cloneThemeBindStep({ targetProjectId: TARGET, intake: { ...gatedIntake(), imagery: { ...IMAGERY, observed: false } }, themeProposal: undefined });

    expect(calls.map((call) => call.name)).not.toContain("object_create");
    expect(envelope.imageryDraft).toBeUndefined();
  });

  it("reports a failed draft create as a reason — a theme bind that worked is never called failed for a review artifact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as RpcRequest;
        const name = request.params?.name ?? "";
        if (request.method === "tools/call") calls.push({ name, args: request.params?.arguments ?? {} });
        if (name === "object_create") {
          return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "visual_standard type not registered" } }) } as unknown as Response;
        }
        const record = name === "object_get" ? { record: { object_id: "site_1", body: { name: "Site", brandTokens: PALETTE, tokens: PALETTE } } } : {};
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data: record } } }) } as unknown as Response;
      })
    );

    const envelope = await cloneThemeBindStep({ targetProjectId: TARGET, intake: { ...gatedIntake(), imagery: VECTOR_IMAGERY }, themeProposal: undefined });

    expect(envelope.artifact).toBe("clone_theme_bind.v1");
    expect(envelope.imageryDraft?.created).toBe(false);
    expect(envelope.imageryDraft?.reason).toContain("clone_imagery_draft_failed");
  });

  // REVIEW — and the case that used to issue a create the schema could only refuse: an incomplete
  // draft is reported, not sent. A theme bind that worked is still not called failed for it.
  it("sends NO create at all when the snapshot could not evidence a required field", async () => {
    const envelope = await cloneThemeBindStep({ targetProjectId: TARGET, intake: { ...gatedIntake(), imagery: IMAGERY }, themeProposal: undefined });

    expect(calls.map((call) => call.name)).not.toContain("object_create");
    expect(envelope.imageryDraft?.created).toBe(false);
    expect(envelope.imageryDraft?.reason).toContain("clone_imagery_draft_incomplete");
    expect(envelope.imageryDraft?.reason).toContain("brandImagery.medium");
    expect(envelope.summary).toContain("never applied");
  });
});
