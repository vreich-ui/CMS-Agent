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
import { buildDataset, caseContract, runTrialCase, type ReplayDeps } from "./replay.js";
import { makeImprovementId, type EvalRubric, type RegressionCaseResult, type RegressionDrift, type RegressionGateReason, type RegressionReport } from "./improvementTypes.js";

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
  // Three disjoint buckets, because conflating them is how both production reports came to read
  // "casesScored 4, casesPassed 0, casesFailed 0" while every one of the four cases was pass:false:
  //  - errored  = the node could not be executed at all, so there is no score (was counted as
  //               casesFailed, which is why an execution failure and a rubric failure were the same
  //               number and neither was the number of cases that actually failed the rubric);
  //  - passed   = scored AND the rubric passed;
  //  - failed   = scored AND the rubric failed (this increment simply did not exist).
  // Invariants the report must satisfy: passed + failed === scored, scored + errored === total.
  let scoreSum = 0, scored = 0, passed = 0, failed = 0, errored = 0;
  for (const evalCase of dataset.cases.slice(0, Math.max(1, params.caseLimit ?? dataset.cases.length))) {
    // variant {} = the node exactly as it stands. runTrialCase runs it through the trial workspace
    // facade, so a regression run never bumps workspaceVersion or writes live stage outputs.
    const execution = await runTrialCase({ evalCase, trialId: reportId, variant: {}, mode: params.mode }, deps);
    if (execution.status === "failed") {
      errored += 1;
      cases.push({ caseId: evalCase.caseId, runId: execution.runId, status: "failed" });
      continue;
    }
    // Give the judge the same reference material the node had: the case's frozen SOURCE CONTRACT
    // (caseContract digs out the conductor's prefetch, which does not live in `input`) and its
    // upstream dependency outputs (the approved body a
    // payload must map exactly). Without these the heaviest criteria in these rubrics are unjudgeable
    // and quietly score fluency instead — see JudgeEvidence.
    const evalResult = await scoreOutput({
      rubric,
      nodeId: params.nodeId,
      output: execution.output,
      mode: params.mode,
      refs: { trialId: reportId, caseId: evalCase.caseId, runId: execution.runId },
      evidence: { contract: caseContract(evalCase), dependencyOutputs: evalCase.dependencyOutputs }
    }, deps);
    scoreSum += evalResult.normalizedScore;
    scored += 1;
    if (evalResult.pass) passed += 1; else failed += 1;
    cases.push({ caseId: evalCase.caseId, runId: execution.runId, status: "completed", evalId: evalResult.evalId, normalizedScore: evalResult.normalizedScore, pass: evalResult.pass });
  }

  const meanScore = scored ? Number((scoreSum / scored).toFixed(4)) : 0;
  const passRate = scored ? Number((passed / scored).toFixed(4)) : 0;

  // Baseline = the node's most recent prior report IN THE SAME EXECUTION MODE (read before this one
  // is recorded). Mode-scoping is not a nicety: a mock report's score is a pseudo-random function of
  // the output hash, so grading a real run against a mock baseline yields a confident, entirely
  // meaningless improved/regressed verdict. Session B hit exactly this — its plumbing-proof mock
  // report would otherwise have become the baseline for Session D's real contract_intelligence
  // regression. Modes are separate ledgers; they are not comparable and must never silently compare.
  const priorReports = await deps.evaluationRepository.listRegressionReports({ nodeId: params.nodeId });
  const baseline = priorReports.find((report) => report.executionMode === params.mode);
  let drift: RegressionDrift;
  let delta: { meanScore: number; passRate: number } | undefined;
  if (!baseline) {
    drift = "baseline_set";
  } else {
    const dMean = Number((meanScore - baseline.summary.meanScore).toFixed(4));
    const dPass = Number((passRate - baseline.summary.passRate).toFixed(4));
    delta = { meanScore: dMean, passRate: dPass };
    drift = dMean > VERDICT_EPSILON ? "improved" : dMean < -VERDICT_EPSILON ? "regressed" : "held";
  }

  // ABSOLUTE health, against the rubric's own passThreshold and nothing else. Drift alone answered
  // "did it move?", so a node scoring 0.484 against a 0.85 threshold with all four cases failing
  // reported "held" — stable, and stably broken — and would have gone on reporting it forever. No
  // epsilon here on purpose: drift tolerates float wobble because a 1e-5 move is not news, but a mean
  // below the threshold the rubric itself declares is not a wobble, it is a failure.
  const gateReasons: RegressionGateReason[] = [];
  if (!scored) gateReasons.push("no_cases_scored");
  else {
    if (meanScore < rubric.passThreshold) gateReasons.push("mean_below_threshold");
    if (failed > 0) gateReasons.push("cases_failed");
  }
  if (errored > 0) gateReasons.push("cases_errored");
  const gate = gateReasons.length ? "fail" : "pass";

  const report: RegressionReport = {
    reportId,
    nodeId: params.nodeId,
    datasetId: dataset.datasetId,
    rubricId: rubric.rubricId,
    executionMode: params.mode,
    cases,
    summary: { casesTotal: cases.length, casesScored: scored, casesFailed: failed, casesPassed: passed, casesErrored: errored, passRate, meanScore, threshold: rubric.passThreshold },
    baseline: baseline ? { reportId: baseline.reportId, meanScore: baseline.summary.meanScore, passRate: baseline.summary.passRate, createdAt: baseline.createdAt } : undefined,
    gate,
    gateReasons,
    drift,
    // The headline reports the gate FIRST: a node below its own threshold must never read as healthy
    // because it happens not to have moved since the last equally-broken run.
    verdict: gate === "fail" ? "failing" : drift,
    delta,
    createdAt: now()
  };
  // Record-only: the report is persisted (and becomes the next baseline), nothing is promoted.
  return deps.evaluationRepository.recordRegressionReport(report);
}
