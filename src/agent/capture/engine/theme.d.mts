// Hand-written declarations for the vendored platform capture engine module (see ../provenance.ts).
export type ThemeExtraction = {
  body: {
    name: string;
    description: string;
    whenToUse: string;
    scope: string;
    tokens: Record<string, Record<string, unknown>>;
  };
  report: {
    swatches: Array<{ key: string; value: string; confidence: number; fallback: boolean }>;
    gaps: string[];
    axes: Record<string, { value: unknown; confidence: number; evidence: boolean }>;
    /** C3: bounded imagery observations — structural only, never an interpretation of content. */
    imagery: ThemeImageryObservations;
  };
};

/** C3 (BRIEF §3.1): what a snapshot can honestly say about a source's imagery, and nothing more. */
export type ThemeImageryObservations = {
  /** False for a source that showed no imagery at all — a fact about the source, not a failure. */
  observed: boolean;
  imageCount: number;
  pagesWithImages: number;
  backgroundImageBlocks: number;
  extensions: string[];
  /** Quantized W:H of the image-bearing blocks, most common first, at most four. */
  aspectRatios: string[];
  /** 'flat_vector' only when every observed asset is an SVG; null otherwise — never guessed. */
  medium: "flat_vector" | null;
};

export function extractTheme(snapshot: unknown, options?: { name?: string }): ThemeExtraction;
export function observeImagery(snapshot: unknown): ThemeImageryObservations;
export function renderThemeReport(extraction: ThemeExtraction): string;
