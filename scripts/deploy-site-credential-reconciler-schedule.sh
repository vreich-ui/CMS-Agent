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
#
# THE IAM PERMISSION THIS ACTUALLY NEEDS IS run.jobs.runWithOverrides, NOT run.jobs.run.
#
# Confirmed live 2026-09-14 in Logs Explorer: the Cloud Scheduler job `site-credential-reconciler-
# daily` returned 403 PERMISSION_DENIED ("URL_ERROR-ERROR_OTHER... status: PERMISSION_DENIED") on
# EVERY fire since it was deployed. The request body above is exactly why: it carries
# overrides.containerOverrides.args — that is the only way `--apply` gets injected, because the
# job's own configured args (scripts/deploy-site-credential-reconciler.sh) deliberately omit it so a
# bare `gcloud run jobs execute` is always a dry run. Running a Cloud Run job WITH OVERRIDES is a
# DISTINCT IAM permission, run.jobs.runWithOverrides, which roles/run.invoker does NOT include —
# roles/run.invoker only covers a bare, override-free run (run.jobs.run) and invoking a Cloud Run
# service (run.routes.invoke). THIS PART IS CONFIRMED THE HARD WAY, not read off documentation:
# roles/run.invoker was granted to SCHEDULER_SA on this job, and the next forced run still 403'd.
#
# WHICH ROLE DOES carry run.jobs.runWithOverrides is NOT independently confirmed against this
# project's live IAM the way run.invoker's insufficiency is. Google's own role documentation
# describes roles/run.developer as the broader development role and a plausible carrier of it, but
# that is a documentation claim repeated here, not a live-verified fact — do not upgrade it to one.
# The reliable route, and the one that needs no trust in a predefined role's exact permission set at
# all, is a custom role that NAMES run.jobs.runWithOverrides explicitly. Whichever the operator
# grants, THIS SCRIPT VERIFIES THE PERMISSION ITSELF below rather than trusting a role name, because
# a custom role can carry it under any name, and even roles/run.developer's contents could drift.
#
# Do not revert the guidance below back to naming roles/run.invoker as sufficient. It was the
# original defect: this file previously told operators "verify roles/run.invoker" and every single
# scheduled fire failed anyway because that advice was for the wrong call shape.
#
# THE VERIFICATION MECHANISM ITSELF (the testIamPermissions REST call, the ALLOW_UNVERIFIED_INVOKER
# escape hatch, the token/permission failure-mode split) now lives in
# scripts/lib/assert-scheduler-run-permission.sh, shared by every deploy-*-schedule.sh script — see
# that file's header for why a direct REST call and not `gcloud run jobs test-iam-permissions` (that
# subcommand does not exist) or a role-name grep. This script's own job is just to name the permission
# ITS request shape needs (run.jobs.runWithOverrides, not run.jobs.run) and the remedy for it. This
# script still does not widen IAM itself, verified or not — it asserts, the operator grants.

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

# shellcheck source=lib/assert-scheduler-run-permission.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/assert-scheduler-run-permission.sh"

# THE PERMISSION THIS ACTUALLY NEEDS IS run.jobs.runWithOverrides, NOT run.jobs.run — see header.
# roles/run.invoker only covers a bare, override-free run and invoking a Cloud Run SERVICE; it does
# NOT include run.jobs.runWithOverrides (confirmed the hard way: granted to SCHEDULER_SA on this job,
# and the next forced run still 403'd). Whichever role the operator grants, this script VERIFIES the
# permission itself below rather than trusting a role name.
REQUIRED_PERMISSION="run.jobs.runWithOverrides"
GRANT_COMMAND="gcloud iam roles create reconcilerSchedulerRunner --project $PROJECT --title \"Reconciler scheduler runner\" --permissions=run.jobs.runWithOverrides
  gcloud run jobs add-iam-policy-binding $JOB --project $PROJECT --region $REGION --member \"serviceAccount:$SCHEDULER_SA\" --role projects/$PROJECT/roles/reconcilerSchedulerRunner
roles/run.developer is documented by Google as carrying run.jobs.runWithOverrides too, but that has not been independently confirmed against this project's live IAM the way run.invoker's insufficiency has."
assert_scheduler_run_permission "$PROJECT" "$REGION" "$JOB" "$SCHEDULER_SA" "$REQUIRED_PERMISSION" \
  "roles/run.invoker does NOT carry it — this call carries overrides.containerOverrides.args" \
  "$GRANT_COMMAND"

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
scheduler_permission_footer "$REQUIRED_PERMISSION" "$JOB" "$SCHEDULER_SA"
say "The first --apply run happens at the next scheduled tick; run 'gcloud scheduler jobs run $SCHEDULER_JOB --project $PROJECT --location $REGION' to fire it once immediately for verification."
