// Improvement Engine entities (docs/improvement/STRATEGY.md, DIRECTION.md Phase 3): evaluation
// rubrics + results, human/analytics feedback, frozen replay datasets, optimizer proposals and
// trials, and per-node ACE playbooks. Plain types with zod schemas at the tool boundary, matching
// the skill/change type conventions. These fill the gap register's §4b "Evaluation" hole.
import { z } from "zod";

export const makeImprovementId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Small stable content hash (FNV-1a over JSON) for provenance and staleness guards — enough to
// detect drift, deliberately not cryptographic.
export const stableHash = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "null";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const rubricStatuses = ["draft", "active", "deprecated"] as const;
export type RubricStatus = typeof rubricStatuses[number];

// `criticalMin` is the ONE hard-fail mechanism (Session B review, Wolf's decision 3). Before it,
// "hard fail" meant three incompatible things across four rubrics: pure arithmetic; arithmetic plus a
// prose veto the arithmetic contradicted (contract_intelligence's provenance criterion declared a 0
// there fatal while a 0 there actually scored 0.88 and PASSED); and a veto that lived only in a
// rationale field no judge ever reads. A weighted mean cannot express "this one thing is
// non-negotiable" — with 7+ criteria, any single zero is survivable by construction. So the veto is
// data the judge harness enforces, not prose it hopes someone honors: scoring at or below
// `criticalMin` on a criterion that declares one fails the rubric outright, whatever the mean says.
//
// SEMANTICS (enforced in rubricJudge.firstVeto, validated below):
//  - The floor is INCLUSIVE: `score <= criticalMin` vetoes. `criticalMin: 0` is therefore a LIVE
//    veto that fires on a score of 0 — which is what the production rubrics mean by "a
//    hollow-provenance output fails outright". It is the correct way to write "a zero here is fatal".
//  - The floor is a floor, not a bar: it must sit BELOW scaleMax, or it would veto a perfect score.
//  - A criterion the judge did NOT score is also a veto, recorded with reason "not_scored" rather
//    than as a fabricated score of 0. A judge that skips a non-negotiable has not cleared it.
export type EvalCriterion = { id: string; name: string; description: string; weight: number; scaleMax: number; guidance?: string; criticalMin?: number };

export type EvalRubric = {
  rubricId: string;
  nodeId: string;
  name: string;
  description: string;
  status: RubricStatus;
  criteria: EvalCriterion[];
  passThreshold: number; // normalized 0..1
  judgeModelConfig?: Record<string, unknown>; // provider/model override for the judge (cross-family)
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
export type EvalRubricVersionSnapshot = { rubricId: string; versionId: string; evalVersion: number; createdAt: string; summary?: string; rubric: EvalRubric };

export type EvalScore = { criterionId: string; score: number; max: number; evidence: string };
export type EvalResult = {
  evalId: string;
  rubricId: string;
  nodeId: string;
  runId?: string;
  trialId?: string;
  caseId?: string;
  subjectHash: string; // stableHash of the judged output — provenance without re-storing it
  subject?: { model?: string; provider?: string; executionMode?: string };
  scores: EvalScore[];
  normalizedScore: number; // 0..1 weighted
  pass: boolean;
  // Set when a criticalMin veto fired: the rubric failed on this criterion regardless of
  // normalizedScore. Recorded rather than folded into the score so "failed the mean" and "tripped a
  // non-negotiable" stay distinguishable in the ledger — they mean different things to an operator.
  // `reason` distinguishes the two ways a non-negotiable fails: the judge scored it at or below its
  // inclusive floor ("at_or_below_floor"), or the judge never scored it at all ("not_scored").
  // Optional only because results recorded before the distinction existed do not carry it.
  veto?: { criterionId: string; score: number; criticalMin: number; reason?: "at_or_below_floor" | "not_scored" };
  // Which evidence the judge actually had. A criterion that needs the source contract scores very
  // differently with and without it, so a stored result that does not say which it was is not
  // comparable to another one. Absent on mock results (the mock judge reads nothing).
  evidenceUsed?: string[];
  judge: { mode: "mock" | "openai"; model: string };
  createdAt: string;
};

export type PairwiseOrdering = { order: "champion_first" | "challenger_first"; winner: "champion" | "challenger" | "tie"; rationale: string };
export type PairwiseResult = {
  comparisonId: string;
  nodeId: string;
  rubricId: string;
  trialId?: string;
  caseId?: string;
  championHash: string;
  challengerHash: string;
  orderings: PairwiseOrdering[]; // ALWAYS both presentation orders
  verdict: "champion" | "challenger" | "tie" | "inconsistent"; // inconsistent = orderings disagree (position bias detected)
  judge: { mode: "mock" | "openai"; model: string };
  createdAt: string;
};

export const feedbackKinds = ["approve", "reject", "edit", "outcome"] as const;
export type FeedbackKind = typeof feedbackKinds[number];
export type FeedbackRecord = {
  feedbackId: string;
  kind: FeedbackKind;
  nodeId?: string;
  runId?: string;
  evalId?: string;
  editDiff?: { before?: unknown; after?: unknown }; // redacted before persist at the tool boundary
  outcome?: { source: string; metrics: Record<string, number> }; // published-analytics hook (Monetizer etc.)
  actor?: unknown; // WorkspaceActor shape, stamped by the tool layer's meta()
  note?: string;
  createdAt: string;
};

// `sourceExecutionMode` exists because a MOCK run's champion output is not a champion — it is a
// deterministic placeholder generated from the node's outputSchema (Session B measured one at 463
// bytes against 14–18KB for the live cases in the same dataset). Replaying a real candidate against a
// placeholder is noise dressed as a comparison, so the mode travels with the case and callers filter.
// `context` is the material the CONDUCTOR injected beside the node's input — clientProjectId, the
// deterministically prefetched client contract, the editorial voice (executor.ts). It is a sibling of
// initialInput/dependencies in the stored run record, not a field inside the input, so a case that
// kept only `input` silently dropped the contract the node was actually given: the replay ran without
// it and the judge was handed `undefined` as the source contract.
// `subjectHash` is that whole replay subject (input + dependencies + context) hashed at freeze time:
// two cases with the same hash replay to the same output and score identically, so a dataset's
// distinct-subject count is its real discriminating power. Optional on cases frozen before it existed.
export type EvalCase = { caseId: string; nodeId: string; input?: unknown; dependencyOutputs: Record<string, unknown>; context?: Record<string, unknown>; subjectHash?: string; sourceRunId: string; sourceExecutionMode?: "mock" | "openai"; championOutput?: unknown; frozenAt: string };
// distinctSubjects is the dataset's real size: how many genuinely different things it replays.
// duplicateSubjects counts cases whose subject repeated one already frozen — dropped unless the
// builder was told to keep them. degenerate = fewer than two distinct subjects, i.e. a dataset that
// cannot discriminate between a good and a bad version of the node no matter how many cases it has.
export type EvalDatasetMetadata = { distinctSubjects: number; duplicateSubjects: number; degenerate: boolean; warning?: string };
export type EvalDataset = { datasetId: string; nodeId: string; name: string; cases: EvalCase[]; metadata?: EvalDatasetMetadata; createdAt: string };

export const proposalStatuses = ["proposed", "trialed", "promoted", "rejected"] as const;
export type ProposalStatus = typeof proposalStatuses[number];
export type ProposalChange =
  | { kind: "prompt"; prompt: string }
  | { kind: "modelConfig"; modelConfig: Record<string, unknown> };
export type ImprovementProposal = {
  proposalId: string;
  nodeId: string;
  status: ProposalStatus;
  diagnosis: string; // natural-language reflection (GEPA-style)
  change: ProposalChange;
  evidence: { runIds?: string[]; evalIds?: string[]; feedbackIds?: string[] };
  baselinePromptHash: string; // refuse promotion if node.prompt drifted since the proposal
  trialIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type TrialCaseResult = { caseId: string; runId: string; status: "completed" | "failed"; evalId?: string; comparisonId?: string };
export type TrialRecord = {
  trialId: string;
  proposalId?: string;
  nodeId: string;
  datasetId: string;
  variant: { promptOverride?: string; modelConfig?: Record<string, unknown> };
  executionMode: "mock" | "openai";
  status: "completed" | "failed";
  cases: TrialCaseResult[];
  summary: { championWins: number; challengerWins: number; ties: number; inconsistent: number; casesFailed: number; meanChallengerScore: number };
  createdAt: string;
};

// Pre-ship regression gate (docs/improvement/STRATEGY.md §2/§3): re-run a node over a FROZEN replay
// dataset and rubric-score each output, then compare the aggregate to the node's last stored
// baseline. Reports only — promotion/publish stay the existing explicit paths. Each run's report is
// stored in the evaluation substrate and becomes the baseline the next run compares against ("last
// stored baseline"). NOTE: latest-report-as-baseline means a slow multi-run drift can stay "held"
// against each immediate predecessor; freeze a known-good dataset to anchor the comparison.
export type RegressionCaseResult = {
  caseId: string;
  runId: string;
  status: "completed" | "failed";
  evalId?: string;
  normalizedScore?: number;
  pass?: boolean;
};
// Drift = movement against the previous stored report in the same mode. It is NOT health: a node
// that has failed every case since the day it shipped drifts by 0.0000 and reads "held" forever
// (both production contract_intelligence reports: meanScore 0.484, threshold 0.85, all four cases
// pass:false, verdict "held").
export type RegressionDrift = "baseline_set" | "improved" | "held" | "regressed";
// Gate = ABSOLUTE health against the rubric's own passThreshold, computed independently of any
// baseline. `verdict` reports the gate first ("failing") and the drift only when the gate passes, so
// no reader of a single field can mistake a permanently broken node for a stable one.
export type RegressionGate = "pass" | "fail";
export type RegressionGateReason = "no_cases_scored" | "mean_below_threshold" | "cases_failed" | "cases_errored";
export type RegressionVerdict = RegressionDrift | "failing";
export type RegressionReportSummary = {
  casesTotal: number;   // cases attempted = casesScored + casesErrored
  casesScored: number;  // cases that executed and were rubric-scored = casesPassed + casesFailed
  casesFailed: number;  // SCORED cases whose rubric result was pass:false (mean below threshold or a veto)
  casesPassed: number;  // scored cases whose rubric result was pass:true
  casesErrored: number; // cases whose EXECUTION failed, so they were never scored at all
  passRate: number;   // casesPassed / casesScored (0 when nothing scored)
  meanScore: number;  // 0..1 mean normalized rubric score over scored cases
  threshold: number;  // rubric.passThreshold, carried for context
};
export type RegressionReport = {
  reportId: string;
  nodeId: string;
  datasetId: string;
  rubricId: string;
  executionMode: "mock" | "openai";
  cases: RegressionCaseResult[];
  summary: RegressionReportSummary;
  // The prior stored report this run was compared against (absent on the first, baseline_set run).
  baseline?: { reportId: string; meanScore: number; passRate: number; createdAt: string };
  // Absolute health against rubric.passThreshold — never against the baseline. Every reason that
  // failed the gate is listed, so "it is below threshold AND two cases errored" is one report.
  gate: RegressionGate;
  gateReasons: RegressionGateReason[];
  // Movement against the baseline, always recorded even when the gate fails (a failing node can
  // still be improving, and that is worth seeing).
  drift: RegressionDrift;
  // gate === "fail" ? "failing" : drift.
  verdict: RegressionVerdict;
  // this-run minus baseline (absent on baseline_set).
  delta?: { meanScore: number; passRate: number };
  createdAt: string;
};

export type PlaybookItemKind = "strategy" | "pitfall" | "constraint";
export type PlaybookItem = {
  itemId: string;
  text: string;
  kind: PlaybookItemKind;
  helpfulCount: number;
  harmfulCount: number;
  status: "active" | "retired";
  provenance: { source: "reflector" | "human" | "migration"; runIds?: string[]; evalIds?: string[] };
  createdAt: string;
  updatedAt: string;
};
export type NodePlaybook = { nodeId: string; items: PlaybookItem[]; budget: { maxItems: number; maxChars: number }; version: number; updatedAt: string };
export type PlaybookDelta = {
  add?: Array<{ text: string; kind: PlaybookItemKind; provenance?: PlaybookItem["provenance"] }>;
  markHelpful?: string[];
  markHarmful?: string[];
  retire?: string[];
};

// --- zod schemas for the tool boundary (`.strict()`, matching repo convention) ---

export const evalCriterionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().positive(),
  scaleMax: z.number().int().min(1).max(10),
  guidance: z.string().min(1).optional(),
  // Veto floor: a score <= this fails the whole rubric regardless of the weighted mean. Omit for
  // ordinary criteria — most criteria should NOT carry one, or the rubric stops grading and starts
  // gatekeeping.
  criticalMin: z.number().int().min(0).optional()
}).strict();

export const evalRubricInputSchema = z.object({
  rubricId: z.string().min(1).optional(),
  nodeId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(rubricStatuses).default("active"),
  criteria: z.array(evalCriterionSchema).min(1),
  passThreshold: z.number().min(0).max(1).default(0.7),
  judgeModelConfig: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();

export const playbookDeltaSchema = z.object({
  add: z.array(z.object({ text: z.string().min(1), kind: z.enum(["strategy", "pitfall", "constraint"]), provenance: z.object({ source: z.enum(["reflector", "human", "migration"]), runIds: z.array(z.string()).optional(), evalIds: z.array(z.string()).optional() }).strict().optional() }).strict()).optional(),
  markHelpful: z.array(z.string().min(1)).optional(),
  markHarmful: z.array(z.string().min(1)).optional(),
  retire: z.array(z.string().min(1)).optional()
}).strict();

// Weights must be meaningful and criterion ids unique; normalization happens at judge time, so
// weights need not sum to exactly 1.
export function validateRubric(rubric: Pick<EvalRubric, "criteria" | "passThreshold">): string[] {
  const errors: string[] = [];
  const ids = rubric.criteria.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) errors.push("criterion ids must be unique");
  const totalWeight = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (!(totalWeight > 0)) errors.push("criterion weights must sum to a positive number");
  // criticalMin is an INCLUSIVE floor (see EvalCriterion): score <= criticalMin fails the rubric, so
  // criticalMin: 0 is a live "a zero here is fatal" veto and NOT an inert declaration. The only
  // unusable value is one at or above scaleMax: it would veto every possible score including a
  // perfect one, which is never what anyone means — always a typo, and a silent one.
  for (const criterion of rubric.criteria) {
    if (criterion.criticalMin !== undefined && criterion.criticalMin >= criterion.scaleMax) {
      errors.push(`criterion ${criterion.id}: criticalMin ${criterion.criticalMin} must be below scaleMax ${criterion.scaleMax} (a floor at or above the max vetoes even a perfect score)`);
    }
  }
  return errors;
}
