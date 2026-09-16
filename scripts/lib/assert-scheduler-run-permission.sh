# Shared by every deploy-*-schedule.sh script: VERIFIES, via a live testIamPermissions call, that
# SCHEDULER_SA actually holds the IAM permission its Cloud Scheduler job will need at fire time —
# instead of only printing advice an operator might follow for the wrong permission.
#
# THIS EXISTS BECAUSE OF #329. deploy-site-credential-reconciler-schedule.sh used to tell operators
# "verify roles/run.invoker" in its own closing footer, never checked anything, and every single
# scheduled fire 403'd from the day it was deployed — confirmed live in Logs Explorer, five days after
# the fact. The job's request carries overrides.containerOverrides.args (that's how --apply gets
# injected), and running a Cloud Run job WITH OVERRIDES needs run.jobs.runWithOverrides, a permission
# roles/run.invoker does not include. An operator followed the printed advice, granted run.invoker
# anyway, and the scheduler still 403'd on the next forced run. The scheduler looked healthy (state:
# Enabled) the entire time.
#
# The lesson generalizes past that one job: an ADVISORY-ONLY footer is the defect, in any
# deploy-*-schedule.sh script, whatever permission that script's own request shape actually needs —
# "advise and hope" cannot catch a wrong role name, a typo'd service account, or a binding that
# silently never took. So the verification mechanism lives in this ONE file, and every schedule
# script calls it with the permission ITS OWN call shape needs (run.jobs.run for a bare :run body,
# run.jobs.runWithOverrides for one that carries container overrides — see
# deploy-site-credential-reconciler-schedule.sh) rather than each script re-deriving, or mis-deriving,
# its own advice.
#
# `gcloud run jobs` HAS NO `test-iam-permissions` SUBCOMMAND (checked against the full subcommand
# list: add-iam-policy-binding, create, delete, deploy, describe, execute, executions, get-iam-policy,
# list, logs, remove-iam-policy-binding, replace, set-iam-policy, update). Cloud Run Admin API v2's
# `projects.locations.jobs.testIamPermissions` method exists and is name-agnostic — it answers "does
# the CALLING IDENTITY have permission P on this job", computed server-side from whatever role,
# predefined or custom, is actually bound — so the check below calls that REST method with curl,
# authenticated as an access token impersonating SCHEDULER_SA. It is deliberately NOT a role-name grep
# (`get-iam-policy` + string match): that is precisely the check that let run.invoker's insufficiency
# through, because run.invoker matched by name and was still wrong for this call shape.
#
# CALLERS MUST DEFINE `say` AND `die` (every deploy-*-schedule.sh script already does, identically)
# BEFORE SOURCING THIS FILE, and must have PROJECT/REGION/JOB/SCHEDULER_SA set before calling the
# function below.
#
# USAGE:
#   REQUIRED_PERMISSION="run.jobs.run"
#   GRANT_COMMAND="gcloud run jobs add-iam-policy-binding $JOB --project $PROJECT --region $REGION --member \"serviceAccount:$SCHEDULER_SA\" --role roles/run.invoker"
#   assert_scheduler_run_permission "$PROJECT" "$REGION" "$JOB" "$SCHEDULER_SA" "$REQUIRED_PERMISSION" \
#     "roles/run.invoker carries it for a bare run with no overrides" "$GRANT_COMMAND"
#   # ... then configure the scheduler job ...
#   scheduler_permission_footer "$REQUIRED_PERMISSION" "$JOB" "$SCHEDULER_SA"
#
# `assert_scheduler_run_permission` sets SCHEDULER_PERMISSION_VERIFIED=1 on a passing live check, or
# =0 if ALLOW_UNVERIFIED_INVOKER=1 skipped it (opt-in only; default is fail-closed). It must run
# BEFORE the scheduler job is created or updated, so a schedule that cannot possibly fire successfully
# is never silently put in place — call it, then configure the schedule, never the other way round.
#
# WHAT A PASSING CHECK PROVES: at the moment this runs, SCHEDULER_SA's effective IAM on JOB includes
# the required permission. WHAT IT DOES NOT PROVE: that IAM has finished propagating for a binding
# granted seconds ago (Google documents this as eventually consistent, typically under a minute,
# occasionally longer); that no future edit narrows the binding before the next scheduled fire; or
# that it can run at all without gcloud/network reachability to the live project — CI or a sandboxed
# review of a caller script cannot exercise this function.
assert_scheduler_run_permission() {
  local project="$1" region="$2" job="$3" scheduler_sa="$4" required_permission="$5" role_hint="$6" grant_command="$7"

  command -v curl >/dev/null || die "curl is not on PATH — needed to verify $required_permission (gcloud has no equivalent subcommand)."

  if [[ "${ALLOW_UNVERIFIED_INVOKER:-0}" == "1" ]]; then
    say "⚠ ALLOW_UNVERIFIED_INVOKER=1: skipping the $required_permission check for $scheduler_sa on $job."
    say "⚠ If $scheduler_sa does not actually hold it, the scheduler may 403 on every fire and fail silently — the exact incident behind #329, where an advisory-only footer let that stand for five days before anyone read Logs Explorer."
    SCHEDULER_PERMISSION_VERIFIED=0
    return 0
  fi

  say "Verifying $scheduler_sa actually holds $required_permission on $job via Cloud Run Admin API v2 testIamPermissions ($role_hint), rather than only advising it."

  # stdout and stderr are captured SEPARATELY, deliberately. gcloud writes component-update notices to
  # stderr on ordinary successful runs — folding that into the token with 2>&1 would concatenate it
  # onto the Authorization header, and the resulting 401 would be misdiagnosed below as "$scheduler_sa
  # is missing the grant": the wrong diagnosis for a machine that is actually fine.
  local token_stderr
  token_stderr="$(mktemp)"
  trap 'rm -f "$token_stderr"' RETURN

  local impersonated_token
  impersonated_token="$(gcloud auth print-access-token --impersonate-service-account="$scheduler_sa" 2>"$token_stderr")" \
    || die "Could not mint an impersonated access token for $scheduler_sa (gcloud said: $(cat "$token_stderr")). This means the identity running THIS SCRIPT lacks roles/iam.serviceAccountTokenCreator on $scheduler_sa — a DIFFERENT grant than $required_permission, needed only to run this check. Grant it with:
  gcloud iam service-accounts add-iam-policy-binding $scheduler_sa --project $project --member \"user:\$(gcloud config get-value account)\" --role roles/iam.serviceAccountTokenCreator
then re-run this script, or set ALLOW_UNVERIFIED_INVOKER=1 to proceed without verifying (the scheduler may then 403 on every fire and fail silently). This script does not widen IAM itself; both grants above are operator decisions."

  # Belt and braces: strip any surrounding whitespace/newline before the token reaches a header.
  impersonated_token="$(printf '%s' "$impersonated_token" | tr -d '[:space:]')"
  [[ -n "$impersonated_token" ]] || die "gcloud returned an empty access token for $scheduler_sa; cannot verify $required_permission. Re-run, or set ALLOW_UNVERIFIED_INVOKER=1 to proceed without verifying."

  local test_iam_url="https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${job}:testIamPermissions"
  local iam_check_response
  iam_check_response="$(curl -sS -X POST \
    -H "Authorization: Bearer $impersonated_token" \
    -H "Content-Type: application/json" \
    -d "{\"permissions\":[\"$required_permission\"]}" \
    "$test_iam_url")" \
    || die "The testIamPermissions request to $test_iam_url failed (curl could not complete it). Check network reachability to run.googleapis.com and that PROJECT=$project, REGION=$region, JOB=$job are correct, or set ALLOW_UNVERIFIED_INVOKER=1 to proceed without verifying."

  # A successful curl round-trip only means the HTTP request completed; the BODY can still be an
  # error object (bad auth, job not found) rather than a permissions result. Check for that BEFORE
  # reading "permissions" — an error body containing neither key would otherwise read as a silent
  # (and wrong) negative answer.
  if printf '%s' "$iam_check_response" | grep -q '"error"'; then
    die "testIamPermissions returned an error, not a permissions result: $iam_check_response"
  fi

  # An empty "permissions" array (or the field omitted entirely) is the NORMAL negative answer —
  # testIamPermissions echoes back only the subset of the requested permissions the caller actually
  # holds, so "none of them" is a valid negative, not a request failure. Do not special-case emptiness
  # as an error.
  case "$iam_check_response" in
    *"$required_permission"*)
      say "✓ $scheduler_sa holds $required_permission on $job."
      SCHEDULER_PERMISSION_VERIFIED=1
      ;;
    *)
      die "$scheduler_sa does NOT hold $required_permission on $job (testIamPermissions returned: $iam_check_response). Every scheduled fire will return 403 PERMISSION_DENIED at Cloud Run — this is the #329 failure mode. This script does not widen IAM itself. Grant it, for example:
  $grant_command
Re-run this script after granting, to confirm before trusting the schedule — or set ALLOW_UNVERIFIED_INVOKER=1 to proceed unverified."
      ;;
  esac
}

# Prints the closing IAM status line for a deploy-*-schedule.sh script, matching whichever branch
# assert_scheduler_run_permission actually took. Call AFTER the scheduler job has been configured.
scheduler_permission_footer() {
  local required_permission="$1" job="$2" scheduler_sa="$3"
  if [[ "${SCHEDULER_PERMISSION_VERIFIED:-0}" == "1" ]]; then
    say "$scheduler_sa was verified above to hold $required_permission on $job."
    say "That check proves IAM as of THIS moment; it does not prove propagation for a binding granted seconds ago, or that nothing narrows it before the next fire."
  else
    say "⚠ $required_permission on $job was NOT verified for $scheduler_sa (ALLOW_UNVERIFIED_INVOKER=1) — the schedule may 403 on every fire and fail silently until someone checks Logs Explorer."
  fi
}
