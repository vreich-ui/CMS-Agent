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
//
// ── W4 (2026-09-09, Wolf): IT SERVES EVERY TENANT NOW, FROM THE RECORD ───────────────────────────
//
// This job used to be able to review exactly ONE tenant, and not by policy. Its two addresses were
// both single global env values on the deployment: TRACKING_PROJECT_ID named the sink partition to
// read, and the EDITORIAL_STRATEGY_* triple named the object to propose against. Whichever tenant an
// operator had wired in got a weekly proposal; every other tenant got nothing, silently, forever, and
// nothing in the job's own output said so — a "no_proposal" summary looks identical whether a tenant
// was quiet or was never looked at.
//
// Both addresses now come from the TENANT'S OWN RECORD (projectTypes.ts: tracking.projectId and
// objectDialect.strategyObjectId, each with a working convention behind it), so a run walks every
// active tenant and proposes at each one's own object. Three properties hold that walk together:
//
//   1. PER-TENANT NAMED RESULTS. Every tenant appears in the summary by project id, with the
//      partition it was read at and the object address the proposal was written to. A tenant that
//      produced nothing is distinguishable from a tenant that was never eligible, which is exactly
//      what the old single-address shape could not express.
//   2. ISOLATION. One tenant's refused marginalia write, dead endpoint or malformed record is that
//      tenant's outcome and nothing else's. The loop keeps going.
//   3. EXIT 0, ALWAYS, unchanged. A weekly schedule that alerts on a quiet week — or on one tenant's
//      expired bearer — trains an operator to ignore it.
//
// The EDITORIAL_STRATEGY_* triple survives as a SINGLE-TENANT OVERRIDE and its behavior is byte-for-
// byte what it was. That is not sentiment: it is what makes `--dry-run` against one named tenant a
// debugging tool rather than a walk of the whole fleet.
import {
  STRATEGY_REVIEW_AUTOPATCH_ENV,
  reviewEditorialStrategy,
  strategyObjectRefState,
  type StrategyObjectRef,
  type StrategyObjectRefState,
  type StrategyReviewResult
} from "../improvement/strategyReview.js";
import { trackingSinkConnectionState, TRACKING_PROJECT_ID_ENV, type TrackingSinkConnectionState } from "../improvement/trackingIngest.js";
import { EDITORIAL_STRATEGY_OBJECT_TYPE, getEditorialStrategy, type StrategyResolutionDeps, type StrategyResolutionResult } from "../projects/genesisEditorialStrategy.js";
import { resolveProjectConnection } from "../projects/projectMcpAdapter.js";
import { conventionalStrategyObjectId, resolveTrackingPartition, type ProjectConnectionConfig } from "../projects/projectTypes.js";
import type { LearningRepository } from "../repository/interfaces/LearningRepository.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";
import { repositoryManager } from "../runtime/repositories.js";
import { bootstrapWorkspaceStore } from "./runConductorJob.js";

export type StrategyReviewJobOptions = {
  /** Tracking partition to read (the sink's TRACKING_PROJECT_ID). Falls back to that env var. On the
   * fan-out path it NARROWS the walk to the tenant(s) resolving to that partition, which is how one
   * tenant stays debuggable without the EDITORIAL_STRATEGY_* triple. */
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
  /** Test seam: the tenant-MCP READ used to resolve each tenant's editorial_strategy object, and the
   * tenant-MCP CALL used to write the proposal. Both default to ProjectMcpAdapter against the
   * tenant's own record. Never set outside a test. */
  readObject?: StrategyResolutionDeps["callReadTool"];
  callProjectTool?: (ref: StrategyObjectRef, tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  now?: () => Date;
};

export type StrategyReviewWindow = { projectId: string; from: string; to: string };

/** One tenant's resolved addresses: which sink partition it is read at, and which governed object a
 * proposal would be written to. Both sources are reported so an operator can see whether a value came
 * off the record or off a convention without re-deriving either. */
export type StrategyReviewTenantAddress = {
  /** The CMS-Agent project id ("dr-lurie") — NOT the partition. */
  projectId: string;
  trackingProjectId: string;
  trackingSource: "env" | "record" | "convention";
  objectRef: StrategyObjectRef;
  objectIdSource: "record" | "convention";
};

/** How this tenant's governed strategy object resolved, carried on the outcome so a summary can say
 * WHICH tenants are still running on a genesis default. Wolf, 2026-09-09: unset never blocks — a
 * default is a warning beside a proposal, never a reason to skip the tenant. */
export type StrategyReviewTenantStrategyState = {
  source: StrategyResolutionResult["source"];
  warningCode?: StrategyResolutionResult["warningCode"];
  warning?: string;
};

export type StrategyReviewTenantOutcome = StrategyReviewTenantAddress &
  { strategy: StrategyReviewTenantStrategyState } &
  (
    | { status: "proposed" | "no_proposal"; result: StrategyReviewResult }
    // NAMED, and per tenant. `marginalia_write_failed` is the review's own worst case (the delta
    // stands, the tenant refused the thread) and an unreachable endpoint arrives the same way; either
    // way it is reported against the tenant it happened to and stops nothing else.
    | { status: "failed"; error: string; result?: StrategyReviewResult }
  );

export type StrategyReviewSkippedTenant = { projectId: string; reason: string };

export type StrategyReviewJobResult =
  | { status: "skipped_unconfigured"; reason: string; connection: TrackingSinkConnectionState; strategyObject: StrategyObjectRefState }
  | { status: "dry_run"; window: StrategyReviewWindow; connection: TrackingSinkConnectionState; strategyObject: StrategyObjectRefState; autopatchFlag: { name: string; enabled: boolean } }
  | { status: "proposed" | "no_proposal"; window: StrategyReviewWindow; result: StrategyReviewResult; connection: TrackingSinkConnectionState; strategyObject: StrategyObjectRefState }
  | {
      status: "dry_run_fanout";
      window: { from: string; to: string };
      tenants: StrategyReviewTenantAddress[];
      skipped: StrategyReviewSkippedTenant[];
      /** One line per tenant: project id, sink partition, strategy object address. Printed by the CLI
       * so a dry run answers "who would this touch, and where" without parsing JSON. */
      addressLines: string[];
      connection: TrackingSinkConnectionState;
      strategyObject: StrategyObjectRefState;
      autopatchFlag: { name: string; enabled: boolean };
    }
  | {
      status: "fanout";
      window: { from: string; to: string };
      tenants: StrategyReviewTenantOutcome[];
      skipped: StrategyReviewSkippedTenant[];
      connection: TrackingSinkConnectionState;
      strategyObject: StrategyObjectRefState;
    };

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The previous whole UTC week: [today-7d, today), the same half-open shape previousUtcDay produces
 * for the daily jobs. The review then fetches the week before THAT one itself, to apply the
 * two-window half of the stability bar. */
export const previousUtcWeek = (reference: Date = new Date()): { from: string; to: string } => {
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: isoDay(start), to: isoDay(end) };
};

/**
 * WHICH PROJECTS THE WALK COVERS, and why it is not simply "every active project".
 *
 * The registry holds two kinds of thing under one shape. Most entries are content TENANTS — sites
 * that publish, carry a governed editorial_strategy object, and have a human who owns it. Some are
 * INTERNAL SERVICE projects this workspace calls out to (monetizer, pdf-tool): they are equally
 * "active", equally reachable, and have no editorial strategy, no editor and no marginalia thread
 * anyone would ever read. Walking them would open a weekly comment thread on a machine.
 *
 * No field says "this is a tenant" outright (projectAdmin.bearerEnvClientSiteBindingAdvisory says so
 * plainly and refuses to guess in either direction), so eligibility is decided by the markers a
 * content tenant actually carries: a client-site binding (every genesis-minted tenant, and the fleet
 * credential reconciler's own marker), an object dialect (every object-native publisher, which covers
 * dr-lurie, platform and fernwell, all of which predate genesis), or an explicit tracking partition.
 * A service project has none of the three.
 *
 * Every exclusion is REPORTED BY NAME with its reason. That is the half that matters: the failure
 * this whole change exists to end was tenants being left out silently, and an eligibility rule that
 * dropped them quietly would simply move the silence rather than remove it.
 */
export function resolveStrategyReviewTenants(
  projects: ProjectConnectionConfig[],
  options: { env?: NodeJS.ProcessEnv; partitionFilter?: string } = {}
): { addressed: StrategyReviewTenantAddress[]; skipped: StrategyReviewSkippedTenant[] } {
  const env = options.env ?? process.env;
  const addressed: StrategyReviewTenantAddress[] = [];
  const skipped: StrategyReviewSkippedTenant[] = [];

  for (const project of [...projects].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
    if (project.status !== "active") {
      skipped.push({ projectId: project.projectId, reason: `status is "${project.status}" — a paused tenant is not proposed at.` });
      continue;
    }
    if (!project.clientSiteBinding && !project.objectDialect && !project.tracking) {
      skipped.push({
        projectId: project.projectId,
        reason: "carries none of clientSiteBinding / objectDialect / tracking, so nothing marks it as a content tenant. Internal service projects (monetizer, pdf-tool) land here by design — an editorial_strategy proposal has no reader on a machine. If this IS a tenant, set one of those on its record (project.update) and it joins the walk."
      });
      continue;
    }
    // The proposal is a marginalia_create against the tenant's own MCP. A project with no resolvable
    // endpoint cannot receive one, and saying so up front beats a per-tenant transport failure that
    // reads like an outage.
    if (!resolveProjectConnection(project, env).endpointConfigured) {
      skipped.push({ projectId: project.projectId, reason: `no MCP endpoint resolves (neither ${project.mcpEndpointEnvVar} nor a stored mcpEndpoint), so a proposal could not be written to it.` });
      continue;
    }
    // No env override here, ever: TRACKING_PROJECT_ID is ONE global value, and applying it per project
    // inside a walk would point the entire fleet at one tenant's numbers. See resolveTrackingPartition.
    const partition = resolveTrackingPartition(project);
    if (options.partitionFilter && partition.projectId !== options.partitionFilter) {
      skipped.push({ projectId: project.projectId, reason: `sink partition "${partition.projectId}" does not match the requested partition "${options.partitionFilter}".` });
      continue;
    }
    const pointer = project.objectDialect?.strategyObjectId?.trim();
    addressed.push({
      projectId: project.projectId,
      trackingProjectId: partition.projectId,
      trackingSource: partition.source,
      objectRef: {
        projectId: project.projectId,
        objectType: EDITORIAL_STRATEGY_OBJECT_TYPE,
        objectId: pointer || conventionalStrategyObjectId(project.projectId)
      },
      objectIdSource: pointer ? "record" : "convention"
    });
  }
  return { addressed, skipped };
}

/** One line per tenant: project id, sink partition, strategy object address. */
export const strategyReviewAddressLine = (address: StrategyReviewTenantAddress): string =>
  `${address.projectId}  partition=${address.trackingProjectId} (${address.trackingSource})  strategy=${address.objectRef.objectType}/${address.objectRef.objectId} (${address.objectIdSource})`;

const autopatchFlagState = (env: NodeJS.ProcessEnv) => ({
  name: STRATEGY_REVIEW_AUTOPATCH_ENV,
  enabled: /^(1|true|on|yes)$/i.test(env[STRATEGY_REVIEW_AUTOPATCH_ENV]?.trim() ?? "")
});

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

  const requestedPartition = options.projectId?.trim() || env[TRACKING_PROJECT_ID_ENV]?.trim();
  const defaults = previousUtcWeek(options.now?.() ?? new Date());
  const window = { from: options.from?.trim() || defaults.from, to: options.to?.trim() || defaults.to };

  // ── the single-tenant override, unchanged ──
  //
  // Reached only when an operator has named BOTH halves of one tenant's address explicitly. Nothing
  // below this block runs in that case, and nothing inside it consults a project record — this is the
  // path an operator debugs one tenant on, and its behavior is exactly what it always was.
  if (strategyObject.configured && requestedPartition) {
    const overrideWindow: StrategyReviewWindow = { projectId: requestedPartition, ...window };
    if (options.dryRun) {
      return { status: "dry_run", window: overrideWindow, connection, strategyObject, autopatchFlag: autopatchFlagState(env) };
    }
    bootstrapWorkspaceStore();
    const result = await reviewEditorialStrategy(
      { projectId: overrideWindow.projectId, from: overrideWindow.from, to: overrideWindow.to },
      {
        learningRepository: options.learningRepository ?? repositoryManager.getLearningRepository(),
        projectRepository: options.projectRepository ?? repositoryManager.getProjectRepository(),
        env,
        fetchImpl: options.fetchImpl
      }
    );
    // reviewEditorialStrategy never throws and every empty outcome is a NAMED fact about the world,
    // not a failure — so this job has no "failed" status at all and always exits 0. A weekly schedule
    // that alerts on a quiet week trains an operator to ignore it.
    return { status: result.status, window: overrideWindow, result, connection, strategyObject };
  }

  // ── the fan-out: every active tenant, from its own record ──
  let projectRepository = options.projectRepository;
  if (!projectRepository) {
    bootstrapWorkspaceStore();
    projectRepository = repositoryManager.getProjectRepository();
  }
  let projects: ProjectConnectionConfig[] = [];
  try {
    projects = await projectRepository.list();
  } catch (error) {
    // A registry this job cannot read is a configuration fact like any other, not a crash. Named,
    // exit 0, and it says which half of the world it could not see.
    return {
      status: "skipped_unconfigured",
      reason: `The project registry could not be read (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}), so no tenant's strategy address could be resolved — no-op, not a failure.`,
      connection,
      strategyObject
    };
  }

  const { addressed, skipped } = resolveStrategyReviewTenants(projects, { env, ...(requestedPartition ? { partitionFilter: requestedPartition } : {}) });

  if (options.dryRun) {
    return {
      status: "dry_run_fanout",
      window,
      tenants: addressed,
      skipped,
      addressLines: addressed.map(strategyReviewAddressLine),
      connection,
      strategyObject,
      autopatchFlag: autopatchFlagState(env)
    };
  }

  if (!addressed.length) {
    return {
      status: "skipped_unconfigured",
      reason: `No active tenant carries a resolvable strategy address${requestedPartition ? ` for partition "${requestedPartition}"` : ""}, and no single-tenant override is set (${strategyObject.missing.join(", ") || "the EDITORIAL_STRATEGY_* triple"} unset) — no-op, not a failure. ${skipped.length ? `${skipped.length} project(s) were examined and excluded by name; see skipped.` : "The registry held no projects at all."}`,
      connection,
      strategyObject
    };
  }

  const learningRepository = options.learningRepository ?? repositoryManager.getLearningRepository();
  const tenants: StrategyReviewTenantOutcome[] = [];
  for (const address of addressed) {
    // Resolve the tenant's own strategy object FIRST, and let its state travel with the outcome.
    // This is the difference between "the review ran" and "the review ran against something somebody
    // decided": a tenant still on the genesis default (provenance.set_by="genesis_default"), or with
    // no object at the address at all, earns the strategy_object_unconfigured warning here — and is
    // then reviewed and proposed at exactly like any other tenant, because unset never blocks
    // (Wolf, 2026-09-09). A proposal is, if anything, MORE useful against a default: it is the first
    // evidence anyone has put in front of the human who owns it.
    const resolved = await getEditorialStrategy(
      { projectId: address.projectId },
      { projectRepository, ...(options.readObject ? { callReadTool: options.readObject } : {}) }
    );
    const strategy: StrategyReviewTenantStrategyState = {
      source: resolved.source,
      ...(resolved.warningCode ? { warningCode: resolved.warningCode } : {}),
      ...(resolved.warning ? { warning: resolved.warning } : {})
    };
    try {
      const result = await reviewEditorialStrategy(
        { projectId: address.trackingProjectId, from: window.from, to: window.to, objectRef: address.objectRef },
        { learningRepository, projectRepository, env, fetchImpl: options.fetchImpl, ...(options.callProjectTool ? { callProjectTool: options.callProjectTool } : {}) }
      );
      // The review's own worst case is a computed delta the tenant refused to accept as a thread. It
      // is reported as this tenant's FAILURE rather than folded into "no_proposal", because the two
      // mean opposite things to an operator: one is a quiet week, the other is a proposal nobody will
      // ever see. Either way the loop continues and the exit code stays 0.
      if (result.reason === "marginalia_write_failed") {
        tenants.push({ ...address, strategy, status: "failed", error: result.detail ?? "marginalia_write_failed", result });
      } else {
        tenants.push({ ...address, strategy, status: result.status, result });
      }
    } catch (error) {
      // Defense in depth: reviewEditorialStrategy is documented never to throw. If that ever stops
      // being true, it must cost ONE tenant its weekly proposal, not the other nine theirs.
      tenants.push({ ...address, strategy, status: "failed", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }

  return { status: "fanout", window, tenants, skipped, connection, strategyObject };
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
  // The address list is printed as LINES, ahead of the JSON, because the question a dry run is asked
  // is "who would this touch, and where" — and an operator reading job logs should not have to pipe
  // them through jq to answer it.
  if (result.status === "dry_run_fanout") for (const line of result.addressLines) console.log(line);
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}
