// GEPA-style reflective optimizer (docs/improvement/STRATEGY.md §2): diagnose a node from eval
// evidence, propose a prompt mutation in natural language, trial it against frozen replay cases
// with pairwise judging, and promote winners through the versioned mutate() funnel — attributable,
// evidence-cited, one-step reversible via changes.restore. PROPOSE-ONLY by default: promotion is a
// separate explicit call carrying the caller's mutation meta; nothing auto-applies.
//
// T21.22 — "eval evidence" now means TWO kinds. Rubric evaluation judges the artifact against a
// written standard; engagement evidence (engagement.ts, from the tracking outer loop) measures what
// readers actually did with the published output, against the site's own median. The second exists
// because the first structurally cannot see the case that matters most: content that scores well on
// the rubric and still fails with readers. DIAGNOSIS reads both; TRIALS deliberately still do not —
// a trial replays frozen cases and is judged by rubric alone, because a challenger prompt has no
// published audience to measure and an online metric there would be a number with no experiment
// behind it. Engagement decides WHAT to change, never WHETHER the change won.
//
// Scope note (updated — Phase 5 landed): a promoted prompt is live for independent execution and
// replay, and now ALSO for full conductor runs when WORKSPACE_NODES_SOURCE=store (the executor
// resolves nodes from the workspace store behind a canonical-node guard — see executor.ts /
// docs/platform/DIRECTION.md Phase 5). With the default WORKSPACE_NODES_SOURCE=static the conductor
// still runs the static nodes.ts definitions, so treat conductor pickup as opt-in until that flip.
import { getNodeRunner } from "../execution/runnerRegistry.js";
import type { WorkspaceNode } from "../workspace/nodeTypes.js";
import type { WorkflowExecutionRecord } from "../workspace/executionTypes.js";
import type { WorkspaceMutationMeta } from "../mcp/workspace/store.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import { comparePairwise, scoreOutput } from "./rubricJudge.js";
import { buildDataset, caseContract, runTrialCase, type ReplayDeps } from "./replay.js";
import { recommendModel, type ModelLadderRecommendation } from "./modelLadder.js";
import { makeImprovementId, stableHash, type EvalRubric, type ImprovementProposal, type ProposalCause, type TrialCaseResult, type TrialRecord } from "./improvementTypes.js";
import { ENGAGEMENT_MIN_SESSIONS, buildEngagementBlock, diagnoseEngagement, renderEngagementEvidence, type EngagementBlock } from "./engagement.js";

const now = () => new Date().toISOString();

// The tracking sink's transport and env are injectable so analyzeNode's engagement lookup is
// testable without a live sink; both default to the process's own, exactly as the ingest bridge does.
export type OptimizerDeps = ReplayDeps & { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv };

export type NodeAnalysis = {
  nodeId: string;
  sampleSize: number;
  meanScore?: number;
  passRate?: number;
  worstCriteria: Array<{ criterionId: string; meanScore: number; maxScore: number }>;
  failureCodes: Record<string, number>;
  feedback: { approvals: number; rejections: number; edits: number; outcomes: number };
  // Measured reader behaviour on this node's PUBLISHED output, compared against the site median for
  // the same window (T21.22). `feedback.outcomes` above still only COUNTS those records; this is
  // what reads them. Absent — and the whole analysis then identical to what it was before T21.22 —
  // when the tracking sink is unconfigured or unreachable, or the node has no engagement records in
  // the window. See engagement.ts for the floor and the no-fabrication rules.
  engagement?: EngagementBlock;
  evidence: { evalIds: string[]; runIds: string[]; feedbackIds: string[] };
};

export async function analyzeNode(params: { nodeId: string; from?: string; to?: string; projectId?: string }, deps: OptimizerDeps): Promise<NodeAnalysis> {
  const results = await deps.evaluationRepository.listResults({ nodeId: params.nodeId, from: params.from, to: params.to, limit: 200 });
  const feedback = await deps.evaluationRepository.listFeedback({ nodeId: params.nodeId, limit: 200 });
  const runs = await deps.executionRepository.listRuns({});
  const failureCodes: Record<string, number> = {};
  const failedRunIds: string[] = [];
  for (const run of runs) {
    for (const error of run.errors ?? []) {
      if (!error.startsWith(`${params.nodeId}:`)) continue;
      const code = error.slice(params.nodeId.length + 1);
      failureCodes[code] = (failureCodes[code] ?? 0) + 1;
      failedRunIds.push(run.runId);
    }
  }
  const criterionTotals = new Map<string, { total: number; max: number; count: number }>();
  for (const result of results) {
    for (const score of result.scores) {
      const bucket = criterionTotals.get(score.criterionId) ?? { total: 0, max: score.max, count: 0 };
      bucket.total += score.score;
      bucket.count += 1;
      criterionTotals.set(score.criterionId, bucket);
    }
  }
  const worstCriteria = [...criterionTotals.entries()]
    .map(([criterionId, bucket]) => ({ criterionId, meanScore: Number((bucket.total / bucket.count).toFixed(3)), maxScore: bucket.max }))
    .sort((a, b) => a.meanScore / a.maxScore - b.meanScore / b.maxScore)
    .slice(0, 3);
  // Best-effort by construction: buildEngagementBlock never throws, and this guard is the belt to
  // that braces — analyzeNode is on the post-run reflection path and a tracking sink must never be
  // able to take a node analysis down.
  let engagement: EngagementBlock | undefined;
  try {
    engagement = await buildEngagementBlock({ feedback, from: params.from, to: params.to, projectId: params.projectId }, { fetchImpl: deps.fetchImpl, env: deps.env });
  } catch {
    engagement = undefined;
  }
  return {
    nodeId: params.nodeId,
    sampleSize: results.length,
    meanScore: results.length ? Number((results.reduce((sum, result) => sum + result.normalizedScore, 0) / results.length).toFixed(4)) : undefined,
    passRate: results.length ? Number((results.filter((result) => result.pass).length / results.length).toFixed(4)) : undefined,
    worstCriteria,
    failureCodes,
    feedback: {
      approvals: feedback.filter((record) => record.kind === "approve").length,
      rejections: feedback.filter((record) => record.kind === "reject").length,
      edits: feedback.filter((record) => record.kind === "edit").length,
      outcomes: feedback.filter((record) => record.kind === "outcome").length
    },
    ...(engagement ? { engagement } : {}),
    evidence: {
      evalIds: results.slice(0, 20).map((result) => result.evalId),
      runIds: [...new Set(failedRunIds)].slice(0, 20),
      feedbackIds: feedback.slice(0, 20).map((record) => record.feedbackId)
    }
  };
}

const reflectorOutputSchema = {
  type: "object",
  required: ["diagnosis", "proposedPrompt", "rationale"],
  additionalProperties: false,
  properties: { diagnosis: { type: "string" }, proposedPrompt: { type: "string" }, rationale: { type: "string" } }
};

const syntheticReflectorNode = (prompt: string): WorkspaceNode => ({
  id: "improvement_reflector", name: "Prompt reflector", kind: "improvement",
  description: "Synthetic GEPA-style reflection node; never persisted in the workspace graph.",
  prompt, schema: reflectorOutputSchema as Record<string, unknown>, inputSchema: { type: "object", additionalProperties: true }, outputSchema: reflectorOutputSchema as Record<string, unknown>,
  allowedTools: [], requiredInputs: [], produces: ["improvement_proposal.v1"], riskLevel: "read", dependsOn: [], status: "active",
  position: { x: 0, y: 0 }, updatedAt: now(), assignedSkills: [],
  modelConfig: { model: process.env.IMPROVEMENT_REFLECTOR_MODEL ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5" },
  metadata: { synthetic: true }
} as unknown as WorkspaceNode);

export async function proposeImprovement(params: { nodeId: string; mode: "mock" | "openai"; rubric?: EvalRubric }, deps: OptimizerDeps): Promise<ImprovementProposal> {
  const node = await deps.workspaceRepository.getNode(params.nodeId);
  if (!node) throw new Error(`Unknown node: ${params.nodeId}`);
  const analysis = await analyzeNode({ nodeId: params.nodeId }, deps);
  const worst = analysis.worstCriteria[0];
  // The named cause is decided HERE, from the evidence, in both modes — a reflector model never picks
  // it. An engagement shortfall on a node whose rubric is healthy is its OWN cause, not a worse
  // reading of worstCriteria[0]: blending the two is exactly how this failure stayed invisible, since
  // the resulting proposal always described a criterion problem the criteria did not have.
  const engaged = diagnoseEngagement(analysis, analysis.engagement);
  // Empty below the session floor, with an unconfigured/unreachable sink, or with nothing comparable
  // — so an under-evidenced node's prompt is byte-identical to what it was before T21.22.
  const engagementEvidence = renderEngagementEvidence(analysis.engagement);
  const cause: ProposalCause = engaged ? engaged.cause : worst ? "rubric_criterion" : "no_evidence";
  const rationale = engaged
    ? engaged.rationale
    : worst
      ? `rubric_criterion: criterion "${worst.criterionId}" averages ${worst.meanScore}/${worst.maxScore} across ${analysis.sampleSize} evaluation${analysis.sampleSize === 1 ? "" : "s"}.`
      : `no_evidence: no criterion-level evaluation evidence for this node, and no engagement evidence above the ${ENGAGEMENT_MIN_SESSIONS}-session floor.`;
  let diagnosis: string;
  let proposedPrompt: string;
  if (params.mode === "mock") {
    if (engaged) {
      diagnosis = `Deterministic reflection [${engaged.cause}]: ${engaged.rationale}`;
      proposedPrompt = `${node.prompt}\nEngagement bar: published output from this node underperforms the site median on ${engaged.shortfalls.map((shortfall) => shortfall.metric).join(", ")} (${engaged.comparison}) while passing its rubric. Write to hold a reader, not only to satisfy the rubric: open on the reader's own problem, make the payoff explicit before they have to scroll for it, and give one unmistakable next action — and state in your output's notes which choice you made for that.`;
    } else {
      diagnosis = worst
        ? `Deterministic reflection [${cause}]: criterion "${worst.criterionId}" averages ${worst.meanScore}/${worst.maxScore} across ${analysis.sampleSize} evaluations — the prompt gives it no explicit completion bar.`
        : `Deterministic reflection [${cause}]: no criterion-level evidence yet (sample ${analysis.sampleSize}); tightening output expectations as a baseline mutation.`;
      proposedPrompt = `${node.prompt}\nQuality bar: explicitly satisfy ${worst ? `the "${worst.criterionId}" criterion` : "every rubric criterion"} — state the evidence for it in your output's notes.`;
    }
  } else {
    const timestamp = now();
    const run: WorkflowExecutionRecord = { runId: makeImprovementId("reflect"), workflowId: "improvement_reflector", projectId: "workspace", status: "running", startedAt: timestamp, updatedAt: timestamp, nodes: [], artifacts: [], errors: [], approvalsRequired: [], stageOutputs: {}, dryRun: true, executionMode: "openai" } as WorkflowExecutionRecord;
    const reflectorPrompt = [
      "You are a prompt engineer improving one agent in a content pipeline (GEPA-style reflection).",
      "Given the agent's current prompt and evaluation evidence, diagnose the weakness in plain language and propose a full replacement prompt.",
      "Keep everything that already works; change surgically; keep the prompt's structural template (Objective/Inputs/Output/Completion/Blocker/Tool policy/Memory policy) intact.",
      // Only present above the session floor, and only with a real site median to compare against —
      // otherwise the reflector is told nothing about engagement and behaves exactly as before.
      ...(engagementEvidence ? ["", engagementEvidence] : []),
      ...(engaged ? ["", `The named cause of this proposal is ${engaged.cause}: the node meets its written standard and still underperforms the site on reader behaviour. Do NOT propose a stricter rubric bar for it — that is the standard it already passes.`] : []),
      "Return only JSON matching the schema."
    ].join("\n");
    const result = await getNodeRunner("openai").run(
      { node: syntheticReflectorNode(reflectorPrompt), input: { input: { currentPrompt: node.prompt, analysis, engagementEvidence: engagementEvidence || undefined } } },
      { run, executionRepository: deps.executionRepository }
    );
    if (!result.ok) throw new Error(`reflection_failed: ${result.code}: ${result.message}`);
    const output = result.output as { diagnosis: string; proposedPrompt: string };
    diagnosis = output.diagnosis;
    proposedPrompt = output.proposedPrompt;
  }
  const proposal: ImprovementProposal = {
    proposalId: makeImprovementId("prop"),
    nodeId: params.nodeId,
    status: "proposed",
    diagnosis,
    cause,
    rationale,
    change: { kind: "prompt", prompt: proposedPrompt },
    evidence: analysis.evidence,
    baselinePromptHash: stableHash(node.prompt),
    trialIds: [],
    createdAt: now(),
    updatedAt: now()
  };
  return deps.improvementRepository.saveProposal(proposal);
}

async function resolveActiveRubric(nodeId: string, rubricId: string | undefined, evaluationRepository: EvaluationRepository): Promise<EvalRubric> {
  if (rubricId) {
    const rubric = await evaluationRepository.getRubric(rubricId);
    if (!rubric) throw new Error(`Unknown rubric: ${rubricId}`);
    return rubric;
  }
  const active = await evaluationRepository.listRubrics({ nodeId, status: "active" });
  if (!active.length) throw new Error(`no_active_rubric: create a rubric for ${nodeId} before judging trials (evaluation.create_rubric).`);
  return active[0]!;
}

export async function runTrial(params: { proposalId?: string; nodeId?: string; promptOverride?: string; modelConfig?: Record<string, unknown>; datasetId?: string; rubricId?: string; mode: "mock" | "openai"; caseLimit?: number }, deps: OptimizerDeps): Promise<TrialRecord> {
  const proposal = params.proposalId ? await deps.improvementRepository.getProposal(params.proposalId) : undefined;
  if (params.proposalId && !proposal) throw new Error(`Unknown proposal: ${params.proposalId}`);
  const nodeId = proposal?.nodeId ?? params.nodeId;
  if (!nodeId) throw new Error("Provide proposalId or nodeId.");
  const variant = proposal
    ? proposal.change.kind === "prompt" ? { promptOverride: proposal.change.prompt } : { modelConfig: proposal.change.modelConfig }
    : { promptOverride: params.promptOverride, modelConfig: params.modelConfig };
  if (!variant.promptOverride && !variant.modelConfig) throw new Error("Nothing to trial: provide a proposal, promptOverride, or modelConfig.");
  const dataset = params.datasetId
    ? await deps.improvementRepository.getDataset(params.datasetId)
    : (await deps.improvementRepository.listDatasets({ nodeId }))[0] ?? await buildDataset({ nodeId }, deps);
  if (!dataset) throw new Error(`Unknown dataset: ${params.datasetId}`);
  const rubric = await resolveActiveRubric(nodeId, params.rubricId, deps.evaluationRepository);

  const trialId = makeImprovementId("trial");
  const cases: TrialCaseResult[] = [];
  let championWins = 0, challengerWins = 0, ties = 0, inconsistent = 0, casesFailed = 0, scoreSum = 0, scored = 0;
  for (const evalCase of dataset.cases.slice(0, Math.max(1, params.caseLimit ?? dataset.cases.length))) {
    const execution = await runTrialCase({ evalCase, trialId, variant, mode: params.mode }, deps);
    if (execution.status === "failed") { casesFailed += 1; cases.push({ caseId: evalCase.caseId, runId: execution.runId, status: "failed" }); continue; }
    // Same reference material the regression gate gives the judge (see JudgeEvidence): a challenger
    // scored without the source contract is scored on fluency, which is exactly the property a
    // cheaper challenger model preserves while degrading everything else.
    const evalResult = await scoreOutput({ rubric, nodeId, output: execution.output, mode: params.mode, refs: { trialId, caseId: evalCase.caseId, runId: execution.runId, subject: { model: String(variant.modelConfig?.model ?? "node_default"), executionMode: params.mode } }, evidence: { contract: caseContract(evalCase), dependencyOutputs: evalCase.dependencyOutputs } }, deps);
    scoreSum += evalResult.normalizedScore; scored += 1;
    let comparisonId: string | undefined;
    if (evalCase.championOutput !== undefined) {
      const comparison = await comparePairwise({ rubric, nodeId, champion: evalCase.championOutput, challenger: execution.output, mode: params.mode, refs: { trialId, caseId: evalCase.caseId } }, deps);
      comparisonId = comparison.comparisonId;
      if (comparison.verdict === "champion") championWins += 1;
      else if (comparison.verdict === "challenger") challengerWins += 1;
      else if (comparison.verdict === "tie") ties += 1;
      else inconsistent += 1;
    }
    cases.push({ caseId: evalCase.caseId, runId: execution.runId, status: "completed", evalId: evalResult.evalId, comparisonId });
  }

  const trial: TrialRecord = {
    trialId,
    proposalId: proposal?.proposalId,
    nodeId,
    datasetId: dataset.datasetId,
    variant,
    executionMode: params.mode,
    status: casesFailed === dataset.cases.length ? "failed" : "completed",
    cases,
    summary: { championWins, challengerWins, ties, inconsistent, casesFailed, meanChallengerScore: scored ? Number((scoreSum / scored).toFixed(4)) : 0 },
    createdAt: now()
  };
  await deps.improvementRepository.saveTrial(trial);
  if (proposal) await deps.improvementRepository.saveProposal({ ...proposal, status: "trialed", trialIds: [...proposal.trialIds, trialId], updatedAt: now() });
  return trial;
}

// Promotion writes through the versioned mutate() funnel with a structured, evidence-citing
// reason. The baseline-hash guard refuses stale proposals (the prompt moved since the diagnosis),
// matching the repo's optimistic-concurrency idiom. Rollback is the existing changes.restore.
export async function promoteProposal(params: { proposalId: string; meta: WorkspaceMutationMeta }, deps: OptimizerDeps): Promise<{ proposal: ImprovementProposal; workspaceVersion: number }> {
  const proposal = await deps.improvementRepository.getProposal(params.proposalId);
  if (!proposal) throw new Error(`Unknown proposal: ${params.proposalId}`);
  if (proposal.status === "promoted") throw new Error(`already_promoted: ${params.proposalId}`);
  const node = await deps.workspaceRepository.getNode(proposal.nodeId);
  if (!node) throw new Error(`Unknown node: ${proposal.nodeId}`);
  if (stableHash(node.prompt) !== proposal.baselinePromptHash) {
    throw new Error(`stale_baseline: the prompt of ${proposal.nodeId} changed after this proposal was made; re-run optimizer.propose against the current prompt.`);
  }
  const bestTrial = (await deps.improvementRepository.listTrials({ proposalId: proposal.proposalId }))[0];
  const reason = `optimizer: ${proposal.diagnosis.slice(0, 160)}${bestTrial ? ` [trial ${bestTrial.trialId}: challenger ${bestTrial.summary.challengerWins}W/${bestTrial.summary.championWins}L/${bestTrial.summary.ties}T, mean ${bestTrial.summary.meanChallengerScore}]` : " [no trial recorded]"}`;
  const meta: WorkspaceMutationMeta = { ...params.meta, reason: params.meta.reason ?? reason, summary: params.meta.summary ?? `Promote improvement proposal ${proposal.proposalId}` };
  let workspaceVersion: number;
  if (proposal.change.kind === "prompt") {
    ({ workspaceVersion } = await deps.workspaceRepository.updateNodePrompt(proposal.nodeId, proposal.change.prompt, meta));
  } else {
    ({ workspaceVersion } = await deps.workspaceRepository.updateNode(proposal.nodeId, { modelConfig: { ...node.modelConfig, ...proposal.change.modelConfig } }, meta, "node.model_config_updated"));
  }
  const promoted = await deps.improvementRepository.saveProposal({ ...proposal, status: "promoted", updatedAt: now() });
  return { proposal: promoted, workspaceVersion };
}

export type OptimizerStatus = {
  nodeId?: string;
  proposals: ImprovementProposal[];
  trials: Array<Pick<TrialRecord, "trialId" | "proposalId" | "nodeId" | "status" | "summary" | "createdAt">>;
  modelLadder?: ModelLadderRecommendation;
};

export async function optimizerStatus(params: { nodeId?: string }, deps: OptimizerDeps): Promise<OptimizerStatus> {
  const proposals = await deps.improvementRepository.listProposals(params.nodeId ? { nodeId: params.nodeId } : {});
  const trials = (await deps.improvementRepository.listTrials(params.nodeId ? { nodeId: params.nodeId } : {}))
    .map(({ trialId, proposalId, nodeId, status, summary, createdAt }) => ({ trialId, proposalId, nodeId, status, summary, createdAt }));
  const modelLadder = params.nodeId
    ? recommendModel({ nodeId: params.nodeId, results: await deps.evaluationRepository.listResults({ nodeId: params.nodeId, limit: 200 }) })
    : undefined;
  return { nodeId: params.nodeId, proposals, trials, modelLadder };
}
