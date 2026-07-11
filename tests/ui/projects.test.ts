import { describe, expect, it } from "vitest";
import { buildProjectOptions, distinctRunProjectIds } from "../../ui/src/projects.js";
import type { ProjectSummary, WorkflowExecutionRecord } from "../../ui/src/types/workspace.js";

const project = (projectId: string, name: string): ProjectSummary => ({
  projectId,
  name,
  authMode: "bearer_env",
  allowedTools: [],
  contentContract: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "" },
  status: "active",
  connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "X" }
});

const run = (projectId: string): WorkflowExecutionRecord => ({
  runId: `run_${projectId}`,
  workflowId: "wf",
  projectId,
  status: "completed",
  startedAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
  nodes: [],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true
});

describe("distinctRunProjectIds", () => {
  it("dedupes and sorts", () => {
    expect(distinctRunProjectIds([run("beta"), run("alpha"), run("beta")])).toEqual(["alpha", "beta"]);
    expect(distinctRunProjectIds([])).toEqual([]);
  });
});

describe("buildProjectOptions", () => {
  it("separates registered projects from ids only seen in runs", () => {
    const groups = buildProjectOptions([project("dr-lurie", "Dr. Lurie")], ["project-a", "dr-lurie"], null);
    expect(groups.registered).toEqual([{ id: "dr-lurie", label: "Dr. Lurie" }]);
    expect(groups.fromRuns).toEqual([{ id: "project-a", label: "project-a" }]);
    expect(groups.orphanSelection).toBeUndefined();
  });

  it("injects a persisted selection that matches nothing instead of dropping it", () => {
    const groups = buildProjectOptions([project("dr-lurie", "Dr. Lurie")], [], "vanished-project");
    expect(groups.orphanSelection).toEqual({ id: "vanished-project", label: "vanished-project (not found)" });
  });

  it("handles empty inputs and null project lists", () => {
    expect(buildProjectOptions(null, [], null)).toEqual({ registered: [], fromRuns: [] });
  });
});
