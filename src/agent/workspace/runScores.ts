import type { WorkflowExecutionRecord } from "./executionTypes.js";

// W5 — A RUN'S SCORES, READ OFF THE RUN'S OWN OUTPUTS.
//
// Every workflow here ends in judgement of some kind — four editorial reviews and an aggregator on
// publishing_conductor, a fidelity score and a gap adjudication on capture, a fit adjudication on
// clone, a contract verdict before anything is built. Every one of those verdicts was reachable
// only by opening the run, then opening the node, then reading a JSON blob. "Are our runs getting
// better or worse" was not a question this system could answer at all.
//
// Two decisions worth stating, because both could have gone the lazy way:
//
//   * NOTHING IS INVENTED. A node that recorded no score is ABSENT from the map, not zero. A zero
//     that means "not scored" is indistinguishable from a zero that means "scored terribly", and
//     this repository has been bitten by exactly that shape before (the run index's nodeStatuses,
//     and the workflow deck's "0 runs"). Absent is the honest answer and the caller can say so.
//   * THE KEYS ARE NOT GUESSED FROM THE VALUE. Only these nodes are read, and only these field
//     names are accepted. A generic "find me a number that looks like a score" walk would happily
//     report a token count, a duration, or an array length as a quality score.

/** A score is a number where a node emits one, and a verdict string where it emits a judgement. */
export type RunScore = number | string;

/**
 * The scoring and judgement nodes, per workflow. Adding one is a deliberate act: it changes what
 * "this run scored" means, and a silently-widened set would make two runs incomparable.
 */
export const SCORING_NODE_IDS: readonly string[] = [
  // publishing_conductor — the four reviews and the aggregator that reconciles them.
  "human_texture",
  "trust_factual",
  "emotional_resonance",
  "reader_simulation",
  "review_aggregator",
  // publishing_conductor — the contract verdict, which gates everything built after it.
  "contract_intelligence",
  // capture_conductor.
  "capture_score",
  "gap_adjudicator",
  // clone_conductor.
  "fit_adjudicator"
];

/** Numeric score fields, in precedence order. */
const NUMBER_KEYS = ["score", "overallScore", "overall", "fitScore", "fidelityScore", "rating", "confidence"] as const;
/** Verdict fields, in precedence order. A verdict is a decision, not a measurement. */
const VERDICT_KEYS = ["verdict", "reviewStatus", "decision", "outcome"] as const;
/** Sub-objects a node may nest its judgement in, searched after the top level and never instead. */
const NESTED_KEYS = ["score", "scores", "result", "judgement", "judgment", "assessment"] as const;

const VERDICT_MAX_CHARS = 40;

const readScore = (value: unknown, depth = 0): RunScore | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of NUMBER_KEYS) {
    const candidate = record[key];
    // Finite only: NaN and Infinity are what a broken computation produces, and storing one would
    // make every later average NaN too.
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const key of VERDICT_KEYS) {
    const candidate = record[key];
    // A short token ("pass", "blocked", "go"), never a paragraph: this lands in a list row that a
    // whole page of runs carries, and free text has no ceiling.
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= VERDICT_MAX_CHARS) return candidate;
  }
  if (depth >= 1) return undefined;
  for (const key of NESTED_KEYS) {
    const nested = readScore(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

/**
 * The scores this run recorded, keyed by node id. Empty when it recorded none — which is the
 * normal state of a run that has not reached its reviews yet, and is reported as an ABSENT field
 * rather than an empty object by the index projection.
 */
export const runScoresOf = (run: Pick<WorkflowExecutionRecord, "stageOutputs" | "nodes">): Record<string, RunScore> => {
  const outputs = run.stageOutputs ?? {};
  const completed = new Set((run.nodes ?? []).filter((node) => node.status === "completed").map((node) => node.nodeId));
  const scores: Record<string, RunScore> = {};
  for (const nodeId of SCORING_NODE_IDS) {
    // A node that failed may still have written something; what it wrote is not a score.
    if (!completed.has(nodeId)) continue;
    const score = readScore(outputs[nodeId]);
    if (score !== undefined) scores[nodeId] = score;
  }
  return scores;
};
