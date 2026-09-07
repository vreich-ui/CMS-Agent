#!/usr/bin/env bash
# Configure the Cloud Scheduler job that fires the tracking-ingest Cloud Run Job once a day, so the
# sink's day-grained rollups reach CMS-Agent's evaluation store without anyone remembering to run it.
# Modeled on scripts/deploy-site-credential-reconciler-schedule.sh: same env-var contract, same
# prerequisite checks, same describe-then-update-else-create idempotence.
#
# WHY DAILY, AND WHY NO WINDOW ARGS. trackingIngestJob defaults its window to the PREVIOUS WHOLE UTC
# DAY. Yesterday is complete; today is not, and the sink's rollups are day-grained. A daily fire with
# no --from/--to is therefore the correct pairing, and passing fixed dates would re-ingest one frozen
# day forever. The default cron is 03:00 UTC — before the 06:00 site-credential-reconciler, and late
# enough that the previous UTC day is closed everywhere.
#
# WHY IT IS SAFE UNATTENDED. ingestTrackingRollups is best-effort and never throws; the job reports
# "failed" (exit 1) only when a CONFIGURED sink ingested nothing at all while reporting errors. A
# quiet day with zero rows is a legitimate "completed", and an unconfigured sink is a clean
# "skipped_unconfigured" exit 0 — so this schedule can exist before its secrets do.
#
# WHAT FIRES: the Cloud Run Jobs v1 namespaces "run" endpoint, the same shape and host
# continuation-tick-schedule already uses, authenticated as SCHEDULER_SA via Cloud Scheduler's own
# OAuth token minting, so no credential is stored in the scheduler job's configuration.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${SCHEDULER_SA:?set SCHEDULER_SA to the service account Cloud Scheduler uses to authenticate the run call}"

JOB="${JOB:-tracking-ingest}"
SCHEDULER_JOB="${SCHEDULER_JOB:-${JOB}-daily}"
CRON="${CRON:-0 3 * * *}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-tracking-ingest.sh first."

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
say "Fire once immediately with: gcloud scheduler jobs run $SCHEDULER_JOB --project $PROJECT --location $REGION"
