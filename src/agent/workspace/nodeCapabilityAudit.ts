// W3.1 (2026-09-09) — WHAT A NODE CAN ACTUALLY DO, as opposed to what its grant list says.
//
// THE HOLE THIS MAKES VISIBLE. Two unrelated things are called "tool" in this system:
//
//   1. CONTROLLED REGISTRY TOOLS (49 of them, toolRegistry.ts). A node's `allowedTools` names these;
//      a model turn calling one passes evaluateToolPolicy, a risk check and an approval gate, and
//      lands in the tool execution ledger.
//   2. TENANT MCP VERBS (object_publish, release_to_production, site_apply_brand_imagery, ...). A
//      DETERMINISTIC route reaches these through ProjectMcpAdapter directly — no node grant is
//      consulted, no risk level is checked, and nothing is written to any ledger.
//
// The consequence, measured against the live node set on 2026-09-09:
//
//   - 51 nodes resolve across the four conductor workflows. 23 of them terminate in a deterministic
//     route, and 22 of those 23 carry `allowedTools` that CAN NEVER FIRE: the route returns before a
//     model runner is ever built. `capture_crawl` is granted `capture.crawl`; nothing will ever call
//     it through that grant.
//   - `visual_standard_materializer` is the sharpest case: riskLevel `admin`, `allowedTools: []` —
//     and it performs six tenant verbs including `site_apply_brand_imagery`, which restyles the whole
//     site. Its grant list says it can do nothing.
//   - `tool.list_executions` structurally cannot show a publish, a release, a crawl, a mint or a
//     theme apply, because none of them passes through the tool executor.
//
// WHAT THIS FILE IS, AND IS NOT. It is a READ. It computes, per node, which grants can fire, which
// cannot, and which tenant verbs the node's route will call regardless of either — so the hole above
// is answerable from `workspace.validate_node` instead of from a brief. It changes no dispatch, routes
// no call differently and blocks nothing. The choke point that makes every tenant call — model-invoked
// or engine-invoked — pass one gate and land in one ledger is the next wave; this is the data model it
// needs, landed on its own so it can be read and argued with before anything starts enforcing it.
//
// A NOTE ON A NUMBER THAT DID NOT SURVIVE CHECKING. The brief this comes from also reported "11 of 49
// registry tools are dead, reachable only via tool.test — capture.*, clone.*, pdf_template.*". Those
// tools are NOT ungranted: every capture and clone stage node carries its own. They are dead for the
// reason above — their nodes are deterministic — which is the same finding, counted twice. The
// genuinely ungranted set is different and larger, and much of it is legitimately used by surfaces
// other than the conductor (the improvement judge, admin chat), so this file reports what it can
// verify per node and does not assert a registry-wide "dead tools" count.
import { resolveExecutionKind, resolveRouteEra, resolveRouteId, routeRequiredToolsFor, type NodeExecutionKind, type RouteRequiredTool } from "./routeRegistry.js";
import type { WorkspaceNode } from "./nodeTypes.js";

export type NodeCapabilityFinding =
  // The node's grants can never fire: it terminates in a deterministic route.
  | { code: "grants_never_fire"; detail: string; grants: string[] }
  // The node's route calls the tenant, and the node's own grant list does not say so. This is the
  // accountability gap, not a safety failure in itself — the tenant's own tool policy still applies.
  | { code: "engine_tenant_calls_unlisted"; detail: string; verbs: string[] }
  // A publish- or admin-risk verb reached from a route, on a node whose grants imply it cannot.
  | { code: "high_risk_engine_verb"; detail: string; verbs: string[] };

export type NodeCapabilityAudit = {
  nodeId: string;
  executionKind: NodeExecutionKind;
  routeEra: string;
  routeId?: string;
  riskLevel?: string;
  // Grants that can actually fire — a model dispatch's allowedTools.
  modelGrants: string[];
  // Grants that cannot fire, because the node never reaches a model runner.
  deadGrants: string[];
  // Tenant verbs the node's route calls, from the route manifest. Empty for a model dispatch and for
  // a deterministic stage that makes no tenant calls.
  engineRequiredTools: RouteRequiredTool[];
  // True when this stage DOES reach the tenant but its verbs are not yet attributed from source.
  // Distinct from an empty list, which asserts the stage calls nothing.
  engineToolsUnverified?: true;
  findings: NodeCapabilityFinding[];
};

const HIGH_RISK: ReadonlySet<RouteRequiredTool["risk"]> = new Set(["publish", "admin"]);

// Pure and total: any node, including one carrying metadata this build has never seen, yields a
// well-formed audit. An unmanifested deterministic route reports `engineRequiredTools: []` and says so
// through the absent routeId rather than asserting the route makes no tenant calls.
export function auditNodeCapabilities(node: WorkspaceNode): NodeCapabilityAudit {
  const executionKind = resolveExecutionKind(node);
  const routeId = resolveRouteId(node);
  const grants = [...(node.allowedTools ?? [])];
  // For a staged route the node IS one stage, so it reaches that stage's verbs and not the route's
  // union — clone_intake must not be reported as reaching site_apply_theme. The stage is the value
  // half of the route era (cloneStageDeterministic:"theme_bind").
  const stageId = resolveRouteEra(node).split(":")[1];
  const resolved = routeId ? routeRequiredToolsFor(routeId, stageId) : [];
  const engineRequiredTools = resolved ?? [];
  const engineToolsUnverified = routeId !== undefined && resolved === undefined;
  const findings: NodeCapabilityFinding[] = [];

  if (executionKind === "deterministic" && grants.length > 0) {
    findings.push({
      code: "grants_never_fire",
      detail: `Node "${node.id}" terminates in a deterministic route (${resolveRouteEra(node)}), so it never reaches a model runner and none of its ${grants.length} grant(s) can ever be called through the tool executor.`,
      grants
    });
  }

  if (engineToolsUnverified) {
    findings.push({
      code: "engine_tenant_calls_unlisted",
      detail: `Node "${node.id}"'s route reaches the tenant, but its verbs are not yet attributed from source, so this audit cannot say which. Treat as unbounded until the manifest names them.`,
      verbs: []
    });
  }
  if (engineRequiredTools.length > 0) {
    const verbs = engineRequiredTools.map((tool) => tool.verb);
    findings.push({
      code: "engine_tenant_calls_unlisted",
      detail: `Node "${node.id}"'s route calls ${verbs.length} tenant verb(s) directly through ProjectMcpAdapter. No node grant is consulted, no risk level is checked, and none of these appears in tool.list_executions.`,
      verbs
    });
    const highRisk = engineRequiredTools.filter((tool) => HIGH_RISK.has(tool.risk)).map((tool) => tool.verb);
    if (highRisk.length > 0) {
      findings.push({
        code: "high_risk_engine_verb",
        detail: `Node "${node.id}" reaches ${highRisk.length} publish- or admin-risk tenant verb(s) from engine code${grants.length === 0 ? ", while declaring no tools at all" : ""}.`,
        verbs: highRisk
      });
    }
  }

  return {
    nodeId: node.id,
    executionKind,
    routeEra: resolveRouteEra(node),
    ...(routeId ? { routeId } : {}),
    ...(node.riskLevel ? { riskLevel: String(node.riskLevel) } : {}),
    modelGrants: executionKind === "model" ? grants : [],
    deadGrants: executionKind === "deterministic" ? grants : [],
    engineRequiredTools,
    ...(engineToolsUnverified ? { engineToolsUnverified: true as const } : {}),
    findings
  };
}

export type CapabilityAuditSummary = {
  nodeCount: number;
  modelNodes: number;
  deterministicNodes: number;
  nodesWithDeadGrants: number;
  deadGrantCount: number;
  nodesReachingTenantFromEngine: number;
  nodesReachingHighRiskVerbs: string[];
};

// The whole-graph view, for an operator asking "how wide is this" rather than "what about this node".
export function summarizeCapabilityAudit(nodes: readonly WorkspaceNode[]): CapabilityAuditSummary {
  const audits = nodes.map(auditNodeCapabilities);
  const withDead = audits.filter((audit) => audit.deadGrants.length > 0);
  return {
    nodeCount: audits.length,
    modelNodes: audits.filter((audit) => audit.executionKind === "model").length,
    deterministicNodes: audits.filter((audit) => audit.executionKind === "deterministic").length,
    nodesWithDeadGrants: withDead.length,
    deadGrantCount: withDead.reduce((sum, audit) => sum + audit.deadGrants.length, 0),
    nodesReachingTenantFromEngine: audits.filter((audit) => audit.engineRequiredTools.length > 0).length,
    nodesReachingHighRiskVerbs: audits
      .filter((audit) => audit.findings.some((finding) => finding.code === "high_risk_engine_verb"))
      .map((audit) => audit.nodeId)
      .sort()
  };
}
