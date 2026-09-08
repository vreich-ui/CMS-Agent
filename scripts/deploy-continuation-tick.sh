#!/usr/bin/env bash
# Configure the Cloud Run Job that dispatches queued workflow nodes every two minutes
# (continuation-tick). Closes the second half of S-14 and C-11.
#
# WHY THIS PLANE IS DIFFERENT FROM THE OTHER FOUR. The W21 jobs run once a day or once a week
# against yesterday's numbers; a bad configuration there is caught before it does anything. This one
# fires every two minutes against LIVE CONTENT on four tenant sites. An env change applied here is
# fleet-wide within two minutes, at full scale, with no schedule to wait behind. That is the same
# blast radius deploy/executor-jobs.txt calls out for image pinning, and it is why this script
# DEFAULTS TO READING, NOT WRITING.
#
# THE HUMAN-DECISION RULE. `bash scripts/deploy-continuation-tick.sh` describes the live job, diffs
# it field by field against the shape declared below, prints the table and exits non-zero if
# anything differs. It writes nothing. Only `APPLY=1 bash scripts/deploy-continuation-tick.sh`
# updates the job, and that is an operator action taken deliberately, between ticks, after checking
# driverHealth -- not something a pipeline does on a push. There is no code path in this file that
# starts a run: configuring the job and running it are different decisions and this script only
# makes the first one.
#
# WHERE THE DECLARED SHAPE CAME FROM. docs/platform/continuation-tick.live-shape.md, a read-only
# gcloud capture taken 2026-09-08 before this script existed. If you change a field here, change it
# there too, or the next reader will not know which one is the intent.
#
# TASK_TIMEOUT_MS IS DERIVED, NOT TYPED. The job reads TASK_TIMEOUT_MS to decide how long it may
# keep working; Cloud Run kills the task at --task-timeout. Two hand-typed numbers drift, and the
# failure is a task killed mid-write with no log line saying why. Both come from TASK_TIMEOUT_SECONDS.
#
# SECRETS. Names and versions only, bound from Secret Manager. No token value is ever a command
# argument, an env literal, output, or a line in this repository.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { say ""; say "✗ $*"; exit 1; }

: "${PROJECT:?set PROJECT}"
: "${REGION:?set REGION}"
: "${GCS_BUCKET:?set GCS_BUCKET}"
: "${RUNTIME_SA:?set RUNTIME_SA to the existing CMS-Agent runtime service account}"

JOB="${JOB:-continuation-tick}"

# The image is owned by scripts/pin-job-images.sh, which pins every executor job to the digest the
# service is running. This script therefore does not declare one by default: unset means "leave the
# live image alone and do not diff it". Set IMAGE only when creating the job for the first time, or
# when you deliberately intend this script to move it.
IMAGE="${IMAGE:-}"

CPU="${CPU:-1}"
MEMORY="${MEMORY:-1Gi}"
TASK_TIMEOUT_SECONDS="${TASK_TIMEOUT_SECONDS:-600}"
MAX_RETRIES="${MAX_RETRIES:-0}"
TASK_COUNT="${TASK_COUNT:-1}"
EXECUTION_ENVIRONMENT="${EXECUTION_ENVIRONMENT:-gen2}"
ENTRYPOINT="${ENTRYPOINT:-src/agent/entrypoints/runContinuationTickMain.ts}"

CONTINUATION_TICK_BUDGET_MS="${CONTINUATION_TICK_BUDGET_MS:-240000}"
# Derived from the same variable as --task-timeout so the two cannot disagree.
TASK_TIMEOUT_MS=$((TASK_TIMEOUT_SECONDS * 1000))

PLATFORM_MCP_ENDPOINT="${PLATFORM_MCP_ENDPOINT:-https://kugel-platform.netlify.app/mcp}"
DR_LURIE_MCP_ENDPOINT="${DR_LURIE_MCP_ENDPOINT:-https://drluriescience.netlify.app/mcp}"
FERNWELL_MCP_ENDPOINT="${FERNWELL_MCP_ENDPOINT:-https://kugel-fernwell.netlify.app/mcp}"
ZILBERMAN_MCP_ENDPOINT="${ZILBERMAN_MCP_ENDPOINT:-https://zilbermanfilmfoundation.netlify.app/mcp}"

OPENAI_API_KEY_SECRET="${OPENAI_API_KEY_SECRET:-openai-api-key}"
PLATFORM_MCP_TOKEN_SECRET="${PLATFORM_MCP_TOKEN_SECRET:-platform-mcp-token}"
DR_LURIE_MCP_TOKEN_SECRET="${DR_LURIE_MCP_TOKEN_SECRET:-dr-lurie-mcp-token}"
FERNWELL_MCP_TOKEN_SECRET="${FERNWELL_MCP_TOKEN_SECRET:-fernwell-mcp-token}"
ZILBERMAN_MCP_TOKEN_SECRET="${ZILBERMAN_MCP_TOKEN_SECRET:-zilberman-mcp-token}"

APPLY="${APPLY:-}"

command -v gcloud >/dev/null || die "gcloud is not on PATH."
command -v node >/dev/null || die "node is not on PATH; it parses the describe output."
[[ "$TASK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "TASK_TIMEOUT_SECONDS must be whole seconds, got: $TASK_TIMEOUT_SECONDS"

# NAME=VALUE, one per line. This list is the single source for both the declared table and the
# gcloud flag, so the thing checked and the thing applied cannot drift apart.
ENV_PAIRS="WORKSPACE_STORE=gcs
GCS_BUCKET=$GCS_BUCKET
CONTINUATION_TICK_BUDGET_MS=$CONTINUATION_TICK_BUDGET_MS
TASK_TIMEOUT_MS=$TASK_TIMEOUT_MS
PLATFORM_MCP_ENDPOINT=$PLATFORM_MCP_ENDPOINT
DR_LURIE_MCP_ENDPOINT=$DR_LURIE_MCP_ENDPOINT
FERNWELL_MCP_ENDPOINT=$FERNWELL_MCP_ENDPOINT
ZILBERMAN_MCP_ENDPOINT=$ZILBERMAN_MCP_ENDPOINT"

SECRET_PAIRS="OPENAI_API_KEY=$OPENAI_API_KEY_SECRET:latest
PLATFORM_MCP_TOKEN=$PLATFORM_MCP_TOKEN_SECRET:latest
DR_LURIE_MCP_TOKEN=$DR_LURIE_MCP_TOKEN_SECRET:latest
FERNWELL_MCP_TOKEN=$FERNWELL_MCP_TOKEN_SECRET:latest
ZILBERMAN_MCP_TOKEN=$ZILBERMAN_MCP_TOKEN_SECRET:latest"

# bash 3.2 on macOS: no mapfile, no associative arrays, no ${var,,}.
join_pipe() {
  local out="" line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ -z "$out" ]]; then out="$line"; else out="$out|$line"; fi
  done
  printf '%s' "$out"
}
ENV_VARS="^|^$(printf '%s\n' "$ENV_PAIRS" | join_pipe)"
SECRET_BINDING="$(printf '%s\n' "$SECRET_PAIRS" | join_pipe)"

ARGS="--import,tsx,$ENTRYPOINT"
# Cloud Run reports cpu "1" as "1000m"; declare it the way the API answers so the diff is real.
case "$CPU" in *m) CPU_NORMALISED="$CPU" ;; *) CPU_NORMALISED="$((CPU * 1000))m" ;; esac

declared_lines() {
  printf 'serviceAccount\t%s\n' "$RUNTIME_SA"
  [[ -n "$IMAGE" ]] && printf 'image\t%s\n' "$IMAGE"
  printf 'cpu\t%s\n' "$CPU_NORMALISED"
  printf 'memory\t%s\n' "$MEMORY"
  printf 'taskTimeoutSeconds\t%s\n' "$TASK_TIMEOUT_SECONDS"
  printf 'maxRetries\t%s\n' "$MAX_RETRIES"
  printf 'taskCount\t%s\n' "$TASK_COUNT"
  printf 'executionEnvironment\t%s\n' "$EXECUTION_ENVIRONMENT"
  printf 'command\tnode\n'
  printf 'args\t%s\n' "$ARGS"
  printf '%s\n' "$ENV_PAIRS" | while IFS= read -r pair; do
    [[ -n "$pair" ]] && printf 'env.%s\t%s\n' "${pair%%=*}" "${pair#*=}"
  done
  printf '%s\n' "$SECRET_PAIRS" | while IFS= read -r pair; do
    [[ -n "$pair" ]] && printf 'secret.%s\t%s\n' "${pair%%=*}" "${pair#*=}"
  done
}

# Reads the describe JSON on stdin and prints the same key<TAB>value shape. Secret bindings come out
# as name:version -- the value is not in the describe output and is never fetched.
LIVE_READER='
let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
  const job = JSON.parse(raw);
  const exec = job.spec.template.spec;
  const task = exec.template.spec;
  const c = (task.containers || [])[0] || {};
  const out = [];
  const add = (k, v) => { if (v !== undefined && v !== null) out.push(k + "\t" + v); };
  add("serviceAccount", task.serviceAccountName);
  add("image", c.image);
  add("cpu", ((c.resources || {}).limits || {}).cpu);
  add("memory", ((c.resources || {}).limits || {}).memory);
  add("taskTimeoutSeconds", task.timeoutSeconds);
  add("maxRetries", task.maxRetries);
  add("taskCount", exec.taskCount);
  add("executionEnvironment", ((job.spec.template.metadata || {}).annotations || {})["run.googleapis.com/execution-environment"]);
  add("command", (c.command || []).join(" "));
  add("args", (c.args || []).join(","));
  for (const e of c.env || []) {
    const ref = (e.valueFrom || {}).secretKeyRef;
    if (ref) add("secret." + e.name, ref.name + ":" + ref.key);
    else add("env." + e.name, e.value === undefined ? "" : e.value);
  }
  process.stdout.write(out.join("\n") + "\n");
});'

LIVE_JSON="$(gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" --format=json 2>/dev/null || true)"

if [[ -z "$LIVE_JSON" ]]; then
  if [[ "$APPLY" != "1" ]]; then
    say "Job $JOB does not exist in $PROJECT/$REGION."
    say "Nothing to diff. Re-run with IMAGE=<digest> APPLY=1 to create it from the shape declared in this script."
    exit 1
  fi
  : "${IMAGE:?set IMAGE to the immutable deployed CMS-Agent image before creating the job}"
  say "Creating $JOB."
  gcloud run jobs create "$JOB" \
    --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
    --service-account "$RUNTIME_SA" --cpu "$CPU" --memory "$MEMORY" \
    --max-retries "$MAX_RETRIES" --task-timeout "$TASK_TIMEOUT_SECONDS" --tasks "$TASK_COUNT" \
    --execution-environment "$EXECUTION_ENVIRONMENT" \
    --command node --args="$ARGS" \
    --set-env-vars "$ENV_VARS" --set-secrets "$SECRET_BINDING"
  say ""
  say "Created $JOB without starting it. Grant roles/run.invoker on the job to the scheduler account,"
  say "then configure the schedule with scripts/deploy-continuation-tick-schedule.sh."
  exit 0
fi

DECLARED_FILE="$(mktemp)"; LIVE_FILE="$(mktemp)"
trap 'rm -f "$DECLARED_FILE" "$LIVE_FILE"' EXIT
declared_lines | sort > "$DECLARED_FILE"
printf '%s' "$LIVE_JSON" | node -e "$LIVE_READER" | sort > "$LIVE_FILE"

DIFFERENCES=0
say "Declared shape vs live $JOB (project $PROJECT, region $REGION)"
say ""
printf '%-3s %-30s %-46s %s\n' "" "FIELD" "DECLARED" "LIVE"
while IFS=$'\t' read -r key want; do
  [[ -n "$key" ]] || continue
  if ! awk -F'\t' -v k="$key" '$1==k {found=1} END {exit !found}' "$LIVE_FILE"; then
    printf '%-3s %-30s %-46s %s\n' "✗" "$key" "$want" "(absent)"
    DIFFERENCES=$((DIFFERENCES + 1))
    continue
  fi
  got="$(awk -F'\t' -v k="$key" '$1==k {print $2}' "$LIVE_FILE")"
  if [[ "$got" != "$want" ]]; then
    printf '%-3s %-30s %-46s %s\n' "✗" "$key" "$want" "$got"
    DIFFERENCES=$((DIFFERENCES + 1))
  else
    printf '%-3s %-30s %-46s %s\n' "=" "$key" "$want" "$got"
  fi
done < "$DECLARED_FILE"

# A field the live job has and this script does not declare is drift too, and the more dangerous
# direction: a merge-style update leaves it in place, so it survives every deploy while appearing
# nowhere in the repository. The image is exempt only when IMAGE is unset, because pin-job-images.sh
# owns it on purpose.
while IFS=$'\t' read -r key got; do
  [[ -n "$key" ]] || continue
  [[ "$key" == "image" && -z "$IMAGE" ]] && { printf '%-3s %-30s %-46s %s\n' "·" "image" "(pin-job-images.sh owns it)" "$got"; continue; }
  if ! awk -F'\t' -v k="$key" '$1==k {found=1} END {exit !found}' "$DECLARED_FILE"; then
    printf '%-3s %-30s %-46s %s\n' "✗" "$key" "(not declared)" "$got"
    DIFFERENCES=$((DIFFERENCES + 1))
  fi
done < "$LIVE_FILE"

say ""
if [[ "$APPLY" != "1" ]]; then
  if [[ "$DIFFERENCES" -eq 0 ]]; then
    say "✓ $JOB matches the declared shape. Nothing was written."
    exit 0
  fi
  say "✗ $DIFFERENCES field(s) differ. Nothing was written."
  say ""
  say "Decide which side is right before doing anything. If the SCRIPT is wrong, fix the script and"
  say "docs/platform/continuation-tick.live-shape.md -- do not reshape a plane that dispatches live"
  say "content every two minutes to match a file. If the JOB is wrong, re-run with APPLY=1, between"
  say "ticks, after checking driverHealth."
  exit 1
fi

if [[ "$DIFFERENCES" -eq 0 ]]; then
  say "✓ $JOB already matches the declared shape. Nothing to apply."
  exit 0
fi

say "APPLY=1: updating $JOB with merge-style changes. This lands fleet-wide within two minutes."
IMAGE_FLAG=()
[[ -n "$IMAGE" ]] && IMAGE_FLAG=(--image "$IMAGE")
gcloud run jobs update "$JOB" \
  --project "$PROJECT" --region "$REGION" "${IMAGE_FLAG[@]+"${IMAGE_FLAG[@]}"}" \
  --service-account "$RUNTIME_SA" --cpu "$CPU" --memory "$MEMORY" \
  --max-retries "$MAX_RETRIES" --task-timeout "$TASK_TIMEOUT_SECONDS" --tasks "$TASK_COUNT" \
  --execution-environment "$EXECUTION_ENVIRONMENT" \
  --command node --args="$ARGS" \
  --update-env-vars "$ENV_VARS" --update-secrets "$SECRET_BINDING"

say ""
say "Updated $JOB. It was not started by this script; the schedule fires it on its own cadence."
say "Re-run without APPLY=1 to confirm the job now matches the declared shape."
