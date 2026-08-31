// W8.3 (2026-08-31) — WHERE THE RUN'S MATERIALIZED MEDIA PLAN LIVES, now that two nodes can hold it.
//
// Until W8, exactly one node produced `artifact_plan.v1`: the node whose id is `artifact_plan`. Three
// readers therefore keyed on that ID rather than on the artifact name —
//   runContext.ts            the publish request-id lift (stageOutputs.artifact_plan.requestId)
//   readinessContentChecks   artifactPlanVerifiedMediaRefsOf (the W6 media evidence)
//   contentItemShell.ts      readContentItemShell (the shell the publisher patches instead of
//                            creating a second object)
// — which is why the W8 plan's "downstream is untouched, the artifact is unchanged" is true of the
// SHAPE and false of the BINDING.
//
// W8 splits the node in two: `artifact_plan` becomes a single model turn emitting
// `materialization_spec.v1`, and the new deterministic `artifact_materializer` emits the SAME
// `artifact_plan.v1` envelope it always emitted. So the three readers need one shared answer to "which
// node holds the plan?", and this module is it.
//
// PREFERENCE ORDER, NOT REPLACEMENT. `artifact_materializer` first, `artifact_plan` second. The
// fallback is load-bearing, not politeness:
//   - a LATE-STAGE ENTRYPOINT run seeds `artifact_plan`'s output directly (workflowLateStageEntrypoint)
//     and has no materializer node state at all;
//   - every run RECORDED BEFORE this change carries its plan under the old id, and the publisher, the
//     readiness surface and the run-context lift all read persisted runs;
//   - a run whose `artifact_plan` still emits the old envelope (a store row not yet re-seeded) keeps
//     working rather than silently losing its media evidence.
// An empty/absent entry under the first id falls through to the second; a present one wins outright.
//
// DELIBERATELY A LEAF. This module imports NOTHING. readinessContentChecks.ts lives under projects/
// and must not pull a workspace/ import graph in behind it (contentItemShell.ts already goes
// workspace -> projects; the reverse edge would close a cycle). Keeping this dependency-free means all
// three call sites can share it without anyone thinking about module order.

/** The nodes that may hold this run's `artifact_plan.v1`, most-authoritative first. */
export const MATERIALIZED_PLAN_NODE_IDS = ["artifact_materializer", "artifact_plan"] as const;

export type MaterializedPlanNodeId = typeof MATERIALIZED_PLAN_NODE_IDS[number];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The run's `artifact_plan.v1` stage output, whichever node produced it, or undefined when neither
 * did. Never merges the two: a plan is one node's whole answer, and blending a materializer's slots
 * with a stale planner's request id would produce a record no node ever asserted.
 */
export const materializedPlanOf = (
  stageOutputs: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  for (const nodeId of MATERIALIZED_PLAN_NODE_IDS) {
    const candidate = stageOutputs?.[nodeId];
    if (isObject(candidate)) return candidate;
  }
  return undefined;
};

/**
 * The first value `pick` returns for any of the plan-holding node ids, in preference order. Callers
 * that need something OTHER than the stage output — readContentItemShell wants the node's INPUT, where
 * the content-item shell was recorded — use this rather than "find the node state, then read it": a
 * materializer state that exists but carries no shell (the shell create failed, which is a warning and
 * not an error) must fall through to the planner's, not stop the search.
 */
export const firstMaterializedPlanValue = <T>(pick: (nodeId: MaterializedPlanNodeId) => T | undefined): T | undefined => {
  for (const nodeId of MATERIALIZED_PLAN_NODE_IDS) {
    const value = pick(nodeId);
    if (value !== undefined) return value;
  }
  return undefined;
};
