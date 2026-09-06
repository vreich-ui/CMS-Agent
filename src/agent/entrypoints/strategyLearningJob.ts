// T21.35: scheduled entrypoint for the strategy-learning pass (improvement/strategyLearning.ts).
// Deliberately the SAME shape as trackingIngestJob.ts, its sibling on the same sink: a plain,
// directly-testable function plus a thin CLI parser, no orchestration logic of its own, the previous
// whole UTC day as the default window (the sink's rollups are day-grained), and an unconfigured sink
// as a clean named no-op rather than a crash — so this can be wired into a schedule before the
// secrets exist, and before kugel-data migration 008 has brought the `by=strategy` grain up.
//
// It runs ALONGSIDE job:tracking-ingest, not instead of it: that job files per-producer engagement as
// feedback outcomes, this one learns what KIND of piece works and writes it into the writer and
// planning playbooks. Order does not matter between them — they read the same sink at different
// grains and write to different substrates.
import {
  ingestStrategyRollups,
  STRATEGY_PLAYBOOK_TARGET_NODES,
  type StrategyLearningResult
} from "../improvement/strategyLearning.js";
import { trackingSinkConnectionState, TRACKING_PROJECT_ID_ENV, type TrackingSinkConnectionState } from "../improvement/trackingIngest.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ImprovementRepository } from "../repository/interfaces/ImprovementRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";
import { previousUtcDay } from "./trackingIngestJob.js";

export type StrategyLearningJobOptions = {
  /** Tracking partition to read (the sink's TRACKING_PROJECT_ID). Falls back to that env var. */
  projectId?: string;
  /** Window bounds; default to the previous whole UTC day, the natural window for a daily schedule. */
  from?: string;
  to?: string;
  /** Report what WOULD run (connection + resolved window + target nodes) without calling the sink or
   * writing anything. Never touches the workspace store, so it is safe with no store configured. */
  dryRun?: boolean;
  learningRepository?: LearningRepository;
  improvementRepository?: ImprovementRepository;
  env?: NodeJS.ProcessEnv;
  /** Test seam: injected straight through to the one rollups client, which defaults to global fetch
   * when omitted. Never set outside a test — production always uses the real sink. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type StrategyLearningWindow = { projectId: string; from: string; to: string };

export type StrategyLearningJobResult =
  | { status: "skipped_unconfigured"; reason: string; connection: TrackingSinkConnectionState }
  | { status: "dry_run"; window: StrategyLearningWindow; targetNodes: string[]; connection: TrackingSinkConnectionState }
  | { status: "skipped_grain_unavailable"; reason: string; window: StrategyLearningWindow; connection: TrackingSinkConnectionState }
  | { status: "completed" | "failed"; window: StrategyLearningWindow; result: StrategyLearningResult; connection: TrackingSinkConnectionState };

const PROJECT_ID_ENV = TRACKING_PROJECT_ID_ENV;

export async function runStrategyLearningJob(options: StrategyLearningJobOptions = {}): Promise<StrategyLearningJobResult> {
  const env = options.env ?? process.env;
  const connection = trackingSinkConnectionState(env);

  // Checked BEFORE anything that could throw (bootstrapWorkspaceStore included), same as the tracking
  // job: a not-yet-configured sink must be a quiet no-op that does not depend on any other piece of
  // deploy configuration being right.
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
  const window: StrategyLearningWindow = { projectId, from: options.from?.trim() || defaults.from, to: options.to?.trim() || defaults.to };
  if (options.dryRun) return { status: "dry_run", window, targetNodes: [...STRATEGY_PLAYBOOK_TARGET_NODES], connection };

  bootstrapWorkspaceStore();
  const result = await ingestStrategyRollups(
    { projectId: window.projectId, from: window.from, to: window.to },
    {
      learningRepository: options.learningRepository ?? repositoryManager.getLearningRepository(),
      improvementRepository: options.improvementRepository ?? repositoryManager.getImprovementRepository(),
      env,
      fetchImpl: options.fetchImpl
    }
  );

  // A grain that has not been migrated yet is not a failure and not an error the caller has to read
  // past — it is the same "nothing to do here yet" an unconfigured sink gets, reported by its own name
  // so an operator can see WHY there is nothing rather than assuming a quiet day.
  if (result.skipped === "grain_unavailable") {
    return {
      status: "skipped_grain_unavailable",
      reason: "The tracking sink's by=strategy grain answered 503 — it is not deployed on this tenant's sink yet (kugel-data migration 008). No-op, not a failure; nothing was observed and no playbook was touched.",
      window,
      connection
    };
  }

  // ingestStrategyRollups is deliberately best-effort and never throws. A "hard failure" at the job
  // level is a configured, migrated sink that produced no observation at all while reporting an
  // error. An empty window (rows but nothing material, or no rows) is a legitimate quiet day.
  const status = result.observations.length === 0 && result.errors.length > 0 ? "failed" : "completed";
  return { status, window, result, connection };
}

export const exitCodeFor = (result: StrategyLearningJobResult): number => (result.status === "failed" ? 1 : 0);

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const requireDate = (value: string | undefined, flag: string): string | undefined => {
  if (value === undefined || !value.trim()) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`--${flag} must be an ISO date or date-time (got an unparseable value).`);
  return value.trim();
};

// Env: TRACKING_PROJECT_ID, STRATEGY_LEARNING_FROM, STRATEGY_LEARNING_TO, STRATEGY_LEARNING_DRY_RUN.
// Flags override env, same convention as trackingIngestJob.ts / monetizerIngestJob.ts.
export async function cliMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const result = await runStrategyLearningJob({
    projectId: flagValue(argv, "project") ?? env.TRACKING_PROJECT_ID,
    from: requireDate(flagValue(argv, "from") ?? env.STRATEGY_LEARNING_FROM, "from"),
    to: requireDate(flagValue(argv, "to") ?? env.STRATEGY_LEARNING_TO, "to"),
    dryRun: argv.includes("--dry-run") || env.STRATEGY_LEARNING_DRY_RUN === "true",
    env
  });
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}
