// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
// Deliberately loose: the .mjs source is the byte-faithful authority; these exist only so strict
// TypeScript callers can import it without allowJs.
export const SNAPSHOT_SCHEMA_VERSION: "snapshot.v1";

export type CaptureRights = {
  content: "prohibited" | "retain_allowed_origin_content";
  media: "prohibited" | "retain_referenced_allowed_origin_media";
};

export type ValidatedCapturePolicy = {
  maxPages: number;
  allowedCrawlOrigins: string[];
  allowedPathPrefixes: string[];
  sameOriginOnly: boolean;
  respectRobots: boolean;
  concurrency: number;
  delayMs: number;
  authenticatedAccess: "prohibited";
  rights: CaptureRights;
  designReferences: unknown[];
  fidelity: {
    mode: "source_faithful" | "design_inspired";
    sourceDesignTreatment: string;
    coverageRubricOverride?: { minimumMappedBlockCoverage: number; requireCompleteTokens: boolean; requireEnumeratedGaps: boolean };
  };
};

export function normalizeOrigin(value: string, name?: string): string;
export function parseCaptureRights(input: unknown): CaptureRights;
export function parseCoverageRubricOverride(input: unknown, name?: string): { minimumMappedBlockCoverage: number; requireCompleteTokens: boolean; requireEnumeratedGaps: boolean } | undefined;
export function parseCapturePolicy(input: unknown): ValidatedCapturePolicy;
export function readProjectCapturePolicy(result: unknown): Record<string, unknown> | null;
export function validateCapturePolicy(input: unknown): ValidatedCapturePolicy;
export function normalizeCrawlUrl(value: string): string | null;
export function isLikelyHtmlPage(value: string): boolean;
export function isUrlWithinPolicy(value: string, policy: { sameOriginOnly: boolean; allowedCrawlOrigins: string[]; allowedPathPrefixes: string[] }, seedOrigin: string): boolean;
export function stablePageId(value: string): string;
export function writeJson(filePath: string, value: unknown): Promise<void>;
export function redactSnapshot(snapshot: unknown): unknown;
