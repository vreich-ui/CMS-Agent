import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConstellationDesignMode } from "../src/components/constellation/ConstellationDesignMode";
import { ConstellationPage } from "../src/components/pages/ConstellationPage";
import type { useWorkspace } from "../src/hooks/useWorkspace";
import type { useWorkflowRun } from "../src/hooks/useWorkflowRun";
import type { McpClient } from "../src/mcp/client";
import type { WorkspaceNode } from "../src/types/workspace";

const node = (id: string, overrides: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id,
  name: id.replace(/_/g, " "),
  prompt: "hidden from canvas",
  kind: "agent",
  status: "active",
  riskLevel: "read",
  dependsOn: [],
  position: { x: 100, y: 100 },
  ...overrides
});

const structureClient = (relationships: unknown[] = []): McpClient => ({
  method: async () => { throw new Error("unused"); },
  call: async <T,>(name: string): Promise<T> => {
    if (name === "constellation.get_structure") return { agents: [], relationships, derivedExecutionEdges: [] } as T;
    throw new Error(`unexpected tool call: ${name}`);
  }
});

type Workspace = ReturnType<typeof useWorkspace>;

// ConstellationDesignMode consumes a narrow slice of useWorkspace; the fake covers that slice and
// fails loudly (via missing-field TypeErrors) if the component grows new dependencies untested.
const fakeWorkspace = (nodes: WorkspaceNode[], overrides: Partial<Workspace> = {}): Workspace => {
  const selectedId = (overrides.selectedId ?? null) as string | null;
  return {
    nodes,
    selectedId,
    selectedNode: nodes.find((candidate) => candidate.id === selectedId) ?? null,
    workspaceVersion: 3,
    setSelectedId: vi.fn(),
    loadWorkspace: vi.fn(async () => {}),
    updateGraph: vi.fn(async () => ({ nodes, workspaceVersion: 4 })),
    validateGraph: vi.fn(async () => ({ validation: { valid: true, issues: [] } })),
    ...overrides
  } as unknown as Workspace;
};

describe("ConstellationDesignMode", () => {
  it("renders layer toggles with honest unavailability and the text list view", async () => {
    const u = userEvent.setup();
    const nodes = [node("alpha"), node("beta", { dependsOn: ["alpha"], riskLevel: "publish" })];
    render(<ConstellationDesignMode client={structureClient()} workspace={fakeWorkspace(nodes)} onStatus={() => {}} onError={() => {}} />);

    const layers = screen.getByRole("group", { name: "Relationship layers" });
    expect(layers).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /execution/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /memory/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /evaluation/i })).toBeDisabled();

    await u.click(screen.getByText("Nodes and dependencies as text"));
    expect(screen.getByText(/beta — kind agent, status active, risk publish; depends on: alpha/)).toBeInTheDocument();
  });

  it("wires the rail's dependency editing to updateGraph patches", async () => {
    const u = userEvent.setup();
    const nodes = [node("alpha"), node("beta"), node("gamma", { dependsOn: ["alpha"] })];
    const workspace = fakeWorkspace(nodes, { selectedId: "gamma" });
    render(<ConstellationDesignMode client={structureClient()} workspace={workspace} onStatus={() => {}} onError={() => {}} />);

    // Remove the existing dependency.
    await u.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(workspace.updateGraph).toHaveBeenCalledWith(
      { dependencies: { gamma: [] } },
      expect.stringContaining("no longer depends on")
    ));

    // Add a new one through the labeled select — the keyboard path for drag-connect.
    await u.selectOptions(screen.getByLabelText("Add dependency"), "beta");
    await u.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(workspace.updateGraph).toHaveBeenCalledWith(
      { dependencies: { gamma: ["alpha", "beta"] } },
      expect.stringContaining("now depends on")
    ));
  });

  it("gates node deletion behind a typed confirmation", async () => {
    const u = userEvent.setup();
    const nodes = [node("alpha"), node("custom_x")];
    const workspace = fakeWorkspace(nodes, { selectedId: "custom_x" });
    render(<ConstellationDesignMode client={structureClient()} workspace={workspace} onStatus={() => {}} onError={() => {}} />);

    const deleteButton = screen.getByRole("button", { name: "Delete custom x" });
    expect(deleteButton).toBeDisabled();
    await u.type(screen.getByLabelText("Confirm node id"), "custom_x");
    expect(deleteButton).toBeEnabled();
    await u.click(deleteButton);
    await waitFor(() => expect(workspace.updateGraph).toHaveBeenCalledWith(
      { delete: ["custom_x"] },
      expect.stringContaining("Deleted custom_x")
    ));
  });

  it("shows the verbatim conflict banner and reloads on request", async () => {
    const u = userEvent.setup();
    const nodes = [node("alpha"), node("gamma", { dependsOn: ["alpha"] })];
    const workspace = fakeWorkspace(nodes, {
      selectedId: "gamma",
      updateGraph: vi.fn(async () => { throw new Error("workspace_version_conflict: expected 3, current 5"); })
    });
    render(<ConstellationDesignMode client={structureClient()} workspace={workspace} onStatus={() => {}} onError={() => {}} />);

    await u.click(screen.getByRole("button", { name: "Remove" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("workspace_version_conflict: expected 3, current 5");
    expect(banner).toHaveTextContent("Reload to get the latest state");

    await u.click(screen.getByRole("button", { name: "Reload workspace" }));
    await waitFor(() => expect(workspace.loadWorkspace).toHaveBeenCalled());
  });
});

describe("ConstellationPage (canvas default)", () => {
  it("renders the real mode strip with Design active and the S5/S6 deferrals honest", async () => {
    const workspace = fakeWorkspace([node("alpha")]);
    render(<ConstellationPage
      mode="operate"
      onNavigate={() => {}}
      selectedProjectId={null}
      client={structureClient()}
      workspace={workspace}
      workflowRun={{} as unknown as ReturnType<typeof useWorkflowRun>}
      refreshUsage={async () => {}}
      onStatus={() => {}}
      onError={() => {}}
    />);

    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Operate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "History" })).toBeDisabled();
    expect(screen.getByText("Operate mode arrives in S5 — showing Design.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Builder (legacy)" })).toHaveAttribute("href", "/constellation?legacy=builder");
    expect(await screen.findByRole("region", { name: "Design mode" })).toBeInTheDocument();
  });
});

