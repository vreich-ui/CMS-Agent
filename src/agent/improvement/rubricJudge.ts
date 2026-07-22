// Rubric LLM-as-judge (docs/improvement/STRATEGY.md §2/§3). The LLM judge is a SYNTHETIC node run
// through the existing runner registry — inheriting schema-constrained JSON output, validation
// retries, timeout, budget checks, and usage recording (judge cost lands in the ledger under
// nodeId "improvement_judge") without duplicating any client code. Judging hygiene enforced here:
// pairwise comparisons run in BOTH presentation orders and disagreement is surfaced as an
// `inconsistent` verdict (position bias made visible, never averaged away); the judge model is
// configurable per rubric so it can come from a different family than the generator.
import { getNodeRunner } from "../execution/runnerRegistry.js";
import type { ExecutionMode } from "../execution/executionContext.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import { makeImprovementId, stableHash, type EvalResult, type EvalRubric, type EvalScore, type PairwiseOrdering, type PairwiseResult } from "./improvementTypes.js";

const now = () => new Date().toISOString();

export const JUDGE_NODE_ID = "improvement_judge";

export type JudgeDeps = { evaluationRepository: EvaluationRepository; executionRepository: ExecutionRepository };
export type JudgeRefs = { runId?: string; trialId?: string; caseId?: string; subject?: EvalResult["subject"] };

const judgeModelName = (rubric: EvalRubric): string =>
  String(rubric.judgeModelConfig?.model ?? process.env.IMPROVEMENT_JUDGE_MODEL ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5");

const scoreOutputSchema = (rubric: EvalRubric) => ({
  type: "object",
  required: ["scores"],
  additionalProperties: false,
  properties: {
    scores: {
      type: "array",
      items: { type: "object", required: ["criterionId", "score", "evidence"], additionalProperties: false, properties: { criterionId: { type: "string", enum: rubric.criteria.map((criterion) => criterion.id) }, score: { type: "number" }, evidence: { type: "string" } } }
    },
    summary: { type: "string" }
  }
});

const pairwiseOutputSchema = {
  type: "object",
  required: ["winner", "rationale"],
  additionalProperties: false,
  properties: { winner: { type: "string", enum: ["A", "B", "tie"] }, rationale: { type: "string" } }
};

const syntheticJudgeNode = (rubric: EvalRubric, prompt: string, outputSchema: unknown): WorkspaceNode => ({
  id: JUDGE_NODE_ID,
  name: "Rubric judge",
  kind: "improvement",
  description: "Synthetic evaluation node; never persisted in the workspace graph.",
  prompt,
  schema: outputSchema as Record<string, unknown>,
  inputSchema: { type: "object", additionalProperties: true },
  outputSchema: outputSchema as Record<string, unknown>,
  allowedTools: [],
  requiredInputs: [],
  produces: ["eval_result.v1"],
  riskLevel: "read",
  dependsOn: [],
  status: "active",
  position: { x: 0, y: 0 },
  updatedAt: now(),
  assignedSkills: [],
  modelConfig: { ...(rubric.judgeModelConfig ?? {}), model: judgeModelName(rubric) },
  metadata: { synthetic: true }
} as unknown as WorkspaceNode);

const syntheticJudgeRun = (mode: ExecutionMode): WorkflowExecutionRecord => {
  const timestamp = now();
  return { runId: makeImprovementId("judge"), workflowId: "improvement_judge", projectId: "workspace", status: "running", startedAt: timestamp, updatedAt: timestamp, nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: mode } as WorkflowExecutionRecord;
};

async function runJudge(rubric: EvalRubric, prompt: string, outputSchema: unknown, input: unknown, deps: JudgeDeps): Promise<unknown> {
  const node = syntheticJudgeNode(rubric, prompt, outputSchema);
  const run = syntheticJudgeRun("openai");
  // Cross-family judging (Phase 6): when the rubric's judgeModelConfig.provider is "anthropic", the
  // judge runs natively on Claude (a Claude judge grading an OpenAI generator, the recommended setup);
  // otherwise it stays on the OpenAI(-compatible) path. Same synthetic-node plumbing either way.
  const result = await getNodeRunner("openai", node.modelConfig as Record<string, unknown> | undefined).run({ node, input: { input } }, { run, executionRepository: deps.executionRepository });
  if (!result.ok) throw new Error(`judge_failed: ${result.code}: ${result.message}`);
  return result.output;
}

// Deterministic mock scoring: stable pseudo-scores derived from the subject hash so tests and
// dry runs exercise the full loop without a model. Same output → same scores, always.
const mockScore = (subjectHash: string, criterionId: string, scaleMax: number): number =>
  parseInt(stableHash(`${subjectHash}:${criterionId}`).slice(0, 4), 16) % (scaleMax + 1);

const normalize = (rubric: EvalRubric, scores: EvalScore[]): number => {
  const totalWeight = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  return rubric.criteria.reduce((sum, criterion) => {
    const score = scores.find((candidate) => candidate.criterionId === criterion.id);
    return sum + (score ? (Math.min(score.score, criterion.scaleMax) / criterion.scaleMax) * criterion.weight : 0);
  }, 0) / totalWeight;
};

export async function scoreOutput(params: { rubric: EvalRubric; nodeId: string; output: unknown; mode: "mock" | "openai"; refs?: JudgeRefs }, deps: JudgeDeps): Promise<EvalResult> {
  const { rubric, output, mode } = params;
  const subjectHash = stableHash(output);
  let scores: EvalScore[];
  if (mode === "mock") {
    scores = rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: mockScore(subjectHash, criterion.id, criterion.scaleMax), max: criterion.scaleMax, evidence: `mock: deterministic score for ${criterion.id}` }));
  } else {
    const prompt = [
      "You are a rigorous content evaluation judge. Score the OUTPUT in the user message against each criterion.",
      `Node role: ${params.nodeId}. Rubric: ${rubric.name} — ${rubric.description}`,
      ...rubric.criteria.map((criterion) => `Criterion ${criterion.id} (weight ${criterion.weight}, scale 0-${criterion.scaleMax}): ${criterion.description}${criterion.guidance ? ` Guidance: ${criterion.guidance}` : ""}`),
      "Cite concrete evidence from the output for every score. Return only JSON matching the schema."
    ].join("\n");
    const raw = await runJudge(rubric, prompt, scoreOutputSchema(rubric), { output }, deps) as { scores: Array<{ criterionId: string; score: number; evidence: string }> };
    scores = rubric.criteria.map((criterion) => {
      const judged = raw.scores.find((candidate) => candidate.criterionId === criterion.id);
      return { criterionId: criterion.id, score: Math.max(0, Math.min(judged?.score ?? 0, criterion.scaleMax)), max: criterion.scaleMax, evidence: judged?.evidence ?? "criterion not scored by judge" };
    });
  }
  const normalizedScore = normalize(rubric, scores);
  const result: EvalResult = {
    evalId: makeImprovementId("eval"),
    rubricId: rubric.rubricId,
    nodeId: params.nodeId,
    runId: params.refs?.runId,
    trialId: params.refs?.trialId,
    caseId: params.refs?.caseId,
    subjectHash,
    subject: params.refs?.subject,
    scores,
    normalizedScore: Number(normalizedScore.toFixed(4)),
    pass: normalizedScore >= rubric.passThreshold,
    judge: { mode, model: mode === "mock" ? "mock" : judgeModelName(rubric) },
    createdAt: now()
  };
  return deps.evaluationRepository.recordResult(result);
}

// One ordering of a pairwise comparison. `first`/`second` are presentation slots; the mapping back
// to champion/challenger happens in comparePairwise so the judge never sees which is which.
async function judgeOrdering(rubric: EvalRubric, nodeId: string, first: unknown, second: unknown, mode: "mock" | "openai", deps: JudgeDeps): Promise<{ winner: "first" | "second" | "tie"; rationale: string }> {
  if (mode === "mock") {
    // Deterministic: higher mock normalized score wins, ties are ties — order-independent by
    // construction, so mock pairwise never fabricates position bias.
    const scoreOf = (subject: unknown) => normalize(rubric, rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: mockScore(stableHash(subject), criterion.id, criterion.scaleMax), max: criterion.scaleMax, evidence: "" })));
    const firstScore = scoreOf(first);
    const secondScore = scoreOf(second);
    return { winner: firstScore === secondScore ? "tie" : firstScore > secondScore ? "first" : "second", rationale: `mock: ${firstScore.toFixed(3)} vs ${secondScore.toFixed(3)}` };
  }
  const prompt = [
    "You are a rigorous content evaluation judge. Two candidate outputs, A and B, are in the user message.",
    `Node role: ${nodeId}. Decide which better satisfies the rubric: ${rubric.name} — ${rubric.description}`,
    ...rubric.criteria.map((criterion) => `- ${criterion.name}: ${criterion.description}`),
    "Answer strictly as JSON: winner is \"A\", \"B\", or \"tie\", with a concise rationale. Judge content quality only; ignore ordering and length."
  ].join("\n");
  const raw = await runJudge(rubric, prompt, pairwiseOutputSchema, { A: first, B: second }, deps) as { winner: "A" | "B" | "tie"; rationale: string };
  return { winner: raw.winner === "A" ? "first" : raw.winner === "B" ? "second" : "tie", rationale: raw.rationale };
}

export async function comparePairwise(params: { rubric: EvalRubric; nodeId: string; champion: unknown; challenger: unknown; mode: "mock" | "openai"; refs?: JudgeRefs }, deps: JudgeDeps): Promise<PairwiseResult> {
  const { rubric, nodeId, champion, challenger, mode } = params;
  const toSide = (slotWinner: "first" | "second" | "tie", championSlot: "first" | "second"): PairwiseOrdering["winner"] =>
    slotWinner === "tie" ? "tie" : slotWinner === championSlot ? "champion" : "challenger";
  const forward = await judgeOrdering(rubric, nodeId, champion, challenger, mode, deps);
  const reversed = await judgeOrdering(rubric, nodeId, challenger, champion, mode, deps);
  const orderings: PairwiseOrdering[] = [
    { order: "champion_first", winner: toSide(forward.winner, "first"), rationale: forward.rationale },
    { order: "challenger_first", winner: toSide(reversed.winner, "second"), rationale: reversed.rationale }
  ];
  const verdict: PairwiseResult["verdict"] = orderings[0]!.winner === orderings[1]!.winner ? orderings[0]!.winner : "inconsistent";
  const result: PairwiseResult = {
    comparisonId: makeImprovementId("cmp"),
    nodeId,
    rubricId: rubric.rubricId,
    trialId: params.refs?.trialId,
    caseId: params.refs?.caseId,
    championHash: stableHash(champion),
    challengerHash: stableHash(challenger),
    orderings,
    verdict,
    judge: { mode, model: mode === "mock" ? "mock" : judgeModelName(rubric) },
    createdAt: now()
  };
  return deps.evaluationRepository.recordPairwise(result);
}
