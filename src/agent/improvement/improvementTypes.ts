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

export type EvalCriterion = { id: string; name: string; description: string; weight: number; scaleMax: number; guidance?: string };

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

export type EvalCase = { caseId: string; nodeId: string; input?: unknown; dependencyOutputs: Record<string, unknown>; sourceRunId: string; championOutput?: unknown; frozenAt: string };
export type EvalDataset = { datasetId: string; nodeId: string; name: string; cases: EvalCase[]; createdAt: string };

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
export type RegressionVerdict = "baseline_set" | "improved" | "held" | "regressed";
export type RegressionReportSummary = {
  casesTotal: number;
  casesScored: number;
  casesFailed: number;
  casesPassed: number;
  passRate: number;   // 0..1 over scored cases
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
  guidance: z.string().min(1).optional()
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
  return errors;
}
