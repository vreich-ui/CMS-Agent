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
  };
};

export function extractTheme(snapshot: unknown, options?: { name?: string }): ThemeExtraction;
export function renderThemeReport(extraction: ThemeExtraction): string;
