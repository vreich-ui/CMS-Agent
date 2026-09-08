#!/usr/bin/env bash
# Configure the Cloud Scheduler job that fires the strategy-review Cloud Run Job once a WEEK.
# Modeled on scripts/deploy-tracking-ingest-schedule.sh: same env-var contract, same prerequisite
# checks, same describe-then-update-else-create idempotence.
#
# WHY WEEKLY, AND WHY NO WINDOW ARGS. strategyReviewJob defaults its window to the PREVIOUS WHOLE UTC
# WEEK, and compares it against the week before that — the two-window half of the promotion bar. A
# weekly fire with no --from/--to is the only pairing that keeps those windows adjacent and moving.
# Fixed dates would re-propose one frozen week forever, and since this job opens a marginalia thread
# a human reads, that is not a harmless repeat: it is a weekly duplicate in an editor's queue.
#
# WHY MONDAY 05:00 UTC. It must run after the daily jobs have closed out the week it reads
# (tracking-ingest 03:00, strategy-learning 04:00) and it reads the week ENDING Sunday, so Monday is
# the first day that week is complete. If the daily jobs move, move this with them — the ordering is
# the contract, not the clock time.
#
# WHY WEEKLY AND NOT DAILY, BEYOND THE WINDOW. A proposal put in front of an editor has to be worth
# the read. The bar is deliberately "held across consecutive windows"; firing more often would not
# find more signal, it would only shorten what a window means and put more unread threads on a human.
#
# WHY IT IS SAFE UNATTENDED. Every degenerate case is a named exit 0: an unconfigured sink, an unset
# partition, an unset EDITORIAL_STRATEGY_* address, no rows, no observations, nothing over the bar,
# or a tenant that refuses the marginalia write. None of them throws, and none of them patches
# anything — the job only ever PROPOSES.
#
# WHAT FIRES: the Cloud Run Jobs v1 namespaces "run" endpoint, the same shape continuation-tick and
# tracking-ingest already use, authenticated as SCHEDULER_SA via Cloud Scheduler's own OAuth token
# minting, so no credential is stored in the scheduler job's configuration.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${SCHEDULER_SA:?set SCHEDULER_SA to the service account Cloud Scheduler uses to authenticate the run call}"

JOB="${JOB:-strategy-review}"
SCHEDULER_JOB="${SCHEDULER_JOB:-${JOB}-weekly}"
CRON="${CRON:-0 5 * * 1}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-strategy-review.sh first."

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
say "Before the first real fire, confirm an editor is expecting the thread: this is the only job in the system whose output lands in a human's queue."
say "Fire once immediately with: gcloud scheduler jobs run $SCHEDULER_JOB --project $PROJECT --location $REGION"
