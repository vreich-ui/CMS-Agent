// T15.21 — map pdf-tool's captured `page.embeds[]` (snapshot.v1, T15.20) into positioned
// `content_embed` section candidates and declared gaps, run as a pass over `mapSnapshot`'s OWN
// output rather than inside it.
//
// WHY THIS LIVES HERE AND NOT IN THE VENDORED map.mjs/emit.mjs (see ./provenance.ts and
// ./engine/*.mjs): the brief's stated preference is to keep new mapping logic outside the vendored
// files whenever a solution exists that does — and one does, because everything this module needs
// is already exposed on `mapSnapshot`'s return value: `page.blockAccounting` (with its
// duplicate/merged `resolvedInto` chain) tells us which raw block ids survived reconciliation and
// which were folded away, and `page.candidates[].sourceBlockIds` tells us which existing section(s)
// belong to which surviving block. Touching map.mjs/emit.mjs for this would require re-vendoring
// both files AND their platform-side originals in the same commit (the provenance pin in
// provenance.ts checks both sides match); this way, provenance.ts is untouched, and the vendored
// engine keeps behaving exactly as its pinned hash says it does.
//
// DISCOVERY THIS MODULE DOES NOT PAPER OVER — read before wiring a real target: the platform
// registry's ACTUAL `content_embed` section type (packages/core/schema/bodies/section-v1.ts) is
// `{ contentItem: string }`, a link card to a published article (D§2.5), rendered by
// ContentEmbed.astro. It has no field for a third-party src, provider, or aspect ratio, and its
// `data` schema is `.strict()` — an object carrying `provider`/`src`/`title`/`aspect` and no
// `contentItem` fails that schema outright. Nothing registered today can hold or render what this
// module's candidates carry. This module still builds them — the geometry, provider
// classification, and allowlist gating below are real, deterministic, capture-side judgments,
// independent of where the data eventually lands — but until the platform side grows an
// embed-capable section type (and a component that actually renders a sandboxed iframe), every
// `content_embed` candidate this module produces will be REJECTED by the target's own
// `object_patch`/`object_create` schema validation at emission time and quarantined
// (`postcreate_validation_failed`), never silently written and never silently dropped — that is a
// visible, reported failure (ADR T15.4), and it is exactly the signal that the platform-side change
// described in CMS-Agent#199's landing report is still owed.
import { createHash } from "node:crypto";
import type { CaptureMapGap, CaptureMapping, CaptureMapPage } from "./engine/map.mjs";

/** The governed section type this module places a captured embed as. See the DISCOVERY note above
 *  for why nothing currently renders it. */
export const EMBED_SECTION_TYPE = "content_embed";

/**
 * Providers snapshot.v1's embed classifier (pdf-tool T15.20, hostname-based) recognizes. `unknown`
 * — same-origin widgets, and every host outside that classifier's table — is never allowlisted by
 * default: it is exactly the case with no evidence the embed is a well-behaved named third party,
 * and "third-party embedded content" is already called out as its own risk surface (clone.mjs's
 * SECTION_TYPE_COMPATIBILITY_CLASSES). Callers may narrow it via
 * `augmentMappingWithEmbeds(mapping, snapshot, { embedProviderAllowlist })`; they may never widen it
 * past this set without also widening the classifier that assigns `provider` in the first place.
 */
export const DEFAULT_EMBED_PROVIDER_ALLOWLIST = Object.freeze(["video", "maps", "booking", "social"]);

const NOT_CAPTURABLE_TEXT: Record<string, string> = {
  "missing-src": "the source element had no src (or data=, for <object>) attribute to capture",
  "unsupported-scheme": "the source src's scheme is not http(s) and cannot be embedded",
  "invalid-src": "the source src could not be parsed as a URL",
};

/** The same statuses captureEngine.ts's NON_CONTENT_STATUSES names: blocks reconciliation dropped
 *  BEFORE classifyBlock ever ran, so they never occupied a place in the page's block order. */
const NON_SURVIVOR_STATUSES = new Set(["duplicate", "merged", "ignored_noncontent"]);

const hash = (value: string, length = 12): string => createHash("sha256").update(value).digest("hex").slice(0, length);

const clean = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

type BoundingBox = { x?: number; y?: number; width?: number; height?: number };

/** One `page.embeds[]` entry, per pdf-tool's snapshot.v1 contract (T15.20). Read defensively —
 *  nothing here trusts the crawl output's shape beyond what it needs. */
export type SnapshotEmbed = {
  id: string;
  ordinal: number;
  tag: "iframe" | "embed" | "object";
  provider: "video" | "maps" | "booking" | "social" | "unknown";
  src: string | null;
  rawSrc: string | null;
  providerHost: string | null;
  title: string | null;
  accessibleName: string | null;
  selector: string;
  containingBlockId: string | null;
  attributes: Record<string, unknown>;
  boundingBoxes: Record<string, BoundingBox>;
  capturable: boolean;
  notCapturableReason: "missing-src" | "unsupported-scheme" | "invalid-src" | null;
};

type RawBlock = { id?: unknown };
type RawSnapshotPage = { pageId?: unknown; blocks?: unknown; embeds?: unknown };
type RawSnapshot = { pages?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readEmbeds(page: RawSnapshotPage): SnapshotEmbed[] {
  if (!Array.isArray(page.embeds)) return [];
  return page.embeds.filter(
    (entry): entry is SnapshotEmbed =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.ordinal === "number" &&
      typeof entry.tag === "string" &&
      typeof entry.provider === "string" &&
      typeof entry.capturable === "boolean"
  ) as SnapshotEmbed[];
}

function readBlockIdsInOrder(page: RawSnapshotPage): string[] {
  if (!Array.isArray(page.blocks)) return [];
  return page.blocks.filter((block): block is RawBlock => isRecord(block) && typeof block.id === "string").map((block) => block.id as string);
}

/**
 * The aspect ratio (width / height) of a captured embed, read from whichever recorded viewport box
 * is widest — the same "trust the biggest measured box" rule map.mjs's `blockSlotWidth` uses for
 * images, so the two agree on which viewport to believe. Ties (equal width) break on the viewport id
 * so the choice never depends on object-key insertion order. Returns null when no viewport recorded
 * a positive width and height (an embed's `boundingBoxes` can be `{}` if it was never measured).
 */
function embedAspectRatio(boundingBoxes: Record<string, BoundingBox> | undefined): number | null {
  const entries = Object.entries(boundingBoxes ?? {}).filter(
    ([, box]) => Number.isFinite(box?.width) && Number.isFinite(box?.height) && (box.width as number) > 0 && (box.height as number) > 0
  );
  if (entries.length === 0) return null;
  entries.sort(([leftId, leftBox], [rightId, rightBox]) => (rightBox.width as number) - (leftBox.width as number) || leftId.localeCompare(rightId));
  const [, box] = entries[0];
  return Math.round(((box.width as number) / (box.height as number)) * 1000) / 1000;
}

function embedTitle(embed: SnapshotEmbed): string | null {
  return clean(embed.title) || clean(embed.accessibleName) || null;
}

/**
 * Resolve an embed's recorded `containingBlockId` through block reconciliation. Reconciliation runs
 * AFTER the crawl assigned `containingBlockId`, so the block an embed names may since have been
 * folded into another (`duplicate`/`merged`, both carrying `resolvedInto`) or dropped outright
 * (`ignored_noncontent`, no resolution). Walk the `resolvedInto` chain to a fixed point and return it
 * only if it lands on a block that actually survived reconciliation. An embed whose ancestor was
 * dropped as noise has no living position to inherit and is placed at the page's end instead — never
 * silently attached to the wrong block.
 */
/** Returns "" (never null — see CaptureMapGap.blockRef's doc comment) when no living block claims
 *  this embed. */
function resolveEmbedBlockId(
  containingBlockId: string | null,
  resolvedInto: Map<string, string>,
  survivorIds: Set<string>
): string {
  let current = containingBlockId;
  const seen = new Set<string>();
  while (current && !survivorIds.has(current)) {
    if (seen.has(current)) return "";
    seen.add(current);
    current = resolvedInto.get(current) ?? null;
  }
  return current && survivorIds.has(current) ? current : "";
}

type EmbedVerdict =
  | { kind: "candidate"; candidate: CaptureMapPage["candidates"][number] }
  | { kind: "gap"; why: string; missingCapability: string };

function classifyEmbed(embed: SnapshotEmbed, allowlist: Set<string>): EmbedVerdict {
  if (!embed.capturable) {
    return {
      kind: "gap",
      why: "embed_not_capturable",
      missingCapability:
        NOT_CAPTURABLE_TEXT[embed.notCapturableReason ?? ""] ??
        `embed src could not be captured (${embed.notCapturableReason ?? "unknown reason"})`,
    };
  }
  if (!allowlist.has(embed.provider)) {
    return {
      kind: "gap",
      why: "embed_provider_not_allowlisted",
      missingCapability: `provider "${embed.provider}" is not on the embeddable-provider allowlist (${[...allowlist].sort().join(", ")})`,
    };
  }
  const aspect = embedAspectRatio(embed.boundingBoxes);
  const title = embedTitle(embed);
  const data: Record<string, unknown> = {
    provider: embed.provider,
    src: embed.src,
    ...(title ? { title } : {}),
    ...(aspect !== null ? { aspect } : {}),
  };
  return {
    kind: "candidate",
    candidate: {
      candidateId: `candidate_${hash(`${embed.id}:${EMBED_SECTION_TYPE}`)}`,
      sectionType: EMBED_SECTION_TYPE,
      data,
      section: { id: `s_${hash(embed.id, 10)}`, type: EMBED_SECTION_TYPE, data },
      confidence: 1,
      mappingReason: `captured ${embed.provider} embed (<${embed.tag}>) from the source page`,
      sourceBlockIds: [],
      screenshotRefs: [],
      assetBindings: [],
      provenance: { textFields: [], embedRef: embed.id },
    },
  };
}

function augmentPage(page: CaptureMapPage, rawPage: RawSnapshotPage, allowlist: Set<string>): CaptureMapPage {
  const embeds = readEmbeds(rawPage).slice().sort((left, right) => left.ordinal - right.ordinal);
  if (embeds.length === 0) return page;

  const survivorIds = new Set<string>();
  const resolvedInto = new Map<string, string>();
  for (const entry of page.blockAccounting ?? []) {
    if (NON_SURVIVOR_STATUSES.has(entry.status)) {
      if (typeof entry.resolvedInto === "string") resolvedInto.set(entry.blockRef, entry.resolvedInto);
      continue;
    }
    survivorIds.add(entry.blockRef);
  }

  const sectionsByBlock = new Map<string, Array<{ id: string; type: string; data: Record<string, unknown> }>>();
  for (const candidate of page.candidates ?? []) {
    const blockId = candidate.sourceBlockIds?.[0];
    if (!blockId) continue;
    sectionsByBlock.set(blockId, [...(sectionsByBlock.get(blockId) ?? []), candidate.section]);
  }

  const newCandidates: CaptureMapPage["candidates"] = [];
  const newGaps: CaptureMapGap[] = [];
  const embedSectionsByBlock = new Map<string, Array<{ id: string; type: string; data: Record<string, unknown> }>>();
  const trailingEmbedSections: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];

  for (const embed of embeds) {
    const resolvedBlockId = resolveEmbedBlockId(embed.containingBlockId, resolvedInto, survivorIds);
    const verdict = classifyEmbed(embed, allowlist);
    if (verdict.kind === "gap") {
      newGaps.push({
        gapId: `gap_${hash(`${embed.id}:${verdict.why}`)}`,
        blockRef: resolvedBlockId,
        screenshotRef: null,
        why: verdict.why,
        nearestType: EMBED_SECTION_TYPE,
        missingCapability: verdict.missingCapability,
        embedRef: embed.id,
        embedProvider: embed.provider,
        embedSrc: embed.src ?? embed.rawSrc ?? null,
        notCapturableReason: embed.notCapturableReason,
      });
      continue;
    }
    newCandidates.push(verdict.candidate);
    if (resolvedBlockId) {
      embedSectionsByBlock.set(resolvedBlockId, [...(embedSectionsByBlock.get(resolvedBlockId) ?? []), verdict.candidate.section]);
    } else {
      trailingEmbedSections.push(verdict.candidate.section);
    }
  }

  if (newCandidates.length === 0 && newGaps.length === 0) return page;

  const orderedBlockIds = readBlockIdsInOrder(rawPage).filter((id) => survivorIds.has(id));
  const sections: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];
  for (const blockId of orderedBlockIds) {
    sections.push(...(sectionsByBlock.get(blockId) ?? []));
    sections.push(...(embedSectionsByBlock.get(blockId) ?? []));
  }
  sections.push(...trailingEmbedSections);

  return {
    ...page,
    pageBody: { ...page.pageBody, sections },
    candidates: [...page.candidates, ...newCandidates],
    gaps: [...page.gaps, ...newGaps],
  };
}

/**
 * Augment a `mapSnapshot` result with `content_embed` candidates and gaps built from the same raw
 * `snapshot` that produced it. Pages the mapping doesn't recognize (no matching `pageId`), or with no
 * `embeds[]`, pass through unchanged. Callers thread this into the `mapping` a page-emission plan is
 * built from (`buildEmissionPlan`/`executeEmission`, ./engine/emit.mjs) so `content_embed` sections
 * are emitted through the governed object verbs exactly like any other section — no emit.mjs change
 * needed, because by the time emission sees the mapping the candidates are already ordinary section
 * entries in `pageBody.sections`.
 */
export function augmentMappingWithEmbeds(
  mapping: CaptureMapping,
  snapshot: unknown,
  options: { embedProviderAllowlist?: Iterable<string> } = {}
): CaptureMapping {
  const allowlist = new Set(
    options.embedProviderAllowlist
      ? [...options.embedProviderAllowlist].filter((provider) => (DEFAULT_EMBED_PROVIDER_ALLOWLIST as readonly string[]).includes(provider))
      : DEFAULT_EMBED_PROVIDER_ALLOWLIST
  );
  const rawPages = isRecord(snapshot) && Array.isArray((snapshot as RawSnapshot).pages) ? ((snapshot as RawSnapshot).pages as unknown[]) : [];
  const rawPageById = new Map<string, RawSnapshotPage>();
  for (const rawPage of rawPages) {
    if (isRecord(rawPage) && typeof rawPage.pageId === "string") rawPageById.set(rawPage.pageId, rawPage as RawSnapshotPage);
  }

  const pages = (mapping.pages ?? []).map((page) => {
    const rawPage = rawPageById.get(page.pageRef);
    return rawPage ? augmentPage(page, rawPage, allowlist) : page;
  });

  const allCandidates = pages.flatMap((page) => page.candidates ?? []);
  const allGaps = pages.flatMap((page) => page.gaps ?? []);
  const embedSections = allCandidates.filter((candidate) => candidate.sectionType === EMBED_SECTION_TYPE).length;

  return {
    ...mapping,
    pages,
    summary: {
      ...mapping.summary,
      sectionCandidates: allCandidates.length,
      gaps: allGaps.length,
      embedSections,
    },
  };
}
