// Framework-free theme model: the single source of truth for the semantic token palettes.
// The tests validate this table (WCAG 2.1 AA over declared pairs) and useTheme applies exactly
// this table as CSS custom properties + data-theme + colorScheme, so validated and rendered
// values can never drift. The :root block in styles.css keeps the light values only as a
// first-paint fallback. Curated presets only — no free-form theme builder.

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";
export type AccentPresetId = "indigo" | "teal" | "amber";
export type ThemePreference = { mode: ThemeMode; accent: AccentPresetId };

export const defaultPreference: ThemePreference = { mode: "system", accent: "indigo" };

export const accentPresets: ReadonlyArray<{ id: AccentPresetId; label: string }> = [
  { id: "indigo", label: "Indigo" },
  { id: "teal", label: "Teal" },
  { id: "amber", label: "Amber" }
];

export const themeTokenNames = [
  "--color-bg",
  "--color-text",
  "--color-text-muted",
  "--color-surface",
  "--color-surface-muted",
  "--color-border",
  "--color-border-muted",
  "--color-accent",
  "--color-accent-strong",
  "--color-accent-surface",
  "--color-accent-text",
  "--color-accent-muted",
  "--color-on-accent",
  "--color-success-surface",
  "--color-success-text",
  "--color-warning-surface",
  "--color-warning-text",
  "--color-danger-surface",
  "--color-danger-text",
  "--color-info-surface",
  "--color-info-text",
  "--color-code-surface",
  "--color-code-text",
  "--color-focus",
  "--color-shadow"
] as const;

export type ThemeTokenName = typeof themeTokenNames[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

type BasePalette = Omit<ThemeTokens, "--color-accent" | "--color-accent-strong" | "--color-accent-surface" | "--color-accent-text" | "--color-accent-muted" | "--color-on-accent" | "--color-info-surface" | "--color-info-text" | "--color-focus">;

const basePalettes: Record<ResolvedThemeMode, BasePalette> = {
  light: {
    "--color-bg": "#f6f7fb",
    "--color-text": "#172033",
    "--color-text-muted": "#526078",
    "--color-surface": "#ffffff",
    "--color-surface-muted": "#f8fafc",
    "--color-border": "#e4e8f0",
    "--color-border-muted": "#e2e8f0",
    "--color-success-surface": "#e8f8ef",
    "--color-success-text": "#16633a",
    "--color-warning-surface": "#fff6d8",
    "--color-warning-text": "#8b5d00",
    "--color-danger-surface": "#ffecec",
    "--color-danger-text": "#9f1d1d",
    "--color-code-surface": "#101828",
    "--color-code-text": "#e9eefc",
    "--color-shadow": "rgba(23, 32, 51, 0.06)"
  },
  dark: {
    "--color-bg": "#0e1420",
    "--color-text": "#e7ecf6",
    "--color-text-muted": "#a3b0c6",
    "--color-surface": "#161e2e",
    "--color-surface-muted": "#1c2537",
    "--color-border": "#2b374e",
    "--color-border-muted": "#253046",
    "--color-success-surface": "#143426",
    "--color-success-text": "#86d9ab",
    "--color-warning-surface": "#3a2d0d",
    "--color-warning-text": "#e5c465",
    "--color-danger-surface": "#44201f",
    "--color-danger-text": "#ff9e9e",
    "--color-code-surface": "#0b1220",
    "--color-code-text": "#dfe7fa",
    "--color-shadow": "rgba(0, 0, 0, 0.35)"
  }
};

type AccentPalette = { accent: string; strong: string; surface: string; text: string; onAccent: string; muted: string };

const accentPalettes: Record<AccentPresetId, Record<ResolvedThemeMode, AccentPalette>> = {
  indigo: {
    light: { accent: "#3157d5", strong: "#2546b6", surface: "#e8edff", text: "#2945a5", onAccent: "#ffffff", muted: "#aab4cc" },
    dark: { accent: "#93aaf8", strong: "#aabcfa", surface: "#22304f", text: "#b6c5fb", onAccent: "#0e1420", muted: "#55618a" }
  },
  teal: {
    light: { accent: "#0f766e", strong: "#115e59", surface: "#e0f5f2", text: "#0b5d55", onAccent: "#ffffff", muted: "#9fbdba" },
    dark: { accent: "#7cd4c8", strong: "#99e0d6", surface: "#123734", text: "#8fdcd2", onAccent: "#0e1420", muted: "#3f6a65" }
  },
  amber: {
    light: { accent: "#b45309", strong: "#92400e", surface: "#fff1e0", text: "#8a4700", onAccent: "#ffffff", muted: "#cbb193" },
    dark: { accent: "#e8bd6d", strong: "#f0cd8c", surface: "#3a2d0d", text: "#eac97e", onAccent: "#0e1420", muted: "#7a6a45" }
  }
};

export function resolveMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedThemeMode {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

// Swatch color for an accent preset preview. Sourced from the palette table so swatches can never
// drift from the tokens they represent.
export function accentSwatch(accent: AccentPresetId, mode: ResolvedThemeMode): string {
  return accentPalettes[accent][mode].accent;
}

export function buildThemeTokens(mode: ResolvedThemeMode, accent: AccentPresetId): ThemeTokens {
  const base = basePalettes[mode];
  const palette = accentPalettes[accent][mode];
  return {
    ...base,
    "--color-accent": palette.accent,
    "--color-accent-strong": palette.strong,
    "--color-accent-surface": palette.surface,
    "--color-accent-text": palette.text,
    "--color-accent-muted": palette.muted,
    "--color-on-accent": palette.onAccent,
    // The info family mirrors the accent family so presets restyle informational chrome as a set.
    "--color-info-surface": palette.surface,
    "--color-info-text": palette.text,
    "--color-focus": palette.accent
  };
}

// Declared text/surface pairs the theme system guarantees at WCAG 2.1 AA (>= 4.5:1). Contrast is
// validated at the token table level — once per theme, not per component.
export const contrastPairs: ReadonlyArray<{ fg: ThemeTokenName; bg: ThemeTokenName; min: number }> = [
  { fg: "--color-text", bg: "--color-bg", min: 4.5 },
  { fg: "--color-text", bg: "--color-surface", min: 4.5 },
  { fg: "--color-text", bg: "--color-surface-muted", min: 4.5 },
  { fg: "--color-text-muted", bg: "--color-bg", min: 4.5 },
  { fg: "--color-text-muted", bg: "--color-surface", min: 4.5 },
  { fg: "--color-text-muted", bg: "--color-surface-muted", min: 4.5 },
  { fg: "--color-on-accent", bg: "--color-accent", min: 4.5 },
  { fg: "--color-on-accent", bg: "--color-accent-strong", min: 4.5 },
  { fg: "--color-accent-text", bg: "--color-accent-surface", min: 4.5 },
  { fg: "--color-accent", bg: "--color-surface", min: 4.5 },
  { fg: "--color-success-text", bg: "--color-success-surface", min: 4.5 },
  { fg: "--color-warning-text", bg: "--color-warning-surface", min: 4.5 },
  { fg: "--color-danger-text", bg: "--color-danger-surface", min: 4.5 },
  { fg: "--color-info-text", bg: "--color-info-surface", min: 4.5 },
  { fg: "--color-code-text", bg: "--color-code-surface", min: 4.5 }
];

const channel = (value: number) => {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
};

const relativeLuminance = (hex: string): number => {
  const normalized = hex.replace("#", "");
  const expanded = normalized.length === 3 ? normalized.split("").map((c) => c + c).join("") : normalized;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export function contrastRatio(hexFg: string, hexBg: string): number {
  const lighter = Math.max(relativeLuminance(hexFg), relativeLuminance(hexBg));
  const darker = Math.min(relativeLuminance(hexFg), relativeLuminance(hexBg));
  return (lighter + 0.05) / (darker + 0.05);
}

export function validateThemeContrast(tokens: ThemeTokens): Array<{ fg: ThemeTokenName; bg: ThemeTokenName; ratio: number; min: number }> {
  return contrastPairs
    .map((pair) => ({ ...pair, ratio: contrastRatio(tokens[pair.fg], tokens[pair.bg]) }))
    .filter((pair) => pair.ratio < pair.min)
    .map(({ fg, bg, ratio, min }) => ({ fg, bg, ratio, min }));
}

export function parseThemePreference(raw: string | null): ThemePreference {
  if (!raw) return { ...defaultPreference };
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; accent?: unknown };
    const mode = parsed.mode === "light" || parsed.mode === "dark" || parsed.mode === "system" ? parsed.mode : defaultPreference.mode;
    const accent = parsed.accent === "indigo" || parsed.accent === "teal" || parsed.accent === "amber" ? parsed.accent : defaultPreference.accent;
    return { mode, accent };
  } catch {
    return { ...defaultPreference };
  }
}

export function serializeThemePreference(preference: ThemePreference): string {
  return JSON.stringify(preference);
}
