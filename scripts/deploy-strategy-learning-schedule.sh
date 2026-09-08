#!/usr/bin/env bash
# Configure the Cloud Scheduler job that fires the strategy-learning Cloud Run Job once a day.
# Modeled on scripts/deploy-tracking-ingest-schedule.sh: same env-var contract, same prerequisite
# checks, same describe-then-update-else-create idempotence.
#
# WHY DAILY, AND WHY NO WINDOW ARGS. strategyLearningJob defaults its window to the PREVIOUS WHOLE
# UTC DAY. A daily fire with no --from/--to is therefore the correct pairing; fixed dates would
# re-read one frozen day forever. That matters more here than for tracking-ingest, because this job
# WRITES: repeated sightings of the same day would inflate the "held across N consecutive windows"
# streak that gates every playbook promotion downstream, turning one day into a false trend.
#
# WHY 04:00 UTC. It must run AFTER tracking-ingest (03:00) has written the day it reads, and before
# the 06:00 site-credential-reconciler. An hour is ample: tracking-ingest is a single day-grained
# pull. If tracking-ingest is ever slowed or rescheduled, move this with it — the ordering is the
# contract, not the clock time.
#
# WHY IT IS SAFE UNATTENDED. Every degenerate case is a named exit 0: an unconfigured sink or unset
# partition is "skipped_unconfigured", a grain this sink does not serve is "grain_unavailable", and a
# quiet day with nothing over the bar is a legitimate "completed". So this schedule can exist before
# its secrets do.
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

JOB="${JOB:-strategy-learning}"
SCHEDULER_JOB="${SCHEDULER_JOB:-${JOB}-daily}"
CRON="${CRON:-0 4 * * *}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-strategy-learning.sh first."

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
say "Ordering matters: this must fire AFTER tracking-ingest writes the day it reads. Check both with: gcloud scheduler jobs list --project $PROJECT --location $REGION"
say "Fire once immediately with: gcloud scheduler jobs run $SCHEDULER_JOB --project $PROJECT --location $REGION"
