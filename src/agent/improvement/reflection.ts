// Automatic post-run reflection (docs/platform/DIRECTION.md Phase 7). The GEPA-style reflector
// (optimizer.propose) is normally fired by hand; this closes the outer loop by firing it AUTOMATICALLY
// when a conductor run reaches "completed", so the learning loop advances on its own instead of waiting
// for an operator. It is deliberately conservative:
//   • Gated by IMPROVEMENT_POST_RUN_REFLECT — default OFF, so behavior is unchanged unless an operator
//     opts in.
//   • PROPOSE-ONLY: it calls proposeImprovement, which saves a draft proposal; nothing is applied.
//     Promotion stays the explicit, human-approved optimizer.promote path (or the auto-promote flag).
//   • BEST-EFFORT: every node's reflection is isolated in try/catch and the whole pass never throws, so
//     a repository hiccup can never fail or roll back an otherwise-successful run.
//   • EVIDENCE-GATED: a node is only reflected on when it has at least IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES
//     recorded eval results — reflection is only as good as its evidence, and this keeps a fresh
//     workspace from emitting a pile of evidence-free proposals.
//   • DEDUPED + BOUNDED: a node with an already-open proposal for its CURRENT prompt is skipped (so
//     re-running the conductor does not stack identical proposals), and at most
//     IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES proposals are created per run.
// Reflection mode defaults to "mock" (deterministic, no model spend); set IMPROVEMENT_POST_RUN_REFLECT_MODE=openai
// for LLM reflection once the candidate models are reachable.
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import { stableHash } from "./improvementTypes.js";
import { proposeImprovement, type OptimizerDeps } from "./optimizer.js";

const truthy = (value: string | undefined): boolean => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");

export const postRunReflectionEnabled = (): boolean => truthy(process.env.IMPROVEMENT_POST_RUN_REFLECT);

export const postRunReflectionMode = (): "mock" | "openai" =>
  process.env.IMPROVEMENT_POST_RUN_REFLECT_MODE?.trim().toLowerCase() === "openai" ? "openai" : "mock";

// Max proposals to create per run (a safety bound, not a prioritizer — candidates are taken in DAG
// order). Default 3; a non-positive/NaN value falls back to the default.
export const postRunReflectionMaxNodes = (): number => {
  const value = Number(process.env.IMPROVEMENT_POST_RUN_REFLECT_MAX_NODES);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
};

// Minimum recorded eval results a node needs before it is a reflection candidate. Default 1; a
// value < 1 / NaN falls back to the default.
export const postRunReflectionMinSamples = (): number => {
  const value = Number(process.env.IMPROVEMENT_POST_RUN_REFLECT_MIN_SAMPLES);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
};

export type PostRunReflectionSkip = { nodeId: string; reason: "no_evidence" | "duplicate_open_proposal" };
export type PostRunReflectionResult = {
  enabled: boolean;
  mode: "mock" | "openai";
  runId: string;
  candidates: number;               // completed nodes that actually executed in this run
  proposals: Array<{ nodeId: string; proposalId: string }>;
  skipped: PostRunReflectionSkip[];
  errors: Array<{ nodeId: string; message: string }>;
  reachedMaxNodes: boolean;
};

// A node "executed in this run" when it completed via the runner. Late-stage-entry seeded/skipped
// ancestors are marked completed but never ran, so their warnings exclude them from reflection.
const executedInRun = (run: WorkflowExecutionRecord): string[] =>
  run.nodes
    .filter((state) => state.status === "completed")
    .filter((state) => !(state.warnings ?? []).some((warning) => warning.startsWith("late_stage_entry")))
    .map((state) => state.nodeId);

// Fire GEPA-style reflection for the nodes that executed in a completed run. Returns a structured
// summary for telemetry; NEVER throws (each node is isolated and the body is fully guarded), so the
// caller can await it on the run-completion path without risking the run.
export async function reflectAfterRun(run: WorkflowExecutionRecord, deps: OptimizerDeps, overrides?: { mode?: "mock" | "openai"; maxNodes?: number; minSamples?: number }): Promise<PostRunReflectionResult> {
  const mode = overrides?.mode ?? postRunReflectionMode();
  const result: PostRunReflectionResult = { enabled: postRunReflectionEnabled(), mode, runId: run.runId, candidates: 0, proposals: [], skipped: [], errors: [], reachedMaxNodes: false };
  if (!result.enabled) return result;

  const maxNodes = overrides?.maxNodes ?? postRunReflectionMaxNodes();
  const minSamples = overrides?.minSamples ?? postRunReflectionMinSamples();
  const candidates = executedInRun(run);
  result.candidates = candidates.length;

  for (const nodeId of candidates) {
    if (result.proposals.length >= maxNodes) { result.reachedMaxNodes = true; break; }
    try {
      // Evidence gate: reflection needs recorded evaluations to diagnose from.
      const evidence = await deps.evaluationRepository.listResults({ nodeId, limit: minSamples });
      if (evidence.length < minSamples) { result.skipped.push({ nodeId, reason: "no_evidence" }); continue; }
      // Dedupe: skip if a still-open proposal already targets this node's CURRENT prompt, so repeated
      // runs never stack identical drafts. A promoted/rejected proposal (or a prompt change) reopens it.
      const node = await deps.workspaceRepository.getNode(nodeId);
      if (node) {
        const promptHash = stableHash(node.prompt);
        const openDuplicate = (await deps.improvementRepository.listProposals({ nodeId }))
          .some((proposal) => (proposal.status === "proposed" || proposal.status === "trialed") && proposal.baselinePromptHash === promptHash);
        if (openDuplicate) { result.skipped.push({ nodeId, reason: "duplicate_open_proposal" }); continue; }
      }
      const proposal = await proposeImprovement({ nodeId, mode }, deps);
      result.proposals.push({ nodeId, proposalId: proposal.proposalId });
    } catch (error) {
      result.errors.push({ nodeId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
