// Improvement Engine MCP surface (DIRECTION.md Phase 3): evaluation.*, feedback.*, dataset.*,
// optimizer.*, playbook.*. Follows the changesTools factory conventions: zod .strict() inputs,
// hand-written JSON schemas, ok() results, meta() actor stamping on mutations, and
// coerceJsonObjectInput on every object-typed parameter (MCP clients stringify nested objects).
// Ops note: if MCP_EXPOSED_TOOL_PREFIXES is set, add these namespaces to expose them.
import { z } from "zod";
import { coerceJsonObjectInput, metaJson, mutationMeta, objectSchema, ok, tool, type WorkspaceTool } from "./toolKit.js";
import type { WorkspaceMutationMeta } from "./store.js";
import type { WorkspaceRepository } from "../../repository/interfaces/WorkspaceRepository.js";
import type { ExecutionRepository } from "../../repository/interfaces/ExecutionRepository.js";
import type { LearningRepository } from "../../repository/interfaces/LearningRepository.js";
import type { EvaluationRepository } from "../../repository/interfaces/EvaluationRepository.js";
import type { ImprovementRepository } from "../../repository/interfaces/ImprovementRepository.js";
import { redactSensitiveKeys } from "../../observability/redaction.js";
import { evalRubricInputSchema, feedbackKinds, makeImprovementId, playbookDeltaSchema, rubricStatuses, type EvalRubric, type FeedbackRecord, type PlaybookDelta } from "../../improvement/improvementTypes.js";
import { applyPlaybookDelta, renderPlaybookForPrompt } from "../../improvement/playbook.js";
import { scoreOutput } from "../../improvement/rubricJudge.js";
import { buildDataset, exportPreferences, exportSft, type ReplayDeps } from "../../improvement/replay.js";
import { analyzeNode, optimizerStatus, promoteProposal, proposeImprovement, runTrial } from "../../improvement/optimizer.js";
import { autoPromoteProposals } from "../../improvement/autoPromote.js";
import { curatePlaybook } from "../../improvement/curator.js";
import { ingestMonetizerAnalytics, MONETIZER_SIGNALS } from "../../improvement/monetizerIngest.js";
import { evaluateFineTuneReadiness } from "../../improvement/fineTune.js";
import { runRegression } from "../../improvement/regression.js";

const now = () => new Date().toISOString();
const modeSchema = z.enum(["mock", "openai"]).default("mock");
const modeJson = { type: "string", enum: ["mock", "openai"], default: "mock" };

export type ImprovementToolDeps = {
  workspaceRepository: WorkspaceRepository;
  executionRepository: ExecutionRepository;
  learningRepository: LearningRepository;
  evaluationRepository: EvaluationRepository;
  improvementRepository: ImprovementRepository;
  meta: <T extends Partial<WorkspaceMutationMeta>>(data: T) => T & WorkspaceMutationMeta;
};

export function createImprovementTools(deps: ImprovementToolDeps): WorkspaceTool[] {
  const { evaluationRepository, improvementRepository, learningRepository, meta } = deps;
  const replayDeps: ReplayDeps = deps;

  const createRubricInput = z.object({ rubric: z.unknown(), ...mutationMeta }).strict();
  const updateRubricInput = z.object({ rubricId: z.string().min(1), patch: z.unknown(), ...mutationMeta }).strict();
  const rubricIdInput = z.object({ rubricId: z.string().min(1) }).strict();
  const listRubricsInput = z.object({ nodeId: z.string().min(1).optional(), status: z.enum(rubricStatuses).optional() }).strict();
  const restoreRubricInput = z.object({ rubricId: z.string().min(1), versionId: z.string().min(1), ...mutationMeta }).strict();
  const evaluationRunInput = z.object({ nodeId: z.string().min(1), rubricId: z.string().min(1).optional(), runId: z.string().min(1).optional(), output: z.unknown().optional(), mode: modeSchema }).strict();
  const listResultsInput = z.object({ nodeId: z.string().min(1).optional(), runId: z.string().min(1).optional(), rubricId: z.string().min(1).optional(), trialId: z.string().min(1).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
  const feedbackRecordInput = z.object({ kind: z.enum(feedbackKinds), nodeId: z.string().min(1).optional(), runId: z.string().min(1).optional(), evalId: z.string().min(1).optional(), editDiff: z.unknown().optional(), outcome: z.unknown().optional(), note: z.string().min(1).optional(), ...mutationMeta }).strict();
  const listFeedbackInput = z.object({ nodeId: z.string().min(1).optional(), runId: z.string().min(1).optional(), kind: z.enum(feedbackKinds).optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
  const ingestMonetizerInput = z.object({ nodeId: z.string().min(1).optional(), runId: z.string().min(1).optional(), signals: z.array(z.enum(["performance", "demand_signals"])).min(1).optional(), args: z.unknown().optional(), note: z.string().min(1).optional(), ...mutationMeta }).strict();
  const datasetBuildInput = z.object({ nodeId: z.string().min(1), name: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional(), projectId: z.string().min(1).optional() }).strict();
  const datasetIdInput = z.object({ datasetId: z.string().min(1) }).strict();
  const nodeFilterInput = z.object({ nodeId: z.string().min(1).optional() }).strict();
  const exportSftInput = z.object({ nodeId: z.string().min(1), minScore: z.number().min(0).max(1).optional(), limit: z.number().int().min(1).max(500).optional() }).strict();
  const exportPrefInput = z.object({ nodeId: z.string().min(1), limit: z.number().int().min(1).max(500).optional() }).strict();
  const fineTuneReadinessInput = z.object({ nodeId: z.string().min(1), minScore: z.number().min(0).max(1).optional() }).strict();
  const analyzeInput = z.object({ nodeId: z.string().min(1), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
  const proposeInput = z.object({ nodeId: z.string().min(1), mode: modeSchema }).strict();
  const runTrialInput = z.object({ proposalId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(), promptVariant: z.string().min(1).optional(), modelConfigVariant: z.unknown().optional(), datasetId: z.string().min(1).optional(), rubricId: z.string().min(1).optional(), mode: modeSchema, caseLimit: z.number().int().min(1).max(100).optional() }).strict();
  const promoteInput = z.object({ proposalId: z.string().min(1), ...mutationMeta }).strict();
  const autoPromoteInput = z.object({ nodeId: z.string().min(1).optional(), dryRun: z.boolean().optional(), minScore: z.number().min(0).max(1).optional(), max: z.number().int().min(1).max(50).optional(), ...mutationMeta }).strict();
  const nodeIdInput = z.object({ nodeId: z.string().min(1) }).strict();
  const applyDeltaInput = z.object({ nodeId: z.string().min(1), delta: z.unknown(), ...mutationMeta }).strict();
  const curateInput = z.object({ nodeId: z.string().min(1), mode: modeSchema }).strict();
  const migrateInput = z.object({ dryRun: z.boolean().optional() }).strict();
  const runRegressionInput = z.object({ nodeId: z.string().min(1), datasetId: z.string().min(1).optional(), rubricId: z.string().min(1).optional(), mode: modeSchema, caseLimit: z.number().int().min(1).max(100).optional() }).strict();
  const listRegressionInput = z.object({ nodeId: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();

  const resolveRubric = async (nodeId: string, rubricId?: string): Promise<EvalRubric> => {
    if (rubricId) {
      const rubric = await evaluationRepository.getRubric(rubricId);
      if (!rubric) throw new Error(`Unknown rubric: ${rubricId}`);
      return rubric;
    }
    const active = await evaluationRepository.listRubrics({ nodeId, status: "active" });
    if (!active.length) throw new Error(`no_active_rubric: create a rubric for ${nodeId} first (evaluation.create_rubric).`);
    return active[0]!;
  };

  return [
    tool({ name: "evaluation.create_rubric", description: "Create a versioned, role-specific evaluation rubric for a node (criteria, weights, pass threshold, optional cross-family judge model).", zodSchema: createRubricInput, inputSchema: objectSchema({ rubric: { type: "object" }, ...metaJson }, ["rubric"]), execute: async (input) => {
      const data = createRubricInput.parse(input);
      const parsed = evalRubricInputSchema.parse(coerceJsonObjectInput(data.rubric));
      const rubric: EvalRubric = { ...parsed, rubricId: parsed.rubricId ?? makeImprovementId("rubric"), createdAt: now(), updatedAt: now() };
      return ok({ rubric: await evaluationRepository.createRubric(rubric, meta(data)) });
    } }),
    tool({ name: "evaluation.update_rubric", description: "Patch a rubric; every change snapshots a restorable version.", zodSchema: updateRubricInput, inputSchema: objectSchema({ rubricId: { type: "string", minLength: 1 }, patch: { type: "object" }, ...metaJson }, ["rubricId", "patch"]), execute: async (input) => {
      const data = updateRubricInput.parse(input);
      return ok({ rubric: await evaluationRepository.updateRubric(data.rubricId, coerceJsonObjectInput(data.patch) as Partial<EvalRubric>, meta(data)) });
    } }),
    tool({ name: "evaluation.get_rubric", description: "Get one rubric.", zodSchema: rubricIdInput, inputSchema: objectSchema({ rubricId: { type: "string", minLength: 1 } }, ["rubricId"]), execute: async (input) => ok({ rubric: await evaluationRepository.getRubric(rubricIdInput.parse(input).rubricId) ?? null }) }),
    tool({ name: "evaluation.list_rubrics", description: "List rubrics, optionally by node and status.", zodSchema: listRubricsInput, inputSchema: objectSchema({ nodeId: { type: "string" }, status: { type: "string", enum: [...rubricStatuses] } }), execute: async (input) => ok({ rubrics: await evaluationRepository.listRubrics(listRubricsInput.parse(input)) }) }),
    tool({ name: "evaluation.list_rubric_versions", description: "List a rubric's version snapshots.", zodSchema: rubricIdInput, inputSchema: objectSchema({ rubricId: { type: "string", minLength: 1 } }, ["rubricId"]), execute: async (input) => ok({ versions: await evaluationRepository.listRubricVersions(rubricIdInput.parse(input).rubricId) }) }),
    tool({ name: "evaluation.restore_rubric_version", description: "Restore a rubric to a prior version (forward operation, snapshots again).", zodSchema: restoreRubricInput, inputSchema: objectSchema({ rubricId: { type: "string", minLength: 1 }, versionId: { type: "string", minLength: 1 }, ...metaJson }, ["rubricId", "versionId"]), execute: async (input) => {
      const data = restoreRubricInput.parse(input);
      return ok({ rubric: await evaluationRepository.restoreRubricVersion(data.rubricId, data.versionId, meta(data)) });
    } }),
    tool({ name: "evaluation.run", description: "Score a node output against its rubric with the LLM judge (mode=openai) or the deterministic mock judge. Supply output inline or reference a run to score its recorded stage output.", zodSchema: evaluationRunInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, rubricId: { type: "string" }, runId: { type: "string" }, output: {}, mode: modeJson }, ["nodeId"]), execute: async (input) => {
      const data = evaluationRunInput.parse(input);
      const rubric = await resolveRubric(data.nodeId, data.rubricId);
      let output = coerceJsonObjectInput(data.output);
      let subject: { model?: string; executionMode?: string } | undefined;
      if (output === undefined || output === null) {
        if (!data.runId) throw new Error("Provide output inline or a runId whose stage output should be judged.");
        const run = await deps.executionRepository.getRun(data.runId);
        if (!run) throw new Error(`Unknown run: ${data.runId}`);
        output = run.stageOutputs[data.nodeId] ?? run.nodes.find((node) => node.nodeId === data.nodeId)?.output;
        if (output === undefined) throw new Error(`Run ${data.runId} has no recorded output for node ${data.nodeId}.`);
        subject = { executionMode: String(run.executionMode ?? "mock") };
      }
      return ok({ result: await scoreOutput({ rubric, nodeId: data.nodeId, output, mode: data.mode, refs: { runId: data.runId, subject } }, deps) });
    } }),
    tool({ name: "evaluation.list_results", description: "List evaluation results, newest first.", zodSchema: listResultsInput, inputSchema: objectSchema({ nodeId: { type: "string" }, runId: { type: "string" }, rubricId: { type: "string" }, trialId: { type: "string" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 200 } }), execute: async (input) => ok({ results: await evaluationRepository.listResults(listResultsInput.parse(input)) }) }),
    tool({ name: "evaluation.get_result", description: "Get one evaluation result.", zodSchema: z.object({ evalId: z.string().min(1) }).strict(), inputSchema: objectSchema({ evalId: { type: "string", minLength: 1 } }, ["evalId"]), execute: async (input) => ok({ result: await evaluationRepository.getResult(z.object({ evalId: z.string().min(1) }).strict().parse(input).evalId) ?? null }) }),
    tool({ name: "evaluation.run_regression", description: "Pre-ship regression gate for a node: re-run the node over a frozen replay dataset and rubric-score each output (mode=openai LLM judge or deterministic mock), then compare the aggregate to the node's last stored baseline. Returns a RegressionReport with per-case pass/fail and an aggregate verdict (baseline_set on the first run, else improved | held | regressed). REPORTS ONLY — never applies, promotes, or publishes; promotion stays optimizer.promote / the human path.", zodSchema: runRegressionInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, datasetId: { type: "string", description: "Frozen dataset to replay; omit to use the node's newest dataset or freeze one from history." }, rubricId: { type: "string", description: "Rubric to score against; omit to use the node's active rubric." }, mode: modeJson, caseLimit: { type: "integer", minimum: 1, maximum: 100 } }, ["nodeId"]), execute: async (input) => ok({ report: await runRegression(runRegressionInput.parse(input), replayDeps) }) }),
    tool({ name: "evaluation.list_regression_reports", description: "List stored regression-gate reports (newest first). The newest for a node is the baseline the next evaluation.run_regression compares against.", zodSchema: listRegressionInput, inputSchema: objectSchema({ nodeId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }), execute: async (input) => ok({ reports: await evaluationRepository.listRegressionReports(listRegressionInput.parse(input)) }) }),

    tool({ name: "feedback.record", description: "Record human/analytics feedback: approve, reject, edit (with diff), or a published-performance outcome. Edit diffs are redacted before persistence.", zodSchema: feedbackRecordInput, inputSchema: objectSchema({ kind: { type: "string", enum: [...feedbackKinds] }, nodeId: { type: "string" }, runId: { type: "string" }, evalId: { type: "string" }, editDiff: { type: "object" }, outcome: { type: "object" }, note: { type: "string" }, ...metaJson }, ["kind"]), execute: async (input) => {
      const data = feedbackRecordInput.parse(input);
      const stamped = meta(data);
      const record: FeedbackRecord = {
        feedbackId: makeImprovementId("fb"),
        kind: data.kind,
        nodeId: data.nodeId,
        runId: data.runId,
        evalId: data.evalId,
        editDiff: data.editDiff !== undefined ? redactSensitiveKeys(coerceJsonObjectInput(data.editDiff)) as FeedbackRecord["editDiff"] : undefined,
        outcome: data.outcome !== undefined ? coerceJsonObjectInput(data.outcome) as FeedbackRecord["outcome"] : undefined,
        actor: stamped.actor,
        note: data.note,
        createdAt: now()
      };
      return ok({ feedback: await evaluationRepository.recordFeedback(record) });
    } }),
    tool({ name: "feedback.list", description: "List feedback records, newest first.", zodSchema: listFeedbackInput, inputSchema: objectSchema({ nodeId: { type: "string" }, runId: { type: "string" }, kind: { type: "string", enum: [...feedbackKinds] }, limit: { type: "integer", minimum: 1, maximum: 200 } }), execute: async (input) => ok({ records: await evaluationRepository.listFeedback(listFeedbackInput.parse(input)) }) }),
    tool({ name: "feedback.ingest_monetizer", description: "Outer-loop ingestion (DIRECTION Phase 7): pull the Monetizer project's read-only performance / demand_signals telemetry and record each as a feedback OUTCOME (source monetizer:<signal>), so published-content analytics feed optimizer.analyze. Optionally attribute to a nodeId/runId and pass Monetizer query args. Requires the Monetizer connection (MONETIZER_MCP_ENDPOINT / MONETIZER_MCP_TOKEN). Best-effort per signal; nothing external is written.", zodSchema: ingestMonetizerInput, inputSchema: objectSchema({ nodeId: { type: "string" }, runId: { type: "string" }, signals: { type: "array", items: { type: "string", enum: [...MONETIZER_SIGNALS] }, description: "Which signals to pull (default both)." }, args: { type: "object", description: "Query args forwarded to the Monetizer tool." }, note: { type: "string" }, ...metaJson }), execute: async (input) => {
      const data = ingestMonetizerInput.parse(input);
      const stamped = meta(data);
      return ok({ result: await ingestMonetizerAnalytics({ nodeId: data.nodeId, runId: data.runId, signals: data.signals, args: coerceJsonObjectInput(data.args) as Record<string, unknown> | undefined, actor: stamped.actor, note: data.note }, { evaluationRepository }) });
    } }),

    tool({ name: "dataset.build", description: "Freeze a replay dataset for a node from completed historical executions (inputs + champion outputs) for offline champion/challenger trials.", zodSchema: datasetBuildInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, name: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, projectId: { type: "string" } }, ["nodeId"]), execute: async (input) => ok({ dataset: await buildDataset(datasetBuildInput.parse(input), replayDeps) }) }),
    tool({ name: "dataset.list", description: "List replay datasets.", zodSchema: nodeFilterInput, inputSchema: objectSchema({ nodeId: { type: "string" } }), execute: async (input) => ok({ datasets: await improvementRepository.listDatasets(nodeFilterInput.parse(input)) }) }),
    tool({ name: "dataset.get", description: "Get one replay dataset.", zodSchema: datasetIdInput, inputSchema: objectSchema({ datasetId: { type: "string", minLength: 1 } }, ["datasetId"]), execute: async (input) => ok({ dataset: await improvementRepository.getDataset(datasetIdInput.parse(input).datasetId) ?? null }) }),
    tool({ name: "dataset.export_sft", description: "Export judge-approved traces for a node as chat-format SFT JSONL (Vertex tuning / Unsloth compatible), with provenance metadata.", zodSchema: exportSftInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, minScore: { type: "number", minimum: 0, maximum: 1 }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["nodeId"]), execute: async (input) => ok(await exportSft(exportSftInput.parse(input), replayDeps)) }),
    tool({ name: "dataset.export_preferences", description: "Export chosen/rejected preference pairs from decisive pairwise trial verdicts (DPO/ORPO-ready JSONL); inconsistent verdicts are excluded and counted.", zodSchema: exportPrefInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["nodeId"]), execute: async (input) => ok(await exportPreferences(exportPrefInput.parse(input), replayDeps)) }),
    tool({ name: "dataset.finetune_readiness", description: "Fine-tuning flywheel trigger (DIRECTION Phase 8): report whether a node has accumulated enough approved SFT examples and decisive preference pairs to warrant a tuning run (thresholds via IMPROVEMENT_FINETUNE_MIN_EXAMPLES / IMPROVEMENT_FINETUNE_MIN_PREFERENCE_PAIRS). REPORT-ONLY — never launches a job; when ready, pair with dataset.export_sft / dataset.export_preferences. Optional minScore mirrors the export bar.", zodSchema: fineTuneReadinessInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, minScore: { type: "number", minimum: 0, maximum: 1, description: "Approve outputs at/above this normalized score instead of the rubric pass flag." } }, ["nodeId"]), execute: async (input) => ok({ readiness: await evaluateFineTuneReadiness(fineTuneReadinessInput.parse(input), replayDeps) }) }),

    tool({ name: "optimizer.analyze", description: "Evidence-cited diagnosis of a node: eval score aggregates, worst criteria, run failure codes, and feedback counts.", zodSchema: analyzeInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } }, ["nodeId"]), execute: async (input) => ok({ analysis: await analyzeNode(analyzeInput.parse(input), replayDeps) }) }),
    tool({ name: "optimizer.propose", description: "GEPA-style reflection: diagnose from eval evidence and propose a prompt mutation. PROPOSE-ONLY — nothing is applied until optimizer.promote.", zodSchema: proposeInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, mode: modeJson }, ["nodeId"]), execute: async (input) => { const data = proposeInput.parse(input); return ok({ proposal: await proposeImprovement(data, replayDeps) }); } }),
    tool({ name: "optimizer.run_trial", description: "Run a proposal (or an ad-hoc prompt/model variant) against a frozen replay dataset: each case re-executes with the variant, is rubric-scored, and is pairwise-judged against the champion output in BOTH orderings.", zodSchema: runTrialInput, inputSchema: objectSchema({ proposalId: { type: "string" }, nodeId: { type: "string" }, promptVariant: { type: "string" }, modelConfigVariant: { type: "object" }, datasetId: { type: "string" }, rubricId: { type: "string" }, mode: modeJson, caseLimit: { type: "integer", minimum: 1, maximum: 100 } }), execute: async (input) => {
      const data = runTrialInput.parse(input);
      return ok({ trial: await runTrial({ proposalId: data.proposalId, nodeId: data.nodeId, promptOverride: data.promptVariant, modelConfig: coerceJsonObjectInput(data.modelConfigVariant) as Record<string, unknown> | undefined, datasetId: data.datasetId, rubricId: data.rubricId, mode: data.mode, caseLimit: data.caseLimit }, replayDeps) });
    } }),
    tool({ name: "optimizer.promote", description: "Promote a proposal through the versioned change funnel (structured evidence-citing reason; rollback via changes.restore). Refuses stale proposals whose node prompt drifted since diagnosis.", zodSchema: promoteInput, inputSchema: objectSchema({ proposalId: { type: "string", minLength: 1 }, ...metaJson }, ["proposalId"]), execute: async (input) => {
      const data = promoteInput.parse(input);
      return ok(await promoteProposal({ proposalId: data.proposalId, meta: meta(data) }, replayDeps));
    } }),
    tool({ name: "optimizer.status", description: "Proposals, trial summaries, and the cost-aware model-ladder recommendation for a node.", zodSchema: nodeFilterInput, inputSchema: objectSchema({ nodeId: { type: "string" } }), execute: async (input) => ok({ status: await optimizerStatus(nodeFilterInput.parse(input), replayDeps) }) }),
    tool({ name: "optimizer.auto_promote", description: "Eval-gated automatic promotion (DIRECTION Phase 7): promote proposals whose champion/challenger TRIAL already proves the change is better, for LOW-RISK nodes only (publish/admin nodes are never auto-promoted). Only 'trialed' proposals qualify — a fresh 'proposed' draft has no trial evidence and is skipped. Set dryRun:true to preview eligibility without promoting. This is an explicit human trigger; the IMPROVEMENT_AUTO_PROMOTE flag governs the AUTOMATIC post-run path.", zodSchema: autoPromoteInput, inputSchema: objectSchema({ nodeId: { type: "string" }, dryRun: { type: "boolean", description: "Preview eligible proposals without promoting." }, minScore: { type: "number", minimum: 0, maximum: 1, description: "Min trial meanChallengerScore to qualify (default 0.7)." }, max: { type: "integer", minimum: 1, maximum: 50, description: "Max promotions this pass (default 3)." }, ...metaJson }), execute: async (input) => {
      const data = autoPromoteInput.parse(input);
      const stamped = meta(data);
      return ok({ result: await autoPromoteProposals({ nodeId: data.nodeId, dryRun: data.dryRun, minScore: data.minScore, max: data.max, actor: stamped.actor }, replayDeps) });
    } }),

    tool({ name: "playbook.get", description: "Get a node's ACE playbook (curated, budgeted lessons) and its rendered prompt-injection form.", zodSchema: nodeIdInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 } }, ["nodeId"]), execute: async (input) => {
      const playbook = await improvementRepository.getPlaybook(nodeIdInput.parse(input).nodeId) ?? null;
      return ok({ playbook, rendered: playbook ? renderPlaybookForPrompt(playbook) : "" });
    } }),
    tool({ name: "playbook.apply_delta", description: "Apply a curated delta to a node's playbook: adds (deduplicated), helpful/harmful counters, retirements — budget-enforced.", zodSchema: applyDeltaInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, delta: { type: "object" }, ...metaJson }, ["nodeId", "delta"]), execute: async (input) => {
      const data = applyDeltaInput.parse(input);
      const delta = playbookDeltaSchema.parse(coerceJsonObjectInput(data.delta)) as PlaybookDelta;
      const existing = await improvementRepository.getPlaybook(data.nodeId);
      return ok({ playbook: await improvementRepository.savePlaybook(applyPlaybookDelta(existing, data.nodeId, delta, now())) });
    } }),
    tool({ name: "playbook.curate", description: "Reflector→Curator pass: derive a playbook delta from the node's evaluation evidence and apply it (dedup + item/char budget enforced). mode=mock (default) is the deterministic heuristic (weakest rubric criterion becomes a pitfall lesson); mode=openai runs the Curator LLM for richer adds (strategy/pitfall/constraint) plus retirement of stale lessons. A no-evidence node is a no-op.", zodSchema: curateInput, inputSchema: objectSchema({ nodeId: { type: "string", minLength: 1 }, mode: modeJson }, ["nodeId"]), execute: async (input) => {
      const data = curateInput.parse(input);
      return ok(await curatePlaybook(data, replayDeps));
    } }),
    tool({ name: "playbook.migrate_observations", description: "One-shot curation of legacy global learning observations into per-node playbooks (observations with metadata.nodeId only). The learning.* tools stay untouched.", zodSchema: migrateInput, inputSchema: objectSchema({ dryRun: { type: "boolean" } }), execute: async (input) => {
      const data = migrateInput.parse(input);
      const observations = await learningRepository.listObservations();
      const byNode = new Map<string, string[]>();
      let skipped = 0;
      for (const observation of observations) {
        const nodeId = typeof observation.metadata?.nodeId === "string" ? observation.metadata.nodeId : undefined;
        if (!nodeId) { skipped += 1; continue; }
        byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), observation.observation]);
      }
      if (!data.dryRun) {
        for (const [nodeId, texts] of byNode) {
          const delta: PlaybookDelta = { add: texts.map((text) => ({ text, kind: "strategy" as const, provenance: { source: "migration" as const } })) };
          const existing = await improvementRepository.getPlaybook(nodeId);
          await improvementRepository.savePlaybook(applyPlaybookDelta(existing, nodeId, delta, now()));
        }
      }
      return ok({ migratedNodes: byNode.size, migratedObservations: [...byNode.values()].reduce((sum, texts) => sum + texts.length, 0), skippedWithoutNodeId: skipped, dryRun: Boolean(data.dryRun) });
    } })
  ];
}
