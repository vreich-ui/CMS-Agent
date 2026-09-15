// NODE DEFAULT OUTPUT — "push through" without a model turn.
//
// THE PROBLEM. Before this module there was exactly one way to pass a node: run it. A model turn, its
// latency and its cost, every time — including the twentieth time an operator re-ran a conductor to
// exercise a change three nodes downstream. The only other exit was a skip predicate
// (nodeGatingSeed.ts), which yields NO output at all: every dependant then sees the node as
// satisfied-with-absent, which is the right semantics for "this node had nothing to contribute" and
// the wrong semantics entirely for "I already know what this node says".
//
// THE CONTRACT. A node may carry a `defaultOutput` — a stored value that the executor can write into
// `run.stageOutputs[nodeId]` verbatim, completing the node with `durationMs: 0`, no dispatch, no
// provider call and no usage record. Three surfaces reach it (workflow.run_node's useDefaultOutput
// flag, a run's own outputMode, and the same verbs over MCP) and ALL THREE WRITE THE SAME THING
// through applyDefaultOutput below. One writer, so there is one shape to audit and one shape to gate.
//
// WHAT MAKES IT SAFE, and the reason this is not just "a cheaper run". Fixture content that reaches a
// live publish is the failure mode this whole feature could introduce, so the run carries a permanent
// mark of it: `run.defaultedNodeIds`. That list is append-only for the life of the run and is read by
// exactly two guards — the publishing tail (publishing tail nodes refuse a LIVE run whose list is
// non-empty, gate.publishing.defaulted_upstream) and the learning recorder (a defaulted node teaches
// nothing, because nothing happened). A dry run is unaffected: exercising topology on fixtures is the
// entire point.
//
// STORE-OWNED, not canonical. `defaultOutput` is authored per node like prompt/schema/tools and is
// deliberately absent from CANONICAL_OWNED_FIELDS (executor.ts): it changes how a node runs, never the
// graph it runs in. So it needs no `npm run nodes:update`, no re-seed, and the drift gate must not see
// it — overlayStoreNode carries it from the stored row exactly as it carries prompt.

/** Who wrote a run's stage output when a model did not. */
export const outputProvenanceSources = ["default_output", "operator_override"] as const;
export type OutputProvenanceSource = typeof outputProvenanceSources[number];

/** Stamped on the node state whenever a stage output did not come from a dispatch. */
export type OutputProvenance = { source: OutputProvenanceSource; updatedAt: string; note?: string };

/**
 * The stored default. `updatedAt`/`updatedBy` are attribution, not authorization (the same reading
 * changeTypes.ts's WorkspaceActor gets). `schemaValidAt` is a TIMESTAMP-OR-NULL rather than a boolean
 * on purpose: `null` means "saved with force, against a schema it does not satisfy" and a present
 * timestamp says WHEN it last validated, so a schema edited afterwards leaves a default whose stamp is
 * visibly older than the schema rather than a stale `true`.
 */
export type NodeDefaultOutput = {
  value: unknown;
  note?: string;
  updatedAt: string;
  updatedBy: "human" | "agent" | "system";
  schemaValidAt?: string | null;
};

// HOW A RUN TREATS DEFAULTS, chosen once at start_dry_run and persisted on the run so every later
// dispatch — including one made by a continuation tick in another process, which has no memory of the
// call that started the run — resolves identically. Absent means "live", which is today's behaviour
// for every run that already exists.
//
//   live               — defaults are never applied automatically. The explicit useDefaultOutput flag
//                        still works; this mode is about what happens WITHOUT one.
//   defaults_where_set — a node carrying a default is passed through; every other node runs live. The
//                        mode for "I only care about the tail of this pipeline".
//   defaults_only      — every node must carry a default. One that does not FAILS with
//                        default_output_missing rather than quietly running live and spending money
//                        the operator did not expect to spend. This is the topology-and-contracts
//                        exerciser: a whole conductor in seconds, with no provider ever called.
export const runOutputModes = ["live", "defaults_where_set", "defaults_only"] as const;
export type RunOutputMode = typeof runOutputModes[number];
export const DEFAULT_RUN_OUTPUT_MODE: RunOutputMode = "live";

/** Classified error code for "you asked for a default this node does not have". */
export const DEFAULT_OUTPUT_MISSING_CODE = "default_output_missing";
/** The publishing gate a defaulted upstream trips on a live run. */
export const DEFAULTED_UPSTREAM_GATE_ID = "gate.publishing.defaulted_upstream";

/** Node warning stamped on any node whose output did not come from a dispatch. */
export const outputSourceWarning = (source: OutputProvenanceSource): string => `output_source:${source}`;

/** Narrow an unknown stored field to a NodeDefaultOutput. A malformed row reads as absent, never throws. */
export const readNodeDefaultOutput = (node: { defaultOutput?: unknown } | undefined): NodeDefaultOutput | undefined => {
  const candidate = node?.defaultOutput;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "value")) return undefined;
  if (typeof record.updatedAt !== "string") return undefined;
  const updatedBy = record.updatedBy;
  return {
    value: record.value,
    ...(typeof record.note === "string" ? { note: record.note } : {}),
    updatedAt: record.updatedAt,
    updatedBy: updatedBy === "human" || updatedBy === "agent" || updatedBy === "system" ? updatedBy : "system",
    ...(Object.prototype.hasOwnProperty.call(record, "schemaValidAt")
      ? { schemaValidAt: typeof record.schemaValidAt === "string" ? record.schemaValidAt : null }
      : {})
  };
};

export const hasNodeDefaultOutput = (node: { defaultOutput?: unknown } | undefined): boolean =>
  readNodeDefaultOutput(node) !== undefined;

/**
 * Should THIS dispatch be satisfied from the node's default instead of run?
 *
 * Three answers, and the third is the one that matters: "missing" is not "no" — it is a REFUSAL the
 * caller must turn into a failed node. Collapsing it into "no" is how a defaults_only run would
 * quietly start spending money on the one node nobody remembered to seed.
 */
export type DefaultOutputDecision =
  | { use: true; defaultOutput: NodeDefaultOutput; reason: "explicit" | "output_mode" }
  | { use: false }
  | { use: false; missing: true; reason: "explicit" | "output_mode" };

export const decideDefaultOutput = (
  node: { defaultOutput?: unknown } | undefined,
  options: { explicit?: boolean; outputMode?: RunOutputMode }
): DefaultOutputDecision => {
  const defaultOutput = readNodeDefaultOutput(node);
  // An explicit useDefaultOutput is an operator instruction and outranks the run's mode in both
  // directions: it applies a default a "live" run would not have touched, and it refuses by name
  // rather than silently falling back to a dispatch the operator did not ask for.
  if (options.explicit) return defaultOutput ? { use: true, defaultOutput, reason: "explicit" } : { use: false, missing: true, reason: "explicit" };
  const mode = options.outputMode ?? DEFAULT_RUN_OUTPUT_MODE;
  if (mode === "live") return { use: false };
  if (defaultOutput) return { use: true, defaultOutput, reason: "output_mode" };
  // defaults_where_set is explicitly permissive — that IS the mode: pass what is seeded, run the rest.
  return mode === "defaults_only" ? { use: false, missing: true, reason: "output_mode" } : { use: false };
};

/** The human-readable half of a default_output_missing refusal. */
export const defaultOutputMissingMessage = (nodeId: string, reason: "explicit" | "output_mode"): string =>
  reason === "explicit"
    ? `Node ${nodeId} has no defaultOutput, so it cannot be pushed through. Set one with workspace.update_node_default_output (or adopt this node's last good output with workspace.adopt_output_as_default) and try again.`
    : `Node ${nodeId} has no defaultOutput and this run's outputMode is "defaults_only", which never falls back to a live dispatch. Set a default for this node, or start the run with outputMode "defaults_where_set" to run the unseeded nodes live.`;
