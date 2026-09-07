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
: "${CMS_AGENT_PUBLIC_MCP_ENDPOINT:?set CMS_AGENT_PUBLIC_MCP_ENDPOINT to the credential-free https /mcp URL for this service}"

SERVICE="${SERVICE:-cms-agent-mcp}"
REPO="${REPO:-cms-agent}"
SCOPED_TOKENS_SECRET="${MCP_SCOPED_TOKENS_SECRET:-mcp-scoped-tokens-json}"
NETLIFY_API_TOKEN_SECRET="${NETLIFY_API_TOKEN_SECRET:-netlify-api-token}"
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

# THE FLAGS ARE NOT HERE. scripts/deploy-service.sh holds the service's entire Cloud Run shape —
# sizing, scaling, runtime identity, env-var list, secret list — and cloudbuild.deploy.yaml runs the
# very same script, so this path and the trigger path cannot disagree (KNOWN_ISSUES C-12).
#
# They used to. This file deployed 512Mi / min-instances=0 with no service account and five
# variables; the trigger deployed 1Gi / min-instances=1 with the runtime SA and eight. Sizing and
# scaling are explicit flags, not merge-preserving, so a hand deploy after a trigger deploy silently
# halved the memory and dropped min-instances — cold starts on the OAuth/consent path — and nothing
# reported it. The values that survived into the shared script are the trigger's, because those are
# what production has actually been running.
say "==> Deploying (shape and flags from scripts/deploy-service.sh)"
PROJECT="$PROJECT" REGION="$REGION" SERVICE="$SERVICE" IMAGE="$IMAGE" \
  GCS_BUCKET="$GCS_BUCKET" PUBLIC_MCP_ENDPOINT="$CMS_AGENT_PUBLIC_MCP_ENDPOINT" \
  MCP_ALLOWED_ORIGINS="$MCP_ALLOWED_ORIGINS" \
  MCP_SCOPED_TOKENS_SECRET="$SCOPED_TOKENS_SECRET" NETLIFY_API_TOKEN_SECRET="$NETLIFY_API_TOKEN_SECRET" \
  bash "$(dirname "${BASH_SOURCE[0]}")/deploy-service.sh"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
REVISION="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.latestReadyRevisionName)')"
say ""
say "Revision: $REVISION"
say "URL     : $URL"

say ""
say "==> Environment on the serving revision (including client variables and genesis authority)"
ENV_NAMES="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(spec.template.spec.containers[0].env[].name)' | tr ';,' '\n\n')"
printf '%s\n' "$ENV_NAMES" | sed 's/^/  /'
printf '%s\n' "$ENV_NAMES" | grep -qx NETLIFY_API_TOKEN \
  || die "The serving revision is missing NETLIFY_API_TOKEN; live site genesis cannot install credentials automatically."

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

# A service is not the whole system. Cloud Run JOBS keep whatever image they were last given and
# never follow a tag on their own, so before this ran here the shell deploy path updated the service
# and stopped — leaving every executor plane on older code, silently, until someone noticed by hand.
#
# Runs LAST, after the health and surface checks above, and deliberately so: if this revision is bad
# we want it confined to the service, not propagated onto the planes that rotate tenant credentials
# and write to the live store. `set -e` means a failure here fails the deploy, which is the point —
# a half-updated fleet is the bug this replaces.
#
# The job list lives in deploy/executor-jobs.txt and NOWHERE else; cloudbuild.deploy.yaml runs this
# same script, so the trigger path and this path cannot disagree about which planes exist.
say ""
say "==> Pinning executor planes to the digest this revision resolves to"
PROJECT="$PROJECT" REGION="$REGION" SERVICE="$SERVICE" bash "$(dirname "${BASH_SOURCE[0]}")/pin-job-images.sh"

say ""
say "✓ Deployed $IMAGE_TAG as $REVISION"
