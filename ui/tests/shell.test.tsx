import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { AppHeader } from "../src/components/AppHeader";
import { useRoute } from "../src/hooks/useRoute";
import type { McpConnection } from "../src/connection";

// Harness-level shell test: App itself is not mountable in jsdom (its data hooks fire real
// fetches on mount), so this composes the same routing pieces App uses — useRoute + AppHeader +
// a route-switched main — and exercises the navigation contract.
const connection: McpConnection = { mode: "direct", endpoint: "http://localhost/mcp", token: "test-token" };

function Shell() {
  const { route, navigate } = useRoute();
  return <div className="app-shell">
    <AppHeader
      route={route}
      onNavigate={navigate}
      projects={null}
      projectsError={null}
      onRetryProjects={() => {}}
      runProjectIds={[]}
      selectedProjectId={null}
      onSelectProject={() => {}}
      connection={connection}
    />
    <main className="app-main">
      <h1>{route.page}</h1>
      {route.page === "constellation" && <span>legacy panel: {route.legacy ?? "builder"}</span>}
    </main>
  </div>;
}

describe("app shell routing", () => {
  it("renders a cold deep link with landmarks and aria-current, without rewriting the URL", () => {
    window.history.replaceState(null, "", "/constellation?legacy=nodes");
    render(<Shell />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Constellation" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("legacy panel: nodes")).toBeInTheDocument();

    // Parse-only at mount: the URL (including query) must survive untouched.
    expect(window.location.pathname + window.location.search).toBe("/constellation?legacy=nodes");
  });

  it("navigates on left click, updating the URL and aria-current", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/overview");
    render(<Shell />);

    await user.click(screen.getByRole("link", { name: "Runs" }));

    expect(window.location.pathname).toBe("/runs");
    expect(screen.getByRole("heading", { name: "runs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("follows history back via popstate", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/overview");
    render(<Shell />);

    await user.click(screen.getByRole("link", { name: "Changes" }));
    expect(window.location.pathname).toBe("/changes");

    // Simulate the browser's back button: restore the previous URL, then announce it.
    act(() => {
      window.history.replaceState(null, "", "/overview");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("pushes exactly one history entry per navigation under StrictMode", async () => {
    // Regression: pushState used to live inside the setRoute updater, which StrictMode invokes
    // twice — every click pushed a duplicate entry and the back button appeared to do nothing.
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/overview");
    render(<StrictMode><Shell /></StrictMode>);

    const before = window.history.length;
    await user.click(screen.getByRole("link", { name: "Runs" }));

    expect(window.location.pathname).toBe("/runs");
    expect(window.history.length).toBe(before + 1);
  });

  it("renders every nav item as a real anchor with an href", () => {
    render(<Shell />);
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview");
    expect(screen.getByRole("link", { name: "Constellation" })).toHaveAttribute("href", "/constellation");
    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("href", "/runs");
    expect(screen.getByRole("link", { name: "Changes" })).toHaveAttribute("href", "/changes");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });
});
