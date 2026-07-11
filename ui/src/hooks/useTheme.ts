import { useCallback, useEffect, useState } from "react";
import { buildThemeTokens, parseThemePreference, resolveMode, serializeThemePreference, themeTokenNames, type AccentPresetId, type ThemeMode, type ThemePreference, type ResolvedThemeMode } from "../theme";
import { readStorage, writeStorage } from "../storage";

const THEME_KEY = "cms-agent.theme";

const applyTheme = (resolved: ResolvedThemeMode, accent: AccentPresetId) => {
  const tokens = buildThemeTokens(resolved, accent);
  const root = document.documentElement;
  for (const name of themeTokenNames) root.style.setProperty(name, tokens[name]);
  root.dataset.theme = resolved;
  // colorScheme makes native selects/inputs/scrollbars render correctly in dark mode.
  root.style.colorScheme = resolved;
};

const systemQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

// Theme preference is a UI preference (localStorage), never workspace state, and never travels
// through MCP. The applied tokens come from the same table the contrast tests validate.
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => parseThemePreference(readStorage(THEME_KEY)));
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => systemQuery().matches);

  useEffect(() => {
    if (preference.mode !== "system") return;
    const query = systemQuery();
    const onChange = (event: { matches: boolean }) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference.mode]);

  const resolvedMode = resolveMode(preference.mode, systemPrefersDark);

  useEffect(() => {
    applyTheme(resolvedMode, preference.accent);
  }, [resolvedMode, preference.accent]);

  const update = useCallback((next: ThemePreference) => {
    setPreference(next);
    writeStorage(THEME_KEY, serializeThemePreference(next));
  }, []);

  return {
    preference,
    resolvedMode,
    setMode: useCallback((mode: ThemeMode) => update({ ...preference, mode }), [preference, update]),
    setAccent: useCallback((accent: AccentPresetId) => update({ ...preference, accent }), [preference, update])
  };
}
