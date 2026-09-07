#!/usr/bin/env bash
# Configure the Cloud Run Job that runs feedback.ingest_tracking on a schedule (S-14 / T21.7).
#
# WHY THIS EXISTS. The three W21 jobs shipped as code with no deploy artifact: an audit of the live
# project found only `continuation-tick` and `site-credential-reconciler`, so the tracking half of the
# learning loop had never executed once. Everything downstream of it — producer attribution, strategy
# learning, the engagement vector CMS-Agent ingests — was plumbing with nothing running through it.
#
# WHAT IT RUNS. src/agent/entrypoints/trackingIngestJobMain.ts, with NO window flags: the job defaults
# to the previous whole UTC day (previousUtcDay), which is exactly the window a once-a-day schedule
# should pull, because the sink's rollups are day-grained and today is incomplete. Do not pin
# TRACKING_INGEST_FROM/TO here — a fixed window would re-ingest the same day forever.
#
# SAFE TO WIRE UP BEFORE THE SINK IS CONFIGURED. An unconfigured sink is a named no-op that exits 0
# (status "skipped_unconfigured"), never a crash, so a schedule can exist ahead of its secrets.
#
# TOKEN HANDLING. The sink bearer is bound from Secret Manager, never passed as an env literal — the
# same rule scripts/deploy-site-credential-reconciler.sh follows. Token values are never command
# arguments, output, or project records.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${IMAGE:?set IMAGE to the immutable deployed CMS-Agent image}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${TRACKING_SINK_URL:?set TRACKING_SINK_URL to the full sink relay URL ending in /api/tracking-sink}"
: "${TRACKING_PROJECT_ID:?set TRACKING_PROJECT_ID to the sink partition this job ingests}"
: "${RUNTIME_SA:?set RUNTIME_SA to the existing CMS-Agent runtime service account}"

JOB="${JOB:-tracking-ingest}"
TRACKING_SINK_TOKEN_SECRET="${TRACKING_SINK_TOKEN_SECRET:-tracking-sink-token}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
gcloud secrets describe "$TRACKING_SINK_TOKEN_SECRET" --project "$PROJECT" >/dev/null 2>&1 \
  || die "Secret $TRACKING_SINK_TOKEN_SECRET is missing; create it without printing its value before configuring the job."
[[ "$TRACKING_PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || die "TRACKING_PROJECT_ID must be a lowercase slug, got: $TRACKING_PROJECT_ID"

# S-07. TWO DIFFERENT IDS FOR ONE TENANT, and they are not interchangeable: TRACKING_PROJECT_ID is the
# SINK's partition (`drlurie`), CMS_AGENT_PROJECT_ID is the CMS-AGENT project (`dr-lurie`). The second
# is what every ingested feedback record is stamped with, and it is what a tenant's scoped bearer
# carries in policy.projects — so setting it to the sink spelling silently hides every ingested row
# from the tenant that produced it, with no error anywhere. OPTIONAL: unset means rows are ingested
# unstamped, exactly as the job behaved before this existed, and the job still exits 0.
CMS_AGENT_PROJECT_ID="${CMS_AGENT_PROJECT_ID:-}"
if [[ -n "$CMS_AGENT_PROJECT_ID" ]]; then
  [[ "$CMS_AGENT_PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || die "CMS_AGENT_PROJECT_ID must be a lowercase slug, got: $CMS_AGENT_PROJECT_ID"
else
  say "CMS_AGENT_PROJECT_ID is unset — ingested feedback rows will carry no project stamp, and this tenant's Insights cards will fall back to resolving them by runId."
fi

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
  --args=--import,tsx,src/agent/entrypoints/trackingIngestJobMain.ts
)
ENV_VARS="^|^WORKSPACE_STORE=gcs|GCS_BUCKET=$GCS_BUCKET|TRACKING_SINK_URL=$TRACKING_SINK_URL|TRACKING_PROJECT_ID=$TRACKING_PROJECT_ID"
# Appended only when set: an empty CMS_AGENT_PROJECT_ID= would be a value the job then trims to
# nothing anyway, and on the merge-style update path it would overwrite a good live value with blank.
if [[ -n "$CMS_AGENT_PROJECT_ID" ]]; then ENV_VARS="$ENV_VARS|CMS_AGENT_PROJECT_ID=$CMS_AGENT_PROJECT_ID"; fi
SECRET_BINDING="TRACKING_SINK_TOKEN=$TRACKING_SINK_TOKEN_SECRET:latest"

if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  say "Updating $JOB with merge-style environment changes."
  gcloud run jobs update "${COMMON[@]}" --update-env-vars "$ENV_VARS" --update-secrets "$SECRET_BINDING"
else
  say "Creating $JOB."
  gcloud run jobs create "${COMMON[@]}" --set-env-vars "$ENV_VARS" --set-secrets "$SECRET_BINDING"
fi

say "Configured $JOB without executing it. Verify $RUNTIME_SA has Secret Manager accessor on $TRACKING_SINK_TOKEN_SECRET before execution."
say "Next: execute once with --args=…,--dry-run to see the resolved window and connection state, then schedule it with scripts/deploy-tracking-ingest-schedule.sh."
