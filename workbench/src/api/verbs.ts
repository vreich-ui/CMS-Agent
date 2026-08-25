// One typed function per MCP verb in spec/HANDOFF.md §6. Read verbs call
// `callVerb` directly; every mutating verb is built on `confirmAction` (never
// on callVerb directly) so the read-only flag and the confirm gate always
// apply. Grouped to match the areas called out in the WP-03 brief.
//
// Shapes marked "(fixture-mode guess)" have no live fixture in
// api/fixtures/*.json — see the WP-03 report for the full list; treat their
// fields as a reasonable placeholder contract, not a verified live shape.

import { callVerb } from './client';
import { confirmAction } from './confirmAction';
import workflowsFixture from './fixtures/workflows.json';
import type {
  Agent,
  Dataset,
  FinetuneReadiness,
  ModelConfig,
  Observation,
  Project,
  PublishReadiness,
  Risk,
  Rubric,
  Run,
  RunStatus,
  Skill,
  ToolDef,
  UsageSummary,
  WorkflowNode,
  Workflow,
} from '../types';

function mutate<T>(verb: string, effect: string, args?: object, danger = false): Promise<T> {
  return confirmAction<T>({ verb, effect, danger }, () => callVerb<T>(verb, args));
}

// ============================ workflow catalog ================================
// HANDOFF §6 has no "list workflows" MCP verb — the 3 (+1 planned) conductor
// workflows are static app config (icon/short/desc marketing copy, per
// fixtures/README.md), not a live query. This mirrors components/TopBar.tsx's
// WF_SWITCHER placeholder, which a later WP swaps for this fixture-backed
// list. Kept Promise-returning so it composes with the same hooks as every
// other verb, but it never touches callVerb/the broker in either mode.

const WORKFLOWS = workflowsFixture as unknown as Record<string, Workflow>;

export const workflowList = (): Promise<Workflow[]> => Promise.resolve(Object.values(WORKFLOWS));

export const workflowGet = (args: { workflowId: string }): Promise<Workflow | undefined> =>
  Promise.resolve(WORKFLOWS[args.workflowId]);

// --- shapes with no fixture — fixture-mode guesses, see report ---------------

export type JSONSchema = Record<string, unknown>;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface EffectivePrompt {
  nodeId: string;
  prompt: string;
  diverged: boolean;
  source: string;
}

export interface EffectiveNodeConfig {
  nodeId: string;
  model: ModelConfig | null;
  tools: string[];
  skills: string[];
  prompt: string | null;
  source: string;
}

export interface NodeExecution {
  id: string;
  runId: string;
  nodeId: string;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface RunContext {
  runId: string;
  workflowId: string;
  projectId: string;
  currentNodeId: string | null;
  status: RunStatus;
  nodesCompleted: number;
  nodesErrored: number;
  dryRun: boolean;
  executionMode: 'openai' | 'mock';
}

export interface RunCost {
  runId: string;
  costUsd: number;
  budgetUsd: number | null;
}

export interface StageOutput {
  runId: string;
  nodeId: string;
  output: unknown;
  note?: string;
}

export interface WorkspaceGraph {
  workflowId: string;
  nodes: Array<{ id: string; deps: string[] }>;
  edges: Array<{ from: string; to: string }>;
}

export interface ChangeRecord {
  id: string;
  nodeId: string;
  field: string;
  before?: unknown;
  after?: unknown;
  when: string;
  author?: string;
}

export interface ChangeDiff {
  nodeId: string;
  from: string;
  to: string;
  diff: Array<{ op: string; path: string; before?: unknown; after?: unknown }>;
}

export interface RestoreResult {
  nodeId: string;
  changeId: string;
  restored: boolean;
}

export interface ConnectionTestResult {
  projectId: string;
  ok: boolean;
  latencyMs: number | null;
  message: string;
}

export interface RepositoryHealth {
  ok: boolean;
  checkedAt: string;
  issues: string[];
}

export interface Playbook {
  nodeId: string;
  lessons: unknown[];
  version: number;
  note?: string;
}

export interface PlaybookMutationResult {
  nodeId: string;
  applied?: boolean;
  migrated?: number;
  [key: string]: unknown;
}

export interface EvaluationResult {
  nodeId: string;
  score: number | null;
  verdict: string | null;
  ranAt?: string;
}

export interface RegressionReport {
  nodeId: string;
  score: number | null;
  verdict: string | null;
  baseline: number | null;
  ranAt?: string;
}

export interface OptimizerStatus {
  nodeId: string | null;
  proposals: unknown[];
  lastTrial: unknown | null;
  state: string;
}

export interface OptimizerAnalysis {
  nodeId: string;
  findings: unknown[];
  analyzedAt: string;
}

export interface OptimizerProposal {
  nodeId: string;
  proposalId: string;
  promptDiff: string;
  createdAt: string;
}

export interface OptimizerTrial {
  proposalId: string;
  trialId: string;
  score: number | null;
  status: string;
}

export interface OptimizerPromoteResult {
  proposalId: string;
  promoted: boolean;
  promotedAt: string;
}

export interface OptimizerAutoPromoteResult {
  nodeId: string;
  autoPromoted: boolean;
  reason: string;
}

export interface DatasetExportResult {
  datasetId: string;
  format: string;
  ready: boolean;
  downloadUrl: string | null;
}

export interface FeedbackItem {
  id: string;
  nodeId?: string;
  runId?: string;
  verdict?: string;
  note?: string;
  recordedAt: string;
}

export interface BudgetStatus {
  runId: string | null;
  spentUsd: number;
  budgetUsd: number | null;
  pctUsed: number | null;
}

export interface SchemaUpdateResult {
  nodeId: string;
  schema: JSONSchema;
  applied: boolean;
}

// ============================== workspace ====================================

export const workspaceGetGraph = (args: { workflowId: string }) =>
  callVerb<WorkspaceGraph>('workspace_get_graph', args);

export const workspaceGetNodes = (args?: { workflowId?: string }) =>
  callVerb<WorkflowNode[]>('workspace_get_nodes', args);

export const workspaceGetNode = (args: { nodeId: string }) =>
  callVerb<WorkflowNode | null>('workspace_get_node', args);

export const workspaceGetNodeEffectiveConfig = (args: { nodeId: string }) =>
  callVerb<EffectiveNodeConfig>('workspace_get_node_effective_config', args);

export const workspaceUpdateNodePrompt = (args: { nodeId: string; prompt: string }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_prompt',
    `Save the edited prompt for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeTools = (args: { nodeId: string; tools: string[] }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_tools',
    `Set the tool list for node ${args.nodeId} (${args.tools.length} tools).`,
    args,
  );

export const workspaceUpdateNodeSkills = (args: { nodeId: string; skills: string[] }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_skills',
    `Set the skill list for node ${args.nodeId} (${args.skills.length} skills).`,
    args,
  );

export const workspaceUpdateNodeModelConfig = (args: { nodeId: string; model: ModelConfig }) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_model_config',
    `Update model & limits for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeInputSchema = (args: { nodeId: string; schema: JSONSchema }) =>
  mutate<SchemaUpdateResult>(
    'workspace_update_node_input_schema',
    `Update the input schema for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeOutputSchema = (args: { nodeId: string; schema: JSONSchema }) =>
  mutate<SchemaUpdateResult>(
    'workspace_update_node_output_schema',
    `Update the output schema for node ${args.nodeId}.`,
    args,
  );

export const workspaceUpdateNodeMetadata = (args: {
  nodeId: string;
  metadata: Partial<Pick<WorkflowNode, 'name' | 'desc' | 'kind' | 'risk' | 'fan'>>;
}) =>
  mutate<WorkflowNode | null>(
    'workspace_update_node_metadata',
    `Update metadata for node ${args.nodeId}.`,
    args,
  );

/** Read-shaped — no confirmAction (HANDOFF §6 marks this "no confirm"). */
export const workspaceValidateNode = (args: { nodeId: string; patch?: unknown }) =>
  callVerb<ValidationResult>('workspace_validate_node', args);

// ================================= node ======================================

export const nodeGetEffectivePrompt = (args: { nodeId: string }) =>
  callVerb<EffectivePrompt>('node_get_effective_prompt', args);

export const nodeGetEffectiveSkills = (args: { nodeId: string }) =>
  callVerb<Skill[]>('node_get_effective_skills', args);

export const nodeGetEffectiveTools = (args: { nodeId: string }) =>
  callVerb<ToolDef[]>('node_get_effective_tools', args);

export const nodeGetInputSchema = (args: { nodeId: string }) =>
  callVerb<JSONSchema>('node_get_input_schema', args);

export const nodeGetOutputSchema = (args: { nodeId: string }) =>
  callVerb<JSONSchema>('node_get_output_schema', args);

/** Read-shaped — no confirmAction (HANDOFF §6 marks this "no confirm"). */
export const nodeValidateInput = (args: { nodeId: string; input: unknown }) =>
  callVerb<ValidationResult>('node_validate_input', args);

export const nodeListExecutions = (args: { nodeId: string; runId?: string }) =>
  callVerb<NodeExecution[]>('node_list_executions', args);

// ============================ workflow + runs ================================

export const workflowListRuns = (args?: {
  workflowId?: string;
  projectId?: string;
  status?: RunStatus;
  limit?: number;
}) => callVerb<Run[]>('workflow_list_runs', args);

export const workflowGetRun = (args: { runId: string }) => callVerb<Run | null>('workflow_get_run', args);

export const workflowGetRunContext = (args: { runId: string }) =>
  callVerb<RunContext | null>('workflow_get_run_context', args);

export const workflowGetRunCost = (args: { runId: string }) =>
  callVerb<RunCost>('workflow_get_run_cost', args);

export const stageListOutputs = (args: { runId: string; nodeId?: string }) =>
  callVerb<string[]>('stage_list_outputs', args);

export const stageGetOutput = (args: { runId: string; nodeId: string }) =>
  callVerb<StageOutput>('stage_get_output', args);

/**
 * Read-shaped — no confirmAction, same treatment as `node_validate_input` /
 * `workspace_validate_node` (HANDOFF §6 marks those "no confirm"; this verb
 * is absent from §6 entirely, but WP-23 names it explicitly as the gate
 * panel's evidence source). Added by WP-23 (Phase 2, gate panel) — additive
 * only, no existing export touched. See `PublishReadiness` in ../types.ts
 * and the mock handler in client.ts for what "derived" evidence means here.
 */
export const workflowPublishReadiness = (args: { runId: string }) =>
  callVerb<PublishReadiness>('workflow_publish_readiness', args);

export const workflowStartDryRun = (args: {
  workflowId: string;
  projectId: string;
  brief?: string;
  budgetUsd?: number;
  /**
   * Added by WP-23/22 (Phase 2) — additive, optional, so every existing
   * caller keeps compiling unchanged. `dry` defaults true (the verb's own
   * name) when omitted; only an explicit `dry: false` is a live launch.
   */
  dry?: boolean;
  executionMode?: 'openai' | 'mock';
  requestId?: string;
}) =>
  mutate<Run>(
    'workflow_start_dry_run',
    args.dry === false
      ? `Start a LIVE run of ${args.workflowId} against project ${args.projectId} — not a dry run. Real, potentially irreversible actions may be taken depending on where the run stops.`
      : `Start a dry run of ${args.workflowId} against project ${args.projectId}.`,
    args,
    args.dry === false,
  );

export const workflowRunAll = (args: { runId: string }) =>
  mutate<Run | null>('workflow_run_all', `Run every remaining node in ${args.runId} to completion.`, args);

export const workflowRunNextNode = (args: { runId: string }) =>
  mutate<Run | null>('workflow_run_next_node', `Run just the next node in ${args.runId}.`, args);

export const workflowRunUntil = (args: { runId: string; nodeId: string }) =>
  mutate<Run | null>(
    'workflow_run_until',
    `Run ${args.runId} forward until node ${args.nodeId}.`,
    args,
  );

export const workflowRunNode = (args: { runId: string; nodeId: string }) =>
  mutate<Run | null>('workflow_run_node', `Run node ${args.nodeId} in ${args.runId}.`, args);

export const workflowPauseRun = (args: { runId: string }) =>
  mutate<Run | null>('workflow_pause_run', `Pause run ${args.runId}.`, args);

export const workflowResumeRun = (args: { runId: string }) =>
  mutate<Run | null>('workflow_resume_run', `Resume run ${args.runId}.`, args);

export const workflowCancelRun = (args: { runId: string; reason?: string }) =>
  mutate<Run | null>('workflow_cancel_run', `Cancel run ${args.runId}. This cannot be undone.`, args, true);

export const workflowResetRun = (args: { runId: string }) =>
  mutate<Run | null>(
    'workflow_reset_run',
    `Reset run ${args.runId} back to queued, clearing progress.`,
    args,
    true,
  );

export const workflowRetryNode = (args: { runId: string; nodeId: string }) =>
  mutate<Run | null>('workflow_retry_node', `Retry node ${args.nodeId} in run ${args.runId}.`, args);

export const workflowSetOperatorPublishDecision = (args: {
  runId: string;
  decision: 'approve' | 'decline';
  reason?: string;
}) =>
  mutate<Run | null>(
    'workflow_set_operator_publish_decision',
    `Record operator decision "${args.decision}" on the publish gate for ${args.runId}.`,
    args,
    args.decision === 'approve',
  );

export const workflowPublishRun = (args: { runId: string }) =>
  mutate<Run | null>(
    'workflow_publish_run',
    `Publish run ${args.runId} to the live site. This cannot be undone.`,
    args,
    true,
  );

// ================================ changes ====================================

export const changesList = (args: { nodeId: string }) => callVerb<ChangeRecord[]>('changes_list', args);

export const changesGet = (args: { changeId: string }) =>
  callVerb<ChangeRecord | null>('changes_get', args);

export const changesCompare = (args: { nodeId: string; from?: string; to?: string }) =>
  callVerb<ChangeDiff>('changes_compare', args);

export const changesRestore = (args: { nodeId: string; changeId: string }) =>
  mutate<RestoreResult>(
    'changes_restore',
    `Restore node ${args.nodeId} to change ${args.changeId}.`,
    args,
    true,
  );

// ================================ registry ===================================

export const projectList = () => callVerb<Project[]>('project_list');

export const projectTestConnection = (args: { projectId: string }) =>
  callVerb<ConnectionTestResult>('project_test_connection', args);

export const toolList = () => callVerb<ToolDef[]>('tool_list');

export const skillList = () => callVerb<Skill[]>('skill_list');

export const skillResolveForNode = (args: { nodeId: string }) =>
  callVerb<Skill[]>('skill_resolve_for_node', args);

export const skillUpdate = (args: { skillId: string; patch: Partial<Skill> }) =>
  mutate<Skill | null>('skill_update', `Update skill ${args.skillId}.`, args);

export const skillAssign = (args: { nodeId: string; skillId: string }) =>
  mutate<Skill | null>(
    'skill_assign',
    `Assign skill ${args.skillId} to node ${args.nodeId}.`,
    args,
  );

export const skillUnassign = (args: { nodeId: string; skillId: string }) =>
  mutate<Skill | null>(
    'skill_unassign',
    `Remove skill ${args.skillId} from node ${args.nodeId}.`,
    args,
  );

export const skillRestoreVersion = (args: { skillId: string; version: string }) =>
  mutate<Skill | null>(
    'skill_restore_version',
    `Restore skill ${args.skillId} to version ${args.version}.`,
    args,
    true,
  );

export const agentList = () => callVerb<Agent[]>('agent_list');

export const repositoryGetHealth = () => callVerb<RepositoryHealth>('repository_get_health');

// ================================ learning ===================================

export const learningListObservations = (args?: { nodeId?: string }) =>
  callVerb<Observation[]>('learning_list_observations', args);

export const learningRecordObservation = (args: { nodeId?: string; runId?: string; txt: string }) =>
  mutate<Observation>(
    'learning_record_observation',
    'Record a new learning observation.',
    args,
  );

export const learningArchiveObservation = (args: { id: string }) =>
  mutate<Observation | null>(
    'learning_archive_observation',
    `Archive observation ${args.id}.`,
    args,
  );

export const playbookGet = (args: { nodeId: string }) => callVerb<Playbook>('playbook_get', args);

export const playbookCurate = (args: { nodeId: string; observationId?: string; lesson: string }) =>
  mutate<PlaybookMutationResult>(
    'playbook_curate',
    `Curate a lesson into the playbook for node ${args.nodeId}.`,
    args,
  );

export const playbookApplyDelta = (args: { nodeId: string; delta: unknown }) =>
  mutate<PlaybookMutationResult>(
    'playbook_apply_delta',
    `Apply a playbook delta to node ${args.nodeId}.`,
    args,
  );

export const playbookMigrateObservations = (args: { nodeId: string }) =>
  mutate<PlaybookMutationResult>(
    'playbook_migrate_observations',
    `Migrate accumulated observations into the playbook for node ${args.nodeId}.`,
    args,
  );

// =============================== evaluation ==================================

export const evaluationListRubrics = () => callVerb<Rubric[]>('evaluation_list_rubrics');

export const evaluationListResults = (args?: { nodeId?: string }) =>
  callVerb<EvaluationResult[]>('evaluation_list_results', args);

export const evaluationListRegressionReports = (args?: { nodeId?: string }) =>
  callVerb<RegressionReport[]>('evaluation_list_regression_reports', args);

export const evaluationCreateRubric = (args: { node: string; crit: number; top: string }) =>
  mutate<Rubric | null>('evaluation_create_rubric', `Create a rubric for node ${args.node}.`, args);

export const evaluationUpdateRubric = (args: { node: string; patch: Partial<Rubric> }) =>
  mutate<Rubric | null>('evaluation_update_rubric', `Update the rubric for node ${args.node}.`, args);

export const evaluationRun = (args: { node: string }) =>
  mutate<EvaluationResult>('evaluation_run', `Run evaluation for node ${args.node}.`, args);

export const evaluationRunRegression = (args: { node: string }) =>
  mutate<RegressionReport>(
    'evaluation_run_regression',
    `Run a regression evaluation for node ${args.node}.`,
    args,
  );

export const evaluationRestoreRubricVersion = (args: { node: string; version: string }) =>
  mutate<Rubric | null>(
    'evaluation_restore_rubric_version',
    `Restore the rubric for node ${args.node} to version ${args.version}.`,
    args,
    true,
  );

// =============================== optimizer ===================================

export const optimizerStatus = (args?: { nodeId?: string }) =>
  callVerb<OptimizerStatus>('optimizer_status', args);

export const optimizerAnalyze = (args: { nodeId: string }) =>
  mutate<OptimizerAnalysis>('optimizer_analyze', `Analyze node ${args.nodeId} for optimization.`, args);

export const optimizerPropose = (args: { nodeId: string }) =>
  mutate<OptimizerProposal>(
    'optimizer_propose',
    `Generate an optimizer proposal for node ${args.nodeId}.`,
    args,
  );

export const optimizerRunTrial = (args: { proposalId: string }) =>
  mutate<OptimizerTrial>(
    'optimizer_run_trial',
    `Run a trial for optimizer proposal ${args.proposalId}.`,
    args,
  );

export const optimizerPromote = (args: { proposalId: string }) =>
  mutate<OptimizerPromoteResult>(
    'optimizer_promote',
    `Promote optimizer proposal ${args.proposalId} into the live prompt.`,
    args,
    true,
  );

export const optimizerAutoPromote = (args: { nodeId: string }) =>
  mutate<OptimizerAutoPromoteResult>(
    'optimizer_auto_promote',
    `Allow auto-promotion of winning proposals for node ${args.nodeId}.`,
    args,
    true,
  );

// ================================ dataset =====================================

export const datasetList = () => callVerb<Dataset[]>('dataset_list');

export const datasetFinetuneReadiness = (args?: { nodeId?: string }) =>
  callVerb<FinetuneReadiness>('dataset_finetune_readiness', args);

export const datasetBuild = (args: { node: string; cases?: number }) =>
  mutate<Dataset>('dataset_build', `Build a replay dataset for node ${args.node}.`, args);

export const datasetExportSft = (args: { datasetId: string }) =>
  mutate<DatasetExportResult>(
    'dataset_export_sft',
    `Export dataset ${args.datasetId} in SFT format.`,
    args,
  );

export const datasetExportPreferences = (args: { datasetId: string }) =>
  mutate<DatasetExportResult>(
    'dataset_export_preferences',
    `Export dataset ${args.datasetId} as preference pairs.`,
    args,
  );

// ================================ feedback ====================================

export const feedbackList = (args?: { nodeId?: string }) => callVerb<FeedbackItem[]>('feedback_list', args);

export const feedbackRecord = (args: {
  nodeId?: string;
  runId?: string;
  verdict: string;
  note?: string;
}) => mutate<FeedbackItem>('feedback_record', 'Record a feedback verdict.', args);

// ================================== usage =====================================

export const usageGetSummary = (args?: { workflowId?: string }) =>
  callVerb<UsageSummary>('usage_get_summary', args);

export const usageGetBudgetStatus = (args?: { runId?: string }) =>
  callVerb<BudgetStatus>('usage_get_budget_status', args);

// Re-exported for callers that only need the risk type alongside these verbs.
export type { Risk, Workflow };
