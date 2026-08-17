// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export const CAPTURE_MAP_SCHEMA_VERSION: "capture-map.v1";
export const DEFAULT_CONFIDENCE_THRESHOLD: number;
export const CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS: Record<string, Set<string> | "any">;

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
  blockRef: string;
  screenshotRef: string | null;
  why: string;
  nearestType: string;
  missingCapability: string;
};

export type CaptureMapPage = {
  pageRef: string;
  sourceUrl: string;
  pageBody: { route: string; pageType: string; title: string; seo: Record<string, unknown>; sections: Array<{ id: string; type: string; data: Record<string, unknown> }> };
  candidates: Array<{ candidateId: string; sectionType: string; data: Record<string, unknown>; section: { id: string; type: string; data: Record<string, unknown> }; confidence: number; mappingReason: string; sourceBlockIds: string[]; screenshotRefs: string[]; assetBindings: Array<Record<string, unknown>>; assetPlan?: CaptureAssetPlan; assetBindingStatus?: "pending" | "bound" | "quarantined"; provenance: { textFields: Array<{ path: string; source: string; sourceBlockRefs: string[] }>; assetFields?: Array<{ path: string; source: string; sourceBlockRefs: string[]; manifestRef: string }> } }>;
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
  summary: { pages: number; sectionCandidates: number; navigationCandidates: number; pendingAssetSections: number; gaps: number; sourceBlocks: number; accountedBlocks: number };
};

export type CaptureMapAssistanceSuggestion = { blockRef: string; sectionType: string; [key: string]: unknown };

export function mapSnapshot(snapshot: unknown, options?: { assistance?: { suggestions?: CaptureMapAssistanceSuggestion[] }; threshold?: number }): CaptureMapping;
