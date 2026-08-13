// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export class FidelityError extends Error {}

export const DEFAULT_FIDELITY_LIMITS: Readonly<{ structuralCoverage: number; requireTokensComplete: boolean; requireGapsEnumerated: boolean; maxRounds: number }>;
export const MAX_FIDELITY_ROUNDS: number;
export const FIDELITY_SCHEMA_VERSION: "capture-fidelity-report.v1";
export const PALETTE_GAP_SCHEMA_VERSION: "capture-palette-gaps.v1";

export type FidelityReport = {
  schemaVersion: "capture-fidelity-report.v1";
  task: string;
  target: string;
  source: Record<string, unknown>;
  limits: Record<string, unknown>;
  pages: Array<{ pageRef: string; sourceUrl: string; structural: { sourceBlocks: number; mappedBlocks: number; mappedBlockCoverage: number; accountedBlocks: number; allGapsEnumerated: boolean; orderFidelity: number; expectedSectionIds: string[]; emittedSectionIds: string[] } }>;
  visual: { comparisons: Array<Record<string, unknown>>; aggregateScore: number | null; scoredCount: number; unavailableCount: number };
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
export function consolidatedGapReport(mapping: unknown): FidelityReport["gapReport"];
export function scoreCaptureFidelity(input: { snapshot: unknown; mapping: unknown; theme: unknown; target: string; projectPolicy?: unknown; previewManifest?: unknown; screenshotRoot?: string }): Promise<FidelityReport>;
export function runBoundedFidelityIterations(input: Record<string, unknown>): Promise<FidelityReport>;
