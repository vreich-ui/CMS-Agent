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
# THE CHECK USES A DIRECT REST CALL, NOT `gcloud run jobs test-iam-permissions` — THAT SUBCOMMAND
# DOES NOT EXIST. Checked against the gcloud command index: `gcloud run jobs` has exactly
# add-iam-policy-binding, create, delete, deploy, describe, execute, executions, get-iam-policy,
# list, logs, remove-iam-policy-binding, replace, set-iam-policy, update — no test-iam-permissions.
# An earlier version of this script called that nonexistent subcommand, which would have `die`d on
# every single deploy (fail-closed, but closed onto a deploy that could never succeed). The
# CAPABILITY is real, though: Cloud Run Admin API v2's `projects.locations.jobs.testIamPermissions`
# method exists and is documented — it is simply not exposed through that gcloud surface. So the
# check below mints an access token impersonating SCHEDULER_SA (`gcloud auth print-access-token
# --impersonate-service-account`) and POSTs to that REST method with curl directly. Same design as
# before (a real, server-side, name-agnostic effective-permission check), different transport.

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
command -v curl >/dev/null || die "curl is not on PATH — needed for the run.jobs.runWithOverrides REST check below (gcloud has no equivalent subcommand)."
[[ "$CRON" =~ ^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+$ ]] \
  || die "CRON must be a 5-field cron expression (minute hour day-of-month month day-of-week), got: $CRON"

gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1 \
  || die "Cloud Run Job $JOB does not exist in $PROJECT/$REGION; run scripts/deploy-site-credential-reconciler.sh first."

# ── ASSERT run.jobs.runWithOverrides, NOT A ROLE-NAME GREP ────────────────────────────────────
#
# Runs BEFORE the scheduler job is created/updated so a schedule that cannot possibly fire
# successfully is never silently put in place — the whole point of this check (see header: this
# exact silent-failure shape 403'd on every fire from 2026-09-14 until someone read Logs Explorer).
#
# WHY A DIRECT REST CALL TO :testIamPermissions, AND NOT THE ALTERNATIVES:
#   - `gcloud run jobs get-iam-policy` + grep for "roles/run.invoker"/a role name is a ROLE-NAME
#     string match, and the ground truth this script exists to prevent is precisely that a role name
#     is not a permission: run.invoker matched and was still insufficient. A custom role can carry
#     run.jobs.runWithOverrides under any name at all (e.g. "reconcilerScheduler"), and a name grep
#     would call that a failure when it is actually fine, or miss it silently.
#   - `gcloud iam roles describe <role>` lists a role's permissions, but only for a role name you
#     already suspect SCHEDULER_SA holds — it cannot tell you what SCHEDULER_SA actually HAS bound,
#     and does nothing for a custom role's real name.
#   - Cloud Run Admin API v2's `projects.locations.jobs.testIamPermissions` method asks IAM directly
#     "does the CALLING IDENTITY have permission P on this job" — the authoritative answer, computed
#     server-side from whatever role or custom role is actually bound, by name-agnostic permission.
#     `gcloud run jobs` has NO subcommand for this method (verified against the full subcommand list:
#     add-iam-policy-binding, create, delete, deploy, describe, execute, executions, get-iam-policy,
#     list, logs, remove-iam-policy-binding, replace, set-iam-policy, update), so the check below
#     calls the REST endpoint with curl instead, authenticated as an impersonated SCHEDULER_SA token.
#     testIamPermissions evaluates the CALLER's own credentials, not an arbitrary principal, which is
#     why impersonation is required at all — this script does not have, and should not have, its own
#     standing credential for SCHEDULER_SA.
#
# TWO DISTINCT FAILURE MODES BELOW, WITH DIFFERENT REMEDIATION — do not conflate them:
#   1. Minting the impersonated token fails => the identity RUNNING THIS SCRIPT lacks
#      roles/iam.serviceAccountTokenCreator on SCHEDULER_SA. This says nothing about whether
#      SCHEDULER_SA itself holds run.jobs.runWithOverrides; it is a separate grant, needed only to
#      run this check, not to fire the schedule.
#   2. The token mints fine but the response's "permissions" array omits run.jobs.runWithOverrides
#      (INCLUDING an empty array or an omitted field — testIamPermissions returns only the subset of
#      the requested permissions the caller actually holds, so "none of them" is a normal, valid
#      NEGATIVE answer, not a request failure) => SCHEDULER_SA itself is missing the grant.
#
# ESCAPE HATCH: ALLOW_UNVERIFIED_INVOKER=1 skips this whole check, for a deployer who genuinely
# cannot obtain impersonation rights right now and wants to proceed anyway. It is opt-in only (the
# default is fail-closed) and prints the concrete cost in the same breath, so skipping can never be
# mistaken for "verified fine": the scheduler may 403 on every fire and fail silently, exactly as it
# did for five days in September 2026 before anyone read Logs Explorer.
#
# WHAT A PASSING CHECK PROVES: at the moment this script runs, SCHEDULER_SA's effective IAM on $JOB
# includes run.jobs.runWithOverrides — the exact permission the scheduler's POST body (below)
# requires. WHAT IT DOES NOT PROVE: that IAM has finished propagating for a binding granted seconds
# ago (Google documents propagation as eventually consistent, typically under a minute, occasionally
# longer); that no future edit narrows the binding before the next scheduled fire; or that the
# oauth-service-account-email token Cloud Scheduler mints at fire time carries the same permission
# (it will, absent a change to SCHEDULER_SA between now and then, but this check is a point-in-time
# assertion, not a monitor). It also cannot be executed in an environment with no gcloud/network
# reachability to the live project — CI or a sandboxed review of this script cannot exercise it.
REQUIRED_PERMISSION="run.jobs.runWithOverrides"

if [[ "${ALLOW_UNVERIFIED_INVOKER:-0}" == "1" ]]; then
  say "⚠ ALLOW_UNVERIFIED_INVOKER=1: skipping the $REQUIRED_PERMISSION check for $SCHEDULER_SA on $JOB."
  say "⚠ If $SCHEDULER_SA does not actually hold it, the scheduler may 403 on every fire and fail silently — exactly as it did for five days in September 2026 before anyone read Logs Explorer."
else
  say "Verifying $SCHEDULER_SA actually holds $REQUIRED_PERMISSION on $JOB via Cloud Run Admin API v2 testIamPermissions (roles/run.invoker does not carry it; see header)."

  # stdout and stderr are captured SEPARATELY, deliberately. gcloud writes component-update notices
  # ("Updates are available for some Google Cloud CLI components...") and other chatter to STDERR on
  # ordinary successful runs — folding that into the variable with 2>&1 would concatenate it onto the
  # token itself, producing a malformed Authorization header whose 401 would then be reported below as
  # "SCHEDULER_SA is missing the grant": the wrong diagnosis, for a machine that is actually fine.
  TOKEN_STDERR="$(mktemp)"
  trap 'rm -f "$TOKEN_STDERR"' EXIT
  IMPERSONATED_TOKEN="$(gcloud auth print-access-token --impersonate-service-account="$SCHEDULER_SA" 2>"$TOKEN_STDERR")" \
    || die "Could not mint an impersonated access token for $SCHEDULER_SA (gcloud said: $(cat "$TOKEN_STDERR")). This means the identity running THIS SCRIPT lacks roles/iam.serviceAccountTokenCreator on $SCHEDULER_SA — a DIFFERENT grant than run.jobs.runWithOverrides, needed only to run this check. Grant it with:
  gcloud iam service-accounts add-iam-policy-binding $SCHEDULER_SA --project $PROJECT --member \"user:\$(gcloud config get-value account)\" --role roles/iam.serviceAccountTokenCreator
then re-run this script, or set ALLOW_UNVERIFIED_INVOKER=1 to proceed without verifying (the scheduler may then 403 on every fire and fail silently, exactly as it did for five days in September 2026). This script does not widen IAM itself; both grants above are operator decisions."

  # Belt and braces: strip any surrounding whitespace/newline before the token reaches a header.
  IMPERSONATED_TOKEN="$(printf '%s' "$IMPERSONATED_TOKEN" | tr -d '[:space:]')"
  [[ -n "$IMPERSONATED_TOKEN" ]] || die "gcloud returned an empty access token for $SCHEDULER_SA; cannot verify $REQUIRED_PERMISSION. Re-run, or set ALLOW_UNVERIFIED_INVOKER=1 to proceed without verifying."

  TEST_IAM_URL="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:testIamPermissions"
  IAM_CHECK_RESPONSE="$(curl -sS -X POST \
    -H "Authorization: Bearer $IMPERSONATED_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"permissions\":[\"$REQUIRED_PERMISSION\"]}" \
    "$TEST_IAM_URL")" || die "The testIamPermissions request to $TEST_IAM_URL failed (curl could not complete it). Check network reachability to run.googleapis.com and that PROJECT=$PROJECT, REGION=$REGION, JOB=$JOB are correct, or set ALLOW_UNVERIFIED_INVOKER=1 to proceed without verifying."

  # A successful curl round-trip only means the HTTP request completed; the BODY can still be an
  # error object (bad auth, job not found) rather than a permissions result. Check for that BEFORE
  # reading "permissions" — an error body containing neither key would otherwise read as a silent
  # (and wrong) negative answer.
  if printf '%s' "$IAM_CHECK_RESPONSE" | grep -q '"error"'; then
    die "testIamPermissions returned an error, not a permissions result: $IAM_CHECK_RESPONSE"
  fi

  # An empty "permissions" array (or the field omitted entirely) is the NORMAL negative answer —
  # testIamPermissions echoes back only the subset of the requested permissions the caller actually
  # holds — NOT a sign anything went wrong. Do not special-case emptiness as an error.
  case "$IAM_CHECK_RESPONSE" in
    *"$REQUIRED_PERMISSION"*)
      say "✓ $SCHEDULER_SA holds $REQUIRED_PERMISSION on $JOB."
      ;;
    *)
      die "$SCHEDULER_SA does NOT hold $REQUIRED_PERMISSION on $JOB (testIamPermissions returned: $IAM_CHECK_RESPONSE). Every scheduled fire will return 403 PERMISSION_DENIED at Cloud Run — this is the exact incident confirmed live 2026-09-14, and roles/run.invoker will NOT fix it (confirmed: it was granted to $SCHEDULER_SA and the next forced run still 403'd). This script does not widen IAM itself. The reliable fix is a role that NAMES run.jobs.runWithOverrides explicitly, for example a custom role:
  gcloud iam roles create reconcilerSchedulerRunner --project $PROJECT --title \"Reconciler scheduler runner\" --permissions=run.jobs.runWithOverrides
  gcloud run jobs add-iam-policy-binding $JOB --project $PROJECT --region $REGION --member \"serviceAccount:$SCHEDULER_SA\" --role projects/$PROJECT/roles/reconcilerSchedulerRunner
roles/run.developer is documented by Google as carrying run.jobs.runWithOverrides too, but that has not been independently confirmed against this project's live IAM the way run.invoker's insufficiency has. Re-run this script after granting either, to confirm before trusting the schedule — or set ALLOW_UNVERIFIED_INVOKER=1 to proceed unverified."
      ;;
  esac
fi

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
if [[ "${ALLOW_UNVERIFIED_INVOKER:-0}" == "1" ]]; then
  say "⚠ run.jobs.runWithOverrides on $JOB was NOT verified for $SCHEDULER_SA (ALLOW_UNVERIFIED_INVOKER=1) — the schedule may 403 on every fire and fail silently until someone checks Logs Explorer."
else
  say "$SCHEDULER_SA was verified above to hold run.jobs.runWithOverrides on $JOB — the permission this scheduler body actually needs, not roles/run.invoker."
  say "That check proves IAM as of THIS moment; it does not prove propagation for a binding granted seconds ago, or that nothing narrows it before the next fire."
fi
say "The first --apply run happens at the next scheduled tick; run 'gcloud scheduler jobs run $SCHEDULER_JOB --project $PROJECT --location $REGION' to fire it once immediately for verification."
