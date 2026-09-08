#!/usr/bin/env bash
# Configure the Cloud Scheduler job that fires continuation-tick every two minutes.
#
# WHY IT IS A SEPARATE SCRIPT. Configuring the job and deciding how often it runs are different
# decisions with different blast radii. scripts/deploy-continuation-tick.sh shapes the plane;
# this one decides how often that plane touches four live tenant sites. Changing the cadence here
# is the larger of the two, and it should not ride along with an env change.
#
# WHY EVERY TWO MINUTES. The tick dispatches queued workflow nodes; the queue is only as current as
# the last fire. CONTINUATION_TICK_BUDGET_MS (240000) is deliberately longer than the interval --
# overlapping executions are expected and safe, and the job's own budget, not the cron, is what
# bounds a tick.
#
# THE PERMISSION_DENIED STORY (docs/platform/CONTINUATION_TICK.md). Cloud Scheduler mints an OAuth
# token as SCHEDULER_SA and POSTs to the Cloud Run Jobs v1 :run endpoint. If that account lacks
# roles/run.invoker ON THE JOB, every fire fails with gRPC code 7 PERMISSION_DENIED and nothing
# anywhere says the tick has stopped -- the scheduler reports its own failures, the job reports
# nothing because it never started, and the queue just stops draining. This script does not widen
# IAM; it prints the reminder because that binding is the failure mode.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${SCHEDULER_SA:?set SCHEDULER_SA to the service account Cloud Scheduler uses to authenticate the run call}"

JOB="${JOB:-continuation-tick}"
SCHEDULER_JOB="${SCHEDULER_JOB:-${JOB}-schedule}"
CRON="${CRON:-*/2 * * * *}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-180s}"
APPLY="${APPLY:-}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-continuation-tick.sh first."

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
  --attempt-deadline "$ATTEMPT_DEADLINE"
)

# Same default as scripts/deploy-continuation-tick.sh, and for the same reason. Its sibling is safe
# to run bare, so the habit transfers: someone checking "what is the cadence?" must not rewrite the
# schedule of the plane that touches four live tenant sites every two minutes, and must not create
# it ENABLED -- a created scheduler job starts firing on its next tick, with no confirmation step
# anywhere between the keystroke and four sites.
if [[ "$APPLY" != "1" ]]; then
  say "Would configure $SCHEDULER_JOB in $PROJECT/$REGION:"
  say "  schedule          $CRON (Etc/UTC)"
  say "  uri               $RUN_URI"
  say "  oauth account     $SCHEDULER_SA"
  say "  attempt deadline  $ATTEMPT_DEADLINE"
  say ""
  if gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    say "$SCHEDULER_JOB exists. Live shape:"
    gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" \
      --format="value[separator='  '](schedule, timeZone, state, attemptDeadline, httpTarget.uri)"
  else
    say "$SCHEDULER_JOB does not exist. APPLY=1 would CREATE it ENABLED, and it begins firing $JOB immediately."
  fi
  say ""
  say "Nothing was written. Re-run with APPLY=1 to apply."
  exit 1
fi

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  say "Updating $SCHEDULER_JOB."
  gcloud scheduler jobs update http "${COMMON[@]}"
else
  say "Creating $SCHEDULER_JOB."
  gcloud scheduler jobs create http "${COMMON[@]}"
fi

say "Configured $SCHEDULER_JOB to fire $JOB (project $PROJECT, region $REGION) on \"$CRON\" (UTC)."
say "Verify $SCHEDULER_SA holds roles/run.invoker on the JOB before the next fire -- without it every"
say "fire fails with PERMISSION_DENIED and the queue stops draining silently. This script never widens IAM."
