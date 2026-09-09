// W4.2 — THE TOOL-ADMINISTRATION MODEL: reachability, tenant usage, and where the two disagree.
//
// Pure logic, framework-free, tested by the root vitest suite — the same discipline nodeInspector.ts
// follows, and the reason a `.tsx` file that root tests do not cover still has its decisions covered.
//
// THREE QUESTIONS THIS ANSWERS, none of which the product could answer before W3.1/W3.2:
//
//   1. Can this granted tool actually fire?  A grant on a node that terminates in a deterministic
//      route never reaches a model runner, so it is a capability on paper and nothing else. The
//      registry alone cannot say this — it knows the tool, not who holds it.
//   2. Who has actually reached this tenant?  Read from the tool execution ledger, which only
//      started containing engine-invoked tenant calls when the choke point landed. Before that, the
//      honest answer for a publish, a release or a theme apply was "we cannot tell you".
//   3. Where do a node's grants and its behaviour disagree?  The capability audit's own findings,
//      rendered as drift rather than left in a brief.

export type ToolReachability = { grantedBy: string[]; reachableFrom: string[]; dead: boolean };

export type RegistryTool = {
  toolId: string;
  name: string;
  category?: string;
  riskLevel?: string;
  reachability?: ToolReachability;
};

export type RegistryRow = {
  toolId: string;
  name: string;
  category: string;
  riskLevel: string;
  grantedBy: string[];
  reachableFrom: string[];
  /** Granted somewhere AND reachable from nowhere. */
  dead: boolean;
  /** Granted nowhere at all. NOT the same as dead: these are legitimately reachable from surfaces
   *  other than the conductor (the improvement judge, admin chat) and from tool.test, so calling
   *  them dead would be an accusation the data does not support. */
  ungranted: boolean;
};

const UNCATEGORIZED = "uncategorized";

export function buildRegistryRows(tools: RegistryTool[] | null | undefined): RegistryRow[] {
  return (tools ?? []).map((tool) => {
    const grantedBy = tool.reachability?.grantedBy ?? [];
    const reachableFrom = tool.reachability?.reachableFrom ?? [];
    return {
      toolId: tool.toolId,
      name: tool.name ?? tool.toolId,
      category: tool.category ?? UNCATEGORIZED,
      riskLevel: tool.riskLevel ?? "read",
      grantedBy,
      reachableFrom,
      dead: tool.reachability?.dead ?? (grantedBy.length > 0 && reachableFrom.length === 0),
      ungranted: grantedBy.length === 0
    };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const summarizeRegistryRows = (rows: RegistryRow[]) => ({
  total: rows.length,
  dead: rows.filter((row) => row.dead).length,
  ungranted: rows.filter((row) => row.ungranted).length,
  live: rows.filter((row) => row.reachableFrom.length > 0).length
});

// ---------------------------------------------------------------------------- tenant usage

export type ProjectUsedByNode = { nodeId: string; calls: number; callers: string[]; routeIds: string[]; verbs: string[]; lastAt: string | null };
export type ProjectUsedBy = { sampledCalls: number; sampleLimit: number; nodes: ProjectUsedByNode[] };

export type UsedByRow = ProjectUsedByNode & {
  /** Reached this tenant from engine code, past every grant and risk check. The row an operator
   *  changing a tool policy most needs to see, because nothing in the node's grant list warned them. */
  engineReached: boolean;
};

export function buildUsedByRows(usedBy: ProjectUsedBy | null | undefined): UsedByRow[] {
  return (usedBy?.nodes ?? []).map((node) => ({ ...node, engineReached: node.callers.includes("engine") }));
}

/** What to say when the ledger is empty — which is a real and common state, not an error, and must
 *  not be rendered as "nothing uses this tenant". */
export const usedByEmptyReason = (usedBy: ProjectUsedBy | null | undefined): string | null => {
  if (!usedBy) return "This project's usage could not be read.";
  if (usedBy.sampledCalls === 0) return "No calls to this tenant are in the ledger yet. That means none have been made since the ledger began recording them — not that nothing uses this project.";
  return null;
};

// ---------------------------------------------------------------------------- capability drift

export type CapabilityFinding = { code: string; detail: string; verbs?: string[]; grants?: string[] };
export type CapabilityAudit = {
  nodeId: string;
  executionKind: "model" | "deterministic";
  routeId?: string;
  riskLevel?: string;
  deadGrants: string[];
  engineRequiredTools: Array<{ verb: string; risk: string; description: string }>;
  findings: CapabilityFinding[];
};
export type CapabilityAuditSummary = {
  nodeCount: number;
  modelNodes: number;
  deterministicNodes: number;
  nodesWithDeadGrants: number;
  deadGrantCount: number;
  nodesReachingTenantFromEngine: number;
  nodesReachingHighRiskVerbs: string[];
};

export type DriftSeverity = "high" | "medium";

export type DriftRow = {
  nodeId: string;
  code: string;
  severity: DriftSeverity;
  detail: string;
  items: string[];
};

// Severity is by CODE, not by count: one admin-risk verb reached past every check outranks twenty
// dead grants, which are untidy rather than dangerous.
const SEVERITY_BY_CODE: Record<string, DriftSeverity> = {
  high_risk_engine_verb: "high",
  engine_tenant_calls_unlisted: "medium",
  grants_never_fire: "medium"
};

export function buildDriftRows(audits: CapabilityAudit[] | null | undefined): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const audit of audits ?? []) {
    for (const finding of audit.findings ?? []) {
      rows.push({
        nodeId: audit.nodeId,
        code: finding.code,
        severity: SEVERITY_BY_CODE[finding.code] ?? "medium",
        detail: finding.detail,
        items: finding.verbs ?? finding.grants ?? []
      });
    }
  }
  return rows.sort((a, b) =>
    a.severity === b.severity ? (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0) : a.severity === "high" ? -1 : 1
  );
}

export const summarizeDrift = (rows: DriftRow[]) => ({
  total: rows.length,
  high: rows.filter((row) => row.severity === "high").length,
  nodes: [...new Set(rows.map((row) => row.nodeId))].sort()
});
