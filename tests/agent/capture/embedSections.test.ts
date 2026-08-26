// T15.21 — content_embed section mapping/gap coverage for embeds.ts (deliberately NOT part of the
// vendored engine; see embeds.ts's header comment for why). Exercises: each provider class, a
// non-capturable embed, an embed with no containingBlockId, and determinism.
import { describe, expect, it } from "vitest";

import { mapSnapshot } from "../../../src/agent/capture/engine/map.mjs";
import {
  augmentMappingWithEmbeds,
  DEFAULT_EMBED_PROVIDER_ALLOWLIST,
  EMBED_SECTION_TYPE,
  type SnapshotEmbed
} from "../../../src/agent/capture/embeds.js";

const block = (id: string, ordinal: number, text: string) => ({
  id,
  ordinal,
  tag: "section",
  role: null,
  accessibleName: null,
  selector: `#${id}`,
  text: { value: text, length: text.length, truncated: false },
  links: [],
  boundingBoxes: { desktop: { x: 0, y: ordinal * 400, width: 1440, height: 200 } },
  computedStyles: {},
  screenshots: [],
  assetUrls: []
});

const embed = (overrides: Partial<SnapshotEmbed> & { id: string; ordinal: number }): SnapshotEmbed => ({
  tag: "iframe",
  provider: "unknown",
  src: null,
  rawSrc: null,
  providerHost: null,
  title: null,
  accessibleName: null,
  selector: `iframe#${overrides.id}`,
  containingBlockId: null,
  attributes: { width: null, height: null, allow: null, allowFullscreen: false, loading: null, sandbox: null, referrerPolicy: null },
  boundingBoxes: {},
  capturable: false,
  notCapturableReason: "missing-src",
  ...overrides
});

function buildSnapshot(embeds: SnapshotEmbed[]) {
  return {
    schemaVersion: "snapshot.v1",
    capture: {
      targetUrl: "https://example.com/",
      origin: "https://example.com",
      capturedAt: "2026-08-25T00:00:00.000Z",
      redacted: false,
      policy: { rights: { content: "retain_allowed_origin_content", media: "prohibited" } }
    },
    pages: [
      {
        pageId: "page_test",
        requestedUrl: "https://example.com/book-online",
        url: "https://example.com/book-online",
        path: "/book-online",
        status: 200,
        capturedAt: "2026-08-25T00:00:00.000Z",
        title: "Book Online",
        lang: "en",
        canonicalUrl: null,
        metaDescription: null,
        outline: [{ level: 1, text: "Book Online" }],
        blocks: [
          block("page_test_block_001", 0, "Welcome to our booking page, come see us soon for a great time"),
          block("page_test_block_002", 1, "Some more filler prose text about our services here in town")
        ],
        embeds,
        navigation: { primary: [], footer: [] },
        discoveredLinks: [],
        screenshots: []
      }
    ],
    diagnostics: { queuedUrls: 1, capturedPages: 1, skipped: [], quarantined: [], stoppedAtProjectMaxPages: false }
  };
}

const mapAndAugment = (embeds: SnapshotEmbed[]) => {
  const snapshot = buildSnapshot(embeds);
  return augmentMappingWithEmbeds(mapSnapshot(snapshot), snapshot);
};

describe("embeds.ts — content_embed mapping", () => {
  it("maps each provider class the classifier can name into an allowlisted candidate", () => {
    const providers: SnapshotEmbed["provider"][] = ["video", "maps", "booking", "social"];
    const embeds = providers.map((provider, index) =>
      embed({
        id: `page_test_embed_${index}`,
        ordinal: index,
        provider,
        src: `https://${provider}.example-provider.com/widget`,
        capturable: true,
        notCapturableReason: null,
        containingBlockId: "page_test_block_001",
        title: `${provider} widget`,
        boundingBoxes: { desktop: { x: 0, y: 0, width: 800, height: 400 } }
      })
    );
    const mapping = mapAndAugment(embeds);
    const page = mapping.pages[0];
    const embedCandidates = page.candidates.filter((candidate) => candidate.sectionType === EMBED_SECTION_TYPE);
    expect(embedCandidates).toHaveLength(4);
    for (const provider of providers) {
      const candidate = embedCandidates.find((entry) => entry.data.provider === provider);
      expect(candidate, `expected a ${provider} candidate`).toBeDefined();
      expect(candidate?.data.src).toBe(`https://${provider}.example-provider.com/widget`);
      expect(candidate?.data.aspect).toBeCloseTo(2, 3);
    }
    expect(page.gaps.filter((gap) => gap.embedRef)).toHaveLength(0);
    expect(mapping.summary.embedSections).toBe(4);
    // DEFAULT_EMBED_PROVIDER_ALLOWLIST names exactly this vocabulary — nothing more, nothing less.
    expect([...DEFAULT_EMBED_PROVIDER_ALLOWLIST].sort()).toEqual(["booking", "maps", "social", "video"]);
  });

  it("declares a non-capturable embed as a gap carrying its notCapturableReason, never dropped", () => {
    const mapping = mapAndAugment([
      embed({
        id: "page_test_embed_0",
        ordinal: 0,
        capturable: false,
        notCapturableReason: "unsupported-scheme",
        containingBlockId: "page_test_block_001",
        rawSrc: "javascript:alert(1)"
      })
    ]);
    const page = mapping.pages[0];
    expect(page.candidates.filter((c) => c.sectionType === EMBED_SECTION_TYPE)).toHaveLength(0);
    const gap = page.gaps.find((entry) => entry.embedRef === "page_test_embed_0");
    expect(gap).toBeDefined();
    expect(gap?.why).toBe("embed_not_capturable");
    expect(gap?.notCapturableReason).toBe("unsupported-scheme");
    expect(gap?.embedSrc).toBe("javascript:alert(1)");
    expect(gap?.nearestType).toBe(EMBED_SECTION_TYPE);
    expect(gap?.blockRef).toBe("page_test_block_001");
  });

  it("declares an unknown-provider embed as a gap naming its src — the gap ledger, not silence", () => {
    const mapping = mapAndAugment([
      embed({
        id: "page_test_embed_0",
        ordinal: 0,
        provider: "unknown",
        capturable: true,
        notCapturableReason: null,
        src: "https://widgets.example-cms-builder.net/thing",
        containingBlockId: "page_test_block_001"
      })
    ]);
    const gap = mapping.pages[0].gaps.find((entry) => entry.embedRef === "page_test_embed_0");
    expect(gap?.why).toBe("embed_provider_not_allowlisted");
    expect(gap?.embedSrc).toBe("https://widgets.example-cms-builder.net/thing");
    expect(gap?.missingCapability).toContain("unknown");
  });

  it("places an embed with no containingBlockId at the page's end, still represented, never dropped", () => {
    const mapping = mapAndAugment([
      embed({
        id: "page_test_embed_0",
        ordinal: 0,
        provider: "maps",
        capturable: true,
        notCapturableReason: null,
        src: "https://www.google.com/maps?q=1",
        containingBlockId: null
      })
    ]);
    const sections = mapping.pages[0].pageBody.sections;
    expect(sections.at(-1)?.type).toBe(EMBED_SECTION_TYPE);
    expect(sections.filter((s) => s.type === EMBED_SECTION_TYPE)).toHaveLength(1);
  });

  it("positions an embed immediately after its containing block's own section, within block order", () => {
    const mapping = mapAndAugment([
      embed({
        id: "page_test_embed_0",
        ordinal: 0,
        provider: "booking",
        capturable: true,
        notCapturableReason: null,
        src: "https://acme.calendly.com/book",
        containingBlockId: "page_test_block_001"
      })
    ]);
    const types = mapping.pages[0].pageBody.sections.map((section) => section.type);
    const bookingIndex = types.indexOf(EMBED_SECTION_TYPE);
    expect(bookingIndex).toBeGreaterThan(0);
    expect(types[bookingIndex - 1]).not.toBe(EMBED_SECTION_TYPE);
    expect(bookingIndex).toBeLessThan(types.length - 1); // block_002's own section still follows
  });

  it("is deterministic: the same snapshot mapped twice yields byte-identical output", () => {
    const embeds = [
      embed({ id: "page_test_embed_0", ordinal: 0, provider: "video", capturable: true, notCapturableReason: null, src: "https://youtube.com/embed/x", containingBlockId: "page_test_block_001" }),
      embed({ id: "page_test_embed_1", ordinal: 1, capturable: false, notCapturableReason: "missing-src", containingBlockId: "page_test_block_002" }),
      embed({ id: "page_test_embed_2", ordinal: 2, provider: "maps", capturable: true, notCapturableReason: null, src: "https://www.google.com/maps?q=2", containingBlockId: null })
    ];
    const first = JSON.stringify(mapAndAugment(embeds));
    const second = JSON.stringify(mapAndAugment(embeds));
    expect(first).toBe(second);
  });

  it("honors a caller-narrowed allowlist without ever widening past the classifier's own vocabulary", () => {
    const snapshot = buildSnapshot([
      embed({ id: "page_test_embed_0", ordinal: 0, provider: "social", capturable: true, notCapturableReason: null, src: "https://facebook.com/plugins/post", containingBlockId: "page_test_block_001" })
    ]);
    const narrowed = augmentMappingWithEmbeds(mapSnapshot(snapshot), snapshot, { embedProviderAllowlist: ["video"] });
    expect(narrowed.pages[0].candidates.filter((c) => c.sectionType === EMBED_SECTION_TYPE)).toHaveLength(0);
    expect(narrowed.pages[0].gaps.find((g) => g.embedRef === "page_test_embed_0")?.why).toBe("embed_provider_not_allowlisted");

    // "widening" past the classifier's own set (e.g. a bogus provider name) does nothing — the
    // filter in augmentMappingWithEmbeds only ever narrows.
    const widened = augmentMappingWithEmbeds(mapSnapshot(snapshot), snapshot, {
      embedProviderAllowlist: ["social", "not_a_real_provider"]
    });
    expect(widened.pages[0].candidates.filter((c) => c.sectionType === EMBED_SECTION_TYPE)).toHaveLength(1);
  });

  it("leaves a page with no embeds byte-identical to the unaugmented mapping", () => {
    const snapshot = buildSnapshot([]);
    const baseline = mapSnapshot(snapshot);
    const augmented = augmentMappingWithEmbeds(baseline, snapshot);
    expect(JSON.stringify(augmented)).toBe(JSON.stringify({ ...baseline, summary: { ...baseline.summary, embedSections: 0 } }));
  });
});
