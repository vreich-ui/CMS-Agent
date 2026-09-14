// Typed workspace failures (CHANGE-PLAN R-4).
//
// Lives below both the store and the MCP tool layer so each can throw and classify without an
// import cycle: store.ts raises these, toolKit.ts renders them into the wire envelope.
//
// Why this exists. Every failure used to reach the wire as `-32603 "Tool execution failed"` with the
// real cause buried in `error.data`, which MCP clients do not surface. A deliberate, correct refusal
// was therefore indistinguishable from a server crash — a `project.delete` that was behaving exactly
// as designed read as a broken server until someone opened the source. A machine-readable `code`
// plus structured `details` is what makes a refusal diagnosable without reading the code, and it is
// the precondition for a save path that can recover from a conflict instead of guessing.

export class WorkspaceToolError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkspaceToolError";
  }
}

export type WorkspaceConflictKind = "workspace_version" | "revision";

export type WorkspaceConflictDetails = {
  conflict: WorkspaceConflictKind;
  currentVersion: number;
  expectedVersion?: number;
  expectedRevisionId?: string;
  currentRevisionId?: string;
};

// Optimistic-concurrency conflict. `currentVersion` / `currentRevisionId` are the whole point: a
// client that receives one can reload to exactly that state and re-apply its change, which a bare
// message string never allowed. This is a recoverable outcome, not a crash.
export class WorkspaceVersionConflictError extends WorkspaceToolError {
  constructor(details: WorkspaceConflictDetails) {
    super(
      details.conflict === "workspace_version" ? "version_conflict" : "revision_conflict",
      // The message text is deliberately byte-compatible with the strings these conflicts have
      // always thrown ("workspace_version_conflict: expected X, current Y" /
      // "revision_conflict: expected A, current B"), with only a recovery hint appended. R-4 is
      // about ADDING a machine-readable code and details, not about breaking every existing caller
      // that matches on the message. New callers should read `code`; old ones keep working.
      details.conflict === "workspace_version"
        ? `workspace_version_conflict: expected ${details.expectedVersion}, current ${details.currentVersion}. Reload and re-apply.`
        : `revision_conflict: expected ${details.expectedRevisionId ?? "none"}, current ${details.currentRevisionId ?? "none"}. Reload and re-apply.`,
      { ...details }
    );
    this.name = "WorkspaceVersionConflictError";
  }
}

// R-1: a single-field writer whose patch omits the field it exists to write. Its own class so the
// guard is greppable and the wire code is stable for callers that want to handle it.
export class MissingPatchFieldError extends WorkspaceToolError {
  constructor(toolName: string, field: string) {
    super(
      "missing_patch_field",
      `${toolName} requires patch.${field}. Refusing the write: omitting the target field would overwrite the stored value with nothing.`,
      { tool: toolName, field }
    );
    this.name = "MissingPatchFieldError";
  }
}

// T5 (docs/plan/two-plane-reconciliation-plan.md §B) — a store write to a field overlayStoreNode pins
// to canonical. Its own class so the refusal is greppable, so the wire code is stable for callers that
// want to handle it, and so the message can name the ONE path that actually changes these fields.
//
// Why refuse rather than accept-and-ignore: the write succeeds today and then never reaches a run
// (executor.ts's overlayStoreNode discards it on every dispatch), so the operator believes the graph
// moved when it did not — and the stale row later blocks a re-seed of nodes.ts. That is how the store
// came to hold the pre-W8 graph.
export class CanonicalOwnedFieldWriteError extends WorkspaceToolError {
  constructor(toolName: string, nodeId: string, fields: string[], pinnedFields: readonly string[]) {
    super(
      "canonical_owned_field_write",
      `${toolName}: ${fields.map((field) => `"${field}"`).join(", ")} ${fields.length === 1 ? "is a canonical-owned field" : "are canonical-owned fields"} on node "${nodeId}". ` +
        `overlayStoreNode (src/agent/workspace/executor.ts) pins ${pinnedFields.join("/")} to the canonical definition in nodes.ts on every dispatch, so this write would NOT have taken effect — ` +
        `a store row can never rewire the graph, move a gate or change a risk level. The path that does: edit the canonical definition, run npm run nodes:update, land the PR, then REDEPLOY. ` +
        `Refusing, so an operator who wrote this does not believe it took effect. A store-authored node canonical does not define is unaffected.`,
      { tool: toolName, nodeId, fields, pinnedFields: [...pinnedFields] }
    );
    this.name = "CanonicalOwnedFieldWriteError";
  }
}
