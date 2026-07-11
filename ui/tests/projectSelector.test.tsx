import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ProjectSelector } from "../src/components/ProjectSelector";
import { useProjects } from "../src/hooks/useProjects";
import { readStorage, writeStorage } from "../src/storage";
import type { McpClient } from "../src/mcp/client";
import type { ProjectSummary } from "../src/types/workspace";

const PROJECT_KEY = "cms-agent.projectId";

const registered = [
  { projectId: "dr-lurie", name: "Dr. Lurie CMS" }
] as unknown as ProjectSummary[];

// Stub MCP client: a plain object satisfying the {method, call} contract with fixture data.
const client: McpClient = {
  method: async () => { throw new Error("unused in this test"); },
  call: async <T,>(name: string): Promise<T> => {
    if (name === "project.list") return { projects: registered } as T;
    throw new Error(`unexpected tool call: ${name}`);
  }
};

// Mirrors App's wiring: useProjects for registered connections, selection state hydrated from and
// persisted to localStorage, run-derived ids passed alongside.
function Harness({ runProjectIds }: { runProjectIds: string[] }) {
  const projects = useProjects(client);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStorage(PROJECT_KEY) || null);
  const selectProject = (projectId: string | null) => {
    setSelectedProjectId(projectId);
    writeStorage(PROJECT_KEY, projectId);
  };
  return <ProjectSelector
    projects={projects.projects}
    runProjectIds={runProjectIds}
    selectedProjectId={selectedProjectId}
    onSelect={selectProject}
    error={projects.error}
    onRetry={() => void projects.refresh()}
  />;
}

describe("project selector", () => {
  it("is a labeled control offering All projects, registered, and seen-in-runs groups", async () => {
    render(<Harness runProjectIds={["project-a"]} />);

    const select = screen.getByLabelText("Project");
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "All projects" })).toBeInTheDocument();

    // Registered projects arrive async from the stubbed project.list.
    expect(await screen.findByRole("option", { name: "Dr. Lurie CMS" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Registered projects" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Seen in runs" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "project-a" })).toBeInTheDocument();
  });

  it("persists the selection to localStorage without touching the route, and rehydrates", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/runs");
    const first = render(<Harness runProjectIds={["project-a"]} />);

    await screen.findByRole("option", { name: "Dr. Lurie CMS" });
    await user.selectOptions(screen.getByLabelText("Project"), "project-a");

    expect(localStorage.getItem(PROJECT_KEY)).toBe("project-a");
    expect(window.location.pathname).toBe("/runs");

    // A fresh mount (new visit) restores the persisted selection.
    first.unmount();
    render(<Harness runProjectIds={["project-a"]} />);
    expect(screen.getByLabelText("Project")).toHaveValue("project-a");
  });

  it("surfaces a stale persisted selection as an explicit not-found option", async () => {
    localStorage.setItem(PROJECT_KEY, "ghost-project");
    render(<Harness runProjectIds={[]} />);

    await screen.findByRole("option", { name: "Dr. Lurie CMS" });
    const select = screen.getByLabelText("Project");
    expect(select).toHaveValue("ghost-project");
    expect(screen.getByRole("option", { name: "ghost-project (not found)" })).toBeInTheDocument();
  });
});
