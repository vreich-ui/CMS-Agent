// Live-API -> UI-shape adapters (workbench-verb-fixes, live-mapping pass).
//
// Everything in this file maps a RAW MCP response shape (verified against
// the live `CMS_Agent` workspace, 2026-08-25 — see fixtures/README.md for
// the verb-by-verb capture notes) into the fixed UI contract in ../types.ts.
// One exported `to<Entity>` function per entity, all pure — no I/O, no
// mutation of their input, no fabricated values. Where the live API
// genuinely does not carry something the UI type wants, the adapter passes
// undefined/null through rather than inventing a placeholder; the UI's own
// existing "unknown"/empty states are what render that honestly.
//
// This is the ONE place either transport's shape-mapping happens. Fixture
// mode reads a raw fixture (api/fixtures/*.json, itself a verbatim capture)
// and calls the same to<Entity>() the Cloud Run transport calls on a live
// response — see client.ts's MOCK_HANDLERS and verbs.ts. That symmetry is
// the whole point: the 46 existing fixture-mode Playwright specs exercise
// this exact mapping, not a parallel fiction.
//
// A few fields need a second raw input the entity's own list verb doesn't
// carry (a rubric's score, a run's cost) — those adapters take an optional
// second parameter for the composing verb (evaluation_list_regression_reports,
// workflow_get_run_cost, …) to supply. Omit it and the adapter reports that
// figure as the type's own "unknown" value (null/0), never a guess.

import type {
  Agent,
  Dataset,
  FinetuneReadiness,
  ModelConfig,
  Observation,
  Project,
  Risk,
  Rubric,
  Run,
  RunStatus,
  Skill,
  ToolDef,
  ToolPolicyCounts,
  UsageSummary,
  WorkflowNode,
} from '../types';

// ============================== shared helpers ================================

/**
 * "24 Aug" — the short-date convention already established by Run.started
 * (Dock.tsx does `run.started.split(' ').slice(0, 2).join(' ')`) and by the
 * pre-adapter mockStore's `todayShort()`. Applied here to every live ISO
 * timestamp an adapter turns into a UI-facing short date, so both stay
 * consistent. Falls back to the raw string if it isn't parseable — never
 * throws on an odd but real timestamp.
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(d);
}

/** "1m 32s" / "47s" / "2h 6m" — from a start ISO to an end ISO (or now). */
export function durationText(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '—';
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const totalSec = Math.max(0, Math.round((end - start) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

/**
 * `Risk` is a closed union in types.ts but every consumer (RiskBadge, the
 * Registry tools filter) treats it as an opaque string — no switch anywhere
 * branches exhaustively over it. Every live `riskLevel` value observed
 * (nodes, tools) is one of 'read' | 'write' | 'publish', so this is a
 * boundary-trust pass-through, not an invented default — the same trust
 * this codebase already places in callVerb's generic parameter.
 */
function asRisk(riskLevel: string): Risk {
  return riskLevel as Risk;
}

// =================================== node ======================================

export interface RawModelConfig {
  maxTurns: number;
  toolCallLimit: number;
  /** Live carries this in milliseconds; ModelConfig.timeout wants "90s". */
  timeout: number;
  budgetUsd: number;
  maxOutputTokens: number;
  /** Live has never carried a value here — every node's is `null`. */
  retryCount?: number | null;
}

export interface RawWorkflowNode {
  id: string;
  name: string;
  kind: string;
  description: string;
  prompt?: string;
  allowedTools: string[];
  assignedSkills: string[];
  requiredInputs?: string[];
  produces?: string[];
  riskLevel: string;
  dependsOn: string[];
  status?: string;
  updatedAt?: string;
  modelConfig?: RawModelConfig;
  /** Present live but not read by toNode() — no ../types.ts equivalent
   *  (schema/prompt tabs use node_get_input_schema / node_get_output_schema
   *  instead, which client.ts's mock now serves straight from these). */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export function toModelConfig(raw: RawModelConfig): ModelConfig {
  return {
    maxTurns: raw.maxTurns,
    toolCallLimit: raw.toolCallLimit,
    timeout: `${Math.round(raw.timeout / 1000)}s`,
    budgetUsd: raw.budgetUsd,
    maxOutputTokens: raw.maxOutputTokens,
    // Live never carries retryCount — 0 here is the type's own "no extra
    // retries configured" default, not a fabricated observed value.
    retryCount: raw.retryCount ?? 0,
  };
}

/**
 * `workspace_get_nodes` / `workspace_get_node`. Live field names differ
 * throughout from the mockup-shaped fixtures this UI was originally built
 * against: `description`→desc, `riskLevel`→risk, `allowedTools`→tools,
 * `assignedSkills`→skills, `dependsOn` (array)→fan (its length). Clone/
 * capture-workflow node ids are invisible to every workspace_get_* verb —
 * this adapter is never called for them; callers get `null` from the verb
 * itself (see verbs.ts's workspaceGetNode) and the UI's existing "not
 * found" branch (Center.tsx) handles that honestly.
 */
export function toNode(raw: RawWorkflowNode): WorkflowNode {
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    risk: asRisk(raw.riskLevel),
    fan: raw.dependsOn.length,
    tools: raw.allowedTools,
    skills: raw.assignedSkills,
    desc: raw.description,
    model: raw.modelConfig ? toModelConfig(raw.modelConfig) : undefined,
    prompt: raw.prompt,
    produces: raw.produces,
    requiredInputs: raw.requiredInputs,
    status: raw.status,
    updatedAt: raw.updatedAt,
  };
}

// ==================================== run =======================================

export interface RawRunNode {
  nodeId: string;
  status: string;
  /** P2-05 — real, live-carried per-node timings. Absent while queued. */
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  warnings?: string[];
  produces?: string[];
  [key: string]: unknown;
}

export interface RawRun {
  runId: string;
  requestId?: string;
  workflowId: string;
  projectId: string;
  status: string;
  /** Present on `workflow_list_runs` rows; ABSENT on `workflow_get_run`'s
   *  single-run object — see deriveCurrentNodeId() below for the fallback. */
  currentNodeId?: string | null;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string | null;
  nodes: RawRunNode[];
  errors: string[];
  dryRun: boolean;
  executionMode: string;
  rev?: number;
  budgetUsd?: number | null;
  /** Nested on a list row; a sibling of `run` on `workflow_get_run` — the
   *  caller (verbs.ts) normalizes that before calling toRun(), so this
   *  adapter only ever sees it in one place. */
  mode?: { executionMode?: string };
  /** Only ever populated on a `status: "running"` row. */
  stall?: unknown;
}

/** Cost/budget come from a separate verb (`workflow_get_run_cost`) — the
 *  list/get run verbs carry no cost figure at all. */
export interface RawRunCostLedger {
  runId: string;
  totalCostUsdEstimate: number;
  budget?: { budgetUsd?: number | null } | null;
}

/**
 * `workflow_get_run`'s single-run object carries no `currentNodeId` at all
 * (confirmed live — its key list has no such field, unlike a
 * `workflow_list_runs` row). Falls back to the first node not yet
 * completed/skipped — a derivation, clearly not a live-asserted value, but
 * a better answer than silently reporting no current node on a run that
 * plainly has one.
 */
function deriveCurrentNodeId(nodes: RawRunNode[]): string | null {
  const active = nodes.find((n) => n.status !== 'completed' && n.status !== 'skipped');
  return active?.nodeId ?? null;
}

/**
 * `workflow_list_runs` / `workflow_get_run`. Live carries no `cost` field
 * on the run object at all — the list/get verbs are silent on spend; only
 * `workflow_get_run_cost`'s ledger has it. Pass that ledger as `cost` when
 * the caller has it (verbs.ts always fetches it); omitted, `cost` reports
 * 0 — the type's own "nothing spent yet" value — not a guess at a real
 * figure this call never saw.
 */
export function toRun(raw: RawRun, cost?: RawRunCostLedger): Run {
  const exec: Run['exec'] = (raw.mode?.executionMode ?? raw.executionMode) === 'mock' ? 'mock' : 'openai';
  return {
    id: raw.runId,
    wf: raw.workflowId,
    proj: raw.projectId,
    status: raw.status as RunStatus, // live values match RunStatus's members exactly (verified)
    cur: raw.currentNodeId ?? deriveCurrentNodeId(raw.nodes),
    started: shortDate(raw.startedAt),
    dur: durationText(raw.startedAt, raw.completedAt ?? raw.updatedAt ?? null),
    cost: cost?.totalCostUsdEstimate ?? 0,
    budget: cost?.budget?.budgetUsd ?? raw.budgetUsd ?? null,
    exec,
    dry: raw.dryRun,
    err: raw.errors.length,
    done: raw.nodes.filter((n) => n.status === 'completed').length,
    stall: raw.stall != null ? true : undefined,
    // P2-05 — carried through verbatim. `durationMs` is only ever a number
    // the workspace measured; a node that has not run yet simply has none.
    nodes: (raw.nodes ?? []).map((n) => ({
      nodeId: n.nodeId,
      status: n.status,
      startedAt: n.startedAt ?? null,
      completedAt: n.completedAt ?? null,
      durationMs: typeof n.durationMs === 'number' ? n.durationMs : null,
      warnings: Array.isArray(n.warnings) ? n.warnings : undefined,
      produces: Array.isArray(n.produces) ? n.produces : undefined,
    })),
    requestId: raw.requestId,
  };
}

// ================================== project =====================================

export interface RawProjectConnection {
  endpointConfigured?: boolean;
  tokenConfigured?: boolean;
  mcpEndpoint?: string;
  mcpEndpointEnvVar?: string;
  tokenEnvVar?: string;
  endpointSource?: string;
  tokenSource?: string;
}

export interface RawProject {
  projectId: string;
  name: string;
  status?: string;
  toolPolicies?: Record<string, string>;
  connection?: RawProjectConnection;
}

function toolPolicyCounts(policies: Record<string, string> | undefined): ToolPolicyCounts {
  const values = Object.values(policies ?? {});
  return {
    a: values.filter((v) => v === 'allowed').length,
    n: values.filter((v) => v === 'needs_approval').length,
    b: values.filter((v) => v === 'blocked').length,
  };
}

/**
 * `project_list`. `ok` (ProjectsTab.tsx's "endpoint + token configured" /
 * "endpoint unset") comes from `connection.endpointConfigured &&
 * connection.tokenConfigured` — live carries no single boolean for this.
 * `pol.{a,n,b}` is tallied from `toolPolicies`'s values, not copied from
 * any single count field (live carries none).
 */
export function toProject(raw: RawProject): Project {
  return {
    id: raw.projectId,
    name: raw.name,
    ok: Boolean(raw.connection?.endpointConfigured && raw.connection?.tokenConfigured),
    disabled: raw.status === 'disabled' ? true : undefined,
    pol: toolPolicyCounts(raw.toolPolicies),
    endpoint: raw.connection?.mcpEndpoint ?? null,
    endpointEnvVar: raw.connection?.mcpEndpointEnvVar,
    tokenEnvVar: raw.connection?.tokenEnvVar,
    tokenSource: raw.connection?.tokenSource,
    endpointSource: raw.connection?.endpointSource,
  };
}

// =================================== tool =======================================

export interface RawToolDef {
  toolId: string;
  name?: string;
  description: string;
  riskLevel: string;
  sideEffect: string;
  category?: string;
  requiresApproval?: boolean;
  enabled?: boolean;
}

/** `tool_list`. `id`←toolId, `desc`←description, `risk`←riskLevel. */
export function toToolDef(raw: RawToolDef): ToolDef {
  return {
    id: raw.toolId,
    risk: asRisk(raw.riskLevel),
    sideEffect: raw.sideEffect,
    desc: raw.description,
    name: raw.name,
    category: raw.category,
    requiresApproval: raw.requiresApproval,
    enabled: raw.enabled,
  };
}

// =================================== skill ======================================

export interface RawSkill {
  skillId: string;
  version: string;
  name?: string;
  description?: string;
  status?: string;
}

/**
 * `skill_list`. Live skill records carry no `assignedTo` — that has to be
 * derived by scanning every node's `assignedSkills` for this skill's id
 * (verbs.ts does that once, from the same `workspace_get_nodes` call it
 * already needs for toNode()). Defaults to an empty array, not omitted,
 * so SkillsTab.tsx's "assigned to nobody"/"unused" reads correctly for a
 * genuinely-unassigned skill rather than looking like missing data.
 */
export function toSkill(raw: RawSkill, assignedTo: string[] = []): Skill {
  return {
    id: raw.skillId,
    version: raw.version,
    assignedTo,
    name: raw.name,
    description: raw.description,
    status: raw.status,
  };
}

/** Builds skillId -> assignedTo[] from a set of already-adapted nodes — the
 *  live source for Skill.assignedTo (see toSkill() above). */
export function assignedSkillsByNode(nodes: Pick<WorkflowNode, 'id' | 'skills'>[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of nodes) {
    for (const skillId of node.skills) {
      const list = map.get(skillId);
      if (list) list.push(node.id);
      else map.set(skillId, [node.id]);
    }
  }
  return map;
}

// ================================= observation ===================================

export interface RawObservation {
  id: string;
  observation: string;
  nodeId?: string | null;
  runId?: string | null;
  createdAt: string;
}

/** `learning_list_observations`. `txt`←observation, `when`←createdAt. */
export function toObservation(raw: RawObservation): Observation {
  return {
    id: raw.id,
    when: shortDate(raw.createdAt),
    node: raw.nodeId ?? null,
    run: raw.runId ?? null,
    txt: raw.observation,
  };
}

// =================================== rubric ======================================

export interface RawRubricCriterion {
  id: string;
  name: string;
  weight: number;
}

export interface RawRubric {
  nodeId: string;
  criteria: RawRubricCriterion[];
}

export interface RawRegressionReport {
  nodeId: string;
  verdict: string;
  summary?: { meanScore?: number | null };
}

/**
 * `evaluation_list_rubrics` for the shape, `evaluation_list_regression_reports`
 * (newest report for the node, if any) for score/verdict — live carries no
 * single verb with both. `crit`←criteria.length; `top`←the highest-`weight`
 * criterion's name (a derivation — live has no single "headline criterion"
 * field). `score`/`verdict` stay `null` when no report exists yet for the
 * node, exactly like the pre-adapter fixture's documented behavior for the
 * 4 of 5 rubrics with no regression history.
 */
export function toRubric(raw: RawRubric, report?: RawRegressionReport): Rubric {
  const top = raw.criteria.reduce<RawRubricCriterion | null>(
    (best, c) => (!best || c.weight > best.weight ? c : best),
    null,
  );
  return {
    node: raw.nodeId,
    crit: raw.criteria.length,
    top: top?.name ?? '',
    score: report?.summary?.meanScore ?? null,
    verdict: report?.verdict ?? null,
  };
}

// ================================== dataset ======================================

export interface RawDataset {
  datasetId: string;
  nodeId: string;
  name: string;
  cases: unknown[];
  createdAt: string;
}

/**
 * `dataset_list`. `cases`(number)←cases.length — the UI wants a count, live
 * returns full case objects. `note`←name: live's own `note`/description
 * field is `null` on every dataset; `name` carries the same descriptive
 * content the UI's `note` displays and is the closest live equivalent.
 */
export function toDataset(raw: RawDataset): Dataset {
  return {
    id: raw.datasetId,
    node: raw.nodeId,
    cases: raw.cases.length,
    when: shortDate(raw.createdAt),
    note: raw.name,
  };
}

// =================================== agent =======================================

export interface RawAgent {
  id: string;
  name: string;
  role: string;
  modelConfig?: { model?: string };
  promptState: string;
  skills: string[];
  rev: number;
  status?: string;
  updatedAt?: string;
}

/** `agent_list`. `model`←modelConfig.model. */
export function toAgent(raw: RawAgent): Agent {
  return {
    id: raw.id,
    name: raw.name,
    role: raw.role,
    // Empty string, not a fabricated model name, on the (unobserved-live)
    // case of an agent record with no modelConfig.model at all.
    model: raw.modelConfig?.model ?? '',
    promptState: raw.promptState,
    skills: raw.skills,
    rev: raw.rev,
    status: raw.status,
    updatedAt: raw.updatedAt,
  };
}

// =================================== usage =======================================

export interface RawUsageSummary {
  totalCostUsdEstimate?: number;
  costUsdEstimate?: number;
}

export interface UsageWorkflowEntry {
  workflowId: string;
  summary: RawUsageSummary;
  /** From `workflow_list_runs({workflowId}).page.matchedCount` — live
   *  usage_get_summary carries no run count of its own. */
  runCount: number;
}

/**
 * `usage_get_summary` (unfiltered, for the overall total) + one
 * `usage_get_summary({workflowId})` call per known workflow (for
 * `byWorkflow`) + one `workflow_list_runs({workflowId})` call per workflow
 * (for each `avgPerRun`'s denominator) — live carries no single verb with
 * a per-workflow breakdown. `weekTotal` is actually the all-time total
 * (usage_get_summary has no rolling time window), which UsageTab.tsx
 * already labels honestly as "all-time total", not "this week".
 */
export function toUsageSummary(overall: RawUsageSummary, perWorkflow: UsageWorkflowEntry[]): UsageSummary {
  const weekTotal = overall.totalCostUsdEstimate ?? overall.costUsdEstimate ?? 0;
  const runCount = perWorkflow.reduce((sum, w) => sum + w.runCount, 0);
  return {
    weekTotal,
    runCount,
    byWorkflow: perWorkflow.map((w) => {
      const total = w.summary.totalCostUsdEstimate ?? w.summary.costUsdEstimate ?? 0;
      return { wf: w.workflowId, total, avgPerRun: w.runCount > 0 ? total / w.runCount : 0 };
    }),
  };
}

// =============================== finetune readiness ===============================

export interface RawFinetuneReadiness {
  nodeId: string;
  approvedExamples: number;
  preferencePairs: number;
  thresholds?: { minExamples?: number; minPreferencePairs?: number };
  recommendation: string;
  /** Live's full sentence — more informative than the bare enum value; see
   *  toFinetuneReadiness()'s use of it below. */
  reason?: string;
}

/**
 * `dataset_finetune_readiness`. `recommendation`←reason when present (the
 * live full sentence folds in the bare `recommendation` enum value already,
 * e.g. "Accumulating: 1/500 approved examples…"), falling back to the bare
 * enum only if a future response ever omits `reason`.
 */
export function toFinetuneReadiness(raw: RawFinetuneReadiness): FinetuneReadiness {
  return {
    approvedExamples: raw.approvedExamples,
    approvedThreshold: raw.thresholds?.minExamples ?? 0,
    preferencePairs: raw.preferencePairs,
    pairThreshold: raw.thresholds?.minPreferencePairs ?? 0,
    recommendation: raw.reason ?? raw.recommendation,
  };
}
