// S4 node inspector — pure model (CHANGE-PLAN R-11, read-only phase).
//
// The canvas can tell you a node has four tools. It cannot tell you WHICH four, whether they
// actually resolve, or that a skill silently appended instructions to the prompt the operator
// thinks they are reading. This module is the logic that answers those questions; the component on
// top of it is deliberately thin (per the architectural constraint in docs/plan/GUI-PLAN.md §5:
// pure logic in framework-free modules tested by root vitest).
//
// THE THREE LAYERS, and why they are never blended:
//
//   Method    — what is STORED on the node (prompt, allowedTools, schemas). Always available.
//   Effective — what the server RESOLVES at run time (effective prompt incl. injected skill
//               instructions, effective tools incl. denial reasons, resolved skill policy).
//               Always available; comes from the workspace, needs no client connection.
//   Identity  — what the CLIENT'S LIVE CONTRACT says. Requires a configured, reachable project
//               connection. When it is down the layer renders greyed with the env var that would
//               fix it, and run controls stay disabled.
//
// The load-bearing rule is the last one: an identity layer that has never been fetched, or was
// fetched and failed, must never render as if it were live. Everything fetched carries `fetchedAt`.

import type { ProjectSummary, SkillResolvedPolicy, WorkspaceNode } from "./types/workspace.js";

// ---------------------------------------------------------------------------- effective tools

// Mirror of resolveEffectiveToolsForNode's per-tool result (src/agent/tools/toolResolver.ts).
export type EffectiveTool = {
  toolId: string;
  name: string;
  category?: string;
  riskLevel?: string;
  allowed: boolean;
  denialReasons: string[];
};

export type ToolRowState = "allowed" | "denied" | "not_requested";

export type ToolRow = {
  toolId: string;
  name: string;
  category: string;
  riskLevel: string;
  /** Listed in the node's own `allowedTools` (the Method layer). */
  own: boolean;
  /** Resolver verdict (the Effective layer). */
  state: ToolRowState;
  /** Why it is denied, verbatim from the resolver. Empty when allowed. */
  denialReasons: string[];
};

const UNCATEGORIZED = "uncategorized";

// The screen that would have surfaced the contract_intelligence defect immediately: own vs
// effective, side by side, with the resolver's reason for every gap. A tool the node requests but
// the resolver denies is the interesting row, so denial reasons are never summarized away.
export function buildNodeToolRows(node: Pick<WorkspaceNode, "allowedTools">, effectiveTools: EffectiveTool[]): ToolRow[] {
  const own = new Set(node.allowedTools ?? []);
  const rows: ToolRow[] = effectiveTools.map((tool) => ({
    toolId: tool.toolId,
    name: tool.name,
    category: tool.category ?? UNCATEGORIZED,
    riskLevel: tool.riskLevel ?? "read",
    own: own.has(tool.toolId) || own.has(tool.name),
    state: tool.allowed ? "allowed" : "denied",
    denialReasons: tool.allowed ? [] : [...tool.denialReasons]
  }));

  // A tool the node lists that the registry does not know about at all. Without this it would
  // vanish from the table entirely — the node would appear to request nothing unusual while its
  // stored config names a tool that can never resolve.
  const known = new Set(rows.flatMap((row) => [row.toolId, row.name]));
  for (const toolId of own) {
    if (known.has(toolId)) continue;
    rows.push({
      toolId,
      name: toolId,
      category: UNCATEGORIZED,
      riskLevel: "read",
      own: true,
      state: "not_requested",
      denialReasons: ["tool_not_in_registry"]
    });
  }

  return rows.sort((a, b) =>
    a.category === b.category ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.category < b.category ? -1 : 1
  );
}

// Rows the operator needs to see first: requested but not granted. Everything else is noise when
// you are diagnosing "why did this node not call the tool it was supposed to call".
export const deniedRequestedTools = (rows: ToolRow[]): ToolRow[] => rows.filter((row) => row.own && row.state !== "allowed");

export const groupToolRowsByCategory = (rows: ToolRow[]): { category: string; rows: ToolRow[] }[] => {
  const byCategory = new Map<string, ToolRow[]>();
  for (const row of rows) {
    const bucket = byCategory.get(row.category);
    if (bucket) bucket.push(row);
    else byCategory.set(row.category, [row]);
  }
  return [...byCategory.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([category, categoryRows]) => ({ category, rows: categoryRows }));
};

export const summarizeToolRows = (rows: ToolRow[]): { own: number; allowed: number; denied: number } => ({
  own: rows.filter((row) => row.own).length,
  allowed: rows.filter((row) => row.state === "allowed").length,
  denied: rows.filter((row) => row.own && row.state !== "allowed").length
});

// ---------------------------------------------------------------------------- effective prompt

export type EffectivePrompt = { prompt: string; nodePrompt: string; skillInstructions: string };

// Nothing in the product reveals that an assigned skill silently appends to the prompt: operators
// have been editing half a prompt without knowing it. `injectedFromSkills` is the flag the Prompt
// tab uses to say so out loud.
export const promptComposition = (effective: EffectivePrompt | null, node: Pick<WorkspaceNode, "prompt">) => {
  const skillInstructions = effective?.skillInstructions ?? "";
  return {
    ownPrompt: node.prompt ?? "",
    skillInstructions,
    effectivePrompt: effective?.prompt ?? node.prompt ?? "",
    injectedFromSkills: skillInstructions.trim().length > 0,
    // The stored prompt drifting from what actually runs, with no skill to explain it, means the
    // resolver is doing something the Method layer does not show. Worth flagging, not hiding.
    unexplainedDrift: !!effective && !skillInstructions.trim() && effective.prompt.trim() !== (node.prompt ?? "").trim()
  };
};

// ---------------------------------------------------------------------------- skills

export type SkillConflictSeverity = "blocker" | "warning";

const SEVERITY_ORDER: Record<SkillConflictSeverity, number> = { blocker: 0, warning: 1 };

// A blocker conflict must be impossible to miss: article_body currently carries one and no surface
// in the product shows it. Sorted blockers-first, and `hasBlocker` drives the red state.
export function summarizeSkillPolicy(policy: SkillResolvedPolicy | null) {
  const conflicts = [...(policy?.conflicts ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity as SkillConflictSeverity] - SEVERITY_ORDER[b.severity as SkillConflictSeverity]
  );
  return {
    skillIds: policy?.skillIds ?? [],
    effectiveTools: policy?.effectiveTools ?? [],
    requestedTools: policy?.requestedTools ?? [],
    deniedTools: policy?.deniedTools ?? [],
    instructions: policy?.instructions ?? "",
    conflicts,
    hasBlocker: conflicts.some((conflict) => conflict.severity === "blocker"),
    blockerCount: conflicts.filter((conflict) => conflict.severity === "blocker").length,
    warningCount: conflicts.filter((conflict) => conflict.severity === "warning").length
  };
}

// R-5: skill.resolve_for_node and node.get_effective_tools disagree on some nodes — one says a tool
// is effective, the other says allowed:false. The GUI cannot render two truths, so it renders the
// disagreement itself rather than silently picking a side.
export function resolverDisagreements(rows: ToolRow[], policy: SkillResolvedPolicy | null): string[] {
  if (!policy) return [];
  const allowedByResolver = new Set(rows.filter((row) => row.state === "allowed").flatMap((row) => [row.toolId, row.name]));
  return policy.effectiveTools.filter((tool) => !allowedByResolver.has(tool)).sort();
}

// ---------------------------------------------------------------------------- overview

export type NodeWarning = { key: string; severity: "blocker" | "warning"; message: string };

// Consistency checks the workspace itself does not report (R-10: get_attention returns [] against
// real defects). These are computed from data the inspector already has, so they cost nothing.
export function nodeWarnings(node: WorkspaceNode, policy: SkillResolvedPolicy | null, rows: ToolRow[]): NodeWarning[] {
  const warnings: NodeWarning[] = [];

  const dependsOn = [...(node.dependsOn ?? [])].sort();
  const requiredInputs = [...(node.requiredInputs ?? [])].sort();
  if (JSON.stringify(dependsOn) !== JSON.stringify(requiredInputs)) {
    warnings.push({
      key: "dependency_mismatch",
      severity: "warning",
      message: `dependsOn [${dependsOn.join(", ") || "—"}] and requiredInputs [${requiredInputs.join(", ") || "—"}] disagree.`
    });
  }

  // The deprecated `schema` alias. Identical on every node today; a divergence means two schemas
  // are in play and the validator's answer depends on which one a caller happened to read.
  if (node.schema !== undefined && node.outputSchema !== undefined && JSON.stringify(node.schema) !== JSON.stringify(node.outputSchema)) {
    warnings.push({ key: "schema_alias_drift", severity: "warning", message: "The deprecated `schema` alias differs from `outputSchema`." });
  }

  const skills = summarizeSkillPolicy(policy);
  for (const conflict of skills.conflicts) {
    warnings.push({ key: `skill_conflict:${conflict.source}`, severity: conflict.severity as NodeWarning["severity"], message: `${conflict.source}: ${conflict.message}` });
  }

  const denied = deniedRequestedTools(rows);
  if (denied.length > 0) {
    warnings.push({
      key: "requested_tools_denied",
      severity: "warning",
      message: `${denied.length} requested tool${denied.length === 1 ? "" : "s"} denied by the resolver: ${denied.map((row) => row.name).join(", ")}.`
    });
  }

  for (const disagreement of resolverDisagreements(rows, policy)) {
    warnings.push({
      key: `resolver_disagreement:${disagreement}`,
      severity: "warning",
      message: `Resolvers disagree on "${disagreement}": the skill policy calls it effective, the tool resolver does not allow it.`
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------- identity layer

export type IdentityLayer =
  | { state: "no_project"; message: string }
  | { state: "unconfigured"; message: string; envVars: string[] }
  | { state: "unreachable"; message: string; envVars: string[]; detail?: string }
  | { state: "live"; message: string; fetchedAt: string };

// Identity is the only layer that can lie by omission: a contract fetched ten minutes ago, or never
// fetched at all, must not render like a live one. Every non-live state names the environment
// variable that would fix it, because "client contract unreachable" without the variable name is
// a dead end for whoever reads it.
export function identityLayer(project: ProjectSummary | null, fetch: { fetchedAt: string | null; error: string | null }): IdentityLayer {
  if (!project) return { state: "no_project", message: "No project selected — the client contract layer needs a project connection." };

  const connection = project.connection;
  const missing = [
    ...(connection.endpointConfigured ? [] : [connection.mcpEndpointEnvVar]),
    ...(connection.tokenEnvVar && !connection.tokenConfigured ? [connection.tokenEnvVar] : [])
  ];
  const envVars = [connection.mcpEndpointEnvVar, ...(connection.tokenEnvVar ? [connection.tokenEnvVar] : [])];

  if (missing.length > 0) {
    return { state: "unconfigured", message: `Client contract unavailable — ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not configured on this deployment.`, envVars: missing };
  }
  if (fetch.error || !fetch.fetchedAt) {
    return {
      state: "unreachable",
      message: `Client contract unreachable (${envVars.join(", ")}).`,
      envVars,
      ...(fetch.error ? { detail: fetch.error } : {})
    };
  }
  return { state: "live", message: `Client contract fetched from ${project.name}.`, fetchedAt: fetch.fetchedAt };
}

export const isIdentityLive = (layer: IdentityLayer): layer is Extract<IdentityLayer, { state: "live" }> => layer.state === "live";

// Run controls stay disabled unless the client contract is actually live — the whole point of
// contract-as-truth is that we do not execute against a guess.
export const runControlsEnabled = (layer: IdentityLayer): boolean => isIdentityLive(layer);

// ---------------------------------------------------------------------------- connection badge

export type ConnectionBadge = { tone: "ok" | "warning" | "danger"; label: string; title: string };

// Badge for the project selector. `disabled` outranks connection state: a disabled project will
// not be called no matter how well configured it is, and showing it as "connected" is misleading.
export function projectConnectionBadge(project: ProjectSummary | null): ConnectionBadge | null {
  if (!project) return null;
  const { connection } = project;
  if (project.status === "disabled") {
    return { tone: "danger", label: "disabled", title: `${project.name} is disabled; its connection is not used.` };
  }
  const missing = [
    ...(connection.endpointConfigured ? [] : [connection.mcpEndpointEnvVar]),
    ...(connection.tokenEnvVar && !connection.tokenConfigured ? [connection.tokenEnvVar] : [])
  ];
  if (missing.length > 0) {
    return { tone: "warning", label: "not configured", title: `Missing on this deployment: ${missing.join(", ")}.` };
  }
  return { tone: "ok", label: "configured", title: `${connection.mcpEndpointEnvVar}${connection.tokenEnvVar ? ` and ${connection.tokenEnvVar}` : ""} are configured.` };
}

// ---------------------------------------------------------------------------- misc

export const INSPECTOR_TABS = ["prompt", "tools", "skills", "overview", "schemas"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const isInspectorTab = (value: unknown): value is InspectorTab =>
  typeof value === "string" && (INSPECTOR_TABS as readonly string[]).includes(value);

// Every fetched layer shows when it was fetched. Absent means "never fetched" and says so, rather
// than rendering an empty timestamp that reads as fresh.
export const formatFetchedAt = (fetchedAt: string | null): string => (fetchedAt ? `fetched ${fetchedAt}` : "never fetched");
