#!/usr/bin/env bash
# Configure the Cloud Scheduler job that fires the site-credential-reconciler Cloud Run Job once a
# day with --apply, so the fleet's Client Manager credentials repair themselves without a human
# typing `gcloud run jobs execute` on a schedule of their own memory. Modeled closely on
# scripts/deploy-site-credential-reconciler.sh: same env-var contract (PROJECT/REGION/JOB), same
# prerequisite checks, same describe-then-update-else-create idempotence, same `say`/`die` helpers.
# Running THIS script only puts the Cloud Scheduler job in place — it never fires the reconciler
# itself; the first --apply run happens at the next scheduled tick.
#
# WHY DAILY IS SAFE TO SCHEDULE UNATTENDED. reconcileSiteClientManagerCredentials
# (src/agent/capture/siteCredentialReconciler.ts) is idempotent: a tenant whose active credential
# already targets the resolved Netlify site AND already carries the current SITE_CLIENT_MANAGER_TOOLS
# allowlist is reported "current" and left completely alone — no mint, no Netlify env write, no
# rebuild-and-wait-for-published-deploy. A scheduled run is therefore a no-op across the whole fleet
# on every day nothing has drifted, and only touches the handful of tenants whose scope actually
# changed since the previous run (SITE_CLIENT_MANAGER_TOOLS widened, a clientSiteBinding backfilled,
# a bearer that fell out of sync by hand). Per that module's own header: before this idempotency
# check existed, EVERY eligible project was re-minted and republished on every single run — which is
# exactly why the job could never be scheduled before now. Daily is a cadence choice, not a safety
# concession: it could run hourly with the same blast radius, because the blast radius is "however
# many tenants actually drifted," never "every tenant, every time."
#
# WHAT FIRES: the Cloud Run Jobs v2 REST "run" endpoint directly (the same host and shape
# site_credentials_apply uses — src/agent/mcp/workspace/siteCredentialTools.ts), authenticated as
# SCHEDULER_SA via Cloud Scheduler's own OAuth token minting (--oauth-service-account-email), so no
# credential is stored in the scheduler job's configuration at all. The request body carries the
# SAME containerOverrides.args array as the manual gcloud invocation and the MCP apply tool. Cloud
# Run REPLACES (never merges) the configured args on an override — passing only "--apply" would
# silently drop the `--import tsx src/agent/entrypoints/reconcileSiteCredentialsMain.ts` entrypoint
# and the job would exec `node` with no script, exiting 0 having rotated nothing. See the identical
# warning in docs/mcp-scoped-bearer-auth.md next to the equivalent gcloud invocation.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${SCHEDULER_SA:?set SCHEDULER_SA to the service account Cloud Scheduler uses to authenticate the daily run call}"

JOB="${JOB:-site-credential-reconciler}"
SCHEDULER_JOB="${SCHEDULER_JOB:-${JOB}-daily}"
# Default: once a day at 06:00 UTC. Any valid 5-field cron expression is accepted; the reconciler's
# idempotency (see header above) is what makes a tighter cadence just as safe, not just a longer one.
CRON="${CRON:-0 6 * * *}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-site-credential-reconciler.sh first."

RUN_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
# Args list mirrors SITE_CREDENTIAL_RECONCILER_APPLY_ARGS in
# src/agent/mcp/workspace/siteCredentialTools.ts and the --args in deploy-site-credential-reconciler.sh's
# own footer instructions — keep all three in lockstep.
MESSAGE_BODY='{"overrides":{"containerOverrides":[{"args":["--import","tsx","src/agent/entrypoints/reconcileSiteCredentialsMain.ts","--apply"]}]}}'

COMMON=(
  "$SCHEDULER_JOB"
  --project "$PROJECT"
  --location "$REGION"
  --schedule "$CRON"
  --uri "$RUN_URI"
  --http-method POST
  --oauth-service-account-email "$SCHEDULER_SA"
  --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
  --headers "Content-Type=application/json"
  --message-body "$MESSAGE_BODY"
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
say "Verify $SCHEDULER_SA has the run.jobs.run IAM permission on $JOB (roles/run.invoker or roles/run.developer) before the first scheduled fire — this script does not widen IAM."
say "The first --apply run happens at the next scheduled tick; run 'gcloud scheduler jobs run $SCHEDULER_JOB --project $PROJECT --location $REGION' to fire it once immediately for verification."
