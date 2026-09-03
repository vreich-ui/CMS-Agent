import { describe, expect, it } from "vitest";
import { isArticleTemplate, mapArticleRenderData, selectHeaderImage, type MaterializedImageSlot, type RenderDataTemplate } from "../../../src/agent/workspace/renderDataMapper.js";

// C2 (BRIEF §3.10, R7). The mapper's whole claim is that a PDF slot costs ZERO extra model tokens
// because the material is already written. So the assertions here are about exactly two things:
//   (a) it reads what draft_writer actually emits, in the several shapes `draft.v1` permits (its
//       schema requires only artifact+summary and is additionalProperties:true), and
//   (b) it never invents. A field it cannot derive is reported, never filled.

const ARTICLE: RenderDataTemplate = {
  templateId: "article_brochure_v1",
  kind: "article",
  isDefault: true,
  renderDataSchema: {
    type: "object",
    additionalProperties: false,
    required: ["brand", "title", "deck", "sections", "pullQuotes", "sources"],
    properties: {
      brand: { type: "object" },
      title: { type: "string" },
      deck: { type: "string" },
      kicker: { type: "string" },
      author: { type: "string" },
      coverImage: { type: "string" },
      sections: { type: "array" },
      pullQuotes: { type: "array" },
      sources: { type: "array" }
    }
  }
};

const image = (slotId: string, extra: Partial<MaterializedImageSlot> = {}): MaterializedImageSlot => ({
  slotId,
  assetId: slotId,
  blobKey: `image/req_x/${slotId}.webp`,
  ...extra
});

describe("renderDataMapper — deterministic article render data (C2)", () => {
  it("only runs for an article-kind template", () => {
    expect(isArticleTemplate({ kind: "article" })).toBe(true);
    expect(isArticleTemplate({ kind: "Article" })).toBe(true);
    expect(isArticleTemplate({ kind: "checklist" })).toBe(false);
    expect(isArticleTemplate({})).toBe(false);
    expect(mapArticleRenderData({ template: { templateId: "tpl_checklist_v1", kind: "checklist" }, draft: { title: "x" } })).toBeUndefined();
  });

  it("reads the several shapes draft.v1 is allowed to take", () => {
    const mapping = mapArticleRenderData({
      template: ARTICLE,
      draft: {
        artifact: "draft.v1",
        summary: "ignored when a real deck exists",
        proposedTitle: "A title under its other name",
        metaDescription: "A deck under its other name",
        kicker: "Field Report",
        byline: "Dr. Lurie",
        draftSections: [
          { title: "One", content: "Alpha.\n\nBeta." },
          { heading: "Two", paragraphs: [{ text: "Gamma." }] }
        ],
        quotes: ["A bare string quote", { quote: "An attributed one", author: "Someone" }],
        citations: ["A bare string source", { title: "A structured one", href: "https://example.invalid/x", evidence: "why" }]
      }
    })!;

    expect(mapping.renderData.title).toBe("A title under its other name");
    expect(mapping.renderData.deck).toBe("A deck under its other name");
    expect(mapping.renderData.kicker).toBe("Field Report");
    expect(mapping.renderData.author).toBe("Dr. Lurie");
    expect(mapping.renderData.sections).toEqual([
      { heading: "One", paragraphs: ["Alpha.", "Beta."] },
      { heading: "Two", paragraphs: ["Gamma."] }
    ]);
    expect(mapping.renderData.pullQuotes).toEqual([{ quote: "A bare string quote" }, { quote: "An attributed one", attribution: "Someone" }]);
    expect(mapping.renderData.sources).toEqual([
      { label: "A bare string source" },
      { label: "A structured one", url: "https://example.invalid/x", note: "why" }
    ]);
  });

  it("falls back to `summary` for the deck only when no real deck exists, and never invents a title", () => {
    const mapping = mapArticleRenderData({ template: ARTICLE, draft: { artifact: "draft.v1", summary: "The one-liner." } })!;
    expect(mapping.renderData.deck).toBe("The one-liner.");
    expect(mapping.renderData.title).toBeUndefined();
    // Required-but-underivable fields are NAMED, never filled with placeholder copy.
    expect(mapping.unfilledRequired).toEqual(["brand", "title", "sections"]);
    // pullQuotes/sources are required arrays with no minItems, so empty is the honest answer; sections
    // requires at least one entry, so an empty one is left absent and reported instead.
    expect(mapping.renderData.pullQuotes).toEqual([]);
    expect(mapping.renderData.sources).toEqual([]);
  });

  it("drops a heading with no prose rather than emitting a page that is only a heading", () => {
    const mapping = mapArticleRenderData({
      template: ARTICLE,
      draft: { sections: [{ heading: "Coming soon", paragraphs: [] }, { heading: "Real", paragraphs: ["Body."] }, { paragraphs: ["Orphan."] }] }
    })!;
    expect(mapping.renderData.sections).toEqual([{ heading: "Real", paragraphs: ["Body."] }]);
  });

  it("emits only the keys the template's own schema declares", () => {
    const narrow: RenderDataTemplate = { templateId: "tpl_minimal", kind: "article", renderDataSchema: { type: "object", required: ["title"], properties: { title: {} } } };
    const mapping = mapArticleRenderData({ template: narrow, draft: { title: "T", deck: "D", sections: [{ heading: "H", paragraphs: ["P"] }] }, images: [image("hero")] })!;
    expect(Object.keys(mapping.renderData)).toEqual(["title"]);
    expect(mapping.assets).toBeUndefined();
    expect(mapping.unfilledRequired).toEqual([]);
  });

  it("clamps to the article template's declared maxima instead of shipping a 400", () => {
    const mapping = mapArticleRenderData({ template: ARTICLE, draft: { title: "x".repeat(400) } })!;
    expect(String(mapping.renderData.title)).toHaveLength(200);
    expect(String(mapping.renderData.title).endsWith("…")).toBe(true);
  });

  it("binds the header image as coverImage plus one assets.images entry — the bytes never travel", () => {
    const images = [image("inline_1"), image("hero_shot", { placement: "top" }), image("inline_2")];
    const mapping = mapArticleRenderData({ template: ARTICLE, draft: { title: "T" }, images })!;
    expect(mapping.renderData.coverImage).toBe("hero_shot");
    expect(mapping.coverSlotId).toBe("hero_shot");
    expect(mapping.assets).toEqual({ images: [{ assetId: "hero_shot", blobKey: "image/req_x/hero_shot.webp" }] });
    // No image at all is simply no cover — not a blocker and not a fabricated id.
    const coverless = mapArticleRenderData({ template: ARTICLE, draft: { title: "T" } })!;
    expect(coverless.renderData.coverImage).toBeUndefined();
    expect(coverless.assets).toBeUndefined();
  });

  it("names the header slot by the words a brief actually uses, and otherwise takes the first image", () => {
    expect(selectHeaderImage([image("a"), image("b", { purpose: "the hero shot" })])?.slotId).toBe("b");
    expect(selectHeaderImage([image("a"), image("cover_art")])?.slotId).toBe("cover_art");
    expect(selectHeaderImage([image("diagram_1"), image("diagram_2")])?.slotId).toBe("diagram_1");
    expect(selectHeaderImage([])).toBeUndefined();
  });
});
