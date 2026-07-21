// Cloud Run Job entrypoint for the Publishing Conductor — Phase 1 of docs/platform/DIRECTION.md.
// Drives one workspace run to a terminal state using exactly the workflow.run_all advance loop
// (one dependency-ready node per step; publish-risk nodes block without explicit approval), so a
// run that outgrows Netlify's background-function ceiling completes here instead. No orchestration
// semantics live in this file — it only wires the existing executor to a process lifecycle:
// env/args in, progress logs plus a single-line JSON summary out, and a meaningful exit code.

import { readFile } from "node:fs/promises";
import { planRun, summarizeRunCost, type RunCostLedger, type RunPlan } from "../workspace/conductor.js";
import { summarizeModelUsage } from "../observability/modelUsage.js";
import { getRun, retryNode, runNextNode, startDryRun } from "../workspace/executor.js";
import { registerCmsAgentStoreFactory, type BlobStoreClient } from "../repository/blobs/blobClient.js";
import { createGcsStoreClient } from "../repository/gcs/gcsStoreClient.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { ExecutionMode } from "../execution/executionContext.js";
import type { ExecutionStatus, WorkflowExecutionRecord } from "../workspace/executionTypes.js";

const TERMINAL_STATUSES = new Set<ExecutionStatus>(["blocked", "cancelled", "completed", "failed"]);
// Matches workflow.run_all's advance bound; the canonical graph has 18 nodes, so this is headroom
// for retries, never a pacing mechanism.
const DEFAULT_MAX_STEPS = 100;

export type ConductorJobOptions = {
  projectId: string;
  executionMode?: ExecutionMode;
  /** Initial workflow input (content_source envelope / instructions), passed through verbatim. */
  input?: unknown;
  /** Resume an existing run instead of starting a new one. A blocked run is re-queued only when
   * `approved` is also set; a cancelled run is never resurrected here (reset is a deliberate act). */
  resumeRunId?: string;
  /** Allow publish-risk nodes to execute. Downstream publish gates (per-project env flag,
   * readiness policy, workflow.publish_run) still apply — this only lifts the executor's stop. */
  approved?: boolean;
  maxSteps?: number;
  /** Optional per-run cost ceiling in USD. Default OFF (omit = no gate). When set, the run halts
   * (status blocked, paused for budget) before dispatching the node that would push accrued
   * estimated model cost to/over the ceiling; that node is not executed and the run stays resumable. */
  budgetUsd?: number;
  log?: (line: string) => void;
  /** Graceful stop (Cloud Run SIGTERM): finish the in-flight node, persist, return; the run stays
   * resumable via resumeRunId. */
  signal?: AbortSignal;
};

export type ConductorJobOutcome = "completed" | "blocked" | "failed" | "cancelled" | "stopped" | "step_limit";

export type ConductorJobResult = {
  run: WorkflowExecutionRecord;
  outcome: ConductorJobOutcome;
  steps: number;
  ledger: RunCostLedger;
  plan: RunPlan;
};

// blocked is a successful unattended outcome: the executor stopped exactly at the publish-risk
// gate awaiting human approval, which is the designed end state of a full run without approval.
// stopped means SIGTERM/abort landed between nodes with state persisted — resumable, not an error.
export const exitCodeFor = (outcome: ConductorJobOutcome): number =>
  outcome === "completed" || outcome === "blocked" || outcome === "stopped" ? 0 : 1;

const outcomeFor = (status: ExecutionStatus, stopped: boolean): ConductorJobOutcome => {
  if (status === "completed" || status === "blocked" || status === "cancelled" || status === "failed") return status;
  return stopped ? "stopped" : "step_limit";
};

// Fail fast on store misconfiguration before minting a run record, and register the GCS transport
// (DIRECTION.md Phase 2) so the lazily-built repositories bind to it on first access. Exported for
// the sibling entrypoints (migration job) and tests.
export function bootstrapWorkspaceStore(): void {
  const workspaceStore = process.env.WORKSPACE_STORE ?? "memory";
  if (workspaceStore === "blobs" && !(process.env.NETLIFY_BLOBS_SITE_ID?.trim() && process.env.NETLIFY_BLOBS_TOKEN?.trim())) {
    throw new Error("WORKSPACE_STORE=blobs outside the Netlify runtime requires NETLIFY_BLOBS_SITE_ID and NETLIFY_BLOBS_TOKEN so the job reads and writes the same production store.");
  }
  if (workspaceStore === "gcs") {
    if (!process.env.GCS_BUCKET?.trim()) {
      throw new Error("WORKSPACE_STORE=gcs requires GCS_BUCKET (and optionally GCS_KEY_PREFIX) so the job can reach the production bucket.");
    }
    registerCmsAgentStoreFactory(() => createGcsStoreClient() as unknown as BlobStoreClient);
  }
}

export async function runConductorJob(options: ConductorJobOptions): Promise<ConductorJobResult> {
  const log = options.log ?? (() => undefined);
  const mode: ExecutionMode = options.executionMode ?? "mock";
  const maxSteps = Math.max(1, Math.floor(options.maxSteps ?? DEFAULT_MAX_STEPS));
  // Fail fast on configuration the first node would otherwise fail on, before minting a run record.
  if (mode === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for executionMode=openai; refusing to create a run that would fail its first node.");
  }
  bootstrapWorkspaceStore();

  const executionRepository = repositoryManager.getExecutionRepository();
  const workspaceRepository = repositoryManager.getWorkspaceRepository();

  let run: WorkflowExecutionRecord;
  if (options.resumeRunId) {
    const existing = await getRun(options.resumeRunId, executionRepository);
    if (!existing) throw new Error(`Unknown run: ${options.resumeRunId}`);
    run = existing;
    log(`Resuming run ${run.runId} (status ${run.status})`);
  } else {
    run = await startDryRun({ projectId: options.projectId, input: options.input, executionMode: mode, budgetUsd: options.budgetUsd }, executionRepository);
    log(`Started run ${run.runId} (project ${options.projectId}, mode ${mode}, ${run.nodes.length} nodes${options.budgetUsd !== undefined ? `, budget $${options.budgetUsd}` : ""})`);
  }

  let steps = 0;
  let stopped = false;
  const loggedNodeStates = new Map<string, ExecutionStatus>();
  const logNodeTransitions = (current: WorkflowExecutionRecord) => {
    for (const node of current.nodes) {
      if (node.status === "queued" || node.status === "running") continue;
      if (loggedNodeStates.get(node.nodeId) === node.status) continue;
      loggedNodeStates.set(node.nodeId, node.status);
      log(`  [step ${steps}] ${node.nodeId} → ${node.status}${typeof node.durationMs === "number" ? ` (${node.durationMs}ms)` : ""}`);
    }
  };

  if (run.status === "blocked" && options.approved === true) {
    // Resuming a blocked run must go through the sanctioned retry path: the executor schedules
    // only queued NODES, so merely re-queuing the run-level status would skip the blocked node
    // and mark the run completed without ever executing it. retryNode resets the blocked node to
    // queued (clearing its approval entry) and advances exactly once.
    const blockedNodeId = run.approvalsRequired[0]?.nodeId ?? run.nodes.find((node) => node.status === "blocked")?.nodeId;
    if (blockedNodeId) {
      log(`Re-queuing blocked node ${blockedNodeId} with approval`);
      run = (await retryNode(run.runId, blockedNodeId, { executionRepository, workspaceRepository, approved: true })) ?? run;
      steps += 1;
    }
  }
  logNodeTransitions(run);

  while (!TERMINAL_STATUSES.has(run.status) && steps < maxSteps) {
    if (options.signal?.aborted) { stopped = true; break; }
    run = await runNextNode(run.runId, { executionRepository, workspaceRepository, approved: options.approved });
    steps += 1;
    logNodeTransitions(run);
  }

  const usage = await summarizeModelUsage({ runId: run.runId }, repositoryManager.getUsageRepository());
  const ledger = summarizeRunCost(run, usage);
  const plan = planRun(run);
  const outcome = outcomeFor(run.status, stopped);
  log(`Run ${run.runId} finished: ${outcome} (status ${run.status}, ${steps} step(s), ~$${ledger.totalCostUsdEstimate.toFixed(4)} estimated)`);
  if (run.approvalsRequired.length > 0) {
    log(`Approvals required: ${run.approvalsRequired.map((approval) => `${approval.nodeId} — ${approval.reason}`).join("; ")}`);
  }
  if (run.budgetBlock) {
    log(`Paused for budget: ${run.budgetBlock.reason}`);
  }
  return { run, outcome, steps, ledger, plan };
}

export type CliParseResult = { options: ConductorJobOptions };

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const hasFlag = (argv: string[], name: string): boolean => argv.includes(`--${name}`);

const parseJsonInput = (raw: string, source: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${source} must contain valid JSON.`);
  }
};

// Flags override env so `gcloud run jobs execute --args` can vary a single execution while the
// job's env vars carry the defaults. Env: PROJECT_ID, EXECUTION_MODE, RUN_INPUT_JSON,
// RUN_INPUT_FILE, RESUME_RUN_ID, RUN_APPROVED, MAX_STEPS.
export async function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv): Promise<ConductorJobOptions> {
  const mode = flagValue(argv, "mode") ?? env.EXECUTION_MODE ?? "mock";
  if (mode !== "mock" && mode !== "openai") throw new Error(`Unsupported --mode "${mode}" (expected mock or openai).`);
  const inputFile = flagValue(argv, "input-file") ?? env.RUN_INPUT_FILE;
  const inlineInput = flagValue(argv, "input") ?? env.RUN_INPUT_JSON;
  let input: unknown;
  if (inlineInput !== undefined) input = parseJsonInput(inlineInput, "--input / RUN_INPUT_JSON");
  else if (inputFile) input = parseJsonInput(await readFile(inputFile, "utf8"), `Input file ${inputFile}`);
  const maxStepsRaw = flagValue(argv, "max-steps") ?? env.MAX_STEPS;
  const maxSteps = maxStepsRaw === undefined ? undefined : Number.parseInt(maxStepsRaw, 10);
  if (maxSteps !== undefined && (!Number.isFinite(maxSteps) || maxSteps < 1)) throw new Error(`--max-steps must be a positive integer.`);
  const budgetRaw = flagValue(argv, "budget") ?? env.RUN_BUDGET_USD;
  const budgetUsd = budgetRaw === undefined ? undefined : Number.parseFloat(budgetRaw);
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) throw new Error(`--budget / RUN_BUDGET_USD must be a non-negative number.`);
  return {
    projectId: flagValue(argv, "project") ?? env.PROJECT_ID ?? "dr-lurie",
    executionMode: mode,
    input,
    resumeRunId: flagValue(argv, "run") ?? env.RESUME_RUN_ID ?? undefined,
    approved: hasFlag(argv, "approved") || env.RUN_APPROVED === "true" ? true : undefined,
    maxSteps,
    budgetUsd
  };
}

// Compact single-line JSON so Cloud Logging ingests the summary as one structured entry.
const summarize = (result: ConductorJobResult): string => JSON.stringify({
  runId: result.run.runId,
  projectId: result.run.projectId,
  executionMode: result.run.executionMode,
  outcome: result.outcome,
  status: result.run.status,
  steps: result.steps,
  nodes: result.run.nodes.map((node) => ({ id: node.nodeId, status: node.status, ...(typeof node.durationMs === "number" ? { ms: node.durationMs } : {}) })),
  approvalsRequired: result.run.approvalsRequired,
  errors: result.run.errors,
  cost: {
    totalTokens: result.ledger.totalTokens,
    totalCostUsdEstimate: result.ledger.totalCostUsdEstimate,
    mostExpensiveNodeId: result.ledger.mostExpensiveNodeId,
    ...(result.ledger.budget ? { budget: result.ledger.budget } : {})
  },
  nextStep: result.plan.reason
});

export async function cliMain(argv: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
  const options = await parseCliOptions(argv, env);
  const result = await runConductorJob({ ...options, signal, log: (line) => console.error(line) });
  console.log(summarize(result));
  return exitCodeFor(result.outcome);
}
