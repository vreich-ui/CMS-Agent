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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Persisted node-input shapes differ by path: the conductor stores { initialInput, dependencies }
// (executor.ts), independent executions store { input, dependencies } (nodeRuntime.ts). EVERYTHING
// ELSE at the top level is conductor-injected context — clientProjectId, `prefetchedContract` (the
// deterministically fetched+reduced client contract), `prefetchError`, `editorialVoice`. It is a
// SIBLING of initialInput, not a field inside it, and a conductor node with dependencies stores
// initialInput: undefined — so a case built from `input` alone carried no contract at all. That is
// why the judge recorded "Source contract was not supplied" on the one real contract_intelligence
// evaluation while the run itself had the contract the whole time.
const storedInput = (raw: unknown): { input?: unknown; dependencies: Record<string, unknown>; context: Record<string, unknown> } => {
  if (!isRecord(raw)) return { dependencies: {}, context: {} };
  const { initialInput, input, dependencies, ...context } = raw as { initialInput?: unknown; input?: unknown; dependencies?: Record<string, unknown> } & Record<string, unknown>;
  return { input: initialInput ?? input, dependencies: (dependencies ?? {}) as Record<string, unknown>, context };
};

// The source contract the node actually had, for the judge to compare the output AGAINST: the
// conductor's prefetch when there is one (contract_intelligence and anything else declaring
// contractPrefetch), else the node's own input, which for a node fed a document IS the source
// material. Undefined when there is genuinely nothing to compare against — the judge is then told so
// explicitly rather than being handed an empty object it would read as "supplied".
export const caseContract = (evalCase: { input?: unknown; context?: Record<string, unknown> }): unknown =>
  evalCase.context?.prefetchedContract ?? (isRecord(evalCase.input) ? evalCase.input.prefetchedContract : undefined) ?? evalCase.input;

// The same reference material the regression gate gives the judge, recovered from a stored run's
// node state — so evaluation.run scores a recorded output against what the node was given, not
// against nothing.
export const judgeEvidenceFromNodeState = (state?: { input?: unknown; toolCalls?: unknown }): { contract?: unknown; dependencyOutputs: Record<string, unknown>; toolCalls?: unknown } => {
  const { input, dependencies, context } = storedInput(state?.input);
  const contract = caseContract({ input, context });
  return { ...(contract !== undefined ? { contract } : {}), dependencyOutputs: dependencies, ...(state?.toolCalls !== undefined ? { toolCalls: state.toolCalls } : {}) };
};

// A frozen case replays with the SAME conductor-injected context the original run had, merged back
// alongside the input. Without it contract_intelligence is re-executed with no contract and then
// judged on contract fidelity — a guaranteed, meaningless failure.
export const replayInput = (evalCase: { input?: unknown; context?: Record<string, unknown> }): unknown => {
  const context = evalCase.context;
  if (!context || !Object.keys(context).length) return evalCase.input;
  return isRecord(evalCase.input)
    ? { ...context, ...evalCase.input }
    : { ...context, ...(evalCase.input !== undefined ? { initialInput: evalCase.input } : {}) };
};

export async function buildDataset(params: { nodeId: string; name?: string; limit?: number; projectId?: string; executionMode?: "mock" | "openai"; allowDuplicateSubjects?: boolean }, deps: ReplayDeps): Promise<EvalDataset> {
  const runs = await deps.executionRepository.listRuns(params.projectId ? { projectId: params.projectId } : {});
  const cases: EvalCase[] = [];
  // A case's discriminating power lives in its replay SUBJECT — input + dependency outputs + injected
  // context. Two cases with the same subject hash re-execute to the same output and score
  // identically, so a dataset of four of them is a dataset of one: ds_1785772079588_9a01hb froze four
  // contract_intelligence cases that all hashed to e8b1ed18 and produced byte-identical scores, and
  // the regression verdict computed from it looked exactly like a real one. Duplicates are dropped by
  // default and the distinct count travels on the dataset, so a degenerate dataset is visible at
  // BUILD time instead of being discovered as a suspiciously stable verdict months later.
  const subjectHashes = new Set<string>();
  let duplicateSubjects = 0;
  for (const run of runs) {
    if (cases.length >= (params.limit ?? 20)) break;
    // Mode filter, opt-in: pass executionMode:"openai" to freeze a dataset of REAL champions only.
    // Left unset the behaviour is unchanged (mock cases still included) because mock cases are what
    // make a plumbing test possible at all — but every case now says which it is, so a caller that
    // cares can no longer be fooled by a placeholder champion.
    if (params.executionMode && run.executionMode !== params.executionMode) continue;
    const state = run.nodes.find((node) => node.nodeId === params.nodeId);
    if (!state || state.status !== "completed" || state.input === undefined) continue;
    const { input, dependencies, context } = storedInput(state.input);
    const subjectHash = stableHash({ input, dependencies, context });
    if (subjectHashes.has(subjectHash)) {
      duplicateSubjects += 1;
      if (!params.allowDuplicateSubjects) continue;
    }
    subjectHashes.add(subjectHash);
    cases.push({ caseId: makeImprovementId("case"), nodeId: params.nodeId, input, dependencyOutputs: dependencies, ...(Object.keys(context).length ? { context } : {}), subjectHash, sourceRunId: run.runId, sourceExecutionMode: run.executionMode, championOutput: state.output, frozenAt: now() });
  }
  if (!cases.length) throw new Error(`no_replay_cases: no completed executions of ${params.nodeId}${params.executionMode ? ` in ${params.executionMode} mode` : ""} with persisted inputs were found; run the conductor (even in mock mode) first.`);
  const degenerate = subjectHashes.size < 2;
  const metadata = {
    distinctSubjects: subjectHashes.size,
    duplicateSubjects,
    degenerate,
    ...(degenerate ? { warning: `degenerate_dataset: ${cases.length} case(s) over ${subjectHashes.size} distinct subject(s) — every case replays to the same output, so any regression or trial verdict from it has no discriminating power. Rebuild from runs with genuinely different inputs (dataset.build with executionMode:"openai" once real runs exist).` } : {})
  };
  const dataset: EvalDataset = { datasetId: makeImprovementId("ds"), nodeId: params.nodeId, name: params.name ?? `${params.nodeId} replay`, cases, metadata, createdAt: now() };
  return deps.improvementRepository.saveDataset(dataset);
}

export type TrialCaseExecution = { caseId: string; runId: string; status: "completed" | "failed"; output?: unknown };

export async function runTrialCase(params: { evalCase: EvalCase; trialId: string; variant: { promptOverride?: string; modelConfig?: Record<string, unknown> }; mode: "mock" | "openai" }, deps: ReplayDeps): Promise<TrialCaseExecution> {
  const runId = `trial_${params.trialId}_${params.evalCase.caseId}`;
  try {
    const result = await executeNode(
      { nodeId: params.evalCase.nodeId, input: replayInput(params.evalCase), runId, dependencyOutputs: params.evalCase.dependencyOutputs, executionMode: params.mode, modelConfig: params.variant.modelConfig, promptOverride: params.variant.promptOverride },
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
