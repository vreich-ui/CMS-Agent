# Phase 1 runbook — Publishing Conductor on Cloud Run

Deploys the execution plane from `docs/platform/DIRECTION.md` Phase 1: the existing
Publishing Conductor runs as a **Cloud Run Job**, escaping Netlify's ~15-minute
background-function ceiling. Netlify keeps serving the UI, control MCP, and storage;
this job reads and writes the **same Netlify Blobs store**, so runs started here are
visible to the existing MCP tools and UI unchanged.

## What ships in the repo

| Piece | Path | Purpose |
|---|---|---|
| Job logic | `src/agent/entrypoints/runConductorJob.ts` | Drives one run to a terminal state with the exact `workflow.run_all` loop; env/flag config; JSON summary; exit codes |
| Process wrapper | `src/agent/entrypoints/runConductorJobMain.ts` | SIGTERM-aware CLI shell (Cloud Run sends SIGTERM before killing a task; the loop finishes the in-flight node and persists, leaving the run resumable) |
| Container image | `Dockerfile` + `.dockerignore` | node:22-slim, prod deps only, runs TS directly via tsx |
| Blobs off-Netlify | `src/agent/repository/blobs/blobClient.ts` | `NETLIFY_BLOBS_SITE_ID` + `NETLIFY_BLOBS_TOKEN` switch the client to API mode against the same store |
| Local runner | `npm run job:conductor -- <flags>` | Same entrypoint without a container |

Semantics preserved from the executor (nothing new): one dependency-ready node per
step; **publish-risk nodes block without `--approved`** (a `blocked` finish is the
*designed* outcome of an unattended full run and exits 0); `workflow.publish_run`'s
gates (per-project env flag, readiness policy) are untouched. Runs are stamped
`dryRun: true` by the existing `startDryRun` path even in `openai` mode — that flag
means "no publishing side effects", not "no real model calls".

## Configuration

| Env var (job) | Flag override | Meaning |
|---|---|---|
| `PROJECT_ID` (default `dr-lurie`) | `--project` | Project the run is scoped to |
| `EXECUTION_MODE` (`mock`\|`openai`, **default `openai`**) | `--mode` | `openai` = live model execution (requires `OPENAI_API_KEY`; the job refuses to mint a run without it). `mock` is the explicit opt-in for cheap CI/smoke runs and emits deterministic placeholder output from each node's schema — structurally valid, content-free, never publishable. |
| `RUN_INPUT_JSON` / `RUN_INPUT_FILE` | `--input` / `--input-file` | Initial workflow input (JSON) |
| `RESUME_RUN_ID` | `--run` | Resume an existing run; with approval, re-queues the blocked node via the sanctioned retry path |
| `RUN_APPROVED=true` | `--approved` | Lets publish-risk nodes execute (downstream publish gates still apply) |
| `MAX_STEPS` (default 100) | `--max-steps` | Advance bound, mirrors `workflow.run_all` |
| `WORKSPACE_NODES_SOURCE` (`store`\|`static`, **default `store`**) | — | Where node definitions come from. See "Node definitions and the required re-seed" below — this one has a deploy step attached. |
| `WORKSPACE_STORE=blobs` | — | Use the production Netlify Blobs store |
| `NETLIFY_BLOBS_SITE_ID` / `NETLIFY_BLOBS_TOKEN` | — | Required with `blobs` outside Netlify (see below) |
| `NETLIFY_BLOBS_STORE_NAME` (default `cms-agent`) | — | Store name |
| `OPENAI_API_KEY`, `OPENAI_AGENT_MODEL` | — | Model execution (openai mode) |

## Node definitions and the required re-seed

`WORKSPACE_NODES_SOURCE` decides which node definitions a conductor run executes, and the
split has a deploy step attached that is easy to miss.

**`store` (the default).** `resolveConductorNodes` overlays each canonical node with its
stored counterpart, so authoring edits made over MCP — **prompt, input/output schemas,
allowedTools, assignedSkills, modelConfig, executionConfig** — are in the next run with no
deploy. This is the default because the alternative was worse in a specific way: with
`static`, an operator could edit a node over MCP, start a run, and watch the *old*
definition execute, with nothing anywhere saying so.

**`static`.** Pins the deployment to the compiled `nodes.ts`. Only the exact word `static`
selects it; anything else resolves to `store`, so a typo cannot silently pin a deployment to
stale definitions.

**What store mode CANNOT carry — the re-seed step.** `overlayStoreNode` deliberately pins
the fields that define the conductor (`dependsOn`, `produces`, `riskLevel`, `position`,
`status`) to the canonical definition, and `resolveConductorNodes` maps over the canonical
list so a store node with **no** canonical counterpart is ignored entirely. That pinning is
what stops a promoted prompt from quietly rewiring a publish gate, and it is worth keeping.
It also means these changes reach a run **only** through a deliberate re-seed:

| Changed in the workspace | Reaches a run how |
|---|---|
| Prompt, schemas, allowedTools, assignedSkills, model/execution config | Store overlay — next run, no deploy |
| Graph edges (`dependsOn`, `produces`) | **Re-seed + redeploy** |
| `riskLevel`, node `status`, grid `position` | **Re-seed + redeploy** |
| A node that exists live but not in `nodes.ts` | **Re-seed + redeploy** |

**Required step when topology changed:**

```bash
npm run nodes:check     # exit 1 if nodes.ts has drifted from the live workspace
npm run nodes:update    # regenerate nodes.ts (+ seededSkills.ts) from the live store
# review the diff, commit, then build and deploy the new image
```

`scripts/seedNodesFromWorkspace.ts` refuses rather than writes when a re-seed would weaken
the conductor: a canonical node disappearing, a `riskLevel` stepping down, a publish-risk
node newly acquiring `project.call_tool`, a graph that fails `validateWorkspaceGraph`, or a
node missing a field the runtime spreads. A re-seed may add a gate; it may not remove one.

Which source a given run actually used is reported on that run — `workflow.get_run` returns
a `mode` block naming both the execution mode and the node source, so this is never
something anyone has to infer after the fact.

`NETLIFY_BLOBS_TOKEN` is a Netlify personal access token with access to the site;
`NETLIFY_BLOBS_SITE_ID` is the site's API ID (Site configuration → Site details).
Both belong in Secret Manager, never in plain env or the image.

## Local smoke (no GCP needed)

```bash
npm run job:conductor -- --mode mock --input '{"instructions":"Smoke run"}'
# expected: 17 nodes complete, publication_controller blocks awaiting approval, exit 0
```

## Deploy

Prereqs: `gcloud` authenticated to the target project; Artifact Registry repo
(`REPO`), region co-located with your Vertex models (example uses `us-central1`).

```bash
PROJECT=<gcp-project> REGION=us-central1 REPO=cms-agent
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/conductor-job:$(git rev-parse --short HEAD)"

# 1. Build the image with Cloud Build (uses .dockerignore; no local Docker needed)
gcloud builds submit --project "$PROJECT" --tag "$IMAGE" .

# 2. Secrets (once)
printf '%s' "<openai-key>"        | gcloud secrets create openai-api-key      --project "$PROJECT" --data-file=-
printf '%s' "<netlify-pat>"       | gcloud secrets create netlify-blobs-token --project "$PROJECT" --data-file=-

# 3. Create the job (dedicated least-privilege service account recommended)
#    --set-env-vars / --set-secrets are correct HERE because this CREATES the job — there is nothing to
#    preserve. Do not copy these flags into a later `jobs update`: --set-* replaces the whole
#    environment, which is how the MCP service lost six variables twice (see PHASE4_RUNBOOK).
gcloud run jobs create conductor-run \
  --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --cpu 1 --memory 1Gi --max-retries 0 --task-timeout 3600 \
  --set-env-vars "WORKSPACE_STORE=blobs,NETLIFY_BLOBS_SITE_ID=<site-api-id>,EXECUTION_MODE=openai,PROJECT_ID=dr-lurie" \
  --set-secrets "OPENAI_API_KEY=openai-api-key:latest,NETLIFY_BLOBS_TOKEN=netlify-blobs-token:latest"

# 4. Execute (per run; flags after -- reach the entrypoint)
gcloud run jobs execute conductor-run --project "$PROJECT" --region "$REGION" --wait \
  --args="--input","{\"instructions\":\"Write the article about X\"}"

# Resume a blocked run with approval (publish gates still apply downstream):
gcloud run jobs execute conductor-run --project "$PROJECT" --region "$REGION" --wait \
  --args="--run","run_<id>","--approved"
```

Update after a new image build: `gcloud run jobs update conductor-run --image "$IMAGE" …`.
Scheduled runs: `gcloud scheduler jobs create http` targeting the job's `:run` URL with
an OAuth service-account token (see Cloud Run Jobs docs), or trigger manually as above.

The final log line of each execution is a single-line JSON summary (runId, outcome,
per-node statuses, cost estimate, next-step recommendation) — query it in Cloud
Logging with `jsonPayload.runId` once ingested, or `resource.type="cloud_run_job"`.

## Acceptance checks (Phase 1 definition of done)

1. Local mock smoke passes (above).
2. A live (`openai`) execution completes on Cloud Run with total wall-clock > 15 min
   (or would have — the point is the ceiling is gone; `--task-timeout` up to 7 days).
3. The run appears in the existing surfaces: `workflow.list_runs` / `workflow.get_run`
   via the Netlify MCP, usage in `usage.get_summary`, and the Constellation UI —
   because the job wrote the same Blobs store.
4. Exit codes observed: `completed`/`blocked`/`stopped` → 0; `failed`/`step_limit` → 1.

## Rollback

Delete the Cloud Run job and (optionally) the image and secrets. Nothing on Netlify
changed; no data migration happened (same store). A run interrupted mid-flight is
resumable (`--run <runId>`) or resettable via the existing `workflow.reset_run` tool.

## Other jobs on the same pattern: `job:monetizer-ingest` (§2.19)

`src/agent/entrypoints/monetizerIngestJob.ts` (+ `monetizerIngestJobMain.ts`) is a second,
independent Cloud Run Job entrypoint built on the exact same shape as `conductor-run`
above — same image, same env/flag convention, same JSON-summary-plus-exit-code contract.
It calls `feedback.ingest_monetizer` (`ingestMonetizerAnalytics`), which the run graph
itself never calls — before this job existed nothing ever triggered it outside a manual
MCP call, so the feedback store held zero outcome records, ever.

It is safe to deploy and schedule BEFORE `MONETIZER_MCP_ENDPOINT` / `MONETIZER_MCP_TOKEN`
are set (that is Wolf's operator task, not this job's concern): with either unset the job
exits 0 having done nothing, with `status: "skipped_unconfigured"` and a named reason in
its JSON summary — never a crash, so a schedule created ahead of the secrets does not
spam failure alerts.

```bash
# Local smoke — reports the connection state; ingests nothing (no live endpoint here):
npm run job:monetizer-ingest -- --dry-run

# 1-3. Build image, create secrets, create the job — same steps as conductor-run above,
#      pointed at the same image (both entrypoints ship in one Dockerfile) with its own
#      Cloud Run Job resource:
#   gcloud run jobs create monetizer-ingest-run \
#     --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
#     --cpu 1 --memory 512Mi --max-retries 0 --task-timeout 300 \
#     --set-env-vars "WORKSPACE_STORE=blobs,NETLIFY_BLOBS_SITE_ID=<site-api-id>" \
#     --set-secrets "NETLIFY_BLOBS_TOKEN=netlify-blobs-token:latest,MONETIZER_MCP_ENDPOINT=monetizer-mcp-endpoint:latest,MONETIZER_MCP_TOKEN=monetizer-mcp-token:latest" \
#     --command "npm" --args "run,job:monetizer-ingest,--"
#
# 4. Execute on demand:
#   gcloud run jobs execute monetizer-ingest-run --project "$PROJECT" --region "$REGION" --wait
#
# Scheduled (e.g. hourly) — same mechanism as conductor-run's "Scheduled runs" line above:
#   gcloud scheduler jobs create http monetizer-ingest-hourly \
#     --schedule="0 * * * *" \
#     --uri="https://<region>-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/<project>/jobs/monetizer-ingest-run:run" \
#     --http-method=POST \
#     --oauth-service-account-email="<job-runtime-sa>"
```

This block is documentation only — nothing above runs as part of any build or deploy;
no live deploy behavior changes until an operator runs these commands by hand.

## …and `job:tracking-ingest` (T21.7)

`src/agent/entrypoints/trackingIngestJob.ts` (+ `trackingIngestJobMain.ts`) is the same
pattern again for the SECOND outer loop: it calls `feedback.ingest_tracking`
(`ingestTrackingRollups`), which reads the tracking sink's per-producer engagement
rollups (`GET /rollups?by=producer`) and records each row as a feedback OUTCOME with
source `tracking:engagement.v1`. Meant to run DAILY — with no `--from`/`--to` it pulls
the previous whole UTC day, which is the window a once-a-day schedule should ask for.

It is safe to deploy and schedule BEFORE `TRACKING_SINK_URL` / `TRACKING_SINK_TOKEN` /
`TRACKING_PROJECT_ID` are set (site genesis provisions the sink pair per tenant): with any
of them unset the job exits 0 having done nothing, with `status: "skipped_unconfigured"`
and a named reason in its JSON summary.

```bash
# Local smoke — reports the connection state and the resolved window; ingests nothing:
npm run job:tracking-ingest -- --dry-run

# Same three build/secret/create steps as above, with its own Cloud Run Job resource:
#   gcloud run jobs create tracking-ingest-run \
#     --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
#     --cpu 1 --memory 512Mi --max-retries 0 --task-timeout 300 \
#     --set-env-vars "WORKSPACE_STORE=blobs,NETLIFY_BLOBS_SITE_ID=<site-api-id>,TRACKING_PROJECT_ID=<trk_...>" \
#     --set-secrets "NETLIFY_BLOBS_TOKEN=netlify-blobs-token:latest,TRACKING_SINK_URL=tracking-sink-url:latest,TRACKING_SINK_TOKEN=tracking-sink-token:latest" \
#     --command "npm" --args "run,job:tracking-ingest,--"
#
# Scheduled DAILY (the rollups are day-grained):
#   gcloud scheduler jobs create http tracking-ingest-daily \
#     --schedule="30 3 * * *" \
#     --uri="https://<region>-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/<project>/jobs/tracking-ingest-run:run" \
#     --http-method=POST \
#     --oauth-service-account-email="<job-runtime-sa>"
```

Documentation only, same as the block above.

## Known limits (accepted for Phase 1, resolved in Phase 2)

- Cross-cloud storage: the job talks to Netlify Blobs over HTTPS — fine for batch;
  Phase 2 moves state to Firestore/GCS and removes the dependency.
- The Blobs lost-update race (`data-model-gaps.md` §6) still exists; the executor's
  per-run CAS retry is the mitigation, and concurrent executions of the *same run*
  from Netlify and the job should be avoided. Fixed properly by Phase 2 storage.
- `--approved` executes publish-risk nodes but real publication remains gated by
  `workflow.publish_run` + per-project readiness — unchanged.
