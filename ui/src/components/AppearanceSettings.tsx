import { accentPresets, accentSwatch, type AccentPresetId, type ResolvedThemeMode, type ThemeMode, type ThemePreference } from "../theme";

// Prop-driven (no hook import) so tests can render it with plain state. Mode and accent are the
// whole surface — curated presets only, no free-form color builder. Never color-only: every
// swatch carries its text label.
type Props = {
  preference: ThemePreference;
  resolvedMode: ResolvedThemeMode;
  onModeChange: (mode: ThemeMode) => void;
  onAccentChange: (accent: AccentPresetId) => void;
};

const modes: Array<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" }
];

export function AppearanceSettings({ preference, resolvedMode, onModeChange, onAccentChange }: Props) {
  return <section className="panel appearance-settings" aria-label="Appearance">
    <h2>Appearance</h2>
    <p className="muted">Theme preferences are stored in this browser only. All combinations pass WCAG AA contrast checks.</p>
    <fieldset className="mode-switch">
      <legend>Theme mode</legend>
      {modes.map((mode) => <label key={mode.id} className="mode-option">
        <input type="radio" name="theme-mode" value={mode.id} checked={preference.mode === mode.id} onChange={() => onModeChange(mode.id)} />
        <span>{mode.label}{mode.id === "system" ? ` (currently ${resolvedMode})` : ""}</span>
      </label>)}
    </fieldset>
    <fieldset className="accent-switch">
      <legend>Accent</legend>
      <div className="accent-options">
        {accentPresets.map((preset) => <button key={preset.id} type="button" className={`accent-option ${preference.accent === preset.id ? "selected" : ""}`} aria-pressed={preference.accent === preset.id} onClick={() => onAccentChange(preset.id)}>
          <span className={`accent-swatch accent-swatch-${preset.id}`} style={{ background: accentSwatch(preset.id, resolvedMode) }} aria-hidden="true" />
          {preset.label}
        </button>)}
      </div>
    </fieldset>
  </section>;
}
