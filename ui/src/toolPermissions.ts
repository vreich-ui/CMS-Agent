// Framework-free model for the Access page: resolve each remote tool's effective permission and
// describe the three states (icon id, label, tone) so the component stays presentational. Mirrors the
// backend precedence in src/agent/projects/projectTypes.ts (effectiveToolPermission): an explicit
// per-tool policy wins, then the client-wide default.

import type { ProjectSummary, ProjectToolsResult, ToolPermission } from "./types/workspace.js";

export const toolPermissionOrder: ToolPermission[] = ["allowed", "needs_approval", "blocked"];

export type PermissionMeta = {
  value: ToolPermission;
  label: string;
  short: string;
  icon: "check" | "hand" | "no-entry";
  tone: "allow" | "ask" | "deny";
  hint: string;
};

export const permissionMeta: Record<ToolPermission, PermissionMeta> = {
  allowed: { value: "allowed", label: "Allowed", short: "Allow", icon: "check", tone: "allow", hint: "The agent may call this tool directly." },
  needs_approval: { value: "needs_approval", label: "Needs approval", short: "Ask", icon: "hand", tone: "ask", hint: "Calls are held until a human approves — the tool does not run automatically." },
  blocked: { value: "blocked", label: "Blocked", short: "Block", icon: "no-entry", tone: "deny", hint: "Calls are refused before reaching the server." }
};

// Effective permission for one tool, given the project's flattened policy map + client-wide default.
export function effectivePermission(
  policy: Pick<ProjectSummary, "defaultToolPolicy" | "toolPolicies">,
  toolName: string
): ToolPermission {
  return policy.toolPolicies[toolName] ?? policy.defaultToolPolicy;
}

export type ToolRow = {
  name: string;
  description?: string;
  permission: ToolPermission;
  // True when this tool carries an explicit override (differs from the client-wide default).
  explicit: boolean;
};

// Merge the remote tool list with the project's policy into sorted rows for display. When the remote
// list is unavailable (endpoint not configured), fall back to the tools we already know policies for
// so the page still renders something honest.
export function buildToolRows(project: ProjectSummary, tools: ProjectToolsResult | null): ToolRow[] {
  const names = new Set<string>();
  if (tools?.ok) for (const tool of tools.tools) names.add(tool.name);
  for (const name of Object.keys(project.toolPolicies)) names.add(name);
  for (const name of project.allowedTools) names.add(name);

  const descriptions = new Map<string, string | undefined>((tools?.tools ?? []).map((tool): [string, string | undefined] => [tool.name, tool.description]));

  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    description: descriptions.get(name),
    permission: effectivePermission(project, name),
    explicit: Object.prototype.hasOwnProperty.call(project.toolPolicies, name)
  }));
}

// Counts per permission, for the page summary line.
export function summarizePermissions(rows: ToolRow[]): Record<ToolPermission, number> {
  const counts: Record<ToolPermission, number> = { allowed: 0, needs_approval: 0, blocked: 0 };
  for (const row of rows) counts[row.permission] += 1;
  return counts;
}

// Compute the toolPolicies patch to send after setting one tool to a permission. Any tool that ends up
// equal to the client-wide default is dropped (kept implicit) so the stored map stays minimal.
export function nextToolPolicies(
  project: Pick<ProjectSummary, "defaultToolPolicy" | "toolPolicies">,
  toolName: string,
  permission: ToolPermission
): Record<string, ToolPermission> {
  const next: Record<string, ToolPermission> = { ...project.toolPolicies, [toolName]: permission };
  for (const [name, value] of Object.entries(next)) {
    if (value === project.defaultToolPolicy) delete next[name];
  }
  return next;
}
