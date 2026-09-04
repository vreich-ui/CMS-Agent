# Continuation tick — Cloud Run Job + Cloud Scheduler

The tick re-enters runs whose driver is parked, so a conductor run finishes from ONE external
`workflow_run_all` call instead of needing a human to poke it between nodes. Evidence it exists:
`run_1786557897658_elj34j` (2026-08-12) spent 12.8 min wall on ~7.3 min of model work, with a 192 s
idle gap before `reader_simulation` and 64 s before `artifact_plan`.

## Why it is here and not on Netlify

It shipped first as a Netlify scheduled function. That was wrong, and the way it was wrong is worth
keeping: it deployed cleanly, the schedule registered, it fired every 60 s with a healthy log line,
and it drove **nothing** for hours.

    workflow.continuation_tick {"enabled":true,"scanned":21,"driven":[],"timedOut":false,
      "refusals":[{"runId":"run_1784213511374_gl5o0h","code":"skip_not_active"}, ...]}

All 21 runs it scanned were from mid-July. Phase 1 of `DIRECTION.md` moved the execution plane to
Cloud Run + GCS, and the Netlify Blobs store has not received a conductor run since. An API-mode read
of that store confirmed it held exactly those 21 records — the tick was reading correctly; the runs
simply were not there. A scheduled function on the control plane cannot drive an execution plane it
cannot see.

Two earlier fixes on the Netlify path were real bugs, both fixed before the plane error surfaced, and
both worth remembering because neither was visible from a green deploy:

1. A v1 scheduled invocation carries no Blobs context, so `connectLambdaBlobs(event)` no-opped and the
   first repository read threw `MissingBlobsEnvironmentError` — silently, 36 times.
2. `export const config = { schedule: CONTINUATION_TICK_CRON }` used an imported identifier the build
   could not resolve, and the function deployed **unscheduled** (`function_schedules: []`).

## Shape

- `src/agent/workspace/runContinuation.ts` — the selector and tick loop. Pure, unit-tested, plane-
  agnostic. Unchanged by the move.
- `src/agent/entrypoints/runContinuationTickJob.ts` — job logic. Calls `bootstrapWorkspaceStore()`
  from the conductor job so a tick and a conductor execution can never bind to different stores.
- `src/agent/entrypoints/runContinuationTickMain.ts` — process wrapper: SIGTERM finishes the in-flight
  node and persists; the next tick picks up the rest.

The tick drives runs through the same `runNextNode` an external `workflow_run_all` uses, and never
passes `approved`. Every budget, approval and publish gate applies unchanged. It replaces the external
poller; it bypasses no stop.

## Deploy

    PROJECT=cms-agent-503015
    REGION=us-central1
    REPO=cms-agent
    BUCKET=cms-agent-503015-cms-agent-state
    RUNTIME_SA=cms-agent-run@cms-agent-503015.iam.gserviceaccount.com
    IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/continuation-tick:$(git rev-parse --short HEAD)"

    # 1. Build. Same Dockerfile as the conductor job; only the entrypoint differs, overridden below.
    gcloud builds submit --project "$PROJECT" --tag "$IMAGE" .

    # 2. Create the job. --set-* is correct HERE because this CREATES the job; never copy these flags
    #    into a later `jobs update` (see PHASE4_RUNBOOK — --set-env-vars ate six variables twice).
    gcloud run jobs create continuation-tick \
      --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
      --service-account "$RUNTIME_SA" \
      --cpu 1 --memory 1Gi --max-retries 0 --task-timeout 300 \
      --command node \
      --args="--import,tsx,src/agent/entrypoints/runContinuationTickMain.ts" \
      --set-env-vars "WORKSPACE_STORE=gcs,GCS_BUCKET=$BUCKET,CONTINUATION_TICK_BUDGET_MS=240000" \
      --set-secrets "OPENAI_API_KEY=openai-api-key:latest"

    # 3. Dry check before scheduling anything: one manual execution, read the summary line.
    gcloud run jobs execute continuation-tick --project "$PROJECT" --region "$REGION" --wait

    # 4. Cloud Scheduler MUST be able to invoke the job. Without this the trigger returns
    #    status.code 7 (PERMISSION_DENIED) and never creates an execution — the runtime SA carries
    #    only roles/secretmanager.secretAccessor at project level. Job-scoped, least privilege.
    gcloud run jobs add-iam-policy-binding continuation-tick \
      --project "$PROJECT" --region "$REGION" \
      --member "serviceAccount:$RUNTIME_SA" --role roles/run.invoker

    # 5. Schedule it. EVERY TWO MINUTES, not every minute: the first execution measured
    #    "Started deployed execution in 2m16.3s" — a Cloud Run Job cold-starts this image slower
    #    than a 60 s cadence, so a 1-minute schedule guarantees permanent overlap. Overlap is SAFE
    #    (the dispatch claim makes the selector refuse an in-flight run) but it is pure waste.
    #    Cloud Scheduler cannot express 30 s either way.
    gcloud scheduler jobs create http continuation-tick-schedule \
      --project "$PROJECT" --location "$REGION" --schedule "*/2 * * * *" \
      --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT/jobs/continuation-tick:run" \
      --http-method POST \
      --oauth-service-account-email "$RUNTIME_SA"

`--task-timeout 300` with `CONTINUATION_TICK_BUDGET_MS=240000` keeps a tick inside its own task
window: the budget is checked BETWEEN advances and never cuts a dispatch short, so the timeout is
headroom, not a guillotine. A node's own timeout (120 s default) fits comfortably inside it.

**It did not fit for `article_body` (2026-09-04).** With a 240 s budget inside a 300 s task, a node
dispatched at 239 s with a 300 s timeout outlives the task: the platform killed the task mid-node,
the dispatch claim expired 90 s later, and the node was re-dispatched 12.7 minutes and ~$0.60 after
the first attempt. Two things changed:

- **`TASK_TIMEOUT_MS` (env, on the job).** W0 T1.2's deadline-aware dispatch reads it and refuses to
  START a node whose own timeout plus a 15 s margin does not fit in the task's REMAINING time; the
  tick returns `deferredDeadline` and the next tick starts that node with a full task ahead of it.
  Set it to the same number of milliseconds as `--task-timeout`, or the check defends the wrong
  ceiling. Default 300000 (the pre-C2.2 value) when unset.
- **A node whose timeout cannot fit a WHOLE task is dispatched anyway**, deliberately: deferring it
  would refuse it on every future tick too. The fix for such a node is a larger `--task-timeout`
  (C2.2 raises it to 600 s), not a deferral loop.

## What the tick leaves behind (W0 T0.2/T0.3)

- `ticks/<tickId>.json` — one ledger document per execution: what was scanned, what actually advanced
  (steps > 0), and every refusal with its reason. Retained 48 h, pruned by the tick that notices.
- `run.driverHealth` on every continuable run — `lastSeenByTickAt`, the last refusal, and a
  consecutive-silence counter. Surfaced in `workflow.list_runs` / `workflow.get_run` under `stall`.
- `driverHealth/<projectId>.json` — the last background dispatch per tenant (tick or conductor job),
  surfaced by `project.get` / `project.list`. "Is anything driving dr-lurie at all" is one read.

**The job now exits 1** when a run it selected for re-entry has advanced zero steps for three
consecutive ticks (`driver_silent_since:<ts>` lands on the run, and the tick logs
`workflow.continuation_tick_driver_silent` at ERROR severity). "Nothing needed advancing" still
exits 0 — that is the healthy steady state. Before this, both looked identical to Scheduler, which
is why a 44-minute hole on 2026-09-04 produced 22 consecutive green executions.

## Kill switch

`RUN_CONTINUATION_TICK=off|false|0` on the job. The job stays deployed and logs
`enabled:false` — it never silently disappears.

    gcloud run jobs update continuation-tick --project "$PROJECT" --region "$REGION" \
      --update-env-vars RUN_CONTINUATION_TICK=off

## Verify it is actually working

A green execution is NOT evidence — that is the whole lesson above. Check the summary line:

    gcloud logging read \
      'resource.type="cloud_run_job" resource.labels.job_name="continuation-tick"' \
      --project "$PROJECT" --limit 5 --format 'value(textPayload)'

`scanned` must be greater than zero and must include a run id you recognise from
`workflow.list_runs`. If `scanned` is non-zero but every id is unfamiliar, the tick is bound to the
wrong store — which is exactly what happened on Netlify.

The behavioural check: leave a run parked mid-pipeline and confirm it reaches a terminal status
within one tick interval with no external call.
