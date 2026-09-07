#!/usr/bin/env bash
# THE ONLY PLACE the cms-agent-mcp Cloud Run service's SHAPE is written down: sizing, scaling,
# runtime identity, the environment variables a deploy sets and the secrets it binds.
#
# WHY THIS FILE EXISTS (KNOWN_ISSUES C-12)
#
# Two artifacts deployed one service and disagreed. cloudbuild.deploy.yaml (the trigger, and so the
# path production actually takes on every push to main) deployed 1Gi / min-instances=1 with the
# runtime service account and eight client endpoint variables. scripts/deploy-mcp.sh (the hand path)
# deployed 512Mi / min-instances=0, named no service account, and set five variables.
#
# Sizing and scaling are NOT merge-preserving the way --update-env-vars is: they are explicit flags,
# so a hand deploy after a trigger deploy silently HALVED the service memory and dropped
# min-instances to 0 — cold starts on the OAuth/consent path — and nothing said so. The reverse
# direction was quieter still: because both paths use merge-style flags, the three client endpoint
# and token pairs the script omitted survived on the existing service, so the gap was invisible
# until it mattered, which is on a first deploy of a fresh service.
#
# This is the same fix shape as deploy/executor-jobs.txt (C-10): one artifact, read by both paths,
# so they cannot drift. cloudbuild.deploy.yaml calls this script and scripts/deploy-mcp.sh calls
# this script. Neither carries a second copy of these flags.
#
# WHERE THE VALUES CAME FROM. The trigger's, unchanged — it is what production has been running.
# 512Mi / min-instances=0 was the drift, not the intent.
#
# MERGE FLAGS, NEVER --set-*. --update-env-vars / --update-secrets change only the keys named.
# --set-env-vars REPLACES the whole environment and has twice deleted the client-connection
# variables while repository.get_health stayed green (workspace state is in GCS, independent of the
# revision). DR_LURIE_PUBLISH_ENABLED and PLATFORM_PUBLISH_ENABLED live in that same environment and
# are deliberately NOT named here, so that a deploy can never disturb them.
#
# Usage (both callers set these; nothing here is interactive):
#   PROJECT REGION SERVICE IMAGE GCS_BUCKET PUBLIC_MCP_ENDPOINT   required
#   RUNTIME_SA            default: the cms-agent-run service account below
#   MCP_ALLOWED_ORIGINS   optional; omitted entirely when empty, which denies every browser origin
#
# bash 3.2 compatible: macOS /bin/bash is 3.2 and the hand path runs there. No associative arrays,
# and no apostrophe inside a ${VAR:?...} message — that is a hard parse error in 3.2, which cost a
# follow-up commit on #275.

set -euo pipefail

: "${PROJECT:?set PROJECT (e.g. cms-agent-503015)}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${SERVICE:?set SERVICE (e.g. cms-agent-mcp)}"
: "${IMAGE:?set IMAGE to the fully qualified, commit-tagged artifact to deploy}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${PUBLIC_MCP_ENDPOINT:?set PUBLIC_MCP_ENDPOINT to the credential-free https /mcp URL for this service}"

RUNTIME_SA="${RUNTIME_SA:-cms-agent-run@cms-agent-503015.iam.gserviceaccount.com}"

# ── shape ───────────────────────────────────────────────────────────────────
CPU="1"
MEMORY="1Gi"
MIN_INSTANCES="1"
MAX_INSTANCES="4"
PORT="8080"

# ── environment ─────────────────────────────────────────────────────────────
# Every key a deploy is allowed to set. A key NOT listed here is never touched by a deploy, which is
# the guarantee the publish-enabled flags depend on.
ENV_PAIRS=(
  "WORKSPACE_STORE=gcs"
  "MCP_STATE_STORE=blobs"
  "GCS_BUCKET=${GCS_BUCKET}"
  "CMS_AGENT_PUBLIC_MCP_ENDPOINT=${PUBLIC_MCP_ENDPOINT}"
  "DR_LURIE_MCP_ENDPOINT=https://drluriescience.netlify.app/mcp"
  "PDF_TOOL_MCP_ENDPOINT=https://pdf-x.netlify.app/mcp"
  "PLATFORM_MCP_ENDPOINT=https://kugel-platform.netlify.app/mcp"
  "FERNWELL_MCP_ENDPOINT=https://kugel-fernwell.netlify.app/mcp"
  # Live on the service since before this file existed and named by NEITHER deploy artifact — a
  # fourth tenant configured entirely by hand. Merge-style flags are the only reason it survived
  # every deploy; a first deploy of a fresh service would simply not have had it, and one --set-*
  # would have deleted it. Found 2026-09-07 by diffing the live service against both artifacts.
  "ZILBERMAN_MCP_ENDPOINT=https://zilbermanfilmfoundation.netlify.app/mcp"
  # Likewise unnamed by either artifact. The tracking-ingest job sets its own copy; the SERVICE
  # needs it for feedback_ingest_tracking.
  "TRACKING_SINK_URL=https://kugel-data.netlify.app/api/tracking-sink"
)

# Only when supplied. An empty value is not the same as an absent one: setting the key to "" denies
# every browser origin explicitly, whereas omitting it leaves whatever the service already has. The
# trigger path has never set it, so it must stay omitted there.
if [ -n "${MCP_ALLOWED_ORIGINS:-}" ]; then
  ENV_PAIRS+=("MCP_ALLOWED_ORIGINS=${MCP_ALLOWED_ORIGINS}")
fi

# ── secrets ─────────────────────────────────────────────────────────────────
# Names only, always :latest, bound from Secret Manager. No literal secret is ever a command
# argument here or anywhere else in this repo.
SECRET_PAIRS=(
  "MCP_API_TOKEN=${MCP_API_TOKEN_SECRET:-mcp-api-token}:latest"
  "OPENAI_API_KEY=openai-api-key:latest"
  "MCP_SCOPED_TOKENS_JSON=${MCP_SCOPED_TOKENS_SECRET:-mcp-scoped-tokens-json}:latest"
  "DR_LURIE_MCP_TOKEN=dr-lurie-mcp-token:latest"
  "PDF_TOOL_MCP_TOKEN=pdf-tool-mcp-token:latest"
  "PLATFORM_MCP_TOKEN=platform-mcp-token:latest"
  "FERNWELL_MCP_TOKEN=fernwell-mcp-token:latest"
  # The other half of the hand-configured fourth tenant above.
  "ZILBERMAN_MCP_TOKEN=zilberman-mcp-token:latest"
  # Was a PLAINTEXT env var on this service until 2026-09-07, readable in every revision before
  # 00236-pcz; now a Secret Manager binding. Named here so it stays one.
  "TRACKING_SINK_TOKEN=tracking-sink-token:latest"
  "NETLIFY_API_TOKEN=${NETLIFY_API_TOKEN_SECRET:-netlify-api-token}:latest"
)

# gcloud splits list flags on commas, and MCP_ALLOWED_ORIGINS is itself a comma-separated list of
# URLs. The ^delim^ prefix overrides the separator. "|" is safe; ":" is NOT, because every origin
# contains "://" and gcloud would split mid-URL and reject the fragment.
join() { local IFS="$1"; shift; printf '%s' "$*"; }
ENV_ARG="^|^$(join '|' "${ENV_PAIRS[@]}")"
SECRET_ARG="$(join ',' "${SECRET_PAIRS[@]}")"

printf '%s\n' "==> gcloud run deploy ${SERVICE} (${MEMORY}, min-instances=${MIN_INSTANCES}, SA ${RUNTIME_SA})"
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "${RUNTIME_SA}" \
  --cpu "${CPU}" \
  --memory "${MEMORY}" \
  --min-instances "${MIN_INSTANCES}" \
  --max-instances "${MAX_INSTANCES}" \
  --port "${PORT}" \
  --allow-unauthenticated \
  --quiet \
  --update-env-vars "${ENV_ARG}" \
  --update-secrets "${SECRET_ARG}"
