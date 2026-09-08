#!/usr/bin/env bash
# Pin every Cloud Run executor JOB to the exact image DIGEST the cms-agent-mcp SERVICE is serving,
# and — with --check — report which planes have drifted off it without deploying anything.
#
# It also reconciles the list against the project in BOTH directions, because the list can only ever
# answer half the question. Listed but not in the project is ABSENT: the repository describes a plane
# nobody built, which produces no logs and no failures to notice. In the project but not listed is
# UNLISTED: a job running this image that nothing pins, which every deploy walks past while it keeps
# executing nodes on the image it was created with. That second one is the 2026-09-07 incident seen
# from the other side, and until now nothing reported it.
#
# WHY THIS FILE EXISTS
#
# A deploy built an image, pushed it, updated the service, and stopped. cloudbuild.deploy.yaml did
# carry a sync step, but the list it iterated lived in a substitution only the trigger could read
# (`_EXECUTOR_JOBS: continuation-tick`) and it predated two of the three jobs. So the mechanism was
# right and the input was wrong, which is the worst combination: the step passed green on every
# push while two planes were never considered at all. KNOWN_ISSUES C-10 predicted exactly this and
# named the wrong job; the two it actually hit, on 2026-09-07, were:
#
#   site-credential-reconciler — several builds behind. It rotates every tenant's scoped credential
#     from a tool allowlist compiled into the image, so running it would have re-narrowed all four
#     tenants to an older, smaller allowlist, undoing an allowlist change that had just deployed —
#     and exited 0 looking like a success.
#   tracking-ingest — behind, and missing the code that stamps projectId on the records it writes.
#     A tenant admin's Insights panel showed nothing while the data sat in the store.
#
# Three repins were done by hand that day. This file is the process that replaces them.
#
# WHY DIGEST AND NOT TAG
#
# A tag is a mutable pointer. Two references spelled `mcp-service:fbe7c2c` are similarly NAMED, not
# provably the same ARTIFACT — re-pushing the tag moves it. The service does not have this problem
# even though its spec names a tag, because Cloud Run resolves that tag to a digest when it creates
# the revision, and the revision is what serves. A JOB gets no such resolution: `gcloud run jobs
# describe` returns the literal tag it was given and there is no digest recorded anywhere in the
# job. So the two sides genuinely are not comparable as written, and answering "is this plane
# current?" needs an Artifact Registry lookup to resolve the job's tag. Pinning jobs BY DIGEST
# removes that asymmetry permanently: after the first pin both sides are digests and the comparison
# is a string compare against the artifact that is actually running.
#
# Usage:
#   PROJECT=cms-agent-503015 REGION=us-central1 scripts/pin-job-images.sh
#   PROJECT=cms-agent-503015 REGION=us-central1 scripts/pin-job-images.sh --check
#
# Optional:
#   SERVICE=<name>             default cms-agent-mcp
#   EXECUTOR_JOBS_FILE=<path>  default deploy/executor-jobs.txt — THE list; see that file.
#
# Changes ONLY the image. Never env vars, secrets, args, service account, CPU/memory or schedule:
# `gcloud run jobs update --image` is a merge-style update and nothing else is passed. Since T12.20
# an executor plane needs no per-tenant configuration anyway — the endpoint comes from the project
# record and the token from that record's tokenSecretRef via Secret Manager, resolved with the
# plane's own identity. Token values are never arguments or output here.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

MODE=pin
case "${1:-}" in
  --check) MODE=check ;;
  "") ;;
  *) die "Unknown argument '$1'. Usage: pin-job-images.sh [--check]" ;;
esac

: "${PROJECT:?set PROJECT (e.g. cms-agent-503015)}"
: "${REGION:?set REGION (e.g. us-central1)}"
SERVICE="${SERVICE:-cms-agent-mcp}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXECUTOR_JOBS_FILE="${EXECUTOR_JOBS_FILE:-$ROOT/deploy/executor-jobs.txt}"
[ -f "$EXECUTOR_JOBS_FILE" ] || die "Job list $EXECUTOR_JOBS_FILE is missing. It is the single source of truth for which planes exist."

# Strip comments, then split on ANY whitespace so a space-separated line still works.
JOBS="$(sed 's/#.*//' "$EXECUTOR_JOBS_FILE" | tr -s '[:space:]' '\n' | grep -v '^$' || true)"
[ -n "$JOBS" ] || die "Job list $EXECUTOR_JOBS_FILE names no jobs."

# The list is a data file, and every name in it becomes a gcloud argument. Reject anything that is
# not a Cloud Run resource name before it gets there, so a typo or a stray character is a clear
# error here rather than a confusing gcloud failure — or worse, a silent no-op — later.
for JOB in $JOBS; do
  [[ "$JOB" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] \
    || die "Invalid job name '$JOB' in ${EXECUTOR_JOBS_FILE##*/}; Cloud Run job names are lowercase alphanumerics and hyphens."
done

# ── The artifact that is actually running ───────────────────────────────────────────────────────
# Read back from the DEPLOYED service, never from what the build believes it pushed: "pushed",
# "deployed" and "serving" are three different facts and only the third one binds anything.
REVISION="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
[ -n "$REVISION" ] || die "Could not read the latest ready revision of $SERVICE ($PROJECT / $REGION)."

# status.imageDigest is the resolved artifact; spec.containers[0].image on a revision is already a
# digest reference too. Try both rather than assuming one field shape survives a gcloud update.
SERVICE_IMAGE=""
for FIELD in 'status.imageDigest' 'spec.containers[0].image'; do
  SERVICE_IMAGE="$(gcloud run revisions describe "$REVISION" --project "$PROJECT" --region "$REGION" \
    --format="value($FIELD)" 2>/dev/null || true)"
  case "$SERVICE_IMAGE" in *@sha256:*) break ;; *) SERVICE_IMAGE="" ;; esac
done
[ -n "$SERVICE_IMAGE" ] || die "Revision $REVISION exposes no digest reference; cannot pin planes to an artifact that cannot be named."

say "Service  : $SERVICE ($PROJECT / $REGION)"
say "Revision : $REVISION"
say "Artifact : $SERVICE_IMAGE"
say "Jobs from: ${EXECUTOR_JOBS_FILE#"$ROOT"/}"
say ""

# Resolve any image reference to its fully qualified digest reference. A digest passes through
# untouched; a tag costs one Artifact Registry lookup. A tag that no longer exists resolves to
# nothing, which is reported as unresolvable rather than guessed at.
resolve_digest() {
  case "$1" in
    *@sha256:*) printf '%s\n' "$1" ;;
    *) gcloud artifacts docker images describe "$1" --format='value(image_summary.fully_qualified_digest)' 2>/dev/null || true ;;
  esac
}

# READ-BACK PATH. A JOB nests its container two levels deeper than a SERVICE:
# spec.template(.spec).template(.spec).containers[] rather than the service's spec.containers[].
# Using the service-shaped path here resolved to nothing and made a comparison fail against an
# EMPTY string on 2026-08-20 build 281759b1 — printing "reports image ," and failing a build whose
# job update had in fact succeeded. A wrong path and a stale plane are indistinguishable when both
# produce "not the expected image", so: try each known shape, take the first that answers, and
# treat "no path answered" as its OWN error rather than reporting a stale plane that isn't stale.
read_job_image() {
  local job image path
  job="$1"
  for path in \
    'spec.template.spec.template.spec.containers[0].image' \
    'template.template.containers[0].image' \
    'spec.template.template.containers[0].image'; do
    image="$(gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" --format "value($path)" 2>/dev/null || true)"
    if [ -n "$image" ]; then printf '%s\n' "$image"; return 0; fi
  done
  return 1
}

# Membership test over a space-padded string. Bash 3.2 is what macOS ships as /bin/bash and what
# `npm run deploy:mcp` therefore runs (ad60201), so: no associative arrays.
JOBS_SPACED=" $(echo $JOBS) "
listed() { case "$2" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ── PRE-FLIGHT ──────────────────────────────────────────────────────────────────────────────────
# Every read happens here, before pin mode updates anything. Two reasons, both learned the hard way.
#
# FIRST: "no such job" and "cannot read job" are different answers that `describe` reports the same
# way — a non-zero exit. Conflating them is dangerous in BOTH directions. An expired credential or a
# lost IAM binding would read as absent, which in pin mode silently SKIPS a live plane (leaving it
# stale, which is this whole file's bug) and in check mode invents a plane that does not exist and
# sends someone to create one that is already there. So the two are told apart by what gcloud
# actually says, and anything that is not a clean "Cannot find job" stops the run.
#
# SECOND: pin mode used to describe job 2 only after updating job 1. A credential expiring midway
# then left a half-pinned fleet — some planes on the new artifact, some on the old, no error that
# named which. Resolving every job up front means an access failure costs nothing.
job_presence() { # 0 = present, 1 = absent, dies on anything else
  local job="$1" err
  if err="$(gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" --format='value(metadata.name)' 2>&1 >/dev/null)"; then
    return 0
  fi
  case "$err" in
    *"Cannot find job"*|*NOT_FOUND*|*"does not exist"*) return 1 ;;
  esac
  die "Cannot read job '$job' in $PROJECT / $REGION, and this is not a 'no such job' answer:
    ${err%%$'\n'*}
  Nothing has been changed. Fix the access first — treating this as 'absent' would skip a live plane
  in pin mode and invent a missing one in check mode."
}

PRESENT=" "
for JOB in $JOBS; do
  if job_presence "$JOB"; then PRESENT="$PRESENT$JOB "; fi
done

# ── THE OTHER DIRECTION ─────────────────────────────────────────────────────────────────────────
# The list answers "which planes should exist". It cannot answer "which planes DO exist", and that
# is the half C-10 left open: a job built from the mcp-service image that nobody added to the list
# is pinned by nothing, checked by nothing, and reported by nothing. That is exactly how
# site-credential-reconciler and tracking-ingest went stale on 2026-09-07 — they existed, they ran
# this image, and the sync did not know they were there.
#
# So both directions are reconciled and both fail. Listed-but-absent (below) says the repository
# describes a plane nobody built. Present-but-unlisted (here) says the project runs a plane nobody
# registered. Neither is a note: an unlisted plane executes workflow nodes on whatever image it was
# created with, forever, and every deploy walks past it.
#
# Only jobs on THIS image repository count. A job built from another image is not an executor plane
# and must never be pinned to mcp-service — that would point it at an artifact without its entrypoint.
JOB_IMAGE_REPO="${JOB_IMAGE_REPO:-${REGION}-docker.pkg.dev/${PROJECT}/cms-agent/mcp-service}"
UNLISTED=""
ALL_JOBS=""
for NAMEFIELD in 'metadata.name' 'name'; do
  ALL_JOBS="$(gcloud run jobs list --project "$PROJECT" --region "$REGION" --format="value($NAMEFIELD)" 2>/dev/null || true)"
  [ -n "$ALL_JOBS" ] && break
done
[ -n "$ALL_JOBS" ] || die "Could not list Cloud Run jobs in $PROJECT / $REGION. Refusing to report a fleet as complete when half the question could not be asked."
for RAW in $ALL_JOBS; do
  CANDIDATE="${RAW##*/}"
  listed "$CANDIDATE" "$JOBS_SPACED" && continue
  CANDIDATE_IMAGE="$(read_job_image "$CANDIDATE")" || continue
  CANDIDATE_REPO="${CANDIDATE_IMAGE%@*}"
  CANDIDATE_REPO="${CANDIDATE_REPO%:*}"
  [ "$CANDIDATE_REPO" = "$JOB_IMAGE_REPO" ] || continue
  say "UNLISTED $CANDIDATE — runs this image but is not in ${EXECUTOR_JOBS_FILE##*/}, so nothing pins it."
  UNLISTED="$UNLISTED $CANDIDATE"
done

# Five verdicts, deliberately not merged into one. "Stale" is a fact about production, "unverified"
# is a fact about this check, "weak" is a fact about how a plane is pinned rather than to what,
# "missing" is a fact about the list, and "unlisted" is a fact about the project. Reporting the
# second as the first is what made build 281759b1 read as a broken fleet when the sync had worked.
STALE=""
UNVERIFIED=""
WEAK=""
MISSING=""
CHANGED=""

for JOB in $JOBS; do
  if ! listed "$JOB" "$PRESENT"; then
    # PIN mode moves on: a job that does not exist cannot run stale code, and the service is
    # deployed and healthy regardless.
    #
    # CHECK mode FAILS (2026-09-08). It used to say the same thing here — "a partial fleet, not a
    # broken one" — and that reasoning is right about images and wrong about the question this mode
    # asks, which is "is the fleet what the repository says it is?". A plane that does not exist is
    # the loudest possible no, and treating it as a note is how `strategy-learning` and
    # `strategy-review` sat unbuilt from the day their deploy scripts merged (#280) until someone
    # listed the project by hand two days later: this check ran daily, green, the whole time,
    # because it only ever inspected jobs that already existed. C-10 closed the gap between the LIST
    # and the SCRIPTS; this closes the gap between the scripts and the PROJECT. See K-O3.
    if [ -f "$ROOT/scripts/deploy-$JOB.sh" ]; then
      say "ABSENT   $JOB — listed in ${EXECUTOR_JOBS_FILE##*/} with a deploy script, but no such job in $REGION."
      say "           create it: PROJECT=$PROJECT REGION=$REGION IMAGE=<digest> GCS_BUCKET=… RUNTIME_SA=… bash scripts/deploy-$JOB.sh"
    else
      say "ABSENT   $JOB — listed in ${EXECUTOR_JOBS_FILE##*/}, no such job in $REGION, and no scripts/deploy-$JOB.sh to create it with."
    fi
    MISSING="$MISSING $JOB"
    continue
  fi

  if ! JOB_IMAGE="$(read_job_image "$JOB")"; then
    say "UNVERIFIED $JOB — every known image field path returned empty."
    UNVERIFIED="$UNVERIFIED $JOB"
    continue
  fi

  if [ "$MODE" = check ]; then
    JOB_DIGEST="$(resolve_digest "$JOB_IMAGE")"
    if [ -z "$JOB_DIGEST" ]; then
      say "UNVERIFIED $JOB — image '$JOB_IMAGE' does not resolve in Artifact Registry."
      UNVERIFIED="$UNVERIFIED $JOB"
    elif [ "$JOB_DIGEST" != "$SERVICE_IMAGE" ]; then
      say "DRIFTED  $JOB"
      say "           runs    $JOB_DIGEST"
      say "           service $SERVICE_IMAGE"
      STALE="$STALE $JOB"
    elif [ "$JOB_IMAGE" != "$SERVICE_IMAGE" ]; then
      # Same artifact today, but named by a tag, and a tag can be re-pushed. Not drift, so not a
      # failure — but not a pin either, and the difference is invisible without this line.
      say "WEAK     $JOB — same artifact as the service, but referenced by tag '${JOB_IMAGE##*:}'. A repin makes it a digest."
      WEAK="$WEAK $JOB"
    else
      say "OK       $JOB"
    fi
    continue
  fi

  # Pin mode. Idempotent by exact reference: a plane already naming this digest is left completely
  # alone, so a re-run creates no new job revision and a converged fleet is a no-op.
  if [ "$JOB_IMAGE" = "$SERVICE_IMAGE" ]; then
    say "OK       $JOB — already pinned to this artifact."
    continue
  fi

  say "PIN      $JOB"
  say "           from $JOB_IMAGE"
  say "           to   $SERVICE_IMAGE"
  if ! gcloud run jobs update "$JOB" --project "$PROJECT" --region "$REGION" --image "$SERVICE_IMAGE" --quiet; then
    say "FAIL     $JOB — the update itself failed."
    STALE="$STALE $JOB"
    continue
  fi
  # "Updated" and "will run this image" are different facts, and only the second one matters.
  if ! JOB_IMAGE="$(read_job_image "$JOB")"; then
    say "UNVERIFIED $JOB — updated, but every known image field path returned empty on read-back."
    UNVERIFIED="$UNVERIFIED $JOB"
    continue
  fi
  if [ "$JOB_IMAGE" != "$SERVICE_IMAGE" ]; then
    say "FAIL     $JOB reports $JOB_IMAGE, not $SERVICE_IMAGE."
    STALE="$STALE $JOB"
    continue
  fi
  say "VERIFIED $JOB will execute $SERVICE_IMAGE"
  CHANGED="$CHANGED $JOB"
done

say ""
if [ -n "$MISSING" ] && [ "$MODE" = pin ]; then say "note: not present in $REGION (skipped, not failed):$MISSING"; fi
if [ -n "$WEAK" ]; then say "note: pinned by tag rather than digest:$WEAK"; fi
if [ "$MODE" = pin ] && [ -n "$CHANGED" ]; then say "repinned:$CHANGED"; fi

if [ -n "$STALE" ]; then
  say ""
  say "✗ planes NOT running the served artifact:$STALE" >&2
  say "  They execute workflow nodes with code older than the service, which presents as intermittent" >&2
  say "  failures that look like a split rather than a stale plane — or, for site-credential-reconciler," >&2
  say "  as a silent success that re-narrows every tenant's credential scope." >&2
fi
if [ -n "$UNVERIFIED" ]; then
  say ""
  say "✗ could not verify what these planes will execute:$UNVERIFIED" >&2
  say "  Fix the read-back; do not assume either way. Check the shape with:" >&2
  say "    gcloud run jobs describe <job> --project $PROJECT --region $REGION --format=json" >&2
fi
if [ "$MODE" = check ] && [ -n "$MISSING" ]; then
  say ""
  say "✗ planes the repository describes that do not exist in $PROJECT / $REGION:$MISSING" >&2
  say "  Nothing they were built to do is happening, and nothing else reports that — a job that was" >&2
  say "  never created produces no logs, no failures and no executions to look at. Create them with" >&2
  say "  their deploy scripts, or remove them from ${EXECUTOR_JOBS_FILE##*/} if they are not wanted." >&2
fi
if [ -n "$UNLISTED" ]; then
  # Fails BOTH modes, unlike ABSENT. A listed plane that was never created cannot run stale code, so
  # pin mode can walk past it. An unlisted plane is the opposite: it exists, it runs this image, and
  # nothing pins it — so a deploy that ignores it ships exactly the split this file was written to
  # prevent. Failing the deploy is the point.
  say ""
  say "✗ planes running $JOB_IMAGE_REPO that are not in ${EXECUTOR_JOBS_FILE##*/}:$UNLISTED" >&2
  say "  Nothing pins them. Every deploy updates the service, repins the listed planes, and walks" >&2
  say "  past these — so they keep executing workflow nodes on whatever image they were created" >&2
  say "  with. This is the 2026-09-07 shape, from the other side of the list." >&2
  say "  Add each to ${EXECUTOR_JOBS_FILE##*/} with a comment saying what it is and what a stale" >&2
  say "  image would do, or delete the job if it is not wanted." >&2
fi

if [ -n "$STALE$UNVERIFIED$UNLISTED" ] || { [ "$MODE" = check ] && [ -n "$MISSING" ]; }; then
  exit 1
fi

if [ "$MODE" = check ]; then
  say "✓ every executor plane runs the artifact $SERVICE is serving."
else
  say "✓ every executor plane is pinned to $SERVICE_IMAGE"
fi
