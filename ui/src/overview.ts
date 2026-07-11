import type { ProjectSummary, RepositoryHealthSummary, WorkflowExecutionRecord, WorkspaceNode } from "./types/workspace.js";

// Pure Overview model. The Overview page leads with what needs attention right now (approvals,
// failures, degraded storage, configuration gaps) and summarizes everything else. All inputs come
// from read-only MCP tools; nothing here is source-of-truth state.

export type OverviewTargetTab = "builder" | "nodes" | "support";

export type AttentionSeverity = "action" | "warning" | "info";

export type AttentionItem = {
  id: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  targetTab?: OverviewTargetTab;
};

export type RunOverview = {
  total: number;
  byStatus: Record<string, number>;
  recent: WorkflowExecutionRecord[];
};

export type NodeOverview = {
  total: number;
  byStatus: Record<string, number>;
  byRisk: Record<string, number>;
  publishRiskNodeIds: string[];
  lastUpdatedAt?: string;
};

const severityRank: Record<AttentionSeverity, number> = { action: 0, warning: 1, info: 2 };

const timestamp = (value?: string) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const count = (bucket: Record<string, number>, key: string) => {
  bucket[key] = (bucket[key] ?? 0) + 1;
};

export function summarizeRuns(runs: WorkflowExecutionRecord[], recentLimit = 5): RunOverview {
  const byStatus: Record<string, number> = {};
  for (const run of runs) count(byStatus, run.status);
  const recent = [...runs].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)).slice(0, recentLimit);
  return { total: runs.length, byStatus, recent };
}

export function summarizeNodes(nodes: WorkspaceNode[]): NodeOverview {
  const byStatus: Record<string, number> = {};
  const byRisk: Record<string, number> = {};
  const publishRiskNodeIds: string[] = [];
  let lastUpdatedAt: string | undefined;
  for (const node of nodes) {
    count(byStatus, node.status ?? "active");
    count(byRisk, node.riskLevel ?? "read");
    if (node.riskLevel === "publish") publishRiskNodeIds.push(node.id);
    if (node.updatedAt && timestamp(node.updatedAt) > timestamp(lastUpdatedAt)) lastUpdatedAt = node.updatedAt;
  }
  return { total: nodes.length, byStatus, byRisk, publishRiskNodeIds, lastUpdatedAt };
}

// A run is waiting on a human decision when the executor blocked it or recorded pending approvals
// on a run that has not already finished.
const isAwaitingApproval = (run: WorkflowExecutionRecord) =>
  run.approvalsRequired.length > 0 && !["completed", "cancelled", "failed"].includes(run.status);

export function buildAttentionItems(input: {
  runs: WorkflowExecutionRecord[];
  projects: ProjectSummary[];
  repositoryHealth: RepositoryHealthSummary | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  const runsByRecency = [...input.runs].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
  for (const run of runsByRecency) {
    if (run.status === "blocked" || isAwaitingApproval(run)) {
      const approval = run.approvalsRequired[0];
      items.push({
        id: `approval:${run.runId}`,
        severity: "action",
        title: `Run ${run.runId} is waiting for approval`,
        detail: approval ? `${approval.nodeId}: ${approval.reason} No publication has been performed.` : "The run is blocked before publish-risk execution. No publication has been performed.",
        targetTab: "builder"
      });
    } else if (run.status === "failed") {
      items.push({
        id: `failed:${run.runId}`,
        severity: "action",
        title: `Run ${run.runId} failed`,
        detail: run.errors[0] ?? `The run stopped at ${run.currentNodeId ?? "an unknown node"}.`,
        targetTab: "builder"
      });
    } else if (run.status === "running") {
      items.push({
        id: `running:${run.runId}`,
        severity: "info",
        title: `Run ${run.runId} is in progress`,
        detail: `Currently at ${run.currentNodeId ?? "the next dependency-ready node"} for project ${run.projectId}.`,
        targetTab: "builder"
      });
    }
  }

  if (input.repositoryHealth && input.repositoryHealth.storageHealth !== "healthy") {
    items.push({
      id: "storage:degraded",
      severity: "warning",
      title: "Workspace storage is degraded",
      detail: `The ${input.repositoryHealth.backend} repository backend reported degraded health. Recent edits may not persist.`,
      targetTab: "support"
    });
  }

  for (const project of input.projects) {
    if (project.status !== "active") continue;
    if (!project.connection.endpointConfigured) {
      items.push({
        id: `project-endpoint:${project.projectId}`,
        severity: "warning",
        title: `${project.name} has no MCP endpoint configured`,
        detail: `Set ${project.connection.mcpEndpointEnvVar} in the server environment to enable connection tests for this project.`
      });
    } else if (project.authMode === "bearer_env" && !project.connection.tokenConfigured) {
      items.push({
        id: `project-token:${project.projectId}`,
        severity: "warning",
        title: `${project.name} has no MCP token configured`,
        detail: `Set ${project.connection.tokenEnvVar ?? "the project token env var"} in the server environment to authenticate connection tests.`
      });
    }
  }

  return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}
