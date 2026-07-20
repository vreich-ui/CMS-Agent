// Champion/challenger replay harness (docs/improvement/STRATEGY.md §1 Trial): historical runs'
// persisted node inputs become frozen EvalCases; challenger variants (prompt/model) re-run against
// them through the existing independent-execution path. Trials never mutate live workspace state:
// a facade suppresses the stage-output mirror so replay cannot bump workspaceVersion or flood the
// change ledger, and trial run ids carry a `trial_` prefix for attribution in runs/usage.
import { executeNode } from "../workspace/nodeRuntime.js";
import type { ExecutionRepository } from "../repository/interfaces/ExecutionRepository.js";
import type { WorkspaceRepository } from "../repository/interfaces/WorkspaceRepository.js";
import type { ImprovementRepository } from "../repository/interfaces/ImprovementRepository.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import { makeImprovementId, stableHash, type EvalCase, type EvalDataset } from "./improvementTypes.js";

const now = () => new Date().toISOString();

export type ReplayDeps = { workspaceRepository: WorkspaceRepository; executionRepository: ExecutionRepository; improvementRepository: ImprovementRepository; evaluationRepository: EvaluationRepository };

// All reads pass through; stage-output writes are dropped. executeNode takes repositories by
// injection, so this needs no change to the runtime itself.
export const trialWorkspaceFacade = (target: WorkspaceRepository): WorkspaceRepository => new Proxy(target, {
  get(repository, property, receiver) {
    if (property === "saveStageOutput") return async () => undefined;
    const value = Reflect.get(repository, property, receiver);
    return typeof value === "function" ? value.bind(repository) : value;
  }
});

// Persisted node-input shapes differ by path: the conductor stores { initialInput, dependencies }
// (executor.ts), independent executions store { input, dependencies } (nodeRuntime.ts).
const storedInput = (raw: unknown): { input?: unknown; dependencies: Record<string, unknown> } => {
  const record = (raw ?? {}) as { initialInput?: unknown; input?: unknown; dependencies?: Record<string, unknown> };
  return { input: record.initialInput ?? record.input, dependencies: record.dependencies ?? {} };
};

export async function buildDataset(params: { nodeId: string; name?: string; limit?: number; projectId?: string }, deps: ReplayDeps): Promise<EvalDataset> {
  const runs = await deps.executionRepository.listRuns(params.projectId ? { projectId: params.projectId } : {});
  const cases: EvalCase[] = [];
  for (const run of runs) {
    if (cases.length >= (params.limit ?? 20)) break;
    const state = run.nodes.find((node) => node.nodeId === params.nodeId);
    if (!state || state.status !== "completed" || state.input === undefined) continue;
    const { input, dependencies } = storedInput(state.input);
    cases.push({ caseId: makeImprovementId("case"), nodeId: params.nodeId, input, dependencyOutputs: dependencies, sourceRunId: run.runId, championOutput: state.output, frozenAt: now() });
  }
  if (!cases.length) throw new Error(`no_replay_cases: no completed executions of ${params.nodeId} with persisted inputs were found; run the conductor (even in mock mode) first.`);
  const dataset: EvalDataset = { datasetId: makeImprovementId("ds"), nodeId: params.nodeId, name: params.name ?? `${params.nodeId} replay`, cases, createdAt: now() };
  return deps.improvementRepository.saveDataset(dataset);
}

export type TrialCaseExecution = { caseId: string; runId: string; status: "completed" | "failed"; output?: unknown };

export async function runTrialCase(params: { evalCase: EvalCase; trialId: string; variant: { promptOverride?: string; modelConfig?: Record<string, unknown> }; mode: "mock" | "openai" }, deps: ReplayDeps): Promise<TrialCaseExecution> {
  const runId = `trial_${params.trialId}_${params.evalCase.caseId}`;
  try {
    const result = await executeNode(
      { nodeId: params.evalCase.nodeId, input: params.evalCase.input, runId, dependencyOutputs: params.evalCase.dependencyOutputs, executionMode: params.mode, modelConfig: params.variant.modelConfig, promptOverride: params.variant.promptOverride },
      { workspaceRepository: trialWorkspaceFacade(deps.workspaceRepository), executionRepository: deps.executionRepository }
    ) as { execution: { status: string; stageOutputs: Record<string, unknown> } };
    if (result.execution.status !== "completed") return { caseId: params.evalCase.caseId, runId, status: "failed" };
    return { caseId: params.evalCase.caseId, runId, status: "completed", output: result.execution.stageOutputs[params.evalCase.nodeId] };
  } catch {
    return { caseId: params.evalCase.caseId, runId, status: "failed" };
  }
}

// Judge/human-approved traces as chat-format SFT JSONL (Vertex tuning / Unsloth both ingest this
// shape). Outputs come from the recorded runs, never re-generated; provenance rides in metadata.
export async function exportSft(params: { nodeId: string; minScore?: number; limit?: number }, deps: ReplayDeps): Promise<{ jsonl: string; count: number }> {
  const node = await deps.workspaceRepository.getNode(params.nodeId);
  if (!node) throw new Error(`Unknown node: ${params.nodeId}`);
  const results = (await deps.evaluationRepository.listResults({ nodeId: params.nodeId, limit: params.limit ?? 200 }))
    .filter((result) => result.runId && (params.minScore !== undefined ? result.normalizedScore >= params.minScore : result.pass));
  const lines: string[] = [];
  for (const result of results) {
    const run = await deps.executionRepository.getRun(result.runId!);
    const state = run?.nodes.find((candidate) => candidate.nodeId === params.nodeId);
    const output = run?.stageOutputs[params.nodeId] ?? state?.output;
    if (!run || output === undefined) continue;
    lines.push(JSON.stringify({
      messages: [
        { role: "system", content: node.prompt },
        { role: "user", content: JSON.stringify(storedInput(state?.input)) },
        { role: "assistant", content: JSON.stringify(output) }
      ],
      metadata: { runId: run.runId, evalId: result.evalId, normalizedScore: result.normalizedScore, rubricId: result.rubricId, promptHash: stableHash(node.prompt) }
    }));
  }
  return { jsonl: lines.join("\n"), count: lines.length };
}

// Preference pairs (chosen/rejected) from decisive pairwise verdicts. Champion output resolves from
// the frozen dataset case, challenger output from the trial-case run record — nothing duplicated.
export async function exportPreferences(params: { nodeId: string; limit?: number }, deps: ReplayDeps): Promise<{ jsonl: string; count: number; skippedInconsistent: number }> {
  const node = await deps.workspaceRepository.getNode(params.nodeId);
  if (!node) throw new Error(`Unknown node: ${params.nodeId}`);
  const comparisons = await deps.evaluationRepository.listPairwise({ nodeId: params.nodeId, limit: params.limit ?? 200 });
  const lines: string[] = [];
  let skippedInconsistent = 0;
  for (const comparison of comparisons) {
    if (comparison.verdict === "inconsistent" || comparison.verdict === "tie") { if (comparison.verdict === "inconsistent") skippedInconsistent += 1; continue; }
    if (!comparison.trialId || !comparison.caseId) continue;
    const trial = await deps.improvementRepository.getTrial(comparison.trialId);
    const dataset = trial ? await deps.improvementRepository.getDataset(trial.datasetId) : undefined;
    const evalCase = dataset?.cases.find((candidate) => candidate.caseId === comparison.caseId);
    const trialCase = trial?.cases.find((candidate) => candidate.caseId === comparison.caseId);
    const challengerOutput = trialCase ? (await deps.executionRepository.getRun(trialCase.runId))?.stageOutputs[params.nodeId] : undefined;
    if (!evalCase || evalCase.championOutput === undefined || challengerOutput === undefined) continue;
    const [chosen, rejected] = comparison.verdict === "challenger" ? [challengerOutput, evalCase.championOutput] : [evalCase.championOutput, challengerOutput];
    lines.push(JSON.stringify({
      prompt: JSON.stringify({ system: node.prompt, input: evalCase.input, dependencies: evalCase.dependencyOutputs }),
      chosen: JSON.stringify(chosen),
      rejected: JSON.stringify(rejected),
      metadata: { comparisonId: comparison.comparisonId, verdict: comparison.verdict, trialId: comparison.trialId }
    }));
  }
  return { jsonl: lines.join("\n"), count: lines.length, skippedInconsistent };
}
