#!/usr/bin/env bash
# Repin the Cloud Run JOBS to the image cms-agent-mcp is currently serving — WITHOUT executing any
# of them, and WITHOUT touching continuation-tick by default (Track C, Wolf 2026-09-14).
#
# WHY THIS EXISTS ALONGSIDE pin-job-images.sh. That script is the pin implementation and stays the
# only one — this is a SELECTION in front of it, not a second copy. It exists because
# continuation-tick is unlike every other plane in deploy/executor-jobs.txt: it runs every ~2
# minutes against live content on four tenant sites, so a repin lands immediately and at full scale
# (that file says so, in as many words, and calls the blast radius deliberate). That is the right
# behaviour on a release. It is the wrong behaviour when you are repinning because ONE job — the new
# editorial-planner, say — is refusing to run on a stale image at 06:00 and you want it fixed
# without simultaneously rolling every in-flight node on the fleet onto a new build.
#
# So: the release path keeps using pin-job-images.sh (via cloudbuild.deploy.yaml) and keeps pinning
# everything. This path is for the targeted repin, and it leaves the loudest plane alone unless you
# say otherwise.
#
# IT NEVER EXECUTES A JOB. Neither does pin-job-images.sh. `gcloud run jobs update --image` changes
# what the NEXT execution runs and starts nothing; nothing here calls `jobs execute`, and nothing
# here fires a scheduler job. A repin of editorial-planner therefore commissions nothing — its next
# scheduled fire does.
#
# USAGE
#   PROJECT=cms-agent-503015 REGION=us-central1 scripts/jobs-repin.sh            # all but continuation-tick
#   PROJECT=… REGION=… scripts/jobs-repin.sh --check                             # report drift, change nothing
#   PROJECT=… REGION=… scripts/jobs-repin.sh --only editorial-planner            # one plane
#   PROJECT=… REGION=… scripts/jobs-repin.sh --all                               # include continuation-tick
#   PROJECT=… REGION=… EXCLUDE="continuation-tick tracking-ingest" scripts/jobs-repin.sh
#
# --check is forwarded verbatim to pin-job-images.sh, so drift reporting has ONE implementation too.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*" >&2; exit 1; }

# The plane a repin reaches immediately and at full scale. Excluded by default for that reason, and
# for no other — it is not a fragile job, it is a fast one.
DEFAULT_EXCLUDE="continuation-tick"

MODE=""
ONLY=""
INCLUDE_ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=--check ;;
    --all) INCLUDE_ALL=1 ;;
    --only) shift; ONLY="${1:-}"; [ -n "$ONLY" ] || die "--only needs a job name." ;;
    -h|--help) sed -n '1,32p' "$0"; exit 0 ;;
    *) die "Unknown argument '$1'. Usage: jobs-repin.sh [--check] [--all] [--only <job>]" ;;
  esac
  shift
done

: "${PROJECT:?set PROJECT (e.g. cms-agent-503015)}"
: "${REGION:?set REGION (e.g. us-central1)}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_LIST="${EXECUTOR_JOBS_FILE:-$ROOT/deploy/executor-jobs.txt}"
[ -f "$SOURCE_LIST" ] || die "Job list $SOURCE_LIST is missing. It is the single source of truth for which planes exist."

EXCLUDE="${EXCLUDE:-$DEFAULT_EXCLUDE}"
[ "$INCLUDE_ALL" = "1" ] && EXCLUDE=""

# Strip comments exactly as pin-job-images.sh does, then apply the selection.
ALL_NAMES="$(sed 's/#.*//' "$SOURCE_LIST" | tr -s '[:space:]' '\n' | grep -v '^$' || true)"
[ -n "$ALL_NAMES" ] || die "Job list $SOURCE_LIST names no jobs."

SELECTED=""
SKIPPED=""
for NAME in $ALL_NAMES; do
  if [ -n "$ONLY" ] && [ "$NAME" != "$ONLY" ]; then SKIPPED="$SKIPPED $NAME"; continue; fi
  SKIP=0
  for EXCLUDED in $EXCLUDE; do
    if [ "$NAME" = "$EXCLUDED" ]; then SKIP=1; fi
  done
  if [ "$SKIP" = "1" ]; then SKIPPED="$SKIPPED $NAME"; continue; fi
  SELECTED="$SELECTED $NAME"
done

if [ -n "$ONLY" ] && [ -z "$SELECTED" ]; then
  die "--only $ONLY does not name a job in ${SOURCE_LIST##*/}. Add it there first; nothing pins an unlisted plane."
fi
[ -n "$SELECTED" ] || die "Every job was excluded. Use --all to include continuation-tick, or clear EXCLUDE."

say "Repinning from: ${SOURCE_LIST#"$ROOT"/}"
say "  selected:$SELECTED"
[ -n "$SKIPPED" ] && say "  skipped:  $SKIPPED$([ "$INCLUDE_ALL" = "0" ] && [ -z "$ONLY" ] && printf '%s' "   (continuation-tick is excluded by default — pass --all to include it)")"
say ""

# One pin implementation, one drift reporter. Nothing here talks to gcloud directly.
#
# The FULL list still goes to pin-job-images.sh, on purpose. Handing it a shortened file would make
# every excluded plane look UNLISTED — the exact failure that file exists to catch — so the
# selection travels as PIN_ONLY instead: both reconciliation directions still run against the whole
# fleet, and all the selection changes is which planes get their image updated.
PIN_ONLY="$SELECTED" EXECUTOR_JOBS_FILE="$SOURCE_LIST" "$ROOT/scripts/pin-job-images.sh" ${MODE:+$MODE}

say ""
say "No job was executed. A repin changes what the NEXT execution runs; it starts nothing and fires no schedule."
