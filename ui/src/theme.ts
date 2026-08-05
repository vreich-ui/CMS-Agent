// Framework-free theme model: the single source of truth for the semantic token palettes.
// The tests validate this table (WCAG 2.1 AA over declared pairs) and useTheme applies exactly
// this table as CSS custom properties + data-theme + colorScheme, so validated and rendered
// values can never drift. The :root block in styles.css keeps the light values only as a
// first-paint fallback. Curated presets only — no free-form theme builder.
//
// S7 reskin: this is Wolf's own operator console (client-facing surfaces elsewhere in the app
// keep the client's own brand — untouched by this file), restyled in Anthropic's palette and type
// as a design language, never the identity: no wordmark, no logo, no lockup, anywhere. The base
// grays/darks are Anthropic's Dark (#141413) / Light (#faf9f5) / Mid Gray (#b0aea5) / Light Gray
// (#e8e6dc); the three accent presets are Anthropic's Orange (#d97757, primary), Blue (#6a9bcc,
// secondary) and Green (#788c5d, tertiary) — each shade re-derived (darkened for light-mode text
// use, lightened for dark-mode surfaces) so every table still clears WCAG AA; see
// validateThemeContrast below. Warning/danger have no counterpart in that seven-color palette —
// conventional amber/red carry meaning users rely on regardless of brand, so they're kept as
// distinct, muted, warm-toned functional colors rather than reusing Orange for both "accent" and
// "danger".

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";
export type AccentPresetId = "orange" | "blue" | "green";
export type ThemePreference = { mode: ThemeMode; accent: AccentPresetId };

export const defaultPreference: ThemePreference = { mode: "system", accent: "orange" };

export const accentPresets: ReadonlyArray<{ id: AccentPresetId; label: string }> = [
  { id: "orange", label: "Orange" },
  { id: "blue", label: "Blue" },
  { id: "green", label: "Green" }
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
    "--color-bg": "#faf9f5",
    "--color-text": "#141413",
    "--color-text-muted": "#6b685f",
    "--color-surface": "#ffffff",
    "--color-surface-muted": "#f2f0ea",
    "--color-border": "#e8e6dc",
    "--color-border-muted": "#efece3",
    "--color-success-surface": "#e7ede1",
    "--color-success-text": "#3f5c2c",
    "--color-warning-surface": "#f8ecd2",
    "--color-warning-text": "#7a5b12",
    "--color-danger-surface": "#f8e4df",
    "--color-danger-text": "#8a3b2c",
    "--color-code-surface": "#141413",
    "--color-code-text": "#faf9f5",
    "--color-shadow": "rgba(20, 20, 19, 0.08)"
  },
  dark: {
    "--color-bg": "#141413",
    "--color-text": "#e7e4db",
    "--color-text-muted": "#948f82",
    "--color-surface": "#201e1b",
    "--color-surface-muted": "#29271f",
    "--color-border": "#3a372e",
    "--color-border-muted": "#2c2a24",
    "--color-success-surface": "#233019",
    "--color-success-text": "#a8c090",
    "--color-warning-surface": "#3d2f14",
    "--color-warning-text": "#e8c674",
    "--color-danger-surface": "#3a231e",
    "--color-danger-text": "#e6a08f",
    "--color-code-surface": "#0b0b0a",
    "--color-code-text": "#eae7de",
    "--color-shadow": "rgba(0, 0, 0, 0.45)"
  }
};

type AccentPalette = { accent: string; strong: string; surface: string; text: string; onAccent: string; muted: string };

// Each preset is Anthropic's Orange/Blue/Green re-derived per mode: light mode darkens the raw hue
// enough to clear 4.5:1 as both a button fill (paired with a white on-accent) and as text on
// var(--color-surface); dark mode uses the hue closer to raw (mid-brightness hues already read
// well on a near-black surface) and flips on-accent to the dark base color. accent-surface/text
// are a separate, softer tint+ink pairing for badges/chips (mirrored onto --color-info-*).
const accentPalettes: Record<AccentPresetId, Record<ResolvedThemeMode, AccentPalette>> = {
  orange: {
    light: { accent: "#a75c43", strong: "#8e4e39", surface: "#faece7", text: "#9c563f", onAccent: "#ffffff", muted: "#ac8979" },
    dark: { accent: "#d97757", strong: "#e08f75", surface: "#3f2a22", text: "#dd8568", onAccent: "#141413", muted: "#b7836d" }
  },
  blue: {
    light: { accent: "#4e7397", strong: "#426280", surface: "#eaf1f8", text: "#4a6c8f", onAccent: "#ffffff", muted: "#84939f" },
    dark: { accent: "#6a9bcc", strong: "#85add5", surface: "#27323c", text: "#79a5d1", onAccent: "#141413", muted: "#7f95a7" }
  },
  green: {
    light: { accent: "#65764e", strong: "#566442", surface: "#ecefe8", text: "#60704a", onAccent: "#ffffff", muted: "#8e957e" },
    dark: { accent: "#7f9265", strong: "#97a682", surface: "#2a2e23", text: "#8c9d75", onAccent: "#141413", muted: "#8a9174" }
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
    const accent = parsed.accent === "orange" || parsed.accent === "blue" || parsed.accent === "green" ? parsed.accent : defaultPreference.accent;
    return { mode, accent };
  } catch {
    return { ...defaultPreference };
  }
}

export function serializeThemePreference(preference: ThemePreference): string {
  return JSON.stringify(preference);
}
