// The `editorial-planner` Cloud Run Job (Track C, Wolf 2026-09-14) — autonomous commissioning,
// once a day, across every tenant whose strategy says it wants it.
//
// SHAPE COPIED FROM strategy-review, DELIBERATELY. Per-tenant addresses come off the PROJECT RECORD,
// not off env vars; there are no per-job tenant settings to forget; `--dry-run` prints exactly what
// a live run would do and writes nothing; and one tenant's failure never stops the walk. That job
// earned those properties the hard way (W4) and a second fan-out job disagreeing with it about any
// of them would be a second set of surprises.
//
// WHAT IS DIFFERENT, AND WHY IT IS STRICTER. strategy-review writes a comment a human reads.
// This one SPENDS MONEY AND PUBLISHES. So:
//   * it refuses to run at all on a stale image (imageGuard.ts — see that module's header);
//   * a tenant must OPT IN in its own governed object (`commissioning.enabled`), and nothing on this
//     job or in this deployment can opt a tenant in;
//   * every ceiling is re-derived from the run store at plan time, so a tenant edited to
//     `runsPerDay: 50` still cannot outrun what the engine has actually recorded spending today.
//
// EXIT CODES. 0 for every ordinary outcome, including "every tenant was skipped" and "one tenant
// refused" — a daily schedule must be un-noisy on the days it has nothing to do. Non-zero ONLY for
// the stale-image refusal, because that is the one state where continuing is worse than alerting.
import { commissionForProject, planForProject, plannerStatus, type CommissionResult } from "../planner/editorialPlanner.js";
import { plannerImageGuard, type ImageGuardVerdict } from "../planner/imageGuard.js";
import { readCommissioning } from "../planner/commissioningTypes.js";
import { getEditorialStrategy } from "../projects/genesisEditorialStrategy.js";
import { resolveProjectConnection } from "../projects/projectMcpAdapter.js";
import type { ProjectConnectionConfig } from "../projects/projectTypes.js";
import { repositoryManager } from "../runtime/repositories.js";
import type { ProjectRepository } from "../repository/interfaces/ProjectRepository.js";

export const EDITORIAL_PLANNER_JOB = "editorial-planner";

export type PlannerJobTenant = { projectId: string; enabled: boolean; runsPerDay: number; dailyBudgetUsd: number };
export type PlannerJobSkip = { projectId: string; reason: string };

/**
 * Which tenants this job even considers, BEFORE any strategy is read. Mirrors
 * `resolveStrategyReviewTenants`: active, marked as a content tenant by carrying at least one of
 * clientSiteBinding / objectDialect / tracking, and reachable. Internal service projects (monetizer,
 * pdf-tool) land in `skipped` by design — there is no publication behind them to commission for.
 */
export const resolvePlannerCandidates = (
  projects: ProjectConnectionConfig[],
  options: { env?: NodeJS.ProcessEnv; only?: string } = {}
): { candidates: ProjectConnectionConfig[]; skipped: PlannerJobSkip[] } => {
  const env = options.env ?? process.env;
  const candidates: ProjectConnectionConfig[] = [];
  const skipped: PlannerJobSkip[] = [];
  for (const project of [...projects].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
    if (options.only && project.projectId !== options.only) continue;
    if (project.status !== "active") {
      skipped.push({ projectId: project.projectId, reason: `status is "${project.status}" — a paused tenant is never commissioned for.` });
      continue;
    }
    if (!project.clientSiteBinding && !project.objectDialect && !project.tracking) {
      skipped.push({ projectId: project.projectId, reason: "carries none of clientSiteBinding / objectDialect / tracking, so nothing marks it as a content tenant." });
      continue;
    }
    if (!resolveProjectConnection(project, env).endpointConfigured) {
      skipped.push({ projectId: project.projectId, reason: `no MCP endpoint resolves (neither ${project.mcpEndpointEnvVar} nor a stored mcpEndpoint), so its inventory cannot be read and a duplicate could not be detected.` });
      continue;
    }
    candidates.push(project);
  }
  return { candidates, skipped };
};

/** One line per tenant, printed before anything is started — the list an operator reads on a dry run. */
export const plannerTenantLine = (tenant: PlannerJobTenant): string =>
  `${tenant.projectId}  commissioning=${tenant.enabled ? "enabled" : "DISABLED"}  runsPerDay=${tenant.runsPerDay}  dailyBudgetUsd=${tenant.dailyBudgetUsd}`;

export type PlannerJobDeps = {
  projectRepository?: ProjectRepository;
  /** Reads the LIVE service's build sha. Injected so the guard is testable without a network. */
  serviceGitSha?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
};

/**
 * The live service's `SERVICE_GIT_SHA`, read through its own health endpoint.
 *
 * Returns null on ANY failure — a service that cannot be reached is an UNVERIFIED comparison, not a
 * stale one (see imageGuard.ts). Refusing to commission because a health probe timed out would turn
 * a transient network fault into a missed publishing day.
 */
const liveServiceGitSha = async (env: NodeJS.ProcessEnv): Promise<string | null> => {
  const base = (env.CMS_AGENT_SERVICE_URL ?? env.MCP_SERVICE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      if (!response.ok) return null;
      const payload = (await response.json()) as { build?: { gitSha?: string | null }; gitSha?: string | null };
      return payload.build?.gitSha ?? payload.gitSha ?? null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};

export type PlannerJobResult = {
  status: "ok" | "refused_stale_image" | "dry_run";
  guard: ImageGuardVerdict;
  tenants: PlannerJobTenant[];
  tenantLines: string[];
  skipped: PlannerJobSkip[];
  results: CommissionResult[];
  startedRuns: { projectId: string; runId: string; requestId: string; topic: string }[];
};

export const runEditorialPlannerJob = async (options: { dryRun?: boolean; only?: string } = {}, deps: PlannerJobDeps = {}): Promise<PlannerJobResult> => {
  const env = deps.env ?? process.env;
  const projectRepository = deps.projectRepository ?? repositoryManager.getProjectRepository();

  const guard = plannerImageGuard({ jobSha: env.SERVICE_GIT_SHA ?? null, serviceSha: await (deps.serviceGitSha ?? (() => liveServiceGitSha(env)))() });
  if (!guard.ok) return { status: "refused_stale_image", guard, tenants: [], tenantLines: [], skipped: [], results: [], startedRuns: [] };

  const { candidates, skipped } = resolvePlannerCandidates(await projectRepository.list(), { env, ...(options.only ? { only: options.only } : {}) });

  const tenants: PlannerJobTenant[] = [];
  const eligible: string[] = [];
  for (const project of candidates) {
    // The opt-in is read from the tenant's OWN governed object, every run. Caching it on this job,
    // or deriving it from anything on this deployment, would mean an operator turning commissioning
    // off in the strategy did not actually turn it off.
    const resolved = await getEditorialStrategy({ projectId: project.projectId }, { projectRepository }).catch(() => undefined);
    const commissioning = resolved?.strategy ? readCommissioning(resolved.strategy) : undefined;
    if (!commissioning) {
      skipped.push({ projectId: project.projectId, reason: "its editorial_strategy carries no commissioning block; this site publishes only what somebody asks for." });
      continue;
    }
    tenants.push({ projectId: project.projectId, enabled: commissioning.enabled, runsPerDay: commissioning.runsPerDay, dailyBudgetUsd: commissioning.dailyBudgetUsd });
    if (commissioning.enabled) eligible.push(project.projectId);
    else skipped.push({ projectId: project.projectId, reason: "commissioning.enabled is false — configured, and deliberately switched off." });
  }

  const tenantLines = tenants.map(plannerTenantLine);
  const results: CommissionResult[] = [];
  const startedRuns: PlannerJobResult["startedRuns"] = [];

  for (const projectId of eligible) {
    try {
      // A DRY run plans exactly as a live one does, and starts nothing — the preview has to be the
      // plan, or it is a different plan and reading it proves nothing.
      const result = options.dryRun ? await planForProject(projectId) : await commissionForProject(projectId);
      results.push(result as CommissionResult);
      for (const outcome of (result as CommissionResult).commissioned ?? []) {
        if (outcome.started && outcome.runId) startedRuns.push({ projectId, runId: outcome.runId, requestId: outcome.requestId, topic: outcome.topic });
      }
    } catch (error) {
      // One tenant's failure never stops the fleet — the whole reason this job walks rather than
      // being wired per tenant.
      skipped.push({ projectId, reason: `planning threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return { status: options.dryRun ? "dry_run" : "ok", guard, tenants, tenantLines, skipped, results, startedRuns };
};

/**
 * `planner.status` for every configured tenant — what the job would report without planning
 * anything. Returns `PlannerStatus[]` as `plannerStatus` built it, nulls included: a tenant whose
 * run-facts read failed carries `runFactsRead: "failed"` and null numeric/halted fields here exactly
 * as it does from a single-tenant call. Never coerce those nulls to 0 downstream — a 0 says "nothing
 * ran today", which a store that could not be read has no basis to claim.
 */
export const editorialPlannerFleetStatus = async (deps: PlannerJobDeps = {}) => {
  const projectRepository = deps.projectRepository ?? repositoryManager.getProjectRepository();
  const { candidates } = resolvePlannerCandidates(await projectRepository.list(), { ...(deps.env ? { env: deps.env } : {}) });
  return Promise.all(candidates.map((project) => plannerStatus(project.projectId, { projectRepository })));
};

export async function cliMain(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dryRun = argv.includes("--dry-run") || /^(1|true|on|yes)$/i.test(env.EDITORIAL_PLANNER_DRY_RUN?.trim() ?? "");
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;

  const result = await runEditorialPlannerJob({ dryRun, ...(only ? { only } : {}) }, { env });

  if (result.guard.state === "unverified") console.warn(`editorial-planner image check UNVERIFIED: ${result.guard.reason}`);
  if (result.status === "refused_stale_image") {
    console.error(result.guard.ok === false ? result.guard.message : "stale image");
    console.log(JSON.stringify({ status: result.status, guard: result.guard }, null, 2));
    return 1;
  }

  // The per-tenant lines come FIRST and in plain text, before the JSON blob, for the same reason
  // strategy-review prints its address lines first: the list of sites this job is about to spend on
  // must be readable in a log pane without a JSON parser.
  for (const line of result.tenantLines) console.log(line);
  if (result.skipped.length) for (const skip of result.skipped) console.log(`skipped ${skip.projectId}: ${skip.reason}`);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
