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
    if (name === "skill.list") return { skills: [{ skillId: "article_body", name: "Article body" }, { skillId: "seo_review", name: "SEO review" }] } as T;
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
    // Scoped to the row: the code now also appears in the denial glossary below the table.
    const row = screen.getByRole("row", { name: /project\.call_tool/ });
    expect(within(row).getByText("risk_level_exceeds_authorization")).toBeInTheDocument();
  });

  // The Why column used to print the bare enum, on the one screen whose entire purpose is explaining
  // why a tool did not resolve.
  it("translates the denial reason into plain language while keeping the raw code", async () => {
    const user = userEvent.setup();
    renderInspector();
    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Tools/ }));

    const row = screen.getByRole("row", { name: /project\.call_tool/ });
    // Visible in the row, not hidden behind a disclosure — for this tool it is the primary content.
    expect(within(row).getByText("Above the node's risk ceiling")).toBeInTheDocument();
    // And the code survives beside it, because the runbooks and the agents both use it.
    expect(within(row).getByText("risk_level_exceeds_authorization")).toBeInTheDocument();
  });

  it("offers the denial and risk vocabularies as collapsed disclosures under the table", async () => {
    const user = userEvent.setup();
    renderInspector();
    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Tools/ }));

    expect(screen.getByText("Why can a tool be denied?")).toBeInTheDocument();
    expect(screen.getByText("What do read, write, publish and admin mean?")).toBeInTheDocument();
  });

  it("explains the three resolution layers in readable text rather than only a tooltip", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());

    // The layer badges no longer rely on title= to carry their meaning.
    const layers = screen.getByRole("group", { name: "Resolution layers" });
    expect(layers.querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.getByText("What are the Method, Effective and Identity layers?")).toBeInTheDocument();
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

  // The write path exists now (R-4 landed), so the invariant is no longer "no save button" — it is
  // that a save is impossible until there is a change AND a reason.
  it("keeps the save disabled until there is something to save", async () => {
    renderInspector();

    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
    expect(screen.getByText("No pending changes.")).toBeInTheDocument();
  });

  it("offers both schemas as editable JSON, and keeps the deprecated alias derived", async () => {
    const user = userEvent.setup();
    renderInspector();
    await waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Schemas" }));

    expect(screen.getByRole("textbox", { name: "Input schema JSON" })).toHaveValue('{\n  "type": "object"\n}');
    expect(screen.getByRole("textbox", { name: "Output schema JSON" })).toBeInTheDocument();
    // The alias is written for you rather than edited, so it can never trail a stale copy.
    expect(screen.getByText(/Derived, not edited/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------- write path (R-11 phase 2)
describe("NodeInspector write path", () => {
  const renderWithSave = (overrides: Overrides = {}, extra: Partial<{ workspaceVersion: number; onSaved: () => void; onReloadWorkspace: () => void }> = {}) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const base = makeClient(overrides);
    const client: McpClient = {
      method: base.method,
      call: async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ name, args: args ?? {} });
        if (name === "workspace.update_node") {
          const override = overrides["workspace.update_node"];
          if (override) return override() as T;
          return { node, workspaceVersion: 85 } as T;
        }
        return base.call<T>(name, args);
      }
    };
    render(<NodeInspector node={node} client={client} project={project()} workspaceVersion={84} onClose={() => {}} {...extra} />);
    return calls;
  };

  const waitLoaded = () => waitFor(() => expect(screen.getByText(/An assigned skill appends/)).toBeInTheDocument());

  it("starts with nothing pending and the save disabled", async () => {
    renderWithSave();
    await waitLoaded();

    expect(screen.getByText("No pending changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  it("shows a field-level diff once the prompt is edited", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();

    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");

    const footer = screen.getByRole("group", { name: "Save changes" });
    expect(within(footer).getByText(/1 pending change/)).toBeInTheDocument();
    expect(within(footer).getByText("Prompt")).toBeInTheDocument();
    // The diff states the before and after, not just that something changed.
    expect(within(footer).getByText("30 characters")).toBeInTheDocument();
    expect(within(footer).getByText("37 characters")).toBeInTheDocument();
  });

  // The rule that keeps the ledger worth reading.
  it("refuses to save without a reason, and says why the reason exists", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");

    expect(screen.getByText(/reason of at least 8 characters is required/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  it("enables the save once a real reason is given", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");

    expect(screen.getByRole("button", { name: "Review and save" })).toBeEnabled();
  });

  // Nothing is written until the operator has confirmed the diff.
  it("writes nothing until the confirmation step is accepted", async () => {
    const user = userEvent.setup();
    const calls = renderWithSave();
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");
    await user.click(screen.getByRole("button", { name: "Review and save" }));

    expect(screen.getByText(/Apply these 1 change/)).toBeInTheDocument();
    expect(calls.some((call) => call.name === "workspace.update_node")).toBe(false);
  });

  it("sends a minimal version-guarded patch carrying the reason and ui source, and no actor", async () => {
    const user = userEvent.setup();
    const calls = renderWithSave();
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(screen.getByRole("button", { name: "Confirm save" }));

    const write = calls.find((call) => call.name === "workspace.update_node");
    expect(write).toBeDefined();
    expect(write!.args).toMatchObject({
      id: "trust_factual",
      expectedWorkspaceVersion: 84,
      source: "ui",
      reason: "tightening the blocker criteria"
    });
    // Only the edited field travels, and the actor is left to the server's verified identity.
    expect(Object.keys(write!.args.patch as object)).toEqual(["prompt"]);
    expect(write!.args).not.toHaveProperty("actor");
  });

  it("toggling a tool checkbox produces an allowedTools patch", async () => {
    const user = userEvent.setup();
    const calls = renderWithSave();
    await waitLoaded();
    await user.click(screen.getByRole("button", { name: /^Tools/ }));
    await user.click(screen.getByRole("checkbox", { name: "Grant stage.get_output" }));
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "dropping an ungrantable grant");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(screen.getByRole("button", { name: "Confirm save" }));

    const write = calls.find((call) => call.name === "workspace.update_node");
    expect(Object.keys(write!.args.patch as object)).toEqual(["allowedTools"]);
    expect((write!.args.patch as { allowedTools: string[] }).allowedTools).not.toContain("stage.get_output");
  });

  // R-4's whole purpose, seen from the UI: a conflict names the version someone else landed on and
  // offers an explicit reload instead of retrying behind the operator's back.
  it("reports a version conflict with the current version and an explicit reload", async () => {
    const user = userEvent.setup();
    const reloads: string[] = [];
    renderWithSave(
      {
        "workspace.update_node": () => {
          throw Object.assign(new Error("MCP tool returned an error."), {
            details: { error: { code: "version_conflict", message: "workspace_version_conflict: expected 84, current 85.", currentVersion: 85, currentRevisionId: "rev_9" } }
          });
        }
      },
      { onReloadWorkspace: () => { reloads.push("reload"); } }
    );
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(screen.getByRole("button", { name: "Confirm save" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("version_conflict")).toBeInTheDocument();
    expect(within(alert).getByText(/Current workspace version: v85 \(rev_9\)/)).toBeInTheDocument();
    expect(screen.getByText(/will not retry silently/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload workspace" }));
    expect(reloads).toEqual(["reload"]);
  });

  it("does not present an unclassifiable failure as a conflict", async () => {
    const user = userEvent.setup();
    renderWithSave({ "workspace.update_node": () => { throw new Error("network down"); } });
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(screen.getByRole("button", { name: "Confirm save" }));

    expect(await screen.findByText(/Nothing was written/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload workspace" })).not.toBeInTheDocument();
  });

  it("refetches the workspace after a successful save", async () => {
    const user = userEvent.setup();
    const saved: string[] = [];
    renderWithSave({}, { onSaved: () => { saved.push("saved"); } });
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(screen.getByRole("button", { name: "Confirm save" }));

    await waitFor(() => expect(saved).toEqual(["saved"]));
  });

  it("discards changes back to the stored node", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    expect(screen.getByText(/1 pending change/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(screen.getByText("No pending changes.")).toBeInTheDocument();
  });

  it("blocks saving when the workspace version is unknown, rather than writing unguarded", async () => {
    const user = userEvent.setup();
    render(<NodeInspector node={node} client={makeClient()} project={project()} onClose={() => {}} />);
    await waitLoaded();
    await user.type(screen.getByRole("textbox", { name: /Own prompt/ }), " Extra.");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "tightening the blocker criteria");

    expect(screen.getByText(/cannot be version-guarded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  // The schema editors go through the identical discipline as every other field: a diff, a reason, a
  // version guard — and a parse verdict while typing, since a dropped brace should not have to wait
  // for the save bar to be noticed.
  const editSchema = async (user: ReturnType<typeof userEvent.setup>, label: string, json: string) => {
    await user.click(screen.getByRole("button", { name: "Schemas" }));
    const field = screen.getByRole("textbox", { name: label });
    await user.clear(field);
    await user.type(field, json.replace(/[{[]/g, "$&$&"));  // userEvent treats { and [ as key descriptors
  };

  it("reports invalid schema JSON both inline and as a save blocker", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();
    await editSchema(user, "Input schema JSON", '{"type":');

    // Inline, next to the field the operator is typing in…
    const panel = screen.getByLabelText("Schemas");
    expect(within(panel).getByText(/Input schema is not valid JSON/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Input schema JSON" })).toHaveClass("node-inspector-textarea--invalid");
    // …and again in the save bar, which is what actually withholds the write.
    const footer = screen.getByRole("group", { name: "Save changes" });
    expect(within(footer).getByText(/Input schema is not valid JSON/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  it("refuses to treat a cleared schema as a deletion", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();
    await user.click(screen.getByRole("button", { name: "Schemas" }));
    await user.clear(screen.getByRole("textbox", { name: "Output schema JSON" }));

    const footer = screen.getByRole("group", { name: "Save changes" });
    expect(within(footer).getByText(/Output schema is empty/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review and save" })).toBeDisabled();
  });

  it("saves an edited output schema and the deprecated alias together", async () => {
    const user = userEvent.setup();
    const calls = renderWithSave();
    await waitLoaded();
    await editSchema(user, "Output schema JSON", '{"type":"object","required":["headline"]}');
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "requiring a headline on the output");
    await user.click(screen.getByRole("button", { name: "Review and save" }));
    await user.click(screen.getByRole("button", { name: "Confirm save" }));

    const write = calls.find((call) => call.name === "workspace.update_node");
    expect(write).toBeDefined();
    expect(write!.args).toMatchObject({ expectedWorkspaceVersion: 84, source: "ui", reason: "requiring a headline on the output" });
    expect(write!.args.patch).toEqual({
      outputSchema: { type: "object", required: ["headline"] },
      schema: { type: "object", required: ["headline"] }
    });
  });

  it("does not flag reformatting as a change", async () => {
    const user = userEvent.setup();
    renderWithSave();
    await waitLoaded();
    // Same schema the node already stores, just collapsed onto one line.
    await editSchema(user, "Input schema JSON", '{"type":"object"}');

    expect(screen.getByText("No pending changes.")).toBeInTheDocument();
  });
});
