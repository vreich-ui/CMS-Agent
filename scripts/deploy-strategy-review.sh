#!/usr/bin/env bash
# Configure the Cloud Run Job that runs the editorial strategy review weekly (S-14 / T21.37).
#
# WHY THIS EXISTS. See scripts/deploy-strategy-learning.sh: of the three W21 jobs only
# tracking-ingest ever got a deploy artifact. This is the last one, and the only job in the system
# whose output is addressed to a HUMAN rather than to another part of the pipeline.
#
# WHAT IT RUNS. src/agent/entrypoints/strategyReviewJobMain.ts, with NO window flags: the job
# defaults to the previous whole UTC WEEK (previousUtcWeek), which is what a once-a-week schedule
# should read. Do NOT pin STRATEGY_REVIEW_FROM/TO — a fixed window would re-propose the same week
# forever, and this job OPENS A MARGINALIA THREAD an editor has to read, so a frozen window is not a
# harmless repeat: it is a weekly duplicate landing in a human's queue.
#
# IT NEVER PATCHES. The output is one marginalia_create thread on the governed strategy object.
# Autonomous patching sits behind STRATEGY_REVIEW_AUTOPATCH, which is OFF by default, which this
# script deliberately does not set, and which enables nothing in the current build — the patch path
# is not written. Setting it here would be a policy decision disguised as a deploy flag.
#
# WHAT IT READS AND WHAT IT PROPOSES AGAINST — BOTH NOW COME OFF THE RECORD (W4, Wolf 2026-09-09).
#   1. The SINK connection (TRACKING_SINK_URL / TRACKING_SINK_TOKEN) is still deployment
#      configuration and still required: it is the one credentialed thing this job holds.
#   2. The two ADDRESSES are not. The sink partition to read and the governed object to propose
#      against are resolved PER TENANT from that tenant's own project record (tracking.projectId and
#      objectDialect.strategyObjectId, each with a working convention behind it), so one run serves
#      every active tenant instead of whichever one an operator wired into this script. That is the
#      whole change: the old single-address shape meant the rest of the fleet got nothing, silently,
#      forever, and the job's own output could not say so.
#
# THE EDITORIAL_STRATEGY_* TRIPLE IS NOW AN OVERRIDE ONLY, NOT A REQUIREMENT.
#   Setting all three pins the job to ONE tenant and one object — its exact pre-W4 behavior, which is
#   what makes `--dry-run` against a single named tenant a debugging tool rather than a fleet walk.
#   Leaving them unset is the NORMAL production setting: the job walks the registry. Unset is
#   therefore no longer a "not useful yet" state to warn about, and this script no longer treats it
#   as one. The three-or-none rule below survives untouched, because a PARTIAL address is still the
#   one shape that can send a proposal to the wrong place.
#   TRACKING_PROJECT_ID likewise stops being required: with it set (and the triple set) you get the
#   single-tenant override; with it set alone it NARROWS the walk to the tenant resolving to that
#   partition; unset, the walk covers everyone.
# With the sink unset the run is a clean "skipped_unconfigured" that NAMES the unset variables and
# exits 0, so this schedule can exist ahead of it.
#
# IT ALSO NEEDS TO REACH EACH TENANT. Writing a proposal is a marginalia_create call through
# ProjectMcpAdapter against that tenant's registered record. The record supplies the endpoint; the
# bearer comes from EITHER the env var the record names (tokenEnvVar) OR the Secret Manager reference
# it carries (tokenSecretRef, read at runtime). This script binds neither by guessing — see the
# closing notes. A tenant that refuses the write is reported, BY NAME, as that tenant's failed
# outcome with the delta intact; every other tenant in the walk is unaffected, the strategy object is
# never touched, and the job still exits 0.
#
# TOKEN HANDLING. The sink bearer is bound from Secret Manager, never passed as an env literal. Token
# values are never command arguments, output, or project records.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${IMAGE:?set IMAGE to the immutable deployed CMS-Agent image}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${TRACKING_SINK_URL:?set TRACKING_SINK_URL to the full sink relay URL ending in /api/tracking-sink}"
: "${RUNTIME_SA:?set RUNTIME_SA to the existing CMS-Agent runtime service account}"

JOB="${JOB:-strategy-review}"
TRACKING_SINK_TOKEN_SECRET="${TRACKING_SINK_TOKEN_SECRET:-tracking-sink-token}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
gcloud secrets describe "$TRACKING_SINK_TOKEN_SECRET" --project "$PROJECT" >/dev/null 2>&1 \
  || die "Secret $TRACKING_SINK_TOKEN_SECRET is missing; create it without printing its value before configuring the job."
# W4: OPTIONAL now. Set it only to narrow the run to one tenant's partition (with the triple below,
# that is the full single-tenant override); leave it unset for the normal fleet-wide walk, which
# resolves each tenant's partition from its own record.
TRACKING_PROJECT_ID="${TRACKING_PROJECT_ID:-}"
if [[ -n "$TRACKING_PROJECT_ID" ]]; then
  [[ "$TRACKING_PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || die "TRACKING_PROJECT_ID must be a lowercase slug, got: $TRACKING_PROJECT_ID"
fi

# The strategy object address — an OVERRIDE since W4, not a requirement. All three or none: a
# partially-addressed object is still the one shape that could send a proposal to the wrong place, so
# it is rejected here rather than at runtime.
EDITORIAL_STRATEGY_PROJECT_ID="${EDITORIAL_STRATEGY_PROJECT_ID:-}"
EDITORIAL_STRATEGY_OBJECT_TYPE="${EDITORIAL_STRATEGY_OBJECT_TYPE:-}"
EDITORIAL_STRATEGY_OBJECT_ID="${EDITORIAL_STRATEGY_OBJECT_ID:-}"
STRATEGY_SET=0
for value in "$EDITORIAL_STRATEGY_PROJECT_ID" "$EDITORIAL_STRATEGY_OBJECT_TYPE" "$EDITORIAL_STRATEGY_OBJECT_ID"; do
  if [[ -n "$value" ]]; then STRATEGY_SET=$((STRATEGY_SET + 1)); fi
done
if [[ "$STRATEGY_SET" -ne 0 && "$STRATEGY_SET" -ne 3 ]]; then
  die "Set all three of EDITORIAL_STRATEGY_PROJECT_ID / _OBJECT_TYPE / _OBJECT_ID, or none. Got $STRATEGY_SET of 3; a partial address is how a proposal reaches the wrong object."
fi
if [[ "$STRATEGY_SET" -eq 3 ]]; then
  # The CMS-Agent project id (e.g. dr-lurie), NOT the sink partition (drlurie) — S-21's four-id trap.
  [[ "$EDITORIAL_STRATEGY_PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || die "EDITORIAL_STRATEGY_PROJECT_ID must be a lowercase slug, got: $EDITORIAL_STRATEGY_PROJECT_ID"
  if [[ -n "$TRACKING_PROJECT_ID" && "$EDITORIAL_STRATEGY_PROJECT_ID" == "$TRACKING_PROJECT_ID" ]]; then
    say "⚠  EDITORIAL_STRATEGY_PROJECT_ID and TRACKING_PROJECT_ID are the same string (\"$TRACKING_PROJECT_ID\")."
    say "   These are different id domains for one tenant: the sink's partition is spelled like \"drlurie\", the CMS-Agent project like \"dr-lurie\"."
    say "   If that is genuinely this tenant's spelling on both sides, ignore this; otherwise the proposal will be addressed to a project that does not exist."
  fi
else
  say "EDITORIAL_STRATEGY_* is unset — this is the NORMAL production setting since W4 (Wolf, 2026-09-09), not a gap."
  say "   The job walks every active tenant and resolves each one's sink partition and editorial_strategy object from its own project record"
  say "   (tracking.projectId and objectDialect.strategyObjectId, each falling back to the conventional bare slug / strat_<slug>)."
  say "   Set all three ONLY to pin the job to one tenant — that is the single-tenant debugging override."
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
  --args=--import,tsx,src/agent/entrypoints/strategyReviewJobMain.ts
)
ENV_VARS="^|^WORKSPACE_STORE=gcs|GCS_BUCKET=$GCS_BUCKET|TRACKING_SINK_URL=$TRACKING_SINK_URL"
# Appended only when set, for the same merge-style reason the triple is: writing an empty value would
# overwrite a live single-tenant pin with blank. Unset here means the fleet-wide walk.
if [[ -n "$TRACKING_PROJECT_ID" ]]; then
  ENV_VARS="$ENV_VARS|TRACKING_PROJECT_ID=$TRACKING_PROJECT_ID"
fi
# Appended only when all three are set: on the merge-style update path an empty value would overwrite
# a good live address with blank, which is the one way this job could stop proposing in silence.
if [[ "$STRATEGY_SET" -eq 3 ]]; then
  ENV_VARS="$ENV_VARS|EDITORIAL_STRATEGY_PROJECT_ID=$EDITORIAL_STRATEGY_PROJECT_ID|EDITORIAL_STRATEGY_OBJECT_TYPE=$EDITORIAL_STRATEGY_OBJECT_TYPE|EDITORIAL_STRATEGY_OBJECT_ID=$EDITORIAL_STRATEGY_OBJECT_ID"
fi
SECRET_BINDING="TRACKING_SINK_TOKEN=$TRACKING_SINK_TOKEN_SECRET:latest"

if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  say "Updating $JOB with merge-style environment changes."
  gcloud run jobs update "${COMMON[@]}" --update-env-vars "$ENV_VARS" --update-secrets "$SECRET_BINDING"
else
  say "Creating $JOB."
  gcloud run jobs create "${COMMON[@]}" --set-env-vars "$ENV_VARS" --set-secrets "$SECRET_BINDING"
fi

say "Configured $JOB without executing it. Verify $RUNTIME_SA has Secret Manager accessor on $TRACKING_SINK_TOKEN_SECRET before execution."
say "This job OPENS A MARGINALIA THREAD a human reads — one per tenant it has something to say to. Execute once with --args=…,--dry-run first: it prints ONE LINE PER TENANT (project id, sink partition, strategy object address), plus the resolved window, the sink connection state and the autopatch flag, and writes nothing. Read that list before the first live run; it is the list of editors who will get a thread."
say "Tenant reachability: on the fleet-wide walk every tenant in the dry-run list must be reachable on its own; a tenant that is not is reported by name and stops nothing else. The bearer for each comes from the env var its record names, or from the Secret Manager reference it carries. Check which with: project_get on that project and read tokenEnvVar / tokenSecretRef. If it is an env var, bind it on this job; if it is a secret ref, grant $RUNTIME_SA accessor on that secret."
say "Then schedule it with scripts/deploy-strategy-review-schedule.sh, and add $JOB to deploy/executor-jobs.txt if it is not there already."
