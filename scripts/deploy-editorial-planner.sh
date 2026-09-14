#!/usr/bin/env bash
# Configure the Cloud Run Job that COMMISSIONS editorial work daily (Track C, Wolf 2026-09-14).
#
# READ THIS FIRST. Every other job in deploy/executor-jobs.txt reads, ingests, proposes or rotates.
# This one SPENDS MONEY AND PUBLISHES, unattended, with nobody looking until an article appears on a
# live site. Everything below follows from that.
#
# WHAT IT RUNS. src/agent/entrypoints/editorialPlannerJobMain.ts, with NO tenant flags. The job walks
# the project registry and commissions for every ACTIVE content tenant whose own governed
# editorial_strategy carries `commissioning.enabled: true`. There is deliberately NO env var on this
# job that can turn a tenant on: the opt-in lives in the tenant's own versioned, approvable object,
# where an operator can read it, diff it and revoke it, and it is re-read on every single run.
#
# THE CEILINGS ARE NOT HERE EITHER. runsPerDay, dailyBudgetUsd and maxConcurrentRuns come off the
# same object, and the engine re-derives today's actual spend and today's open runs from the run
# store before every commission — so a strategy edited to `runsPerDay: 50` still cannot outspend
# what has actually been recorded. Nothing about this deployment is a budget control; do not treat
# it as one.
#
# IT REFUSES TO RUN ON A STALE IMAGE. The job compares its own SERVICE_GIT_SHA against the sha the
# LIVE cms-agent-mcp service reports, and exits non-zero having commissioned nothing if they differ
# (src/agent/planner/imageGuard.ts). That is why CMS_AGENT_SERVICE_URL is REQUIRED below: without it
# the comparison is UNVERIFIED and the guard cannot protect anything. A planner one release behind
# spends today's budget on yesterday's caps, dedupe rule and halt threshold — see
# deploy/executor-jobs.txt for what a stale plane has already cost this fleet twice.
#
# FIRST EXECUTION MUST BE --dry-run. A dry run plans identically to a live one — same reads, same
# model turn, same caps — and starts nothing. It prints one line per tenant and the full plan. Read
# that before the first live fire; it is the list of articles this fleet is about to pay to publish.
#
# TOKEN HANDLING. This job binds no new secret. It reaches each tenant through that tenant's own
# registered record, exactly as strategy-review does — endpoint from the record, bearer from the env
# var the record names or the Secret Manager reference it carries.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${IMAGE:?set IMAGE to the immutable deployed CMS-Agent image (the SAME one cms-agent-mcp serves)}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${RUNTIME_SA:?set RUNTIME_SA to the existing CMS-Agent runtime service account}"
: "${CMS_AGENT_SERVICE_URL:?set CMS_AGENT_SERVICE_URL to the live cms-agent-mcp base URL — without it the stale-image guard is UNVERIFIED and this job can run a build the service no longer serves}"

JOB="${JOB:-editorial-planner}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CMS_AGENT_SERVICE_URL" =~ ^https:// ]] || die "CMS_AGENT_SERVICE_URL must be an https URL, got: $CMS_AGENT_SERVICE_URL"

# The sha this job will compare against the service's. Taken from the image TAG, exactly as
# scripts/deploy-service.sh does, so the two planes stamp themselves from the same source.
GIT_SHA="${IMAGE##*:}"
[[ -n "$GIT_SHA" && "$GIT_SHA" != "$IMAGE" ]] || die "IMAGE must carry a tag (…/mcp-service:<sha>); the stale-image guard has nothing to compare without one. Got: $IMAGE"

COMMON=(
  "$JOB"
  --project "$PROJECT"
  --region "$REGION"
  --image "$IMAGE"
  --service-account "$RUNTIME_SA"
  --cpu 1
  --memory 512Mi
  --max-retries 0
  # 1800s, not strategy-review's 900s: the walk makes one model turn per enabled tenant and then
  # starts runs. It does NOT drive them — each commissioned run is kicked one node and handed to the
  # continuation tick — so this ceiling covers planning, never a twenty-node pipeline.
  --task-timeout 1800
  --command node
  --args=--import,tsx,src/agent/entrypoints/editorialPlannerJobMain.ts
)
ENV_VARS="^|^WORKSPACE_STORE=gcs|GCS_BUCKET=$GCS_BUCKET|CMS_AGENT_SERVICE_URL=$CMS_AGENT_SERVICE_URL|SERVICE_GIT_SHA=$GIT_SHA|SERVICE_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  say "Updating $JOB with merge-style environment changes."
  gcloud run jobs update "${COMMON[@]}" --update-env-vars "$ENV_VARS"
else
  say "Creating $JOB."
  gcloud run jobs create "${COMMON[@]}" --set-env-vars "$ENV_VARS"
fi

say ""
say "Configured $JOB without executing it."
say "NEXT, IN THIS ORDER:"
say "  1. Add $JOB to deploy/executor-jobs.txt if it is not there already — nothing repins an unlisted job."
say "  2. DRY RUN FIRST. gcloud run jobs execute $JOB --project $PROJECT --region $REGION --args=--import,tsx,src/agent/entrypoints/editorialPlannerJobMain.ts,--dry-run"
say "     It prints one line per tenant (commissioning enabled/disabled, runsPerDay, dailyBudgetUsd) and the full plan, and starts nothing."
say "  3. Read that plan. Every request in it is an article this fleet will pay to write and publish."
say "  4. Only then schedule it with scripts/deploy-editorial-planner-schedule.sh."
say ""
say "NO TENANT IS COMMISSIONED FOR BY CONFIGURING THIS JOB. A tenant opts in by setting"
say "commissioning.enabled: true in its OWN editorial_strategy object; until then this job reports it"
say "as skipped and starts nothing for it. There is no env var here that overrides that, on purpose."
say ""
say "Every release must repin this job: PROJECT=$PROJECT REGION=$REGION scripts/jobs-repin.sh"
say "It refuses to run when its image sha differs from the one cms-agent-mcp serves, so a forgotten"
say "repin shows up as a failed execution rather than as a day of commissioning on an older policy."
