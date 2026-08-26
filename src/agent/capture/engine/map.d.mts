// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export const CAPTURE_MAP_SCHEMA_VERSION: "capture-map.v1";
export const DEFAULT_CONFIDENCE_THRESHOLD: number;
export const CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS: Record<string, Set<string> | "any">;
/**
 * Every section type the deterministic builder can actually BUILD — and therefore the only
 * vocabulary a block_classifier suggestion may draw from. Exported so the node prompt is generated
 * from it rather than restating it: the prompt listed seven types by hand while the builder grew to
 * fourteen, so the classifier spent T12.14 through T12.22 unable to offer any of the types added
 * after it was written.
 */
export const SUPPORTED_SECTION_TYPES: ReadonlySet<string>;

// ─── T12.14 asset-aware mapping ─────────────────────────────────────────────
export const CONTENT_SPLIT_MAX_IMAGES: number;
export const MEDIA_MAX_ITEMS: number;
export const BRAND_ROW_MIN_LOGOS: number;
export const BRAND_ROW_MAX_LOGOS: number;
export const MEDIA_RETENTION_RIGHT: "retain_referenced_allowed_origin_media";
export const SUBSTANTIVE_BODY_MIN_CHARS: number;
/** Mirrors the engine's artifact-trust regexes exactly — see map.mjs. */
export const MAJOR_KEY_ARTIFACT_REF_RE: RegExp;
export const FIRST_PARTY_ASSET_PATH_RE: RegExp;
export const ASSET_FIELD_BOUNDS: Record<string, { min: number; max: number }>;

export type CaptureAssetPlanTarget = "items" | "images" | "logos" | "portrait";
export type CaptureAssetPlan = {
  target: CaptureAssetPlanTarget;
  sectionType?: string;
  entries: Array<{ manifestRef: string; alt: string | null }>;
};
export type CaptureBoundAsset = { manifestRef: string; artifactRef: string; src: string; alt: string };

/**
 * THE HOTLINK GUARD: accepts ONLY a Major-Key artifact reference and returns its
 * served first-party path. Any URL, data: URI, or repo path returns null.
 */
export function firstPartyAssetPath(artifactRef: unknown): string | null;

export function bindSectionAssets(
  section: { id: string; type: string; data: Record<string, unknown> },
  assetPlan: CaptureAssetPlan | undefined,
  resolveArtifactRef: (manifestRef: string) => string | null | undefined
):
  | { section: { id: string; type: string; data: Record<string, unknown> }; bound: CaptureBoundAsset[]; overflow: CaptureBoundAsset[]; unresolved?: Array<{ manifestRef: string; reason: string }> }
  | { error: { code: string; detail: string; unresolved?: Array<{ manifestRef: string; reason: string }> } };

export function bindMappingAssets(
  mapping: CaptureMapping,
  resolveArtifactRef: (manifestRef: string) => string | null | undefined
): {
  mapping: CaptureMapping;
  bound: Array<{ pageRef: string; candidateId: string; sectionId: string; sectionType: string; target: string; manifestRefs: string[]; overflowManifestRefs?: string[] }>;
  quarantined: Array<{ pageRef: string; candidateId: string; sectionId: string; sectionType: string; target: string; code: string; detail: string }>;
};

export type CaptureMapGap = {
  gapId: string;
  // T15.21: an embed gap whose containing block did not survive reconciliation (or whose embed sat
  // outside every block to begin with) has no real block to name and reports blockRef as "" — kept
  // as `string`, not widened to `string | null`, so every existing blockRef-keyed lookup elsewhere
  // (Set<string>, Map<string, ...>) keeps typechecking unchanged; "" can never collide with a real
  // block id (pdf-tool mints those as non-empty `<pageId>_block_NNN`).
  blockRef: string;
  screenshotRef: string | null;
  why: string;
  nearestType: string;
  missingCapability: string;
  // T15.21 embed-gap enrichment (embeds.ts, not the vendored mapper) — present only on a gap that
  // came from an embed, so its src/provider/reason reach the report per ADR T15.4 without forcing
  // every non-embed gap to carry null placeholders for fields that never apply to it.
  embedRef?: string;
  embedProvider?: string;
  embedSrc?: string | null;
  notCapturableReason?: string | null;
};

export type CaptureMapPage = {
  pageRef: string;
  sourceUrl: string;
  pageBody: { route: string; pageType: string; title: string; seo: Record<string, unknown>; sections: Array<{ id: string; type: string; data: Record<string, unknown> }> };
  candidates: Array<{ candidateId: string; sectionType: string; data: Record<string, unknown>; section: { id: string; type: string; data: Record<string, unknown> }; confidence: number; mappingReason: string; sourceBlockIds: string[]; screenshotRefs: string[]; assetBindings: Array<Record<string, unknown>>; assetPlan?: CaptureAssetPlan; assetBindingStatus?: "pending" | "bound" | "quarantined"; provenance: { textFields: Array<{ path: string; source: string; sourceBlockRefs: string[] }>; assetFields?: Array<{ path: string; source: string; sourceBlockRefs: string[]; manifestRef: string }>; embedRef?: string } }>;
  gaps: CaptureMapGap[];
  blockAccounting: Array<{ blockRef: string; status: string; gapId?: string; candidateId?: string; reason?: string; resolvedInto?: string }>;
};

export type CaptureMapping = {
  schemaVersion: "capture-map.v1";
  snapshotSchemaVersion: string;
  generatedAt: string;
  source: { targetUrl: string; capturedAt: string; redacted: boolean };
  policy: Record<string, unknown>;
  pages: CaptureMapPage[];
  navigationCandidates: Array<{ candidateId: string; role: string; body: Record<string, unknown>; confidence: number; sourcePageRefs: string[]; provenance: unknown }>;
  // embedSections is optional here because the vendored mapSnapshot itself never sets it — only
  // embeds.ts's augmentMappingWithEmbeds (T15.21, deliberately NOT part of the vendored engine) does.
  summary: { pages: number; sectionCandidates: number; navigationCandidates: number; pendingAssetSections: number; gaps: number; sourceBlocks: number; accountedBlocks: number; embedSections?: number };
};

export type CaptureMapAssistanceSuggestion = { blockRef: string; sectionType: string; [key: string]: unknown };

export function mapSnapshot(snapshot: unknown, options?: { assistance?: { suggestions?: CaptureMapAssistanceSuggestion[] }; threshold?: number }): CaptureMapping;
