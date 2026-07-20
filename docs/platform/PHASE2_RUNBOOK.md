# Phase 2 runbook — state on Google Cloud Storage

Executes Phase 2 of `docs/platform/DIRECTION.md`: workspace/run/usage/change/skill/project
state moves from Netlify Blobs to a **GCS bucket**, closing the documented lost-update
race (`docs/constellation/data-model-gaps.md` §6) with hard compare-and-swap and removing
the Cloud Run job's cross-cloud storage dependency.

## Design decision: GCS, not Firestore (recorded)

DIRECTION.md originally sketched "Firestore (documents needing transactions) + GCS
(artifacts)". Implementation review showed **nothing needs multi-document transactions**:
the entire persistence model is JSON-documents-at-keys with single-key optimistic
concurrency (workspace document version + revision chain; run `rev` counter; append-only
change/usage records at unique keys). GCS object **generation preconditions**
(`ifGenerationMatch`) cover that model completely, and implementing GCS as a drop-in
`BlobStoreClient` transport meant **reusing every existing blob repository class and its
tests unchanged** — a fraction of the risk of re-modeling eight repositories on Firestore.
Firestore remains the upgrade path if server-side query patterns ever demand it (e.g.
filtered run listing at scale).

## What ships in the repo

| Piece | Path | Purpose |
|---|---|---|
| GCS transport | `src/agent/repository/gcs/gcsStoreClient.ts` | `BlobStoreClient` over `@google-cloud/storage`: strong consistency, generation-based ETags, `onlyIfMatch`/`onlyIfNew` → `ifGenerationMatch` preconditions; `GCS_KEY_PREFIX` namespacing seam (per-project scoping later) |
| Backend routing | `RepositoryManager` (`WORKSPACE_STORE=gcs`) + `registerCmsAgentStoreFactory` in `blobClient.ts` | The gcs backend reuses the blob repository classes; entrypoints register the GCS transport so `@google-cloud/storage` never enters Netlify function bundles |
| Workspace CAS | `src/agent/repository/blobs/BlobWorkspaceRepository.ts` | The workspace document save is now conditional on the last-accepted ETag: concurrent writers get `workspace_version_conflict` instead of silently losing writes. Create-only seeding settles first-write races. (Also active on Netlify Blobs wherever ETags are available.) |
| Migration tool | `src/agent/entrypoints/migrateStoreJob.ts` (`npm run job:migrate-store`) | Copy Netlify Blobs → GCS (`--dry-run` to count, default migrate, `--verify` byte-for-byte check), idempotent |
| Honest health | `repository.get_health` | Reports `backend: "gcs"` end-to-end when active |

## GCP setup (once)

```bash
PROJECT=<gcp-project> REGION=us-central1 BUCKET=<project>-cms-agent-state

# Bucket co-located with the Cloud Run job + Vertex models; versioning = point-in-time safety net
gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" \
  --uniform-bucket-level-access
gcloud storage buckets update "gs://$BUCKET" --versioning

# Grant the job's service account object admin on this bucket only
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:<job-sa>@$PROJECT.iam.gserviceaccount.com" --role roles/storage.objectAdmin
```

Auth is Application Default Credentials: on Cloud Run the job's service account, locally
`gcloud auth application-default login`. No key material enters the repo or the image.

## Cutover procedure (freeze → migrate → verify → flip)

The window only needs to cover active writes — for a single-operator system, minutes.

1. **Freeze writes**: don't start runs (Netlify or Cloud Run) and pause UI mutations for
   the duration. (There is no hard freeze switch; discipline suffices at this scale.)
2. **Dry-run count** (from any machine with the four env vars below):
   ```bash
   export NETLIFY_BLOBS_SITE_ID=<site-api-id> NETLIFY_BLOBS_TOKEN=<pat>
   export GCS_BUCKET=<bucket>            # plus ADC credentials
   npm run job:migrate-store -- --dry-run
   ```
3. **Migrate**: `npm run job:migrate-store` — idempotent; re-run freely if interrupted.
4. **Verify**: `npm run job:migrate-store -- --verify` — exits non-zero on any missing or
   mismatched key. Do not proceed until it exits 0.
5. **Flip the Cloud Run job**: `gcloud run jobs update conductor-run \
   --set-env-vars "WORKSPACE_STORE=gcs,GCS_BUCKET=<bucket>,..." \
   --remove-env-vars NETLIFY_BLOBS_SITE_ID --clear-secrets ...netlify-blobs-token...`
   (keep OPENAI secrets). Execute a mock run; confirm it appears in `workflow.list_runs`
   **via the job's own summary** and the bucket (`gcloud storage ls gs://$BUCKET/runs/`).
6. **Netlify control plane**: continues reading/writing Netlify Blobs until Phase 4 —
   see the split-brain note below.

## ⚠️ Split-brain during the transition

After the flip, the Cloud Run job and the Netlify MCP/UI see **different stores**. Two
sane operating modes:

- **Recommended — move execution traffic entirely to the Cloud Run job** (that was
  Phase 1's point) and treat Netlify's store as read-only legacy until Phase 4 retires
  it. Re-run the migration any time Netlify-side state changed (it is idempotent).
- Or keep both active knowing runs/usage recorded on one side aren't visible on the
  other. Nothing corrupts — the stores are simply independent — but supervision views
  on Netlify won't show Cloud Run runs. If that trade-off bites, accelerate Phase 4
  (point `/api/mcp` at a Cloud Run service using the gcs backend).

## Acceptance checks (Phase 2 definition of done)

1. `npm test` — the `gcsBackend` suite proves the race is closed: concurrent run writers
   → `RunConcurrencyError`; concurrent workspace writers → `workspace_version_conflict`
   with the first write preserved; seeding races settle via create-only writes.
2. Migration verify exits 0 (change history + revisions intact, byte-for-byte).
3. A conductor run executed with `WORKSPACE_STORE=gcs` completes and its record, usage,
   and stage outputs are present in the bucket.
4. `repository.get_health` (through the job or a gcs-configured server) reports
   `backend: "gcs"`, `storageHealth: "healthy"`.

## Rollback

During the window: flip `WORKSPACE_STORE` back to `blobs` (+ restore the Netlify env) —
the source store was never mutated by the migration. After running live on gcs for a
while, rolling back means migrating in reverse (the tool is directional; copy back by
swapping source/target env-wise is NOT built — treat gcs as authoritative once live, and
use bucket **object versioning** for point-in-time recovery instead).

## Cost

Storage at this scale is effectively free: the state tree is a few MBs of JSON.
Class A/B operation counts from a conductor run are thousands, not millions — well under
a dollar a month. Object versioning adds pennies.
