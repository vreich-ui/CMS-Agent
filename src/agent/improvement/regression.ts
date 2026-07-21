// Per-node pre-ship regression gate (docs/improvement/STRATEGY.md §2/§3). Wires the EXISTING pieces
// — the frozen replay dataset (dataset.build), the independent-execution replay path (runTrialCase),
// and the rubric LLM-as-judge (scoreOutput) — into a single "run and score against a baseline" pass
// so a prompt/skill/model change can be checked against known-good cases BEFORE it ships.
//
// This is a GATE that REPORTS. It never mutates node config, never promotes, never publishes — the
// same philosophy as the optimizer's propose-only default. Promotion stays the explicit
// optimizer.promote / human path. Each run stores its report in the evaluation substrate and that
// report becomes the baseline the next run compares against ("last stored baseline").
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import { scoreOutput } from "./rubricJudge.js";
import { buildDataset, runTrialCase, type ReplayDeps } from "./replay.js";
import { makeImprovementId, type EvalRubric, type RegressionCaseResult, type RegressionReport, type RegressionVerdict } from "./improvementTypes.js";

const now = () => new Date().toISOString();
// Ignore sub-1e-4 aggregate wobble so float noise is never reported as a real improvement/regression.
const VERDICT_EPSILON = 1e-4;

export type RegressionDeps = ReplayDeps;

async function resolveActiveRubric(nodeId: string, rubricId: string | undefined, evaluationRepository: EvaluationRepository): Promise<EvalRubric> {
  if (rubricId) {
    const rubric = await evaluationRepository.getRubric(rubricId);
    if (!rubric) throw new Error(`Unknown rubric: ${rubricId}`);
    return rubric;
  }
  const active = await evaluationRepository.listRubrics({ nodeId, status: "active" });
  if (!active.length) throw new Error(`no_active_rubric: create a rubric for ${nodeId} before running a regression (evaluation.create_rubric).`);
  return active[0]!;
}

// Execute the node's CURRENT definition (no variant) over each frozen case and rubric-score every
// output, then grade the aggregate against the node's last stored regression baseline.
export async function runRegression(params: { nodeId: string; datasetId?: string; rubricId?: string; mode: "mock" | "openai"; caseLimit?: number }, deps: RegressionDeps): Promise<RegressionReport> {
  const node = await deps.workspaceRepository.getNode(params.nodeId);
  if (!node) throw new Error(`Unknown node: ${params.nodeId}`);
  // Reuse the existing dataset path: an explicit dataset, else the node's newest frozen dataset,
  // else freeze one now from completed history.
  const dataset = params.datasetId
    ? await deps.improvementRepository.getDataset(params.datasetId)
    : (await deps.improvementRepository.listDatasets({ nodeId: params.nodeId }))[0] ?? await buildDataset({ nodeId: params.nodeId }, deps);
  if (!dataset) throw new Error(`Unknown dataset: ${params.datasetId}`);
  const rubric = await resolveActiveRubric(params.nodeId, params.rubricId, deps.evaluationRepository);

  const reportId = makeImprovementId("reg");
  const cases: RegressionCaseResult[] = [];
  let scoreSum = 0, scored = 0, passed = 0, failed = 0;
  for (const evalCase of dataset.cases.slice(0, Math.max(1, params.caseLimit ?? dataset.cases.length))) {
    // variant {} = the node exactly as it stands. runTrialCase runs it through the trial workspace
    // facade, so a regression run never bumps workspaceVersion or writes live stage outputs.
    const execution = await runTrialCase({ evalCase, trialId: reportId, variant: {}, mode: params.mode }, deps);
    if (execution.status === "failed") {
      failed += 1;
      cases.push({ caseId: evalCase.caseId, runId: execution.runId, status: "failed" });
      continue;
    }
    const evalResult = await scoreOutput({ rubric, nodeId: params.nodeId, output: execution.output, mode: params.mode, refs: { trialId: reportId, caseId: evalCase.caseId, runId: execution.runId } }, deps);
    scoreSum += evalResult.normalizedScore;
    scored += 1;
    if (evalResult.pass) passed += 1;
    cases.push({ caseId: evalCase.caseId, runId: execution.runId, status: "completed", evalId: evalResult.evalId, normalizedScore: evalResult.normalizedScore, pass: evalResult.pass });
  }

  const meanScore = scored ? Number((scoreSum / scored).toFixed(4)) : 0;
  const passRate = scored ? Number((passed / scored).toFixed(4)) : 0;

  // Baseline = the node's most recent PRIOR report (read before this one is recorded).
  const baseline = await deps.evaluationRepository.getLatestRegressionReport(params.nodeId);
  let verdict: RegressionVerdict;
  let delta: { meanScore: number; passRate: number } | undefined;
  if (!baseline) {
    verdict = "baseline_set";
  } else {
    const dMean = Number((meanScore - baseline.summary.meanScore).toFixed(4));
    const dPass = Number((passRate - baseline.summary.passRate).toFixed(4));
    delta = { meanScore: dMean, passRate: dPass };
    verdict = dMean > VERDICT_EPSILON ? "improved" : dMean < -VERDICT_EPSILON ? "regressed" : "held";
  }

  const report: RegressionReport = {
    reportId,
    nodeId: params.nodeId,
    datasetId: dataset.datasetId,
    rubricId: rubric.rubricId,
    executionMode: params.mode,
    cases,
    summary: { casesTotal: cases.length, casesScored: scored, casesFailed: failed, casesPassed: passed, passRate, meanScore, threshold: rubric.passThreshold },
    baseline: baseline ? { reportId: baseline.reportId, meanScore: baseline.summary.meanScore, passRate: baseline.summary.passRate, createdAt: baseline.createdAt } : undefined,
    verdict,
    delta,
    createdAt: now()
  };
  // Record-only: the report is persisted (and becomes the next baseline), nothing is promoted.
  return deps.evaluationRepository.recordRegressionReport(report);
}
