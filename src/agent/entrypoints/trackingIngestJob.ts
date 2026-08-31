// T21.7: scheduled entrypoint for feedback.ingest_tracking (improvement/trackingIngest.ts). Same shape
// as monetizerIngestJob.ts (and the other Cloud Run Job entrypoints — runConductorJob.ts,
// conversationTurnGcJob.ts): a plain, directly-testable function plus a thin CLI parser, no
// orchestration logic of its own. Meant to run DAILY: the sink's rollups are day-grained, so the
// default window is the previous whole UTC day, which is what a once-a-day schedule should pull.
//
// Setting TRACKING_SINK_URL/TRACKING_SINK_TOKEN is an operator task (site genesis provisions the pair
// per tenant), not this job's concern. Its only responsibility toward that is to behave correctly on
// BOTH sides of it: an unconfigured sink is a clean, named no-op (exit 0), never a crash — so this can
// be wired into a schedule before the secrets exist without failing every run until someone notices.
import {
  ingestTrackingRollups,
  trackingSinkConnectionState,
  type TrackingIngestResult,
  type TrackingSinkConnectionState
} from "../improvement/trackingIngest.js";
import type { EvaluationRepository } from "../repository/interfaces/EvaluationRepository.js";
import type { WorkspaceActor } from "../workspace/changeTypes.js";
import { repositoryManager } from "../runtime/repositories.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";

export type TrackingIngestJobOptions = {
  /** Tracking partition to read (the sink's TRACKING_PROJECT_ID). Falls back to that env var. */
  projectId?: string;
  /** Window bounds; default to the previous whole UTC day, the natural window for a daily schedule. */
  from?: string;
  to?: string;
  nodeId?: string;
  actor?: string | WorkspaceActor;
  /** Report what WOULD run (connection + resolved window) without calling the sink or writing
   * anything. Never touches the workspace store, so it is safe to run with no store configured. */
  dryRun?: boolean;
  evaluationRepository?: EvaluationRepository;
  env?: NodeJS.ProcessEnv;
  /** Test seam: injected straight through to ingestTrackingRollups, which defaults to global fetch
   * when omitted. Never set outside a test — production always uses the real sink. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type TrackingIngestWindow = { projectId: string; from: string; to: string; nodeId?: string };

export type TrackingIngestJobResult =
  | { status: "skipped_unconfigured"; reason: string; connection: TrackingSinkConnectionState }
  | { status: "dry_run"; window: TrackingIngestWindow; connection: TrackingSinkConnectionState }
  | { status: "completed" | "failed"; window: TrackingIngestWindow; result: TrackingIngestResult; connection: TrackingSinkConnectionState };

const DEFAULT_ACTOR: WorkspaceActor = { kind: "agent", label: "tracking_ingest_job" };
const PROJECT_ID_ENV = "TRACKING_PROJECT_ID";

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Previous whole UTC day — the window a daily schedule should pull (yesterday is complete; today is not). */
export const previousUtcDay = (reference: Date = new Date()): { from: string; to: string } => {
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { from: isoDay(start), to: isoDay(end) };
};

export async function runTrackingIngestJob(options: TrackingIngestJobOptions = {}): Promise<TrackingIngestJobResult> {
  const env = options.env ?? process.env;
  const connection = trackingSinkConnectionState(env);

  // Checked BEFORE anything else that could throw (bootstrapWorkspaceStore included) — the whole point
  // of this branch is that a not-yet-configured sink is a quiet no-op, not a failure, so it must not
  // depend on the workspace store or any other piece of deploy configuration being right.
  if (!connection.urlConfigured || !connection.tokenConfigured) {
    const missing = [!connection.urlConfigured ? connection.urlEnvVar : undefined, !connection.tokenConfigured ? connection.tokenEnvVar : undefined].filter(Boolean);
    return {
      status: "skipped_unconfigured",
      reason: `Tracking sink is not configured (${missing.join(", ")} unset) — no-op, not a failure. Setting these is an operator task (site genesis provisions the pair per tenant); this job runs cleanly on either side of that.`,
      connection
    };
  }

  const projectId = options.projectId?.trim() || env[PROJECT_ID_ENV]?.trim();
  if (!projectId) {
    return {
      status: "skipped_unconfigured",
      reason: `No tracking project partition to read (${PROJECT_ID_ENV} unset and no --project given) — no-op, not a failure.`,
      connection
    };
  }

  const defaults = previousUtcDay(options.now?.() ?? new Date());
  const window: TrackingIngestWindow = {
    projectId,
    from: options.from?.trim() || defaults.from,
    to: options.to?.trim() || defaults.to,
    ...(options.nodeId ? { nodeId: options.nodeId } : {})
  };
  if (options.dryRun) return { status: "dry_run", window, connection };

  bootstrapWorkspaceStore();
  const evaluationRepository = options.evaluationRepository ?? repositoryManager.getEvaluationRepository();
  const result = await ingestTrackingRollups(
    { projectId: window.projectId, from: window.from, to: window.to, nodeId: window.nodeId, actor: options.actor ?? DEFAULT_ACTOR },
    { evaluationRepository, env, fetchImpl: options.fetchImpl }
  );
  // ingestTrackingRollups is deliberately best-effort and never throws — a "hard failure" at the job
  // level is a configured sink that still ingested nothing at all while reporting an error. An empty
  // window (zero rows, zero errors) is a legitimate quiet day, not a failure; a partial result (some
  // rows recorded, some rejected) still completes: that is the per-row contract working as designed.
  const status = result.ingested.length === 0 && result.errors.length > 0 ? "failed" : "completed";
  return { status, window, result, connection };
}

export const exitCodeFor = (result: TrackingIngestJobResult): number => (result.status === "failed" ? 1 : 0);

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const requireDate = (value: string | undefined, flag: string): string | undefined => {
  if (value === undefined || !value.trim()) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`--${flag} must be an ISO date or date-time (got an unparseable value).`);
  return value.trim();
};

// Env: TRACKING_PROJECT_ID, TRACKING_INGEST_FROM, TRACKING_INGEST_TO, TRACKING_INGEST_NODE_ID,
// TRACKING_INGEST_DRY_RUN. Flags override env, same convention as monetizerIngestJob.ts.
export async function cliMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const result = await runTrackingIngestJob({
    projectId: flagValue(argv, "project") ?? env.TRACKING_PROJECT_ID,
    from: requireDate(flagValue(argv, "from") ?? env.TRACKING_INGEST_FROM, "from"),
    to: requireDate(flagValue(argv, "to") ?? env.TRACKING_INGEST_TO, "to"),
    nodeId: flagValue(argv, "node") ?? env.TRACKING_INGEST_NODE_ID,
    dryRun: argv.includes("--dry-run") || env.TRACKING_INGEST_DRY_RUN === "true",
    env
  });
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}
