// T21.37: scheduled entrypoint for the editorial strategy review (improvement/strategyReview.ts).
//
// Deliberately the SAME shape as strategyLearningJob.ts and trackingIngestJob.ts, its siblings on the
// same sink: a plain, directly-testable function plus a thin CLI parser, no orchestration logic of
// its own, and every not-yet-configured piece of the world as a clean named no-op rather than a
// crash — so an operator can create the schedule before the secrets, before the strategy object has
// an address, and before T21.35's daily pass has recorded a single observation.
//
// The one difference from its siblings is the CADENCE and therefore the default WINDOW: this job is
// WEEKLY and defaults to the previous whole UTC week, because its whole purpose is to compare that
// week against the one before it. A daily window would be asking a week's question of a day's data.
//
// It never patches anything. Its output is a marginalia proposal on the governed strategy object;
// autonomous patching is behind STRATEGY_REVIEW_AUTOPATCH, off by default, and this job reports the
// flag's state in its own JSON summary so an operator never has to grep for it.
import {
  STRATEGY_REVIEW_AUTOPATCH_ENV,
  reviewEditorialStrategy,
  strategyObjectRefState,
  type StrategyObjectRefState,
  type StrategyReviewResult
} from "../improvement/strategyReview.js";
import { trackingSinkConnectionState, TRACKING_PROJECT_ID_ENV, type TrackingSinkConnectionState } from "../improvement/trackingIngest.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";

export type StrategyReviewJobOptions = {
  /** Tracking partition to read (the sink's TRACKING_PROJECT_ID). Falls back to that env var. */
  projectId?: string;
  /** Window bounds; default to the previous whole UTC week — the natural window for a weekly schedule. */
  from?: string;
  to?: string;
  /** Report what WOULD run (connection, strategy object address, resolved windows, autopatch state)
   * without calling the sink, the tenant, or the store. */
  dryRun?: boolean;
  learningRepository?: LearningRepository;
  projectRepository?: ProjectRepository;
  env?: NodeJS.ProcessEnv;
  /** Test seam: injected straight through to the one rollups client. Never set outside a test. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type StrategyReviewWindow = { projectId: string; from: string; to: string };

export type StrategyReviewJobResult =
  | { status: "skipped_unconfigured"; reason: string; connection: TrackingSinkConnectionState; strategyObject: StrategyObjectRefState }
  | { status: "dry_run"; window: StrategyReviewWindow; connection: TrackingSinkConnectionState; strategyObject: StrategyObjectRefState; autopatchFlag: { name: string; enabled: boolean } }
  | { status: "proposed" | "no_proposal"; window: StrategyReviewWindow; result: StrategyReviewResult; connection: TrackingSinkConnectionState; strategyObject: StrategyObjectRefState };

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The previous whole UTC week: [today-7d, today), the same half-open shape previousUtcDay produces
 * for the daily jobs. The review then fetches the week before THAT one itself, to apply the
 * two-window half of the stability bar. */
export const previousUtcWeek = (reference: Date = new Date()): { from: string; to: string } => {
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: isoDay(start), to: isoDay(end) };
};

export async function runStrategyReviewJob(options: StrategyReviewJobOptions = {}): Promise<StrategyReviewJobResult> {
  const env = options.env ?? process.env;
  const connection = trackingSinkConnectionState(env);
  const strategyObject = strategyObjectRefState(env);

  // Checked BEFORE anything that could throw (bootstrapWorkspaceStore included), same as every
  // sibling job: a not-yet-configured deployment must be a quiet no-op that does not depend on any
  // other piece of configuration being right.
  if (!connection.urlConfigured || !connection.tokenConfigured) {
    const missing = [!connection.urlConfigured ? connection.urlEnvVar : undefined, !connection.tokenConfigured ? connection.tokenEnvVar : undefined].filter(Boolean);
    return {
      status: "skipped_unconfigured",
      reason: `Tracking sink is not configured (${missing.join(", ")} unset) — no-op, not a failure. Setting these is an operator task (site genesis provisions the pair per tenant); this job runs cleanly on either side of that.`,
      connection,
      strategyObject
    };
  }

  const projectId = options.projectId?.trim() || env[TRACKING_PROJECT_ID_ENV]?.trim();
  if (!projectId) {
    return {
      status: "skipped_unconfigured",
      reason: `No tracking project partition to read (${TRACKING_PROJECT_ID_ENV} unset and no --project given) — no-op, not a failure.`,
      connection,
      strategyObject
    };
  }

  if (!strategyObject.configured) {
    return {
      status: "skipped_unconfigured",
      reason: `No governed strategy object to propose against (${strategyObject.missing.join(", ")} unset) — no-op, not a failure. Naming the object an editor owns is an operator task; this job runs cleanly on either side of it.`,
      connection,
      strategyObject
    };
  }

  const defaults = previousUtcWeek(options.now?.() ?? new Date());
  const window: StrategyReviewWindow = { projectId, from: options.from?.trim() || defaults.from, to: options.to?.trim() || defaults.to };
  if (options.dryRun) {
    return {
      status: "dry_run",
      window,
      connection,
      strategyObject,
      autopatchFlag: { name: STRATEGY_REVIEW_AUTOPATCH_ENV, enabled: /^(1|true|on|yes)$/i.test(env[STRATEGY_REVIEW_AUTOPATCH_ENV]?.trim() ?? "") }
    };
  }

  bootstrapWorkspaceStore();
  const result = await reviewEditorialStrategy(
    { projectId: window.projectId, from: window.from, to: window.to },
    {
      learningRepository: options.learningRepository ?? repositoryManager.getLearningRepository(),
      projectRepository: options.projectRepository ?? repositoryManager.getProjectRepository(),
      env,
      fetchImpl: options.fetchImpl
    }
  );

  // reviewEditorialStrategy never throws and every empty outcome is a NAMED fact about the world, not
  // a failure — so this job has no "failed" status at all and always exits 0. A weekly schedule that
  // alerts on a quiet week trains an operator to ignore it.
  return { status: result.status, window, result, connection, strategyObject };
}

export const exitCodeFor = (_result: StrategyReviewJobResult): number => 0;

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const requireDate = (value: string | undefined, flag: string): string | undefined => {
  if (value === undefined || !value.trim()) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`--${flag} must be an ISO date or date-time (got an unparseable value).`);
  return value.trim();
};

// Env: TRACKING_PROJECT_ID, STRATEGY_REVIEW_FROM, STRATEGY_REVIEW_TO, STRATEGY_REVIEW_DRY_RUN.
// Flags override env, same convention as strategyLearningJob.ts / trackingIngestJob.ts.
export async function cliMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const result = await runStrategyReviewJob({
    projectId: flagValue(argv, "project") ?? env.TRACKING_PROJECT_ID,
    from: requireDate(flagValue(argv, "from") ?? env.STRATEGY_REVIEW_FROM, "from"),
    to: requireDate(flagValue(argv, "to") ?? env.STRATEGY_REVIEW_TO, "to"),
    dryRun: argv.includes("--dry-run") || env.STRATEGY_REVIEW_DRY_RUN === "true",
    env
  });
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}
