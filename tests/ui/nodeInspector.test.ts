// S4 node inspector model (CHANGE-PLAN R-11, read-only phase). The inspector's whole value is
// telling an operator something the canvas cannot — which tools actually resolve, that a skill
// silently appended to the prompt, that a blocker conflict exists, that the client contract is NOT
// live. Each of those is a logic decision, tested here rather than through the DOM.
import { describe, expect, it } from "vitest";
import {
  buildNodeToolRows,
  deniedRequestedTools,
  formatFetchedAt,
  groupToolRowsByCategory,
  identityLayer,
  isInspectorTab,
  nodeWarnings,
  projectConnectionBadge,
  promptComposition,
  resolverDisagreements,
  runControlsEnabled,
  summarizeSkillPolicy,
  summarizeToolRows,
  type EffectiveTool
} from "../../ui/src/nodeInspector.js";
import type { ProjectSummary, SkillResolvedPolicy, WorkspaceNode } from "../../ui/src/types/workspace.js";

const effectiveTool = (toolId: string, allowed: boolean, denialReasons: string[] = [], category = "stage"): EffectiveTool =>
  ({ toolId, name: toolId, category, riskLevel: "read", allowed, denialReasons });

const node = (overrides: Partial<WorkspaceNode> = {}): WorkspaceNode =>
  ({ id: "trust_factual", name: "Trust Factual", prompt: "Objective: verify.", ...overrides }) as WorkspaceNode;

const project = (overrides: Partial<ProjectSummary["connection"]> = {}, rest: Partial<ProjectSummary> = {}): ProjectSummary =>
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
    connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN", ...overrides },
    ...rest
  }) as ProjectSummary;

describe("tool rows — own vs effective", () => {
  const tools = [
    effectiveTool("stage.get_output", true),
    effectiveTool("stage.save_output", false, ["approval_required"]),
    effectiveTool("project.call_tool", false, ["risk_level_exceeds_authorization"], "project"),
    effectiveTool("web.fetch", false, ["node_tool_not_allowed"], "web")
  ];

  it("marks which tools the node itself requests and which the resolver allows", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["stage.get_output", "stage.save_output", "project.call_tool"] }), tools);
    const byId = Object.fromEntries(rows.map((row) => [row.toolId, row]));

    expect(byId["stage.get_output"]).toMatchObject({ own: true, state: "allowed", denialReasons: [] });
    expect(byId["stage.save_output"]).toMatchObject({ own: true, state: "denied", denialReasons: ["approval_required"] });
    expect(byId["project.call_tool"]).toMatchObject({ own: true, state: "denied", denialReasons: ["risk_level_exceeds_authorization"] });
    expect(byId["web.fetch"]).toMatchObject({ own: false, state: "denied", denialReasons: ["node_tool_not_allowed"] });
  });

  it("keeps a requested tool the registry does not know about instead of dropping it", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["ghost.tool"] }), tools);
    const ghost = rows.find((row) => row.toolId === "ghost.tool");

    expect(ghost).toMatchObject({ own: true, state: "not_requested", denialReasons: ["tool_not_in_registry"] });
  });

  it("surfaces requested-but-denied tools as the rows that matter", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["stage.get_output", "project.call_tool"] }), tools);

    expect(deniedRequestedTools(rows).map((row) => row.toolId)).toEqual(["project.call_tool"]);
  });

  it("counts own, allowed, and denied-but-requested separately", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["stage.get_output", "stage.save_output"] }), tools);

    expect(summarizeToolRows(rows)).toEqual({ own: 2, allowed: 1, denied: 1 });
  });

  it("groups by category with categories and names sorted", () => {
    const groups = groupToolRowsByCategory(buildNodeToolRows(node({ allowedTools: [] }), tools));

    expect(groups.map((group) => group.category)).toEqual(["project", "stage", "web"]);
    expect(groups[1].rows.map((row) => row.toolId)).toEqual(["stage.get_output", "stage.save_output"]);
  });
});

describe("prompt composition", () => {
  it("reveals that a skill appended instructions to the prompt", () => {
    const composition = promptComposition(
      { prompt: "Objective: verify.\n\nSkill: cite sources.", nodePrompt: "Objective: verify.", skillInstructions: "Skill: cite sources." },
      node()
    );

    expect(composition.injectedFromSkills).toBe(true);
    expect(composition.skillInstructions).toBe("Skill: cite sources.");
    expect(composition.unexplainedDrift).toBe(false);
  });

  it("does not claim injection when no skill contributed", () => {
    const composition = promptComposition({ prompt: "Objective: verify.", nodePrompt: "Objective: verify.", skillInstructions: "" }, node());

    expect(composition.injectedFromSkills).toBe(false);
    expect(composition.unexplainedDrift).toBe(false);
  });

  it("flags an effective prompt that differs with no skill to explain it", () => {
    const composition = promptComposition({ prompt: "Something else entirely.", nodePrompt: "Objective: verify.", skillInstructions: "" }, node());

    expect(composition.unexplainedDrift).toBe(true);
  });

  it("falls back to the stored prompt before the effective prompt has loaded", () => {
    expect(promptComposition(null, node()).effectivePrompt).toBe("Objective: verify.");
  });
});

describe("skill policy", () => {
  const policy = (overrides: Partial<SkillResolvedPolicy> = {}): SkillResolvedPolicy =>
    ({ nodeId: "trust_factual", skillIds: ["article_body"], instructions: "", effectiveTools: [], requestedTools: [], deniedTools: [], conflicts: [], ...overrides }) as SkillResolvedPolicy;

  it("sorts blockers ahead of warnings and counts each", () => {
    const summary = summarizeSkillPolicy(policy({
      conflicts: [
        { severity: "warning", source: "schema", message: "advisory" },
        { severity: "blocker", source: "output_schema", message: "incompatible" }
      ]
    }));

    expect(summary.conflicts.map((conflict) => conflict.severity)).toEqual(["blocker", "warning"]);
    expect(summary).toMatchObject({ hasBlocker: true, blockerCount: 1, warningCount: 1 });
  });

  it("reports no blocker for a clean policy", () => {
    expect(summarizeSkillPolicy(policy()).hasBlocker).toBe(false);
  });

  it("tolerates a policy that has not loaded", () => {
    expect(summarizeSkillPolicy(null)).toMatchObject({ skillIds: [], conflicts: [], hasBlocker: false });
  });

  // R-5: the two resolvers disagree on some nodes. The inspector renders the disagreement rather
  // than silently picking whichever answer it fetched last.
  it("reports tools the skill policy calls effective that the tool resolver does not allow", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["project.call_tool"] }), [effectiveTool("project.call_tool", false, ["risk_level_exceeds_authorization"])]);

    expect(resolverDisagreements(rows, policy({ effectiveTools: ["project.call_tool"] }))).toEqual(["project.call_tool"]);
  });

  it("reports no disagreement when both resolvers agree", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["stage.get_output"] }), [effectiveTool("stage.get_output", true)]);

    expect(resolverDisagreements(rows, policy({ effectiveTools: ["stage.get_output"] }))).toEqual([]);
  });
});

describe("node warnings", () => {
  it("flags dependsOn and requiredInputs disagreeing", () => {
    const warnings = nodeWarnings(node({ dependsOn: ["a"], requiredInputs: ["a", "b"] }), null, []);

    expect(warnings.map((warning) => warning.key)).toContain("dependency_mismatch");
  });

  it("stays quiet when dependsOn and requiredInputs match regardless of order", () => {
    const warnings = nodeWarnings(node({ dependsOn: ["b", "a"], requiredInputs: ["a", "b"] }), null, []);

    expect(warnings.map((warning) => warning.key)).not.toContain("dependency_mismatch");
  });

  it("flags the deprecated schema alias drifting from outputSchema", () => {
    const warnings = nodeWarnings(node({ schema: { type: "object" }, outputSchema: { type: "string" } }), null, []);

    expect(warnings.map((warning) => warning.key)).toContain("schema_alias_drift");
  });

  it("does not flag the alias when the two are identical", () => {
    const warnings = nodeWarnings(node({ schema: { type: "object" }, outputSchema: { type: "object" } }), null, []);

    expect(warnings.map((warning) => warning.key)).not.toContain("schema_alias_drift");
  });

  it("promotes a blocker skill conflict to a blocker warning", () => {
    const policy = { nodeId: "n", skillIds: [], instructions: "", effectiveTools: [], requestedTools: [], deniedTools: [], conflicts: [{ severity: "blocker" as const, source: "output_schema", message: "incompatible" }] } as SkillResolvedPolicy;
    const warnings = nodeWarnings(node({ dependsOn: [], requiredInputs: [] }), policy, []);

    expect(warnings).toContainEqual({ key: "skill_conflict:output_schema", severity: "blocker", message: "output_schema: incompatible" });
  });

  it("reports requested tools the resolver denied", () => {
    const rows = buildNodeToolRows(node({ allowedTools: ["project.call_tool"] }), [effectiveTool("project.call_tool", false, ["risk_level_exceeds_authorization"])]);
    const warnings = nodeWarnings(node({ dependsOn: [], requiredInputs: [] }), null, rows);

    expect(warnings.find((warning) => warning.key === "requested_tools_denied")?.message).toContain("project.call_tool");
  });
});

describe("identity layer", () => {
  it("is not live without a project", () => {
    const layer = identityLayer(null, { fetchedAt: null, error: null });

    expect(layer.state).toBe("no_project");
    expect(runControlsEnabled(layer)).toBe(false);
  });

  it("names the missing environment variables when the connection is unconfigured", () => {
    const layer = identityLayer(project({ endpointConfigured: false, tokenConfigured: false }), { fetchedAt: null, error: null });

    expect(layer.state).toBe("unconfigured");
    expect(layer).toMatchObject({ envVars: ["DR_LURIE_MCP_ENDPOINT", "DR_LURIE_MCP_TOKEN"] });
    expect(layer.message).toContain("DR_LURIE_MCP_ENDPOINT");
    expect(runControlsEnabled(layer)).toBe(false);
  });

  it("names only the variable that is actually missing", () => {
    const layer = identityLayer(project({ endpointConfigured: true, tokenConfigured: false }), { fetchedAt: null, error: null });

    expect(layer).toMatchObject({ state: "unconfigured", envVars: ["DR_LURIE_MCP_TOKEN"] });
  });

  // The load-bearing case: configured but never fetched must NOT read as live.
  it("reads as unreachable when configured but never fetched", () => {
    const layer = identityLayer(project(), { fetchedAt: null, error: null });

    expect(layer.state).toBe("unreachable");
    expect(layer.message).toContain("DR_LURIE_MCP_ENDPOINT");
    expect(runControlsEnabled(layer)).toBe(false);
  });

  it("carries the fetch error as detail when the fetch failed", () => {
    const layer = identityLayer(project(), { fetchedAt: null, error: "connection refused" });

    expect(layer).toMatchObject({ state: "unreachable", detail: "connection refused" });
  });

  it("is live only with a successful fetch, and always carries fetchedAt", () => {
    const layer = identityLayer(project(), { fetchedAt: "2026-07-26T17:00:00.000Z", error: null });

    expect(layer).toMatchObject({ state: "live", fetchedAt: "2026-07-26T17:00:00.000Z" });
    expect(runControlsEnabled(layer)).toBe(true);
  });

  it("says so when a layer was never fetched rather than rendering an empty timestamp", () => {
    expect(formatFetchedAt(null)).toBe("never fetched");
    expect(formatFetchedAt("2026-07-26T17:00:00.000Z")).toBe("fetched 2026-07-26T17:00:00.000Z");
  });
});

describe("project connection badge", () => {
  it("shows configured when both env vars are present", () => {
    expect(projectConnectionBadge(project())).toMatchObject({ tone: "ok", label: "configured" });
  });

  it("shows not configured and names what is missing", () => {
    const badge = projectConnectionBadge(project({ endpointConfigured: false }));

    expect(badge).toMatchObject({ tone: "warning", label: "not configured" });
    expect(badge?.title).toContain("DR_LURIE_MCP_ENDPOINT");
  });

  // A disabled project is not called regardless of how well configured it is.
  it("shows disabled ahead of connection state", () => {
    expect(projectConnectionBadge(project({}, { status: "disabled" }))).toMatchObject({ tone: "danger", label: "disabled" });
  });

  it("renders nothing without a project", () => {
    expect(projectConnectionBadge(null)).toBeNull();
  });
});

describe("tab identifiers", () => {
  it("accepts the five read-only tabs and rejects anything else", () => {
    expect(["prompt", "tools", "skills", "overview", "schemas"].every(isInspectorTab)).toBe(true);
    expect(isInspectorTab("model")).toBe(false);
    expect(isInspectorTab(undefined)).toBe(false);
  });
});
