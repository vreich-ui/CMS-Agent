// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export const CAPTURE_MAP_SCHEMA_VERSION: "capture-map.v1";
export const DEFAULT_CONFIDENCE_THRESHOLD: number;
export const CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS: Record<string, Set<string> | "any">;

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
  candidates: Array<{ candidateId: string; sectionType: string; data: Record<string, unknown>; section: { id: string; type: string; data: Record<string, unknown> }; confidence: number; mappingReason: string; sourceBlockIds: string[]; screenshotRefs: string[]; assetBindings: Array<Record<string, unknown>>; provenance: { textFields: Array<{ path: string; source: string; sourceBlockRefs: string[] }> } }>;
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
  summary: { pages: number; sectionCandidates: number; navigationCandidates: number; gaps: number; sourceBlocks: number; accountedBlocks: number };
};

export type CaptureMapAssistanceSuggestion = { blockRef: string; sectionType: string; [key: string]: unknown };

export function mapSnapshot(snapshot: unknown, options?: { assistance?: { suggestions?: CaptureMapAssistanceSuggestion[] }; threshold?: number }): CaptureMapping;
