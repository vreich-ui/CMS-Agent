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
| `EXECUTION_MODE` (`mock`\|`openai`, default `mock`) | `--mode` | `openai` = live model execution (requires `OPENAI_API_KEY`) |
| `RUN_INPUT_JSON` / `RUN_INPUT_FILE` | `--input` / `--input-file` | Initial workflow input (JSON) |
| `RESUME_RUN_ID` | `--run` | Resume an existing run; with approval, re-queues the blocked node via the sanctioned retry path |
| `RUN_APPROVED=true` | `--approved` | Lets publish-risk nodes execute (downstream publish gates still apply) |
| `MAX_STEPS` (default 100) | `--max-steps` | Advance bound, mirrors `workflow.run_all` |
| `WORKSPACE_STORE=blobs` | — | Use the production Netlify Blobs store |
| `NETLIFY_BLOBS_SITE_ID` / `NETLIFY_BLOBS_TOKEN` | — | Required with `blobs` outside Netlify (see below) |
| `NETLIFY_BLOBS_STORE_NAME` (default `cms-agent`) | — | Store name |
| `OPENAI_API_KEY`, `OPENAI_AGENT_MODEL` | — | Model execution (openai mode) |

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

## Known limits (accepted for Phase 1, resolved in Phase 2)

- Cross-cloud storage: the job talks to Netlify Blobs over HTTPS — fine for batch;
  Phase 2 moves state to Firestore/GCS and removes the dependency.
- The Blobs lost-update race (`data-model-gaps.md` §6) still exists; the executor's
  per-run CAS retry is the mitigation, and concurrent executions of the *same run*
  from Netlify and the job should be avoided. Fixed properly by Phase 2 storage.
- `--approved` executes publish-risk nodes but real publication remains gated by
  `workflow.publish_run` + per-project readiness — unchanged.
