// P3-cost (§2.19): scheduled entrypoint for feedback.ingest_monetizer (monetizerIngest.ts). Before
// this job existed nothing outside a manual MCP call ever invoked ingestMonetizerAnalytics, so the
// feedback store held zero outcome records, ever — no published-content performance signal had ever
// entered the learning substrate. Same shape as the other Cloud Run Job entrypoints
// (runConductorJob.ts, conversationTurnGcJob.ts): a plain, directly-testable function plus a thin CLI
// parser, no orchestration logic of its own.
//
// Setting MONETIZER_MCP_ENDPOINT/MONETIZER_MCP_TOKEN is an operator task (Wolf), not this job's
// concern. This job's only responsibility toward that is to behave correctly on BOTH sides of it: an
// unconfigured connection is a clean, named no-op (exit 0), never a crash — so this can be wired into
// a schedule before the secrets exist without failing every run until someone notices.
import { toConnectionState } from "../projects/projectMcpAdapter.js";
import { monetizerProjectConfig } from "../projects/monetizer/definition.js";
import type { ProjectConnectionState } from "../projects/projectTypes.js";
import { ingestMonetizerAnalytics, MONETIZER_SIGNALS, type CallToolFn, type MonetizerIngestResult, type MonetizerSignal } from "../improvement/monetizerIngest.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import type { WorkspaceActor } from "../workspace/changeTypes.js";
import { repositoryManager } from "../runtime/repositories.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";

export type MonetizerIngestJobOptions = {
  runId?: string;
  nodeId?: string;
  signals?: MonetizerSignal[];
  /** Query args forwarded to each Monetizer tool call (e.g. a limit/window the remote supports). */
  args?: Record<string, unknown>;
  note?: string;
  actor?: string | WorkspaceActor;
  /** Report what WOULD run (connection + resolved signals) without calling Monetizer or writing
   * anything. Never touches the workspace store, so it is safe to run with no store configured. */
  dryRun?: boolean;
  evaluationRepository?: EvaluationRepository;
  env?: NodeJS.ProcessEnv;
  /** Test seam: injected straight through to ingestMonetizerAnalytics, which defaults to a real
   * ProjectMcpAdapter when omitted. Never set outside a test — production always uses the real
   * adapter, resolved from MONETIZER_MCP_ENDPOINT/MONETIZER_MCP_TOKEN. */
  callTool?: CallToolFn;
};

export type MonetizerIngestJobResult =
  | { status: "skipped_unconfigured"; reason: string; connection: ProjectConnectionState }
  | { status: "dry_run"; signals: MonetizerSignal[]; connection: ProjectConnectionState }
  | { status: "completed" | "failed"; signals: MonetizerSignal[]; result: MonetizerIngestResult; connection: ProjectConnectionState };

const DEFAULT_ACTOR: WorkspaceActor = { kind: "agent", label: "monetizer_ingest_job" };

export async function runMonetizerIngestJob(options: MonetizerIngestJobOptions = {}): Promise<MonetizerIngestJobResult> {
  const env = options.env ?? process.env;
  const connection = toConnectionState(monetizerProjectConfig, env);
  const signals = options.signals?.length ? options.signals : MONETIZER_SIGNALS;

  // Checked BEFORE anything else that could throw (bootstrapWorkspaceStore included) — the whole
  // point of this branch is that a not-yet-configured connection is a quiet no-op, not a failure, so
  // it must not depend on the workspace store or any other piece of deploy configuration being right.
  if (!connection.endpointConfigured || !connection.tokenConfigured) {
    const missing = [!connection.endpointConfigured ? connection.mcpEndpointEnvVar : undefined, !connection.tokenConfigured ? connection.tokenEnvVar : undefined].filter(Boolean);
    return {
      status: "skipped_unconfigured",
      reason: `Monetizer connection is not configured (${missing.join(", ")} unset) — no-op, not a failure. Setting these is an operator task (see handoff §2.19); this job runs cleanly on either side of that.`,
      connection
    };
  }
  if (options.dryRun) return { status: "dry_run", signals, connection };

  bootstrapWorkspaceStore();
  const evaluationRepository = options.evaluationRepository ?? repositoryManager.getEvaluationRepository();
  const result = await ingestMonetizerAnalytics(
    { nodeId: options.nodeId, runId: options.runId, signals, args: options.args, actor: options.actor ?? DEFAULT_ACTOR, note: options.note },
    { evaluationRepository, env, callTool: options.callTool }
  );
  // ingestMonetizerAnalytics is deliberately best-effort per signal and never throws — a "hard
  // failure" at the job level is a configured connection that still ingested nothing at all (every
  // requested signal errored). A partial result (some ingested, some errored) still completes: that
  // is the per-signal contract working as designed, not a job failure.
  const status = result.ingested.length === 0 && result.errors.length > 0 ? "failed" : "completed";
  return { status, signals, result, connection };
}

export const exitCodeFor = (result: MonetizerIngestJobResult): number => (result.status === "failed" ? 1 : 0);

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const parseSignals = (raw: string | undefined): MonetizerSignal[] | undefined => {
  if (!raw?.trim()) return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const valid = new Set<string>(MONETIZER_SIGNALS);
  const invalid = values.filter((value) => !valid.has(value));
  if (invalid.length) throw new Error(`--signals contains unknown signal(s): ${invalid.join(", ")} (expected: ${MONETIZER_SIGNALS.join(", ")}).`);
  return values as MonetizerSignal[];
};

// Env: MONETIZER_INGEST_RUN_ID, MONETIZER_INGEST_NODE_ID, MONETIZER_INGEST_SIGNALS (comma-separated),
// MONETIZER_INGEST_LIMIT, MONETIZER_INGEST_NOTE, MONETIZER_INGEST_DRY_RUN. Flags override env, same
// convention as runConductorJob.ts.
export async function cliMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const limitRaw = flagValue(argv, "limit") ?? env.MONETIZER_INGEST_LIMIT;
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error("--limit must be a positive integer.");
  const result = await runMonetizerIngestJob({
    runId: flagValue(argv, "run") ?? env.MONETIZER_INGEST_RUN_ID,
    nodeId: flagValue(argv, "node") ?? env.MONETIZER_INGEST_NODE_ID,
    signals: parseSignals(flagValue(argv, "signals") ?? env.MONETIZER_INGEST_SIGNALS),
    args: limit !== undefined ? { limit } : undefined,
    note: flagValue(argv, "note") ?? env.MONETIZER_INGEST_NOTE,
    dryRun: argv.includes("--dry-run") || env.MONETIZER_INGEST_DRY_RUN === "true",
    env
  });
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}
