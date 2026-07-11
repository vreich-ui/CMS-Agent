import { describe, expect, it } from "vitest";
import { buildAttentionItems, summarizeNodes, summarizeRuns } from "../../ui/src/overview.js";
import type { ProjectSummary, RepositoryHealthSummary, WorkflowExecutionRecord, WorkspaceNode } from "../../ui/src/types/workspace.js";

const run = (overrides: Partial<WorkflowExecutionRecord>): WorkflowExecutionRecord => ({
  runId: "run-1",
  workflowId: "publishing_conductor",
  projectId: "project-a",
  status: "queued",
  startedAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
  nodes: [],
  artifacts: [],
  errors: [],
  approvalsRequired: [],
  stageOutputs: {},
  dryRun: true,
  ...overrides
});

const node = (overrides: Partial<WorkspaceNode> & { id: string }): WorkspaceNode => ({
  name: overrides.id,
  prompt: "",
  ...overrides
});

const project = (overrides: Partial<ProjectSummary>): ProjectSummary => ({
  projectId: "dr-lurie",
  name: "Dr. Lurie",
  authMode: "bearer_env",
  allowedTools: [],
  contentContract: { contentContract: "content_source.v1", canonicalArticleBody: "article_body.v1" },
  publishingPolicy: { publishEnabled: false, requiresExplicitPublish: true, description: "Publishing disabled" },
  status: "active",
  connection: { endpointConfigured: true, tokenConfigured: true, mcpEndpointEnvVar: "DR_LURIE_MCP_ENDPOINT", tokenEnvVar: "DR_LURIE_MCP_TOKEN" },
  ...overrides
});

const healthyStorage: RepositoryHealthSummary = {
  backend: "memory",
  storageHealth: "healthy",
  workspaceVersion: 3,
  workspace: { backend: "memory", writable: true, readable: true, version: "3" },
  execution: { backend: "memory", writable: true, readable: true, version: "3" },
  artifact: { backend: "memory", writable: true, readable: true, version: "3" },
  learning: { backend: "memory", writable: true, readable: true, version: "3" },
  usage: { backend: "memory", writable: true, readable: true, version: "3" },
  skill: { backend: "memory", writable: true, readable: true, version: "3" }
};

describe("summarizeRuns", () => {
  it("counts runs by status and sorts recent runs by updatedAt descending", () => {
    const runs = [
      run({ runId: "old", status: "completed", updatedAt: "2026-07-01T09:00:00.000Z" }),
      run({ runId: "new", status: "failed", updatedAt: "2026-07-02T09:00:00.000Z" }),
      run({ runId: "mid", status: "completed", updatedAt: "2026-07-01T12:00:00.000Z" })
    ];
    const overview = summarizeRuns(runs);
    expect(overview.total).toBe(3);
    expect(overview.byStatus).toEqual({ completed: 2, failed: 1 });
    expect(overview.recent.map((entry) => entry.runId)).toEqual(["new", "mid", "old"]);
  });

  it("limits recent runs and handles empty input", () => {
    const runs = Array.from({ length: 7 }, (_, index) => run({ runId: `run-${index}`, updatedAt: `2026-07-0${index + 1}T10:00:00.000Z` }));
    expect(summarizeRuns(runs, 2).recent.map((entry) => entry.runId)).toEqual(["run-6", "run-5"]);
    expect(summarizeRuns([])).toEqual({ total: 0, byStatus: {}, recent: [] });
  });
});

describe("summarizeNodes", () => {
  it("counts status and risk, lists publish-risk nodes, and finds the latest update", () => {
    const nodes = [
      node({ id: "draft_writer", status: "active", riskLevel: "write", updatedAt: "2026-07-01T10:00:00.000Z" }),
      node({ id: "publication_controller", status: "active", riskLevel: "publish", updatedAt: "2026-07-03T10:00:00.000Z" }),
      node({ id: "custom_new", status: "draft" })
    ];
    const overview = summarizeNodes(nodes);
    expect(overview.total).toBe(3);
    expect(overview.byStatus).toEqual({ active: 2, draft: 1 });
    expect(overview.byRisk).toEqual({ write: 1, publish: 1, read: 1 });
    expect(overview.publishRiskNodeIds).toEqual(["publication_controller"]);
    expect(overview.lastUpdatedAt).toBe("2026-07-03T10:00:00.000Z");
  });

  it("handles empty input", () => {
    expect(summarizeNodes([])).toEqual({ total: 0, byStatus: {}, byRisk: {}, publishRiskNodeIds: [], lastUpdatedAt: undefined });
  });
});

describe("buildAttentionItems", () => {
  it("surfaces blocked runs awaiting approval as action items targeting the builder", () => {
    const blocked = run({
      runId: "run-blocked",
      status: "blocked",
      approvalsRequired: [{ nodeId: "publication_controller", type: "approval_required", reason: "Publish risk requires explicit approval.", requestedAt: "2026-07-01T11:00:00.000Z" }]
    });
    const items = buildAttentionItems({ runs: [blocked], projects: [], repositoryHealth: healthyStorage });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "approval:run-blocked", severity: "action", targetTab: "builder" });
    expect(items[0].detail).toContain("No publication has been performed.");
  });

  it("surfaces failed runs with their first error", () => {
    const failed = run({ runId: "run-failed", status: "failed", errors: ["research node exploded"] });
    const items = buildAttentionItems({ runs: [failed], projects: [], repositoryHealth: healthyStorage });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "failed:run-failed", severity: "action", detail: "research node exploded" });
  });

  it("ignores approvals recorded on finished runs", () => {
    const completed = run({
      runId: "run-done",
      status: "completed",
      approvalsRequired: [{ nodeId: "publication_controller", type: "approval_required", reason: "stale", requestedAt: "2026-07-01T11:00:00.000Z" }]
    });
    expect(buildAttentionItems({ runs: [completed], projects: [], repositoryHealth: healthyStorage })).toEqual([]);
  });

  it("warns about degraded storage and unconfigured active project connections", () => {
    const degraded: RepositoryHealthSummary = { ...healthyStorage, storageHealth: "degraded", backend: "blobs" };
    const items = buildAttentionItems({
      runs: [],
      projects: [
        project({ projectId: "no-endpoint", name: "No Endpoint", connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "X_ENDPOINT", tokenEnvVar: "X_TOKEN" } }),
        project({ projectId: "no-token", name: "No Token", connection: { endpointConfigured: true, tokenConfigured: false, mcpEndpointEnvVar: "Y_ENDPOINT", tokenEnvVar: "Y_TOKEN" } }),
        project({ projectId: "disabled", name: "Disabled", status: "disabled", connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "Z_ENDPOINT" } })
      ],
      repositoryHealth: degraded
    });
    expect(items.map((item) => item.id)).toEqual(["storage:degraded", "project-endpoint:no-endpoint", "project-token:no-token"]);
    expect(items.every((item) => item.severity === "warning")).toBe(true);
    // Env var *names* are safe to display; values never appear in attention details.
    expect(items[1].detail).toContain("X_ENDPOINT");
  });

  it("orders action items before warnings and infos regardless of input order", () => {
    const items = buildAttentionItems({
      runs: [
        run({ runId: "run-running", status: "running", currentNodeId: "research", updatedAt: "2026-07-03T10:00:00.000Z" }),
        run({ runId: "run-failed", status: "failed", updatedAt: "2026-07-01T10:00:00.000Z" })
      ],
      projects: [project({ projectId: "no-endpoint", name: "No Endpoint", connection: { endpointConfigured: false, tokenConfigured: false, mcpEndpointEnvVar: "X_ENDPOINT" } })],
      repositoryHealth: healthyStorage
    });
    expect(items.map((item) => item.severity)).toEqual(["action", "warning", "info"]);
  });

  it("returns no items for calm inputs", () => {
    expect(buildAttentionItems({ runs: [run({ status: "completed" })], projects: [project({})], repositoryHealth: healthyStorage })).toEqual([]);
  });
});
