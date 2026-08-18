// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export class FidelityError extends Error {}

export const DEFAULT_FIDELITY_LIMITS: Readonly<{ structuralCoverage: number; requireTokensComplete: boolean; requireGapsEnumerated: boolean; maxRounds: number }>;
export const MAX_FIDELITY_ROUNDS: number;
export const FIDELITY_SCHEMA_VERSION: "capture-fidelity-report.v1";
export const PALETTE_GAP_SCHEMA_VERSION: "capture-palette-gaps.v1";
/** T12.10 — reason -> defect code for an unavailable visual comparison. */
export const VISUAL_DEFECT_CODES: Readonly<Record<string, string>>;
/** T12.14 — the defect code for a planned asset section emission never mentioned. */
export const ASSET_DEFECT_CODE_UNEMITTED: "asset_section_absent_from_emission";

/**
 * T12.14 asset-binding evidence. `evidenceComplete` is null when no emission
 * report was supplied (binding not verified), never silently "clean".
 */
export type AssetBindingEvidence = {
  plannedSections: number;
  boundSections: number | null;
  defects: Array<{ code: string; severity: "defect"; pageRef: string; candidateId: string; sectionId: string | null; sectionType: string; target: string; plannedAssets: number; detail: string; gapId?: string }>;
  defectCount: number;
  evidenceComplete: boolean | null;
  reason?: string;
};

export type FidelityReport = {
  schemaVersion: "capture-fidelity-report.v1";
  task: string;
  target: string;
  source: Record<string, unknown>;
  limits: Record<string, unknown>;
  pages: Array<{ pageRef: string; sourceUrl: string; structural: { sourceBlocks: number; mappedBlocks: number; mappedBlockCoverage: number; accountedBlocks: number; allGapsEnumerated: boolean; orderFidelity: number; expectedSectionIds: string[]; emittedSectionIds: string[] } }>;
  /**
   * T12.10 evidence accounting (re-vendored 2026-08-18): every unavailable
   * comparison is an enumerated DEFECT, and a page with no scored comparison is
   * a defect in its own right. `rubric` is untouched — visual evidence explains,
   * it never authorizes.
   */
  visual: {
    comparisons: Array<Record<string, unknown>>;
    aggregateScore: number | null;
    scoredCount: number;
    unavailableCount: number;
    pagesWithoutScoredComparison: string[];
    defects: Array<{ code: string; severity: "defect"; pageRef: string; blockRef?: string; viewportId?: string; blockStatus?: string; gapId?: string; detail: string }>;
    defectCount: number;
    evidenceComplete: boolean;
  };
  /** Present only when the mapping planned at least one asset section (T12.14). */
  assets?: AssetBindingEvidence;
  rubric: {
    coverage: { score: number; mappedBlocks: number; relevantBlocks: number; minimum: number; met: boolean };
    tokensComplete: { value: boolean; required: boolean; met: boolean };
    gapsEnumerated: { value: boolean; required: boolean; met: boolean };
    verdict: "within_reasonable_limits" | "needs_governed_iteration";
  };
  iterations: unknown[];
  gapReport: { schemaVersion: "capture-palette-gaps.v1"; entries: Array<Record<string, unknown>>; byCapability: Array<{ missingCapability: string; count: number; gapIds: string[] }> };
  safety: Record<string, unknown>;
};

export function fidelityLimitsFromProject(result: unknown, target: string): Record<string, unknown>;
export function normalizedScreenshotDiff(sourcePath: string, previewPath: string): Promise<Record<string, unknown>>;
export function assetBindingEvidence(mapping: unknown, emissionReport?: unknown): AssetBindingEvidence | null;
export function consolidatedGapReport(mapping: unknown): FidelityReport["gapReport"];
export function scoreCaptureFidelity(input: { snapshot: unknown; mapping: unknown; theme: unknown; target: string; projectPolicy?: unknown; previewManifest?: unknown; emissionReport?: unknown; screenshotRoot?: string }): Promise<FidelityReport>;
export function runBoundedFidelityIterations(input: Record<string, unknown>): Promise<FidelityReport>;
