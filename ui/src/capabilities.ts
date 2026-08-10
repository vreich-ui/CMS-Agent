// What the current bearer can actually do, derived from tools/list.
//
// Scoped bearers (MCP_SCOPED_TOKENS_JSON) carry a per-tenant tool allowlist, and the server
// neither advertises nor accepts anything outside it — an out-of-scope tool reads as "Unknown
// tool", and a wrong-project call is an opaque 401 identical to a bad token. Without a probe the
// operator meets that as a wall of unexplained failures on unrelated pages. tools/list is the one
// call every scoped token may make, so it is the honest way to say what this credential is for.

export type ToolListEntry = { name: string };
export type ToolListResult = { tools?: ToolListEntry[] };

export type CapabilityArea = {
  id: string;
  label: string;
  /** Wire tool names that must all be present for the area to count as available. */
  requires: readonly string[];
};

// Deliberately coarse: an operator wants to know which surfaces work, not which of 140 tools.
export const CAPABILITY_AREAS: readonly CapabilityArea[] = [
  { id: "agents", label: "Conversational agents", requires: ["agent_list", "agent_update"] },
  { id: "conversations", label: "Client editor chat", requires: ["agent_resolve", "agent_converse"] },
  { id: "workspace", label: "Workspace and nodes", requires: ["workspace_get_nodes"] },
  { id: "runs", label: "Runs and workflows", requires: ["workflow_list_runs"] },
  { id: "changes", label: "Change ledger", requires: ["changes_list"] },
  { id: "projects", label: "Projects and access", requires: ["project_list"] }
];

export type CapabilityReport = {
  toolCount: number;
  /** True when the surface looks deliberately narrowed rather than a full-privilege token. */
  scoped: boolean;
  areas: Array<{ id: string; label: string; available: boolean; missing: string[] }>;
};

// A full-privilege token sees the whole catalogue (140 tools today). Anything materially smaller
// is a scoped credential. The threshold is intentionally generous — misreporting a full token as
// scoped is worse than the reverse, because it would invite an operator to widen a key that is
// already correct.
const SCOPED_TOOL_CEILING = 40;

export function summarizeCapabilities(result: ToolListResult | null): CapabilityReport | null {
  if (!result || !Array.isArray(result.tools)) return null;
  const names = new Set(result.tools.map((tool) => tool.name));
  return {
    toolCount: names.size,
    scoped: names.size > 0 && names.size <= SCOPED_TOOL_CEILING,
    areas: CAPABILITY_AREAS.map((area) => {
      const missing = area.requires.filter((required) => !names.has(required));
      return { id: area.id, label: area.label, available: missing.length === 0, missing };
    })
  };
}

/** One plain sentence for the connection panel. */
export function describeCapabilities(report: CapabilityReport | null): string {
  if (!report) return "";
  const available = report.areas.filter((area) => area.available).map((area) => area.label);
  if (!report.scoped) return `Full workspace access — ${report.toolCount} tools.`;
  if (available.length === 0) return `Scoped token — ${report.toolCount} tools, none of the main surfaces.`;
  return `Scoped token — ${report.toolCount} tools covering ${available.join(", ").toLowerCase()}.`;
}
