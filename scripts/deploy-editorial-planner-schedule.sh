#!/usr/bin/env bash
# Configure the Cloud Scheduler job that fires editorial-planner once a DAY (Track C, 2026-09-14).
# Same env-var contract, prerequisite checks and describe-then-update-else-create idempotence as
# scripts/deploy-strategy-review-schedule.sh.
#
# WHY 06:00 UTC. It must run AFTER the jobs that produce the evidence it plans against —
# tracking-ingest 03:00, strategy-learning 04:00, strategy-review Mondays 05:00 — so the day's
# commissioning reads yesterday's measured performance and this week's proposed strategy rather than
# the day before's. If those move, move this with them: the ORDERING is the contract, not the clock.
#
# WHY DAILY AND NOT MORE OFTEN. The tenant's own runsPerDay is the real cadence control, and firing
# twice a day would not raise it — the caps are re-derived from the run store every time, so a second
# fire on a tenant that has spent its day plans, finds no slots, and costs a model turn for nothing.
# One fire a day is the cheapest schedule that can fill any legal cadence.
#
# WHY IT IS SAFE UNATTENDED. Every degenerate case is a named exit 0: no tenants, no commissioning
# blocks, commissioning disabled, a halted planner, a model turn that returns nothing, a tenant that
# refuses. The ONE non-zero exit is the stale-image refusal, which is exactly the state where a
# failed execution in the console is what you want.
#
# BEFORE THE FIRST FIRE, run the job once with --dry-run and read the plan. This schedule spends
# money and publishes; every other schedule in this system does not.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${SCHEDULER_SA:?set SCHEDULER_SA to the service account Cloud Scheduler uses to authenticate the run call}"

JOB="${JOB:-editorial-planner}"
SCHEDULER_JOB="${SCHEDULER_JOB:-${JOB}-daily}"
CRON="${CRON:-0 6 * * *}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-editorial-planner.sh first."

RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"

COMMON=(
  "$SCHEDULER_JOB"
  --project "$PROJECT"
  --location "$REGION"
  --schedule "$CRON"
  --uri "$RUN_URI"
  --http-method POST
  --oauth-service-account-email "$SCHEDULER_SA"
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
  --time-zone "Etc/UTC"
)

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  say "Updating $SCHEDULER_JOB."
  gcloud scheduler jobs update http "${COMMON[@]}"
else
  say "Creating $SCHEDULER_JOB."
  gcloud scheduler jobs create http "${COMMON[@]}"
fi

say "Configured $SCHEDULER_JOB to fire $JOB (project $PROJECT, region $REGION) on schedule \"$CRON\" (UTC)."
say "Verify $SCHEDULER_SA has run.jobs.run on $JOB (roles/run.invoker) before the first scheduled fire — this script does not widen IAM."
say "THIS IS THE ONLY SCHEDULE IN THIS SYSTEM THAT SPENDS MONEY AND PUBLISHES. Confirm you have read a --dry-run plan for every enabled tenant before leaving it on."
say "To stop commissioning fleet-wide without touching any tenant: gcloud scheduler jobs pause $SCHEDULER_JOB --project $PROJECT --location $REGION"
say "To stop it for ONE tenant: set commissioning.enabled false in that tenant's editorial_strategy — the job re-reads it every run."
