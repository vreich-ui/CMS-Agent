#!/usr/bin/env bash
# Configure the Cloud Run Job that runs the strategy-learning daily pass (S-14 / T21.35).
#
# WHY THIS EXISTS. Of the three W21 jobs, only tracking-ingest ever got a deploy artifact. This one
# and strategy-review shipped as tested code that has never executed anywhere: they were absent from
# the live project, absent from deploy/executor-jobs.txt, and had no script. So tracking-ingest has
# been COLLECTING since 2026-09-06 and nothing has been LEARNING from it. This is the consumer.
#
# WHAT IT RUNS. src/agent/entrypoints/strategyLearningJobMain.ts, with NO window flags: the job
# defaults to the previous whole UTC day (previousUtcDay), which is what a once-a-day schedule should
# read, because the sink's rollups are day-grained and today is incomplete. Do NOT pin
# STRATEGY_LEARNING_FROM/TO here — a fixed window would re-read one frozen day forever, and this job
# WRITES observations, so a frozen window would accumulate duplicate sightings of the same day and
# quietly corrupt the "held across N consecutive windows" bar that gates every promotion downstream.
#
# WHY IT NEEDS THE STORE. Unlike tracking-ingest, this job reads AND writes the workspace document:
# it records `tracking:strategy.v1` observations and applies playbook deltas to the writer/planning
# nodes. WORKSPACE_STORE=gcs and GCS_BUCKET are therefore load-bearing, not optional.
#
# SAFE TO WIRE UP BEFORE THE SINK IS CONFIGURED. Every degenerate case is a named no-op that exits 0
# ("skipped_unconfigured" for an unset sink or an unset partition, "grain_unavailable" for a grain
# this deployment's sink does not serve), never a crash — so the schedule can exist ahead of its
# secrets, exactly as tracking-ingest's does.
#
# TOKEN HANDLING. The sink bearer is bound from Secret Manager, never passed as an env literal — the
# same rule scripts/deploy-tracking-ingest.sh and deploy-site-credential-reconciler.sh follow. Token
# values are never command arguments, output, or project records.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${IMAGE:?set IMAGE to the immutable deployed CMS-Agent image}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${TRACKING_SINK_URL:?set TRACKING_SINK_URL to the full sink relay URL ending in /api/tracking-sink}"
: "${TRACKING_PROJECT_ID:?set TRACKING_PROJECT_ID to the sink partition this job reads}"
: "${RUNTIME_SA:?set RUNTIME_SA to the existing CMS-Agent runtime service account}"

JOB="${JOB:-strategy-learning}"
TRACKING_SINK_TOKEN_SECRET="${TRACKING_SINK_TOKEN_SECRET:-tracking-sink-token}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
gcloud secrets describe "$TRACKING_SINK_TOKEN_SECRET" --project "$PROJECT" >/dev/null 2>&1 \
  || die "Secret $TRACKING_SINK_TOKEN_SECRET is missing; create it without printing its value before configuring the job."
[[ "$TRACKING_PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || die "TRACKING_PROJECT_ID must be a lowercase slug, got: $TRACKING_PROJECT_ID"

# The sink's partition spelling, NOT the CMS-Agent project id — the same two-id trap documented at
# length in deploy-tracking-ingest.sh (S-21). This job reads the sink only; it stamps nothing with a
# CMS-Agent project, so there is deliberately no CMS_AGENT_PROJECT_ID here.

COMMON=(
  "$JOB"
  --project "$PROJECT"
  --region "$REGION"
  --image "$IMAGE"
  --service-account "$RUNTIME_SA"
  --cpu 1
  --memory 512Mi
  --max-retries 0
  --task-timeout 900
  --command node
  --args=--import,tsx,src/agent/entrypoints/strategyLearningJobMain.ts
)
ENV_VARS="^|^WORKSPACE_STORE=gcs|GCS_BUCKET=$GCS_BUCKET|TRACKING_SINK_URL=$TRACKING_SINK_URL|TRACKING_PROJECT_ID=$TRACKING_PROJECT_ID"
SECRET_BINDING="TRACKING_SINK_TOKEN=$TRACKING_SINK_TOKEN_SECRET:latest"

if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  say "Updating $JOB with merge-style environment changes."
  gcloud run jobs update "${COMMON[@]}" --update-env-vars "$ENV_VARS" --update-secrets "$SECRET_BINDING"
else
  say "Creating $JOB."
  gcloud run jobs create "${COMMON[@]}" --set-env-vars "$ENV_VARS" --set-secrets "$SECRET_BINDING"
fi

say "Configured $JOB without executing it. Verify $RUNTIME_SA has Secret Manager accessor on $TRACKING_SINK_TOKEN_SECRET before execution."
say "This job WRITES observations and playbook deltas. Execute once with --args=…,--dry-run first to see the resolved window and connection state without writing anything."
say "Then schedule it with scripts/deploy-strategy-learning-schedule.sh, and add $JOB to deploy/executor-jobs.txt if it is not there already."
