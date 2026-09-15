// node-default-output (2026-09-15) — THE ONE PLACE A DEFAULT BECOMES A RUN'S OUTPUT.
//
// THE PROBLEM. Before this module there was no way to pass a node without paying for it. A node could
// be RUN (a model turn, a cost, a latency) or SKIPPED by a gating predicate (nodeGatingSeed.ts) — and
// a skip yields no output at all, so every downstream node then reads a hole. That left two things
// impossible: pushing one blocked or expensive node through with an output the operator already has,
// and exercising a whole conductor's topology and contracts without buying a single model turn.
//
// THE RULE. There are three ways a default reaches a run — an operator's explicit
// `workflow.run_node { useDefaultOutput: true }`, a run started in a defaults output mode, and an MCP
// client doing either — and all three write EXACTLY the same thing, through applyRunOutputFromDefault
// below: run.stageOutputs[nodeId] = value, node state completed, durationMs 0, no model turn, no usage
// record, an outputProvenance stamp naming the source, a node warning, and the node's id on
// run.defaultedNodeIds. One writer, so "was this output bought or supplied?" has one answer shape
// wherever it is asked.
//
// WHY outputProvenance IS ITS OWN FIELD and not NodeExecutionState.provenance. `provenance` is the
// EXECUTION-time identity of the model turn that produced an output (promptVersion + model), and
// producerContextForPublish (nodeExecutionProvenance.ts) reads it to stamp a published client object
// with who produced it. A defaulted node had no model turn, so it has no such identity — and writing a
// fabricated one there would be the exact failure that module exists to prevent: a publish claiming a
// producer that never ran. A defaulted node therefore leaves `provenance` ABSENT (so
// producerContextForPublish declines, as it should) and states what it really is here instead.
import { WorkspaceToolError } from "./workspaceErrors.js";
import { validateOutput } from "../execution/outputValidator.js";
import type { NodeDefaultOutput, NodeDefaultOutputAuthor, WorkspaceNode } from "./nodeTypes.js";
import type { NodeExecutionState, RunOutputMode, WorkflowExecutionRecord } from "./executionTypes.js";

const now = () => new Date().toISOString();

/** The only two ways an output can be supplied rather than produced. */
export const OUTPUT_SOURCES = ["default_output", "operator_override"] as const;
export type SuppliedOutputSource = typeof OUTPUT_SOURCES[number];

/** Node-level warning, so a run reads as defaulted without opening the node's provenance. */
export const outputSourceWarning = (source: SuppliedOutputSource): string => `output_source:${source}`;

/**
 * The refusal when an operator asks to push a node through and the node carries no default.
 * Classified rather than a bare Error: the Workbench disables its own button on the same fact, and a
 * generic 500 here would read as a broken control rather than an empty field.
 */
export const DEFAULT_OUTPUT_MISSING = "default_output_missing";

export const defaultOutputMissingError = (nodeId: string, details: Record<string, unknown> = {}): WorkspaceToolError =>
  new WorkspaceToolError(
    DEFAULT_OUTPUT_MISSING,
    `Node ${nodeId} has no default output, so there is nothing to push through. Set one with workspace.update_node_default_output (or adopt this node's last good output with workspace.adopt_output_as_default) and try again.`,
    { nodeId, ...details }
  );

// THE DEFAULTED-UPSTREAM PUBLISH GATE.
//
// Deliberately NOT a row in gateRegistry.ts. Every id in that registry addresses one (workflow, node)
// publish-risk pair so an operator can hold exactly one gate, and its conformance test walks the
// registered workflows' publish-risk nodes. This refusal is the opposite shape: it is cross-cutting
// (any tail node, any workflow), it is a property of the RUN rather than of a node, and — critically —
// it is not an approval anyone may grant. The remedy is to re-run the defaulted nodes for real, not to
// approve past them, so putting it in the registry would advertise an address for a hold that cannot
// be lifted by holding or releasing anything.
export const DEFAULTED_UPSTREAM_GATE_ID = "gate.publishing.defaulted_upstream";

/**
 * Does dispatching this node make a write a CLIENT can see?
 *
 * Matched on semantic node properties, never on a hardcoded id list — the same precedent
 * isPublishRisk / isPublishExecutorNode / isReleaserNode already set in executor.ts, and for the same
 * reason: a workflow that composes a new publisher, releaser or emitter must be guarded by existing
 * code rather than by someone remembering to extend an array.
 *
 * Deliberately WIDER than the publishing tail the brief named. The tail
 * (publication_controller / publish_executor / release_executor) is where a DTC article reaches the
 * world, but it is not the only place a run touches a client: `kind: "emission"` covers
 * capture_conductor's capture_emit_live and clone_conductor's recipe_mint / theme_bind /
 * layout_restamp, each of which writes objects, themes and templates onto the live tenant site — and
 * all of them run UPSTREAM of the tail, so a tail-only guard would refuse the publish long after the
 * pages existed. riskLevel publish/admin picks up the branches that never compose the tail at all
 * (pdf_template_publish, visual_standard_materializer).
 */
export const writesToLiveClient = (node: Pick<WorkspaceNode, "riskLevel" | "kind">): boolean =>
  node.riskLevel === "publish" || node.riskLevel === "admin" || node.kind === "publisher" || node.kind === "releaser" || node.kind === "emission";

export const RUN_OUTPUT_MODES = ["live", "defaults_where_set", "defaults_only"] as const;

export const DEFAULT_RUN_OUTPUT_MODE: RunOutputMode = "live";

/**
 * Validate and stamp a value into a storable default. Throws a classified error when the value fails
 * the node's own outputSchema and `force` was not passed — the operator is the authority, but the
 * override has to be said out loud, and a default saved over a failure is stamped `schemaValidAt: null`
 * so the record shows which of the two happened.
 */
export function buildNodeDefaultOutput(params: {
  node: Pick<WorkspaceNode, "id" | "outputSchema">;
  value: unknown;
  note?: string;
  force?: boolean;
  updatedBy: NodeDefaultOutputAuthor;
  at?: string;
}): NodeDefaultOutput {
  const at = params.at ?? now();
  const validation = validateOutput(params.value, params.node.outputSchema);
  if (!validation.ok && !params.force) {
    throw new WorkspaceToolError(
      "default_output_schema_invalid",
      `The supplied default for ${params.node.id} does not satisfy that node's outputSchema: ${validation.errors.join("; ")}. Fix the value, or pass force: true to store it anyway — the stored default is then marked schema-invalid rather than silently accepted.`,
      { nodeId: params.node.id, issues: validation.errors }
    );
  }
  return {
    value: params.value,
    ...(params.note?.trim() ? { note: params.note.trim() } : {}),
    updatedAt: at,
    updatedBy: params.updatedBy,
    schemaValidAt: validation.ok ? at : null
  };
}

/** True when this node's recorded output was supplied rather than produced. */
export const isSuppliedOutput = (state: Pick<NodeExecutionState, "outputProvenance">): boolean =>
  state.outputProvenance?.source !== undefined;

/** Every node on this run whose output was supplied rather than produced. */
export const suppliedOutputNodeIds = (run: Pick<WorkflowExecutionRecord, "nodes">): string[] =>
  run.nodes.filter((node) => isSuppliedOutput(node)).map((node) => node.nodeId);

/**
 * Should THIS node be passed through from its default on THIS advance?
 *
 * `explicit` is the operator's own `useDefaultOutput` on run_node/retry_node and always wins — it is
 * the one case where a refusal (no default) is an ERROR the caller asked for, rather than a quiet
 * fall-through to a live dispatch. Otherwise the run's own outputMode decides:
 *   live                — never (today's behaviour, and the default for every run).
 *   defaults_where_set  — pass through any node that has a default; others run live.
 *   defaults_only       — pass through any node that has a default; a node WITHOUT one fails, so a
 *                         defaults-only run proves the topology AND the gaps in one pass.
 */
export type DefaultOutputDecision =
  | { action: "dispatch" }
  | { action: "apply"; defaultOutput: NodeDefaultOutput }
  | { action: "refuse"; reason: "missing" };

export function decideDefaultOutput(params: {
  node: Pick<WorkspaceNode, "defaultOutput">;
  outputMode: RunOutputMode;
  explicit?: boolean;
  /** NodeExecutionState.defaultOutputOverride — an operator retried this node for real on this run. */
  overridden?: boolean;
}): DefaultOutputDecision {
  const stored = params.node.defaultOutput;
  if (params.explicit) return stored ? { action: "apply", defaultOutput: stored } : { action: "refuse", reason: "missing" };
  // A retry for real outranks the run's mode, and outranks "defaults_only" too: the operator has said
  // this node must produce its own output, so a mode that would fail it for having no default would be
  // refusing the very thing that was asked for.
  if (params.overridden) return { action: "dispatch" };
  if (params.outputMode === "defaults_where_set") return stored ? { action: "apply", defaultOutput: stored } : { action: "dispatch" };
  if (params.outputMode === "defaults_only") return stored ? { action: "apply", defaultOutput: stored } : { action: "refuse", reason: "missing" };
  return { action: "dispatch" };
}

/**
 * Write a supplied output onto a run, identically for every path that supplies one.
 *
 * Mutates `run` and `state` in place (the executor's own convention — the caller owns the save) and
 * returns nothing. No usage record is written anywhere near this: the R-20 rule is that a $0 event
 * stays $0, and a defaulted node is the purest $0 event the engine has.
 */
export function applyRunOutputFromDefault(params: {
  run: WorkflowExecutionRecord;
  state: NodeExecutionState;
  node: Pick<WorkspaceNode, "id" | "produces" | "outputSchema">;
  value: unknown;
  source: SuppliedOutputSource;
  /** When the supplied value was authored — the default's own updatedAt, or the override's save time. */
  updatedAt: string;
  note?: string;
  at?: string;
}): void {
  const { run, state, node } = params;
  const at = params.at ?? now();
  state.status = "completed";
  state.startedAt = at;
  state.completedAt = at;
  state.durationMs = 0;
  state.output = params.value;
  state.errors = undefined;
  delete state.blockage;
  delete state.dispatch;
  // No `provenance` stamp — see this module's header. DELETED rather than merely not written: a node
  // that really ran and is now being overridden still carries the previous turn's promptVersion/model,
  // and producerContextForPublish would stamp a live client object with the identity of a turn that
  // produced DIFFERENT text. Leaving it was the exact fabrication this split exists to prevent.
  delete state.provenance;
  state.outputProvenance = { source: params.source, updatedAt: params.updatedAt, ...(params.note ? { note: params.note } : {}) };
  // AT APPLY TIME, not only at save time. A default validated when it was stored can be applied months
  // later against an outputSchema that has since changed, and an operator override is never validated
  // by the server at all (the Workbench validates client-side; an MCP caller does not). The dispatch
  // path this replaces would have FAILED the node on a schema miss — but the operator is the authority
  // here, so this warns loudly rather than refusing, and the warning travels on the run record where
  // every downstream reader and the learning exclusion can already see it.
  const applied = validateOutput(params.value, params.node.outputSchema);
  state.warnings = [
    ...new Set([
      ...(state.warnings ?? []),
      outputSourceWarning(params.source),
      ...(applied.ok ? [] : [`supplied_output_schema_invalid:${applied.errors[0] ?? "schema_invalid"}`])
    ])
  ];
  run.stageOutputs[node.id] = params.value;
  run.artifacts = [
    ...run.artifacts.filter((artifact) => artifact.nodeId !== node.id),
    { id: `artifact_${node.id}_${Date.parse(at) || Date.now()}`, nodeId: node.id, type: node.produces?.[0] ?? "mock_output", value: params.value, createdAt: at }
  ];
  run.defaultedNodeIds = [...new Set([...(run.defaultedNodeIds ?? []), node.id])];
  run.updatedAt = at;
}

/**
 * The publish refusal. Returns the reason string when this dispatch must be blocked, undefined when it
 * may proceed.
 *
 * WHY executionMode AND NOT run.dryRun. The runner brief said "block when run.dryRun === false", but
 * `dryRun` is typed `true` on WorkflowExecutionRecord and is `true` on every run this engine has ever
 * created — it names the tool (`workflow.start_dry_run`), not the run's reality. The field that really
 * separates "this will touch a client" from "this is a traversal" is executionMode, which is exactly
 * what the existing publish gate next door already uses for its own live-only checks (`liveRun`). So:
 * a mock run passes with the defaults on board (that is the whole point of a defaults-only traversal),
 * and a live run carrying ANY supplied output is refused at the tail.
 */
export function defaultedUpstreamRefusal(params: {
  run: Pick<WorkflowExecutionRecord, "defaultedNodeIds" | "executionMode" | "nodes">;
  node: Pick<WorkspaceNode, "id" | "riskLevel" | "kind">;
  liveRun: boolean;
}): { gateId: string; defaultedNodeIds: string[]; reason: string } | undefined {
  if (!writesToLiveClient(params.node) || !params.liveRun) return undefined;
  const defaulted = params.run.defaultedNodeIds?.length ? [...params.run.defaultedNodeIds] : suppliedOutputNodeIds(params.run);
  if (!defaulted.length) return undefined;
  return {
    gateId: DEFAULTED_UPSTREAM_GATE_ID,
    defaultedNodeIds: defaulted,
    reason: `${DEFAULTED_UPSTREAM_GATE_ID}: ${defaulted.length} node(s) on this run did not produce their output — it was supplied (${defaulted.join(", ")}). Fixture content never publishes. Retry those nodes for real (workflow.retry_node without useDefaultOutput — a plain retry forces a live dispatch even on a defaults-mode run) or start a fresh run in outputMode "live".`
  };
}
