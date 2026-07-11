import { describe, expect, it } from "vitest";
import {
  accentPresets,
  buildThemeTokens,
  contrastRatio,
  defaultPreference,
  parseThemePreference,
  resolveMode,
  serializeThemePreference,
  themeTokenNames,
  validateThemeContrast
} from "../../ui/src/theme.js";

const modes = ["light", "dark"] as const;

describe("theme token tables", () => {
  it("defines every token in every mode x preset table", () => {
    for (const mode of modes) {
      for (const preset of accentPresets) {
        const tokens = buildThemeTokens(mode, preset.id);
        for (const name of themeTokenNames) {
          expect(tokens[name], `${mode}/${preset.id} ${name}`).toBeTruthy();
        }
      }
    }
  });

  it("passes WCAG 2.1 AA for every declared contrast pair in all six tables", () => {
    for (const mode of modes) {
      for (const preset of accentPresets) {
        const failures = validateThemeContrast(buildThemeTokens(mode, preset.id));
        expect(failures, `${mode}/${preset.id}: ${JSON.stringify(failures)}`).toEqual([]);
      }
    }
  });

  it("is deterministic", () => {
    expect(buildThemeTokens("dark", "teal")).toEqual(buildThemeTokens("dark", "teal"));
  });
});

describe("contrastRatio", () => {
  it("computes the WCAG extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 0);
  });
});

describe("resolveMode", () => {
  it("lets an explicit choice win over the system preference", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });
});

describe("theme preference persistence", () => {
  it("round-trips", () => {
    const preference = { mode: "dark" as const, accent: "teal" as const };
    expect(parseThemePreference(serializeThemePreference(preference))).toEqual(preference);
  });

  it("falls back to defaults on garbage, partial, or missing values", () => {
    expect(parseThemePreference(null)).toEqual(defaultPreference);
    expect(parseThemePreference("not json")).toEqual(defaultPreference);
    expect(parseThemePreference(JSON.stringify({ mode: "neon", accent: "octarine" }))).toEqual(defaultPreference);
    expect(parseThemePreference(JSON.stringify({ mode: "dark" }))).toEqual({ mode: "dark", accent: "indigo" });
  });
});
