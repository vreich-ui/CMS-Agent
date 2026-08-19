#!/usr/bin/env bash
# Configure the dedicated Cloud Run Job that repairs existing client-site Client Manager
# credentials. The fleet Netlify credential flows directly from Secret Manager; token values are
# never command arguments, output, or project records. This script does not execute the job.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${IMAGE:?set IMAGE to the immutable deployed CMS-Agent image}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${CMS_AGENT_PUBLIC_MCP_ENDPOINT:?set CMS_AGENT_PUBLIC_MCP_ENDPOINT to the credential-free https /mcp URL}"
: "${RUNTIME_SA:?set RUNTIME_SA to the existing CMS-Agent runtime service account}"

JOB="${JOB:-site-credential-reconciler}"
NETLIFY_API_TOKEN_SECRET="${NETLIFY_API_TOKEN_SECRET:-netlify-api-token}"
if [ -z "${CMS_AGENT_SITE_BINDINGS_JSON:-}" ]; then
  CMS_AGENT_SITE_BINDINGS_JSON="{}"
fi

command -v gcloud >/dev/null || die "gcloud is not on PATH."
command -v node >/dev/null || die "node is not on PATH."
CMS_AGENT_SITE_BINDINGS_JSON="$CMS_AGENT_SITE_BINDINGS_JSON" node -e '
const raw = process.env.CMS_AGENT_SITE_BINDINGS_JSON;
const value = JSON.parse(raw);
if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1);
for (const [projectId, siteName] of Object.entries(value)) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectId) || typeof siteName !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(siteName)) process.exit(1);
}
' || die "CMS_AGENT_SITE_BINDINGS_JSON must be a non-secret project-id to Netlify-site-name map."
gcloud secrets describe "$NETLIFY_API_TOKEN_SECRET" --project "$PROJECT" >/dev/null \
  || die "Secret $NETLIFY_API_TOKEN_SECRET is missing; create it without printing its value before configuring the job."

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
  --args=--import,tsx,src/agent/entrypoints/reconcileSiteCredentialsMain.ts
)
ENV_VARS="^|^WORKSPACE_STORE=gcs|GCS_BUCKET=$GCS_BUCKET|CMS_AGENT_PUBLIC_MCP_ENDPOINT=$CMS_AGENT_PUBLIC_MCP_ENDPOINT|CMS_AGENT_SITE_BINDINGS_JSON=$CMS_AGENT_SITE_BINDINGS_JSON"
SECRET_BINDING="NETLIFY_API_TOKEN=$NETLIFY_API_TOKEN_SECRET:latest"

if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  say "Updating $JOB with merge-style environment changes."
  gcloud run jobs update "${COMMON[@]}" \
    --update-env-vars "$ENV_VARS" \
    --update-secrets "$SECRET_BINDING"
else
  say "Creating $JOB."
  gcloud run jobs create "${COMMON[@]}" \
    --set-env-vars "$ENV_VARS" \
    --set-secrets "$SECRET_BINDING"
fi

say "Configured $JOB without executing it. Verify $RUNTIME_SA has Secret Manager accessor on $NETLIFY_API_TOKEN_SECRET before execution."
say "Next: execute once without args, review the dry-run result, then execute with --args=--apply only after approval."
