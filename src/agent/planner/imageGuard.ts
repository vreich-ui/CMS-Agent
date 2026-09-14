// THE STALE-IMAGE REFUSAL for the editorial-planner job (Track C, Wolf 2026-09-14).
//
// WHY A JOB NEEDS THIS AND A SERVICE DOES NOT. A Cloud Run SERVICE is the thing that gets deployed;
// its image is whatever the last deploy put there, by definition. A JOB is a separate plane pinned
// to an image by `scripts/pin-job-images.sh`, and a job whose repin was forgotten keeps running the
// build it was created with — indefinitely, on a schedule, exiting 0. That is not hypothetical here:
// `deploy/executor-jobs.txt` records the 2026-08-14→20 incident (six days of half the capture nodes
// failing on a job one release behind the service beside it), and the site-credential-reconciler
// note records a stale job silently UNDOING a just-deployed change while looking like a success.
//
// A PLANNER IS THE WORST PLANE TO RUN STALE. It spends money and it publishes, unattended, with
// nobody reading the output until an article appears. An older planner's caps, its dedupe rule and
// its halt threshold are all older too — so a forgotten repin does not degrade gracefully, it
// commissions yesterday's policy against today's site.
//
// SO THE JOB REFUSES rather than degrades. `SERVICE_GIT_SHA` is stamped on both planes by their
// deploy scripts; the job compares its own against the one the LIVE service reports through
// `repository.get_health`, and a mismatch is a refusal with both shas named. "Refuse" here means
// exit non-zero having commissioned nothing, which is the correct failure for a plane whose whole
// job is to spend: a quiet day costs a day, a wrong day costs money and publishes.
//
// UNKNOWN IS NOT MISMATCHED. A job or service deployed before this wiring reports no sha at all
// (KNOWN_ISSUES K-O2). Refusing on absence would mean the guard's own rollout takes the planner
// down, so an unknown sha on either side is reported as UNVERIFIED and allowed through — the one
// case where "we cannot tell" must not become "we refuse", because nothing has actually gone wrong.

export type ImageGuardVerdict =
  | { ok: true; state: "matched"; sha: string }
  | { ok: true; state: "unverified"; reason: string }
  | { ok: false; state: "stale"; jobSha: string; serviceSha: string; message: string };

export const plannerImageGuard = (input: { jobSha?: string | null; serviceSha?: string | null }): ImageGuardVerdict => {
  const jobSha = input.jobSha?.trim();
  const serviceSha = input.serviceSha?.trim();
  if (!jobSha) return { ok: true, state: "unverified", reason: "This job carries no SERVICE_GIT_SHA; it predates the stamp or was deployed without it. Repin it with scripts/jobs-repin.sh to make the check meaningful." };
  if (!serviceSha) return { ok: true, state: "unverified", reason: "The cms-agent-mcp service reported no SERVICE_GIT_SHA, so there is nothing to compare against." };
  if (jobSha === serviceSha) return { ok: true, state: "matched", sha: jobSha };
  return {
    ok: false,
    state: "stale",
    jobSha,
    serviceSha,
    message: `editorial-planner is running image ${jobSha} while cms-agent-mcp serves ${serviceSha}. Refusing to commission: a planner one release behind spends today's budget on yesterday's caps, dedupe rule and halt threshold. Repin with: PROJECT=<project> REGION=<region> scripts/jobs-repin.sh`
  };
};
