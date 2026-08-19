#!/usr/bin/env bash
# Release the Cloud Run MCP service. ONE command, committed, so the correct flags are not something
# anyone has to remember.
#
# WHY THIS FILE EXISTS
#
# The deploy was previously hand-assembled from docs/platform/PHASE4_RUNBOOK.md, whose step-2 command
# used --set-env-vars / --set-secrets. Those REPLACE the service's entire environment with only what is
# passed, and the runbook command listed just the store/CORS variables. Every release therefore deleted
# the six client-connection variables (DR_LURIE / PDF_TOOL / PLATFORM endpoint + token), taking all
# client connections down while `repository.get_health` stayed green — because workspace state lives in
# GCS and is independent of the revision. It read as a credentials problem and never was one. It
# happened twice.
#
# This script uses the merge-style --update-env-vars / --update-secrets, which change only the keys
# named and leave everything else — including those six — untouched. Then it verifies the result,
# because "deployed" and "working" are also different facts.
#
# Usage:
#   PROJECT=cms-agent-503015 REGION=us-central1 GCS_BUCKET=<bucket> \
#   MCP_ALLOWED_ORIGINS="https://<site>.netlify.app,http://localhost:5173" \
#   scripts/deploy-mcp.sh
#
# Optional:
#   IMAGE_TAG=<tag>   default: the current short git SHA. Never "latest" by default — an immutable tag
#                     is what makes "which commit is live?" answerable at all.
#   SKIP_BUILD=1      deploy an already-built image.
#
# To REMOVE a variable later, use `gcloud run services update --remove-env-vars KEY`. Never re-list
# everything with --set-env-vars to drop one key; that is the original bug.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT (e.g. cms-agent-503015)}"
: "${REGION:?set REGION (e.g. us-central1)}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${MCP_ALLOWED_ORIGINS:?set MCP_ALLOWED_ORIGINS (exact origins, comma-separated; unset denies every browser origin)}"
: "${CMS_AGENT_PUBLIC_MCP_ENDPOINT:?set CMS_AGENT_PUBLIC_MCP_ENDPOINT to this service's credential-free https /mcp URL}"

SERVICE="${SERVICE:-cms-agent-mcp}"
REPO="${REPO:-cms-agent}"
SCOPED_TOKENS_SECRET="${MCP_SCOPED_TOKENS_SECRET:-mcp-scoped-tokens-json}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/mcp-service:$IMAGE_TAG"

command -v gcloud >/dev/null || die "gcloud is not on PATH."

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  say "⚠  Working tree is dirty. The image will be tagged $IMAGE_TAG, which will NOT describe what is in it."
  printf 'Continue anyway? [y/N] '
  read -r reply
  [ "$reply" = "y" ] || die "Aborted. Commit first so the image tag identifies the code."
fi

say "Service : $SERVICE ($PROJECT / $REGION)"
say "Image   : $IMAGE"
say ""

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  say "==> Building (Dockerfile.mcp via cloudbuild.mcp.yaml)"
  gcloud builds submit --project "$PROJECT" --config cloudbuild.mcp.yaml --substitutions _IMAGE="$IMAGE" .
else
  say "==> Skipping build (SKIP_BUILD=1)"
fi

# --update-* MERGES. This is the whole point of the file: anything already on the service — notably the
# six client-connection variables — survives the deploy untouched.
#
# gcloud splits these lists on commas, so a multi-origin allow-list needs a different delimiter via the
# ^delim^ prefix. "|" is safe; ":" is NOT, because every origin contains "://" and gcloud would split
# mid-URL and reject the fragment.
say "==> Deploying with MERGE-style flags (--update-env-vars / --update-secrets)"
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 4 --port 8080 \
  --allow-unauthenticated \
  --update-env-vars "^|^WORKSPACE_STORE=gcs|GCS_BUCKET=$GCS_BUCKET|MCP_STATE_STORE=blobs|MCP_ALLOWED_ORIGINS=$MCP_ALLOWED_ORIGINS|CMS_AGENT_PUBLIC_MCP_ENDPOINT=$CMS_AGENT_PUBLIC_MCP_ENDPOINT|FERNWELL_MCP_ENDPOINT=https://kugel-fernwell.netlify.app/mcp" \
  --update-secrets "MCP_API_TOKEN=mcp-api-token:latest,OPENAI_API_KEY=openai-api-key:latest,MCP_SCOPED_TOKENS_JSON=$SCOPED_TOKENS_SECRET:latest,FERNWELL_MCP_TOKEN=fernwell-mcp-token:latest"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
REVISION="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.latestReadyRevisionName)')"
say ""
say "Revision: $REVISION"
say "URL     : $URL"

say ""
say "==> Environment on the serving revision (all ten expected, including the six client variables)"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(spec.template.spec.containers[0].env[].name)' | tr ';' '\n' | sed 's/^/  /'

say ""
say "==> Health"
curl -fsS "$URL/health" >/dev/null
say "health    : ok"

# The check that would have caught both of this project's deploy incidents: is the SERVED tool surface
# the one this commit expects, does every active client still have its endpoint and token, and (when
# the operator supplied a scoped token only in this shell) does its project pin resolve the agent?
if [ -n "${MCP_API_TOKEN:-}" ]; then
  say ""
  say "==> Verifying the served surface and client configuration"
  MCP_URL="$URL/mcp" npm run --silent verify:deploy
else
  say ""
  say "⚠  MCP_API_TOKEN not set in this shell, so the surface/client verification was skipped."
  say "   Run it before trusting the deploy:"
  say "     MCP_URL=$URL/mcp MCP_API_TOKEN=<bearer> npm run verify:deploy"
fi

say ""
say "✓ Deployed $IMAGE_TAG as $REVISION"
