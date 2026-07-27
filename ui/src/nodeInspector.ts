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

// ---------------------------------------------------------------------------- write path (R-11 phase 2)
//
// Shipped only now that R-4 gives conflicts a typed envelope: before that, a failed save could not
// tell "someone else edited this" from "the server broke", and a UI that cannot distinguish those
// has no honest recovery to offer. Every rule below is here because the change ledger is only as
// good as what the UI insists on before writing.

export type NodeDraft = {
  prompt: string;
  allowedTools: string[];
  assignedSkills: string[];
  inputSchema: string;
  outputSchema: string;
};

// Schemas live in the draft as TEXT, not as parsed objects. The operator edits JSON by hand, so
// mid-edit text is routinely invalid; holding the raw text means a stray keystroke surfaces a blocker
// instead of silently reverting the field to the last value that happened to parse.
export const SCHEMA_DRAFT_FIELDS = ["inputSchema", "outputSchema"] as const;
export type SchemaDraftField = (typeof SCHEMA_DRAFT_FIELDS)[number];
const SCHEMA_LABELS: Record<SchemaDraftField, string> = { inputSchema: "Input schema", outputSchema: "Output schema" };

const schemaToText = (value: unknown): string => (value === undefined ? "" : JSON.stringify(value, null, 2));

export const draftFromNode = (node: WorkspaceNode): NodeDraft => ({
  prompt: node.prompt ?? "",
  allowedTools: [...(node.allowedTools ?? [])],
  assignedSkills: [...(node.assignedSkills ?? [])],
  inputSchema: schemaToText(node.inputSchema),
  outputSchema: schemaToText(node.outputSchema)
});

// Mirrors the server's store.coerceSchemaInput contract (R-3) on purpose: the editor should refuse
// exactly what the writer would refuse, so the operator finds out while typing rather than after a
// failed save. A JSON Schema is legally an object OR a boolean, so both pass; an array or a number is
// valid JSON but not a schema, and clearing the field is refused outright because
// `{...existing, inputSchema: undefined}` would round-trip through normalizeNode into
// `{"type":"object"}` — a silent rewrite dressed up as a deletion.
export type SchemaParse = { ok: true; value: unknown } | { ok: false; error: string };

export function parseSchemaDraft(text: string): SchemaParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "is empty — write {} for an unconstrained schema rather than clearing the field" };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { ok: false, error: "is not valid JSON" }; }
  if (typeof parsed === "boolean") return { ok: true, value: parsed };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "must be a JSON Schema object or boolean" };
  return { ok: true, value: parsed };
}

export type DraftChange = { field: keyof NodeDraft; label: string; before: string; after: string };

const listText = (values: string[]): string => (values.length ? [...values].sort().join(", ") : "—");
const sameMembers = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

// A schema diff shows compact JSON rather than a character count: "4 characters longer" is not
// something an operator can review, whereas the shape is.
const SCHEMA_PREVIEW_LIMIT = 60;
const schemaSummary = (text: string): string => {
  if (!text.trim()) return "not set";
  const parsed = parseSchemaDraft(text);
  if (!parsed.ok) return "invalid";
  const compact = JSON.stringify(parsed.value);
  return compact.length > SCHEMA_PREVIEW_LIMIT ? `${compact.slice(0, SCHEMA_PREVIEW_LIMIT)}…` : compact;
};

// Compared semantically, so reformatting whitespace or re-indenting is not a change and never reaches
// the ledger. Key REORDERING does count as a change (JSON.stringify is order-sensitive) — that is a
// deliberate edit to the stored document, not cosmetics. Unparseable draft text always reports as a
// change so "Nothing has changed" can never hide a typo the operator is looking straight at.
const schemaChange = (node: WorkspaceNode, draft: NodeDraft, field: SchemaDraftField): DraftChange | null => {
  const storedText = draftFromNode(node)[field];
  const draftText = draft[field];
  if (storedText.trim() === draftText.trim()) return null;
  const parsedDraft = parseSchemaDraft(draftText);
  const parsedStored = parseSchemaDraft(storedText);
  if (parsedDraft.ok && parsedStored.ok && JSON.stringify(parsedDraft.value) === JSON.stringify(parsedStored.value)) return null;
  return { field, label: SCHEMA_LABELS[field], before: schemaSummary(storedText), after: schemaSummary(draftText) };
};

// The diff the operator confirms before anything is written. Field-level and human-readable on
// purpose: "you are about to change these three things" is reviewable, "save?" is not.
export function draftChanges(node: WorkspaceNode, draft: NodeDraft): DraftChange[] {
  const changes: DraftChange[] = [];
  const stored = draftFromNode(node);

  if (stored.prompt !== draft.prompt) {
    changes.push({ field: "prompt", label: "Prompt", before: `${stored.prompt.length} characters`, after: `${draft.prompt.length} characters` });
  }
  if (!sameMembers(stored.allowedTools, draft.allowedTools)) {
    changes.push({ field: "allowedTools", label: "Allowed tools", before: listText(stored.allowedTools), after: listText(draft.allowedTools) });
  }
  if (!sameMembers(stored.assignedSkills, draft.assignedSkills)) {
    changes.push({ field: "assignedSkills", label: "Assigned skills", before: listText(stored.assignedSkills), after: listText(draft.assignedSkills) });
  }
  for (const field of SCHEMA_DRAFT_FIELDS) {
    const change = schemaChange(node, draft, field);
    if (change) changes.push(change);
  }
  return changes;
}

// Only changed fields travel. `workspace.update_node` merges (`{...existing, ...patch}`), so a
// minimal patch cannot clobber anything — and unlike the single-field writers it never had the R-1
// wipe. Sending the whole node would make every save look like it touched everything in the ledger.
export function buildNodePatch(node: WorkspaceNode, draft: NodeDraft): Partial<WorkspaceNode> {
  const patch: Partial<WorkspaceNode> = {};
  for (const change of draftChanges(node, draft)) {
    if (change.field === "prompt") patch.prompt = draft.prompt;
    if (change.field === "allowedTools") patch.allowedTools = [...draft.allowedTools];
    if (change.field === "assignedSkills") patch.assignedSkills = [...draft.assignedSkills];
    if (change.field === "inputSchema") {
      const parsed = parseSchemaDraft(draft.inputSchema);
      if (parsed.ok) patch.inputSchema = parsed.value as WorkspaceNode["inputSchema"];
    }
    if (change.field === "outputSchema") {
      const parsed = parseSchemaDraft(draft.outputSchema);
      // The dedicated writer (workspace.update_node_output_schema) sets outputSchema AND the
      // deprecated `schema` alias together, and normalizeNode falls back to `schema` when
      // outputSchema is absent. Writing only one would leave the alias trailing a stale copy of the
      // schema, visible in this very tab. Keep them in lockstep.
      if (parsed.ok) {
        patch.outputSchema = parsed.value as WorkspaceNode["outputSchema"];
        patch.schema = parsed.value as WorkspaceNode["schema"];
      }
    }
  }
  return patch;
}

// A reason is mandatory, not encouraged. With agents doing most of the editing, "why" is the only
// thing a human reviewing the ledger later can actually act on.
export const MIN_REASON_LENGTH = 8;

export function saveBlockers(node: WorkspaceNode, draft: NodeDraft, reason: string, workspaceVersion?: number): string[] {
  const blockers: string[] = [];
  const changes = draftChanges(node, draft);
  if (changes.length === 0) blockers.push("Nothing has changed.");
  // Only a CHANGED schema field is validated. A node whose stored schema is already unparseable must
  // not become uneditable in every other respect — that would make the one bad field a lock on the
  // whole node.
  const changed = new Set(changes.map((change) => change.field));
  for (const field of SCHEMA_DRAFT_FIELDS) {
    if (!changed.has(field)) continue;
    const parsed = parseSchemaDraft(draft[field]);
    if (!parsed.ok) blockers.push(`${SCHEMA_LABELS[field]} ${parsed.error}.`);
  }
  if (reason.trim().length < MIN_REASON_LENGTH) blockers.push(`A reason of at least ${MIN_REASON_LENGTH} characters is required — it is what a human reviewing the change ledger will read.`);
  if (workspaceVersion === undefined) blockers.push("The workspace version is unknown, so this save cannot be version-guarded. Reload first.");
  return blockers;
}

// Mutation arguments. Deliberately omits `actor`: the server resolves it from the verified identity
// the secure proxy stamped, and a tool-supplied actor OVERRIDES that (meta() prefers the argument),
// so self-declaring here would replace a verified human with an unverified guess.
export const mutationArgsFor = (reason: string, summary: string, workspaceVersion: number) => ({
  expectedWorkspaceVersion: workspaceVersion,
  source: "ui" as const,
  reason: reason.trim(),
  summary
});

export type WriteFailure = {
  kind: "conflict" | "missing_patch_field" | "validation" | "unknown";
  code: string;
  message: string;
  currentVersion?: number;
  currentRevisionId?: string;
  recovery: string;
};

// Reads R-4's typed envelope off an McpClientError. Both shapes are handled: `error.data` from a
// JSON-RPC error, and the `structuredContent.error` envelope. A save that cannot be classified says
// so rather than pretending to be a conflict — guessing "reload and retry" at a real bug would loop
// the operator forever.
export function classifyWriteFailure(error: unknown): WriteFailure {
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { details?: unknown } | null)?.details;
  const envelope = (details as { error?: Record<string, unknown> } | undefined)?.error ?? (details as Record<string, unknown> | undefined);
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  const detailMessage = typeof envelope?.message === "string" ? envelope.message : message;

  if (code === "version_conflict" || code === "revision_conflict") {
    return {
      kind: "conflict",
      code,
      message: detailMessage,
      ...(typeof envelope?.currentVersion === "number" ? { currentVersion: envelope.currentVersion } : {}),
      ...(typeof envelope?.currentRevisionId === "string" ? { currentRevisionId: envelope.currentRevisionId } : {}),
      recovery: "Someone else changed the workspace. Reload to that version, then re-apply your edit — this UI will not retry silently."
    };
  }
  if (code === "missing_patch_field") {
    return { kind: "missing_patch_field", code, message: detailMessage, recovery: "The save was refused before it could overwrite anything. This is a bug in the editor, not in your edit." };
  }
  if (code === "validation_error") {
    return { kind: "validation", code, message: detailMessage, recovery: "The edit does not match the node's schema. Fix the highlighted field and try again." };
  }
  return { kind: "unknown", code: code || "unknown", message: detailMessage, recovery: "The save did not complete. Nothing was written. Reload to confirm the current state before trying again." };
}
