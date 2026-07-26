// S4 node inspector component (CHANGE-PLAN R-11, read-only phase). The model is tested by root
// vitest (tests/ui/nodeInspector.test.ts); this covers what only the DOM can answer: that the
// three layers are rendered as three, that a non-live client contract is stated rather than
// implied, that a failed read says "unknown" rather than showing an empty state that reads as
// clean, and that nothing here offers a write.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodeInspector } from "../src/components/NodeInspector";
import type { McpClient } from "../src/mcp/client";
import type { ProjectSummary, WorkspaceNode } from "../src/types/workspace";

const node = {
  id: "trust_factual",
  name: "Trust Factual",
  kind: "verification",
  prompt: "Objective: verify every claim.",
  riskLevel: "write",
  status: "active",
  allowedTools: ["stage.get_output", "project.call_tool"],
  assignedSkills: ["article_body"],
  dependsOn: ["research"],
  requiredInputs: ["research", "brief_architect"],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" }
} as unknown as WorkspaceNode;

const project = (overrides: Partial<ProjectSummary["connection"]> = {}): ProjectSummary =>
  ({
    projectId: "dr-lurie",
    name: "Dr. Lurie",
    authMode: "bearer_env",
    allowedTools: [],
    defaultToolPolicy: "blocked",
    toolPolicies: {},
    contentContract: { contentContract: "article_body.v1", canonicalArticleBody: "article_body.v1" },
    publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "" },
    status: "active",
    connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN", ...overrides }
  }) as ProjectSummary;

type Overrides = Partial<Record<string, () => unknown>>;

// Tool-name-keyed stub, matching the convention in the rest of ui/tests: no mocking library, and
// an unexpected call is a loud failure rather than an undefined.
const makeClient = (overrides: Overrides = {}): McpClient => ({
  method: async () => { throw new Error("unused"); },
  call: async <T,>(name: string): Promise<T> => {
    const override = overrides[name];
    if (override) return override() as T;
    if (name === "node.get_effective_prompt") {
      return { prompt: "Objective: verify every claim.\n\nCite a primary source.", nodePrompt: "Objective: verify every claim.", skillInstructions: "Cite a primary source." } as T;
    }
    if (name === "node.get_effective_tools") {
      return { tools: [
        { toolId: "stage.get_output", name: "stage.get_output", category: "stage", riskLevel: "read", allowed: true, denialReasons: [] },
        { toolId: "project.call_tool", name: "project.call_tool", category: "project", riskLevel: "write", allowed: false, denialReasons: ["risk_level_exceeds_authorization"] }
      ] } as T;
    }
    if (name === "node.get_effective_skills") {
      return { policy: { nodeId: "trust_factual", skillIds: ["article_body"], instructions: "Cite a primary source.", effectiveTools: ["stage.get_output"], requestedTools: ["stage.get_output"], deniedTools: [], conflicts: [{ severity: "blocker", source: "output_schema", message: "skill outputSchema is not compatible" }] } } as T;
    }
    if (name === "project.test_connection") return { connected: false, error: "DR_LURIE_MCP_ENDPOINT is not reachable" } as T;
    throw new Error(`unexpected tool call: ${name}`);
  }
});

const renderInspector = (client: McpClient = makeClient(), projectSummary: ProjectSummary | null = project()) =>
  render(<NodeInspector node={node} client={client} project={projectSummary} onClose={() => {}} />);

describe("NodeInspector", () => {
  it("names all three layers so a value is never ambiguous between stored and resolved", async () => {
    renderInspector();
    const layers = screen.getByRole("group", { name: "Resolution layers" });

    expect(within(layers).getByText(/Method · stored/)).toBeInTheDocument();
    await waitFor(() => expect(within(layers).getByText(/Effective · fetched/)).toBeInTheDocument());
    expect(within(layers).getByText(/Identity · unreachable/)).toBeInTheDocument();
  });

  it("says out loud that a skill appends to the prompt, and shows both halves", async () => {
    renderInspector();

    await waitFor(() => expect(screen.getByText(/An assigned skill appends instructions to this prompt/)).toBeInTheDocument());
    expect(screen.getByText("Objective: verify every claim.")).toBeInTheDocument();
    expect(screen.getAllByText("Cite a primary source.").length).toBeGreaterThan(0);
  });

  it("renders own vs effective tools with the resolver's denial reason", async () => {
    const user = userEvent.setup();
    renderInspector();

    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Tools/ }));

    expect(screen.getByText("project.call_tool")).toBeInTheDocument();
    expect(screen.getByText("risk_level_exceeds_authorization")).toBeInTheDocument();
  });

  it("surfaces a blocker skill conflict instead of leaving it invisible", async () => {
    const user = userEvent.setup();
    renderInspector();

    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Skills/ }));

    expect(screen.getByText("skill outputSchema is not compatible")).toBeInTheDocument();
    expect(screen.getByText("output_schema")).toBeInTheDocument();
  });

  it("reports dependsOn and requiredInputs disagreeing on the Overview tab", async () => {
    const user = userEvent.setup();
    renderInspector();

    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Overview" }));

    expect(screen.getByText(/dependsOn \[research\] and requiredInputs \[brief_architect, research\] disagree/)).toBeInTheDocument();
  });

  // The load-bearing behaviour: an unreachable client contract must be stated, with the env var,
  // and must disable run controls rather than quietly rendering as if it were live.
  it("states that the client contract is unreachable, names the env var, and disables run controls", async () => {
    const user = userEvent.setup();
    renderInspector();

    await waitFor(() => expect(screen.getByText(/Client contract unreachable \(DR_LURIE_MCP_ENDPOINT, DR_LURIE_MCP_TOKEN\)/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Overview" }));

    expect(screen.getByText(/Disabled — the client contract is not live/)).toBeInTheDocument();
  });

  it("names the missing environment variable when the connection was never configured", async () => {
    renderInspector(makeClient(), project({ endpointConfigured: false, tokenConfigured: false }));

    await waitFor(() => expect(screen.getByText(/DR_LURIE_MCP_ENDPOINT and DR_LURIE_MCP_TOKEN are not configured/)).toBeInTheDocument());
  });

  // A failed read must not render as an empty, clean-looking panel.
  it("reports unknown rather than clean when the skill policy fails to load", async () => {
    const user = userEvent.setup();
    const client = makeClient({ "node.get_effective_skills": () => { throw new Error("resolver unavailable"); } });
    render(<NodeInspector node={node} client={client} project={project()} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Skill policy unavailable: resolver unavailable/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Skills/ }));

    expect(screen.getByText(/could not be resolved, so conflicts are unknown — not clean/)).toBeInTheDocument();
  });

  it("still renders the tools tab when only the prompt read failed", async () => {
    const user = userEvent.setup();
    const client = makeClient({ "node.get_effective_prompt": () => { throw new Error("prompt resolver down"); } });
    render(<NodeInspector node={node} client={client} project={project()} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Effective prompt unavailable/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Tools/ }));

    expect(screen.getByText("stage.get_output")).toBeInTheDocument();
  });

  // Read-only phase: the write path ships only after R-4. No save affordance may exist to be
  // mistaken for one.
  it("offers no save or edit control anywhere in the inspector", async () => {
    renderInspector();

    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    const labels = screen.getAllByRole("button").map((button) => button.textContent ?? "");

    expect(labels.some((label) => /save|apply|update|edit|delete/i.test(label))).toBe(false);
  });
});
