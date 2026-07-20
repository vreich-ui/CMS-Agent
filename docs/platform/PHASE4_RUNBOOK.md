# Phase 4 runbook — dual control plane with a UI switch

Executes Phase 4 of `docs/platform/DIRECTION.md`: a Google **Cloud Run MCP Service**
comes up *beside* the Netlify control plane (Netlify is NOT retired), and the active
plane becomes a labeled **switch in the existing Constellation UI** — no new UI is
built. Phases 1–3 (execution plane, GCS state, improvement engine) are prerequisites
in spirit but this phase is independently deployable; it shares nothing with them
except the GCS state store.

## What ships in the repo

| Piece | Path | Purpose |
|---|---|---|
| MCP endpoint core | `src/agent/mcp/http/mcpEndpoint.ts` | Transport-neutral auth+session+dispatch, extracted from `netlify/functions/mcp.mts` (now a thin adapter, mirroring the OAuth `oauthEndpoints.ts` pattern) so Netlify and Cloud Run share ONE implementation |
| Control-plane router | `src/agent/mcp/http/controlPlaneRouter.ts` | Routes `/mcp`, `/healthz`, and the OAuth discovery/flow to the shared cores |
| Cloud Run server | `src/agent/entrypoints/mcpServerMain.ts` (`npm run serve:mcp`) | `node:http` wrapper; `bootstrapWorkspaceStore()` on start; graceful SIGTERM drain |
| Container image | `Dockerfile.mcp` + `cloudbuild.mcp.yaml` | node:22-slim, prod deps, runs TS via tsx |
| Shared session/OAuth state | `stateStore.ts` (`mcpStateUsesBlobs` now includes `gcs`) | Sessions + OAuth codes/tokens persist in **GCS**, shared across all instances — **no session affinity required** |
| UI switch | `ui/src/connection.ts`, `App.tsx`, `ConnectionPanel.tsx`, `SettingsPage.tsx` | "Control plane: Netlify \| Cloud Run" toggle in Settings, shown only when `VITE_CLOUD_RUN_MCP_URL` is configured |

## Why no session affinity is needed

The MCP `Mcp-Session-Id` sessions and all OAuth authorization state route through
`getMcpStateStore()`, which uses the blob-shaped store whenever `WORKSPACE_STORE` is
`blobs` **or `gcs`**. On the Cloud Run service (`WORKSPACE_STORE=gcs`) that resolves
to the registered GCS transport, so any instance can read any session — horizontal
scaling and scale-to-zero work without sticky sessions.

## Deploy the Cloud Run MCP Service (4a)

Prereqs: the Phase 2 GCS bucket + a service account with `roles/storage.objectAdmin`
on it; region co-located with the bucket and Vertex models.

```bash
PROJECT=<gcp-project> REGION=us-central1 REPO=cms-agent
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/mcp-service:$(git rev-parse --short HEAD)"

# 1. Build from Dockerfile.mcp (via the config, since --tag only builds ./Dockerfile)
gcloud builds submit --project "$PROJECT" --config cloudbuild.mcp.yaml --substitutions _IMAGE="$IMAGE" .

# 2. Deploy as a Service. Session affinity is NOT required (GCS-shared state), but harmless to keep.
#    MCP_API_TOKEN is the bearer the UI's direct mode sends; keep it in Secret Manager.
gcloud run deploy cms-agent-mcp \
  --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 4 --port 8080 \
  --no-allow-unauthenticated \
  --set-env-vars "WORKSPACE_STORE=gcs,GCS_BUCKET=<bucket>,MCP_STATE_STORE=blobs" \
  --set-secrets "MCP_API_TOKEN=mcp-api-token:latest,OPENAI_API_KEY=openai-api-key:latest"

# 3. Note the service URL; the MCP endpoint is <url>/mcp and health is <url>/healthz.
gcloud run services describe cms-agent-mcp --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
```

Auth choices:
- **`--no-allow-unauthenticated`** puts Cloud Run IAM (`roles/run.invoker`) in front —
  strongest, but the browser UI then needs an identity token. For a browser-driven UI,
  either allow unauthenticated at the platform edge and rely on the app's own
  `MCP_API_TOKEN`/OAuth bearer (the app never trusts the network), or front it with IAP.
  Start with app-level bearer auth (`MCP_API_TOKEN`) which the switch already uses.
- OAuth discovery/flow is served too (`/.well-known/oauth-*`, `/oauth/*`), so remote
  MCP connectors (Claude) can authorize against the Cloud Run plane exactly as against
  Netlify.

Health check: `curl <url>/healthz` → `{"status":"ok","service":"cms-agent-mcp","store":"gcs"}`.
Smoke the MCP endpoint: `curl -XPOST <url>/mcp -H "authorization: Bearer <MCP_API_TOKEN>" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`.

## Turn on the UI switch (4b)

Rebuild the Netlify-served UI with the Cloud Run URL baked in:

```bash
# In the Netlify site's build environment (Site settings -> Environment variables):
VITE_CLOUD_RUN_MCP_URL = https://cms-agent-mcp-xxxx-uc.a.run.app/mcp
```

On the next Netlify deploy, **Settings → Connection** shows a **Control plane:
Netlify | Cloud Run** toggle. Selecting Cloud Run repoints every UI call to the
service (forcing direct token auth); selecting Netlify restores the default. With no
`VITE_CLOUD_RUN_MCP_URL` set, the toggle is hidden and the UI is Netlify-only exactly
as before. This is the "quick switch in the existing GUI" — no new frontend.

## Coexistence (the split-brain rule, restated)

The two planes do **not** share a workspace store unless both point at the same
backend. After the Phase 2 cutover, GCS is authoritative: point the Cloud Run plane
(and the conductor job) at GCS, run execution there, and treat the Netlify plane's
Blobs store as a legacy read-only view until it is migrated (the migration job is
idempotent — re-run it whenever Netlify-side state changed). The switch makes the
active plane an explicit, one-click choice instead of an implicit one.

## Acceptance checks

1. `npm test` — the control-plane router suite passes (health, MCP dispatch through
   the shared core, OAuth discovery, 404s) and the existing MCP function tests stay
   green (the extraction is transparent).
2. `<url>/healthz` returns ok; `tools/list` over `<url>/mcp` returns the full tool
   catalog including the Phase 3 `evaluation.*`/`optimizer.*`/`playbook.*` tools.
3. In the UI with `VITE_CLOUD_RUN_MCP_URL` set, the toggle flips planes and
   "Test connection" succeeds against each; with it unset, no toggle appears.

## Rollback

Delete the Cloud Run service and unset `VITE_CLOUD_RUN_MCP_URL` (redeploy the UI) —
the toggle disappears and the UI is Netlify-only again. Nothing about the Netlify
control plane changed; the `mcp.mts` extraction is behavior-preserving and covered by
the existing test suite.
