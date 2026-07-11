import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSettings } from "../src/components/AppearanceSettings";
import { useTheme } from "../src/hooks/useTheme";
import { matchMediaState } from "./setup";

const THEME_KEY = "cms-agent.theme";

// Same wiring App uses: useTheme owns preference + application, AppearanceSettings is the
// prop-driven control surface.
function Harness() {
  const theme = useTheme();
  return <AppearanceSettings
    preference={theme.preference}
    resolvedMode={theme.resolvedMode}
    onModeChange={theme.setMode}
    onAccentChange={theme.setAccent}
  />;
}

describe("theme system", () => {
  it("switching to dark applies data-theme + colorScheme, persists, and rehydrates on remount", async () => {
    const user = userEvent.setup();
    const first = render(<Harness />);

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    const root = document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(JSON.parse(localStorage.getItem(THEME_KEY) ?? "{}")).toMatchObject({ mode: "dark" });

    // Reset the applied DOM state, keep localStorage: a fresh mount must restore dark itself.
    first.unmount();
    root.removeAttribute("data-theme");
    root.removeAttribute("style");
    render(<Harness />);
    expect(root.dataset.theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  it("system mode follows the OS color scheme, and an explicit choice stops following it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const root = document.documentElement;

    // Default preference is system; the stubbed media query starts light.
    expect(root.dataset.theme).toBe("light");

    act(() => {
      matchMediaState.matches = true;
      matchMediaState.dispatch();
    });
    expect(root.dataset.theme).toBe("dark");

    // Explicit light wins even while the system prefers dark.
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("choosing an accent preset updates the accent token and persists the preset", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const root = document.documentElement;

    const indigoAccent = root.style.getPropertyValue("--color-accent");
    await user.click(screen.getByRole("button", { name: "Teal" }));

    const tealAccent = root.style.getPropertyValue("--color-accent");
    expect(tealAccent).not.toBe(indigoAccent);
    expect(tealAccent).toBe("#0f766e");
    expect(screen.getByRole("button", { name: "Teal" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem(THEME_KEY) ?? "{}")).toMatchObject({ accent: "teal" });
  });
});
