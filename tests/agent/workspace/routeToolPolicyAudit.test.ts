import { describe, expect, it } from "vitest";
import { auditNodeCapabilities, summarizeCapabilityAudit, type ProjectPolicyView } from "../../../src/agent/workspace/nodeCapabilityAudit.js";
import { listWorkspaceNodes } from "../../../src/agent/workspace/nodes.js";
import type { WorkspaceNode } from "../../../src/agent/workspace/nodeTypes.js";

// ACCEPTANCE — W5 T2 (2026-09-16). A route's requiredTools, against the TENANT's own tool policy.
//
// THE GAP THIS CLOSES. W3.1 made a route's tenant verbs knowable (routeRegistry's requiredTools) and
// W3.2.1 made every call accountable. Neither answered the question an operator actually asks before
// pointing a workflow at a client: "can this tenant even run it?" A deterministic route reaches the
// tenant through ProjectMcpAdapter, which refuses a verb the project blocks BEFORE any transport, and
// the route has no approval step to enter — so the node simply stops. That is knowable from config
// alone, and until this it was discoverable only by running the workflow and reading the wreckage.
//
// The fixture is the one the brief named: zilberman with `deploy_status` blocked. release_executor
// polls deploy_status by commit after release_to_production, so a tenant that blocks it produces a
// run that has ALREADY GONE LIVE and then cannot confirm it — the most expensive shape this check
// catches, and the reason `needs_approval` counts here as well as `blocked`.

const releaseExecutor = (): WorkspaceNode => {
  const node = listWorkspaceNodes().find((candidate) => candidate.id === "release_executor");
  if (!node) throw new Error("release_executor is no longer a canonical node — this test's premise moved.");
  return node;
};

const zilberman = (overrides: Partial<ProjectPolicyView> = {}): ProjectPolicyView => ({
  projectId: "zilberman",
  allowedTools: ["release_to_production", "deploy_status", "object_publish"],
  defaultToolPolicy: "allowed",
  toolPolicies: {},
  ...overrides
});

describe("W5 T2 — route requiredTools against a project's tool policy", () => {
  it("flags release_executor on a tenant that blocks deploy_status, naming the issue id", () => {
    const audit = auditNodeCapabilities(releaseExecutor(), [zilberman({ toolPolicies: { deploy_status: "blocked" } })]);
    const finding = audit.findings.find((candidate) => candidate.code === "route_tool_blocked_by_policy");
    expect(finding).toBeDefined();
    expect(finding && "issues" in finding && finding.issues).toEqual(["route_tool_blocked_by_policy:zilberman:deploy_status"]);
    expect(finding && "projectId" in finding && finding.projectId).toBe("zilberman");
    // release_to_production is allowed on this tenant, so it is NOT in the finding. A check that
    // named every verb of a route with one blocked entry would be unreadable and would train an
    // operator to skip it.
    expect(finding && "verbs" in finding && finding.verbs).toEqual(["deploy_status"]);
  });

  it("counts needs_approval as blocked FOR A ROUTE, and says which it is", () => {
    const audit = auditNodeCapabilities(releaseExecutor(), [zilberman({ toolPolicies: { deploy_status: "needs_approval" } })]);
    const finding = audit.findings.find((candidate) => candidate.code === "route_tool_blocked_by_policy");
    expect(finding?.detail).toContain("deploy_status (needs_approval)");
    // ...and says why a route is different from a model turn here.
    expect(finding?.detail).toContain("no approval step to enter");
  });

  it("says nothing when every verb the route needs is allowed", () => {
    const audit = auditNodeCapabilities(releaseExecutor(), [zilberman()]);
    expect(audit.findings.some((finding) => finding.code === "route_tool_blocked_by_policy")).toBe(false);
  });

  it("checks each tenant separately — the same node is fine on one client and blocked on the next", () => {
    const audit = auditNodeCapabilities(releaseExecutor(), [
      zilberman(),
      zilberman({ projectId: "genesis-lab", toolPolicies: { deploy_status: "blocked" } })
    ]);
    const findings = audit.findings.filter((finding) => finding.code === "route_tool_blocked_by_policy");
    expect(findings).toHaveLength(1);
    expect(findings[0] && "projectId" in findings[0] && findings[0].projectId).toBe("genesis-lab");
  });

  it("is a no-op with no projects, so every existing caller keeps the audit it had", () => {
    expect(auditNodeCapabilities(releaseExecutor()).findings.some((finding) => finding.code === "route_tool_blocked_by_policy")).toBe(false);
  });

  it("never flags a MODEL node: its grants go through the tool executor, which has an approval path", () => {
    const articleBody = listWorkspaceNodes().find((node) => node.id === "article_body")!;
    const audit = auditNodeCapabilities(articleBody, [zilberman({ defaultToolPolicy: "blocked", allowedTools: [], toolPolicies: {} })]);
    expect(audit.executionKind).toBe("model");
    expect(audit.findings.some((finding) => finding.code === "route_tool_blocked_by_policy")).toBe(false);
  });

  it("rolls every pair up into the whole-graph summary the drift panel reads", () => {
    // Both verbs of release_executor's manifest, so the summary has to carry two entries for one
    // node rather than collapsing a node to a single row.
    const summary = summarizeCapabilityAudit(listWorkspaceNodes(), [zilberman({ toolPolicies: { deploy_status: "blocked", release_to_production: "needs_approval" } })]);
    expect(summary.routeToolsBlockedByPolicy).toContain("route_tool_blocked_by_policy:zilberman:deploy_status");
    expect(summary.routeToolsBlockedByPolicy).toContain("route_tool_blocked_by_policy:zilberman:release_to_production");
    // Sorted and deduplicated, so the list is diffable between two runs of the check.
    expect(summary.routeToolsBlockedByPolicy).toEqual([...new Set(summary.routeToolsBlockedByPolicy)].sort());
  });
});
