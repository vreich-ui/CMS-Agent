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

    # 4. Schedule it. Cloud Scheduler's floor is 1 minute, which is the 60 s end of the 30–60 s the
    #    plan asked for; 30 s is not expressible on this platform either.
    gcloud scheduler jobs create http continuation-tick-every-minute \
      --project "$PROJECT" --location "$REGION" --schedule "* * * * *" \
      --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT/jobs/continuation-tick:run" \
      --http-method POST \
      --oauth-service-account-email "$RUNTIME_SA"

`--task-timeout 300` with `CONTINUATION_TICK_BUDGET_MS=240000` keeps a tick inside its own task
window: the budget is checked BETWEEN advances and never cuts a dispatch short, so the timeout is
headroom, not a guillotine. A node's own timeout (120 s default) fits comfortably inside it.

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
