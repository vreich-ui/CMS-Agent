# CMS-Agent — Deployment

Status: current as of commit `40424c4` (2026-09-05), derived from `cloudbuild.deploy.yaml`, `cloudbuild.mcp.yaml`, `cloudbuild.workbench.yaml`, `Dockerfile*`, `scripts/deploy-*.sh`, `netlify.toml`, `.github/workflows/*.yml` and the entrypoints. Evidence classes as in [ARCHITECTURE.md](ARCHITECTURE.md). Runbooks with hand-run `gcloud` snippets live in `docs/platform/` (see [docs/README.md](README.md) for which are still valid).

## 1. Topology

| Plane | GCP / Netlify resource | Image / build | Entrypoint | Trigger | Deployed by |
|---|---|---|---|---|---|
| MCP control plane | Cloud Run **service** `cms-agent-mcp`, project `cms-agent-503015`, region `us-central1`, runtime SA `cms-agent-run@cms-agent-503015.iam.gserviceaccount.com`, public URL `https://cms-agent-mcp-937996366809.us-central1.run.app` | `Dockerfile.mcp` → `us-central1-docker.pkg.dev/cms-agent-503015/cms-agent/mcp-service:<SHORT_SHA>` | `node --import tsx src/agent/entrypoints/mcpServerMainRun.ts` (port 8080) | HTTPS, `--allow-unauthenticated` (auth is in-app) | Cloud Build trigger `cms-agent-mcp-deploy` on push to `main` (`cloudbuild.deploy.yaml`), or by hand `scripts/deploy-mcp.sh` |
| Background run driver | Cloud Run **job** `continuation-tick` | same image (synced by the trigger's `sync-executor-planes` step, `_EXECUTOR_JOBS`) | `node --import tsx src/agent/entrypoints/runContinuationTickMain.ts` | Cloud Scheduler `*/2 * * * *` (per `docs/platform/CONTINUATION_TICK.md`; CONTINUATION_TICK_CRON in code is the retired Netlify minute schedule) | Created by hand per runbook; image auto-synced; **env never touched by the trigger** |
| Long-run driver | Cloud Run **job** `conductor-run` — **existence today UNVERIFIED from the repo** (last evidence: `docs/plan/HANDOFF.md:514`, 2026-08-04) | `Dockerfile` (same code) | `node --import tsx src/agent/entrypoints/runConductorJobMain.ts` | `gcloud run jobs execute … --args` | Hand (`docs/platform/PHASE1_RUNBOOK.md`, Blobs-era text); no deploy artifact; image **not** in `_EXECUTOR_JOBS` |
| Credential reconciler | Cloud Run **job** `site-credential-reconciler` + Cloud Scheduler `site-credential-reconciler-daily` (`0 6 * * *` UTC, POSTs Jobs v2 `:run` with `--apply` container override) | image passed as `IMAGE` | `node --import tsx src/agent/entrypoints/reconcileSiteCredentialsMain.ts [--apply]` | Scheduler / `site_credentials_apply` MCP tool | `scripts/deploy-site-credential-reconciler.sh`, `scripts/deploy-site-credential-reconciler-schedule.sh` |
| Ingest / GC / migration jobs | (candidates) `monetizer-ingest-run`, `tracking-ingest-run`, conversation-turn GC, `migrate-store` | same image | respective `*Main.ts` | Scheduler (commented snippets in PHASE1 runbook) | **No deploy artifact in repo — deployment UNKNOWN** |
| State | GCS bucket `cms-agent-503015-cms-agent-state` (`GCS_BUCKET`), optional `GCS_KEY_PREFIX` | — | — | — | Pre-existing; not created by any script here |
| Secrets | Secret Manager: `mcp-api-token`, `openai-api-key`, `mcp-scoped-tokens-json`, `dr-lurie-mcp-token`, `pdf-tool-mcp-token`, `platform-mcp-token`, `fernwell-mcp-token`, `netlify-api-token`; per-tenant `tokenSecretRef` versions for minted tenants | — | — | — | Hand-created |
| Operator UIs + legacy functions | Netlify site `cms-agent` (production deploy of `921367e` on 2026-09-06): `/` = `ui/dist`, `/workbench/*` = `workbench/dist`; **8 functions still deployed and routed** (`agent`, `mcp`, `session`, 5× `oauth-*`; probe 2026-09-06: `/api/mcp` and `/api/agent` 502, `/api/session` 401 alive, OAuth metadata 200 alive) | `netlify.toml` build command (root + ui + workbench installs, two Vite builds) | — | Netlify CI on push | Netlify |
| Workbench broker (Track A) | Cloud Run service (name per `docs/plan/TRACK-A-RUNBOOK.md`) | `Dockerfile.workbench` via `cloudbuild.workbench.yaml` (build only) | `node dist/index.js` | — | Runbook never executed — **UNCONFIRMED** |
| LibreChat kit | GCE VM + docker-compose | `deploy/librechat/` | — | — | Experimental |

## 2. Release path for the MCP service (`cloudbuild.deploy.yaml`)

1. `docker build -f Dockerfile.mcp` → tag `mcp-service:<SHORT_SHA>` (immutable; a `:latest` substitution on the trigger defeats this and is warned about).
2. `docker push`.
3. `deploy()` → [`scripts/deploy-service.sh`](../scripts/deploy-service.sh), the single source for the service's shape: `--service-account cms-agent-run@… --cpu 1 --memory 1Gi --min-instances 1 --max-instances 4 --port 8080 --allow-unauthenticated` with **merge** flags `--update-env-vars` / `--update-secrets` (never `--set-*`: that replaced the whole environment and deleted the client-connection variables twice). `scripts/deploy-mcp.sh` runs the same script — see §3.
4. Verify: served image == built image, resolving concurrent-build races by git ancestry (older build redeploys; newer build yields); 11 client variables present (`CMS_AGENT_PUBLIC_MCP_ENDPOINT`, `MCP_SCOPED_TOKENS_JSON`, `NETLIFY_API_TOKEN`, `{DR_LURIE,PDF_TOOL,PLATFORM,FERNWELL}_MCP_{ENDPOINT,TOKEN}`); `*_PUBLISH_ENABLED` reported advisory-only; `GET /health` must be 200.
5. `sync-executor-planes`: runs `scripts/pin-job-images.sh`, which pins every job in [`deploy/executor-jobs.txt`](../deploy/executor-jobs.txt) — today `continuation-tick`, `site-credential-reconciler`, `tracking-ingest`, `strategy-learning`, `strategy-review` — to the **digest** the just-deployed revision resolves to, then reads the image back through three known field paths (a stale plane fails the build; an unreadable path is reported as *unverified*, not stale; a job that does not exist is skipped, not failed). `scripts/deploy-mcp.sh` runs the same script, so the two release paths cannot disagree about which planes exist. Adding a plane is one line in that file and nothing else — the list used to be a `_EXECUTOR_JOBS` substitution visible only to the trigger, which is how two of the three jobs came to be synced by nothing at all (C-10).

   Pinned by **digest**, not by the `:<SHORT_SHA>` tag, because a tag is a mutable pointer: two references spelled alike are similarly *named*, not provably the same *artifact*. The service escapes this without trying — Cloud Run resolves its tag to a digest when it creates the revision, and the revision is what serves — but a job records the literal reference it was given and no digest at all, so plane and service were genuinely not comparable as written.

6. Between deploys: `npm run check:job-images` (or the `check-job-images` action of `cloud-run-plane.yml`, which also runs daily on a schedule) reports any plane whose image digest differs from the service's **and any listed plane that does not exist in the project at all**, exiting non-zero on either. The second direction was added on 2026-09-08 (K-O3): an absent plane used to be a note, so two jobs sat unbuilt while this check went green every morning. Read-only; it never repins and never creates. The same workflow runs `npm run env:audit` as a separate job, which needs the `NETLIFY_AUTH_TOKEN` Actions secret and fails rather than skipping when it is absent.

### The W21 learning loop (S-14)

Three jobs, one chain, and each has a job script and a schedule script under `scripts/`:

| Job | Reads | Writes | Schedule (UTC) |
|---|---|---|---|
| `tracking-ingest` | sink rollups, previous whole **day** | feedback outcomes in the evaluation store | `0 3 * * *` |
| `strategy-learning` | sink rollups at the strategy grain, previous whole **day** | `tracking:strategy.v1` observations + playbook deltas on the writer/planning nodes | `0 4 * * *` |
| `strategy-review` | those observations + `by=object` rollups, previous whole **week** | one `marginalia_create` thread on the governed strategy object — **never patches** | `0 5 * * 1` |

**Two of these three jobs do not exist in the live project (verified 2026-09-08).** `gcloud run jobs list` in `cms-agent-503015`/`us-central1` returns exactly `continuation-tick`, `site-credential-reconciler` and `tracking-ingest`; `gcloud scheduler jobs list` returns exactly `continuation-tick-schedule` and `tracking-ingest-daily`. So `strategy-learning` and `strategy-review` have never run, and `site-credential-reconciler` has no schedule either. The scripts landed in #280 and were never executed — which is the same shape as the C-10 incident (a thing recorded as existing because the artifact describing it exists) and is why the table above reads as a schedule when it is a specification. Creating them is an operator action; the scripts are ready and take `PROJECT`, `REGION`, `IMAGE`, `GCS_BUCKET`, `RUNTIME_SA`. Until then the learning loop collects and nothing consumes: `tracking-ingest` has been writing feedback outcomes since 2026-09-06 with no `strategy-learning` reading them.

The ordering is the contract, not the clock: `strategy-learning` must fire after `tracking-ingest` has written the day it reads, and `strategy-review` on the first day the week it reads is complete. Move one and move the rest.

None of the three pins a window. Each defaults to its own trailing period, and a fixed `--from`/`--to` would re-read one frozen period forever — harmless for a pure reader, but `strategy-learning` writes observations (a frozen day would inflate the consecutive-window streak that gates every promotion) and `strategy-review` opens a thread a human reads (a frozen week would be a weekly duplicate in an editor's queue). `tests/deploy/executorJobs.test.ts` asserts this, and asserts that every job any deploy script can create is in `executor-jobs.txt`.

`strategy-review` needs two independent pieces of configuration — the sink, and `EDITORIAL_STRATEGY_PROJECT_ID`/`_OBJECT_TYPE`/`_OBJECT_ID` naming the object an editor owns. Its script rejects a *partial* address (all three or none), because a half-set address is the one shape that could send a proposal to the wrong object. With none set the job is a clean named no-op that exits 0.

**`continuation-tick` now has one too, closing S-14.** `scripts/deploy-continuation-tick.sh` and `scripts/deploy-continuation-tick-schedule.sh`, and all five planes in `executor-jobs.txt` are now reproducible from this repository. This one is not shaped like the other four: it dispatches live content nodes on four tenant sites every two minutes, so an env change applied to it lands fleet-wide before anyone could notice it was wrong. The script therefore DEFAULTS TO READING — it describes the live job, diffs the declared shape field by field, prints the table and exits non-zero on any difference, in either direction, without writing anything. `APPLY=1` is the only path that writes, and it is an operator action taken between ticks. Neither script fires the job itself: the deploy script has no execute path at all, and the schedule script — whose product is, of course, a thing that fires it — defaults to the same read-only mode and writes only under `APPLY=1`. `tests/deploy/continuationTickScript.test.ts` asserts all of that, and `tests/deploy/executorJobs.test.ts` now asserts the reverse direction that would have caught the gap: every job in `executor-jobs.txt` has both a deploy script and a schedule script.

Build-time startup guard: both Dockerfiles import the entrypoint's whole module graph during `docker build` (`node --import tsx -e "await import('./src/agent/entrypoints/…')"`) so an image that cannot load fails the build instead of dying silently on Cloud Run with zero logs (2026-08-20 incident).

Rollback: none scripted. Cloud Run keeps revisions; `.github/workflows/cloud-run-plane.yml` (`workflow_dispatch`) can `report` traffic/revisions/env names or `route-to-latest`. Rolling back = redeploying an older commit through the trigger or `gcloud run services update-traffic` by hand (I-4).

## 3. One service, one shape: `scripts/deploy-service.sh` (C-12, fixed)

Both release paths run [`scripts/deploy-service.sh`](../scripts/deploy-service.sh), which is the only place the service's sizing, scaling, runtime identity, env-var list and secret list are written down. `cloudbuild.deploy.yaml`'s `deploy()` calls it; `scripts/deploy-mcp.sh` calls it. Adding a variable, a secret or a sizing change is one edit there and nothing else. Same arrangement `deploy/executor-jobs.txt` gives the job list.

**What it was.** The two artifacts deployed one service and disagreed:

| Flag / var | `cloudbuild.deploy.yaml` (the trigger, i.e. production) | `scripts/deploy-mcp.sh` (by hand) |
|---|---|---|
| memory / min-instances / SA | 1Gi / 1 / `cms-agent-run@…` | 512Mi / 0 / not passed |
| `DR_LURIE_*`, `PDF_TOOL_*`, `PLATFORM_*` endpoint+token | set | not set |
| `MCP_ALLOWED_ORIGINS` | not set | required input |

Sizing and scaling are **not** merge-preserving the way `--update-env-vars` is — they are explicit flags — so a hand deploy after a trigger deploy silently halved the memory and dropped min-instances to 0 (cold starts on the OAuth/consent path). The shared script keeps the trigger's values, because those are what production has been running.

**What the fix also turned up.** Diffing the live service against both artifacts on 2026-09-07 found three things neither file named, all of which had survived only because both paths merge:

- `ZILBERMAN_MCP_ENDPOINT` + `ZILBERMAN_MCP_TOKEN` — a **fourth tenant configured entirely by hand**. A fresh service would not have had it; one `--set-*` would have deleted it.
- `TRACKING_SINK_URL` on the service (the `tracking-ingest` job sets its own copy; the service needs this one for `feedback_ingest_tracking`).
- `TRACKING_SINK_TOKEN`, now a Secret Manager binding (it was a plaintext env var, readable in every revision before `00236-pcz`).

All five are named in the shared script.

`MCP_ALLOWED_ORIGINS` stays an optional input: the script omits the key entirely when the variable is empty, so the trigger path keeps leaving whatever the service already has rather than replacing it with nothing. **Its live value was found corrupted** on 2026-09-07 — `https://cms-agent.netlify.app`, `https://cmslhost:5173-agent.netlify.app`, `http://loca` — a spliced list from an earlier hand deploy, in which `http://localhost:5173` was never actually allowed and two nonsense origins were. Corrected in place by hand; the exact-match check means the garbage entries were unreachable rather than permissive.

Variables that the script still does **not** set, and that code reads on the service: `SITE_CREDENTIAL_RECONCILER_GCP_PROJECT/REGION` (needed by `site_credentials_apply`, C-13), `MCP_OAUTH_APPROVAL_SECRET`, `MCP_EXPOSED_TOOL_PREFIXES`, `MCP_REQUIRE_SESSION`, the `IMPROVEMENT_*` flags, `WORKSPACE_NODES_SOURCE`, `ANTHROPIC_API_KEY`, `*_PUBLISH_ENABLED`. The last of those is deliberate — `DR_LURIE_PUBLISH_ENABLED` and `PLATFORM_PUBLISH_ENABLED` are left unnamed precisely so a deploy can never disturb them. For the rest, `gcloud run services describe cms-agent-mcp --format='value(spec.template.spec.containers[0].env[].name)'` (or the `report` action of `cloud-run-plane.yml`) lists what is live.

## 4. CI (`.github/workflows/ci.yml`)

Runs on every push/PR, Node 22, no secrets: `workspace` (root `npm ci` + `ui` install because the root typecheck imports ui types; `npm run build` = `tsc --noEmit`; `npm test` ≈ 290 files / ~2 760 tests, ~4 min), `ui` (`npm run test:ui`, `npm run ui:build`), `drift` (`test:drift` two-plane MCP surface vs `docs/mcp-tool-manifest.json`; `test:glossary` `docs/ui-glossary.md` vs `ui/src/explain.ts`; `test:objects` `docs/engine-objects.md` + generated envelopes vs `ui/src/objectModel.ts`; `test:scope` `docs/site-credential-scope-lock.json` vs `SITE_CLIENT_MANAGER_TOOLS`), `summary` (single required status). Not in CI: `workbench` Playwright (109 tests), `workbench-broker` tests (84), `npm run nodes:check` / `store:check` (need a live store), `scripts/generateMcpToolReference.ts --check` (new, see [reference/MCP_TOOLS.md](reference/MCP_TOOLS.md)).

## 5. Environment variables (canonical table)

Complete inventory with file:line evidence, defaults and which artifact sets each: the audit table is reproduced in condensed form here; when in doubt grep `process.env.` / `env.` in the cited file.

### 5.1 Store and control plane

| Variable | Read by | Meaning | Default | Set by |
|---|---|---|---|---|
| `WORKSPACE_STORE` | `repository/RepositoryManager.ts`, `blobs/blobClient.ts`, `mcp/state/stateStore.ts`, entrypoints | `gcs` (prod) / `blobs` (legacy Netlify) / `memory` / `json` (=memory) | `memory` | trigger, deploy script, reconciler script |
| `GCS_BUCKET`, `GCS_KEY_PREFIX` | `repository/gcs/gcsStoreClient.ts` | bucket; optional key prefix | — / `""` | trigger, scripts (bucket only) |
| `MCP_STATE_STORE` | `mcp/state/stateStore.ts` | `blobs` = durable via the registered store, `memory` = in-process; otherwise follows `WORKSPACE_STORE` | derived | trigger, script |
| `WORKSPACE_NODES_SOURCE` | `workspace/executor.ts:338` | `static` pins compiled nodes; anything else = `store` overlay | **`store`** (`.env.example` wrongly says static) | none |
| `MCP_API_TOKEN` | `mcp/http/mcpEndpoint.ts`, `mcp/auth/consent.ts`, `scopedBearerTokens.ts` | static full-access bearer; OAuth approval fallback | — | secret |
| `MCP_OAUTH_APPROVAL_SECRET` | `mcp/auth/consent.ts` | consent-screen secret | falls back to `MCP_API_TOKEN` | none |
| `MCP_REQUIRE_SESSION` | `mcpEndpoint.ts:137` | require `Mcp-Session-Id` | `false` | none |
| `MCP_EXPOSED_TOOL_PREFIXES` | `mcp/workspace/server.ts:15` | namespace allow-list | all | none |
| `MCP_ALLOWED_ORIGINS` | `entrypoints/mcpServerMain.ts:71` | CORS exact origins | deny all | deploy script only |
| `MCP_SCOPED_TOKENS_JSON` | `mcp/auth/scopedBearerTokens.ts` | static scoped bearer map (validated at startup) | none | secret |
| `MCP_MANAGED_SCOPED_BEARERS` | `managedScopedBearerCredentials.ts:83` | force managed registry on/off | on when store is gcs/blobs | none |
| `PORT` | `mcpServerMain.ts:99` | listen port | 8080 | Dockerfile / Cloud Run |
| `CMS_AGENT_PUBLIC_MCP_ENDPOINT` | `capture/siteGenesis.ts`, `siteCredentialReconciler.ts` | this service's public `/mcp` URL wired into tenants | dry-run placeholder | trigger, scripts |
| `NETLIFY_API_TOKEN` | `siteGenesis.ts`, `siteCredentialReconciler.ts` | Netlify PAT for genesis / reconciler | — | secret |
| `NETLIFY_AUTH_TOKEN`, `TRACKING_SINK_URL`, `TRACKING_SINK_TOKEN` | `siteGenesis.ts:265-290`, `improvement/trackingIngest.ts` | fleet values genesis copies onto new sites; tracking ingest | — | none |
| `PLATFORM_REPO_ROOT`, `SITE_GENESIS_NETLIFY_MODE` | `siteGenesis.ts` | platform checkout for `create-site.mjs`; `live` enables real Netlify writes | — / `dry_run` | none |
| `CMS_AGENT_SITE_BINDINGS_JSON` | `siteCredentialReconciler.ts` | one-time project→Netlify-site backfill map | `{}` | reconciler script |
| `SITE_CREDENTIAL_RECONCILER_GCP_PROJECT`, `_REGION`, `_JOB` | `mcp/workspace/siteCredentialTools.ts` | lets `site_credentials_apply` fire the job | — / — / `site-credential-reconciler` | none |
| `K_SERVICE`, `K_REVISION`, `SERVICE_GIT_SHA`, `SERVICE_DEPLOYED_AT` | `RepositoryManager.ts:74-77` | build identity in `repository_get_health` | Cloud Run sets `K_*`; the SHA/date stamps are set by nothing (report null) | runtime |

### 5.2 Models and runners

| Variable | Meaning | Default |
|---|---|---|
| `OPENAI_API_KEY` (secret), `OPENAI_AGENT_MODEL`, `OPENAI_BASE_URL`, `OPENAI_MAX_OUTPUT_TOKENS_CEILING` | OpenAI runner/provider | — / `gpt-5.5` / api.openai.com / 128000 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MAX_OUTPUT_TOKENS_CEILING` | native Anthropic runner (`provider: "anthropic"`) | — / `claude-opus-4-8` / api.anthropic.com / 64000 (`ANTHROPIC_VERSION` in `.env.example` is never read) |
| `GEMINI_API_KEY`, `modelConfig.apiKeyEnv` | Google / openai-compatible providers | — |
| `TOOL_RESULT_MAX_CHARS`, `DEPENDENCY_OUTPUT_MAX_CHARS`, `AGENT_TRACING_ENABLED` | prompt size caps; OpenAI Agents tracing metadata | 32000 / 48000 / off |
| `TOOL_BLOB_PREFIXES`, `WEB_DOMAIN_ALLOWLIST`, `WEB_DOMAIN_DENYLIST`, `WEB_RESPONSE_SIZE_LIMIT_BYTES`, `WEB_PROVIDER` | controlled tools | `agent-tools/` / — / — / 250000 / `disabled` |
| `IMPROVEMENT_MODEL_LADDER_ENFORCE|_THRESHOLD|_MIN_SAMPLES`, `IMPROVEMENT_POST_RUN_REFLECT|_MODE|_MAX_NODES|_MIN_SAMPLES`, `IMPROVEMENT_AUTO_PROMOTE|_MIN_SCORE|_MAX`, `IMPROVEMENT_REFLECTOR_MODEL`, `IMPROVEMENT_CURATOR_MODEL`, `IMPROVEMENT_JUDGE_MODEL`, `IMPROVEMENT_FINETUNE_MIN_EXAMPLES|_MIN_PREFERENCE_PAIRS` | learning-loop flags ([AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md) §8) | all off / defaults in `.env.example` |

### 5.3 Drivers and jobs

| Variable | Read by | Meaning | Default |
|---|---|---|---|
| `RUN_DRIVER_TIME_BUDGET_MS` | `mcp/workspace/tools.ts:65` | in-request advance window, clamped ≤ 45 000 | 45 000 |
| `RUN_CONTINUATION_TICK` | `runContinuation.ts:139` | `off`/`false`/`0` disables the tick | `on` |
| `CONTINUATION_TICK_BUDGET_MS`, `CONTINUATION_TICK_MAX_RUNS`, `TASK_TIMEOUT_MS` | tick | wall budget; runs per tick; the job's own `--task-timeout` so dispatches that would outlive the task are deferred — **set by nothing in the repo** (I-2) | 45 000 / 5 / 300 000 |
| `PROJECT_ID`, `EXECUTION_MODE`, `RUN_INPUT_JSON`, `RUN_INPUT_FILE`, `RESUME_RUN_ID`, `RUN_APPROVED`, `MAX_STEPS`, `RUN_BUDGET_USD` | conductor job | per-execution defaults (flags override) | `dr-lurie` / `openai` / … |
| `CONVERSATION_ID`, `MIGRATE_PREFIX`, `MONETIZER_INGEST_*`, `TRACKING_PROJECT_ID`, `TRACKING_INGEST_*` | GC / migrate / ingest jobs | see the entrypoint headers | — |
| `SITE_DUPLICATE_KICK_BUDGET_MS` | `workspace/runKick.ts` | in-call kick after `site.duplicate` | 60 000 |

### 5.4 Tenant connections (dynamic names)

`<CLIENT>_MCP_ENDPOINT` / `<CLIENT>_MCP_TOKEN` per project record (`mcpEndpointEnvVar`, `tokenEnvVar`; genesis derives `<SLUG>` upper-cased), `<PREFIX>_PUBLISH_ENABLED` (derived by stripping `_MCP_ENDPOINT`; `false` is a kill switch). Compiled defaults: `DR_LURIE_*`, `PDF_TOOL_*`, `PLATFORM_*`, `FERNWELL_*`, `MONETIZER_*`. Endpoint may come from the record; token may come from `tokenSecretRef` (Secret Manager) — executor planes need no per-tenant env at all when records carry both.

### 5.5 SPAs and broker

`VITE_CLOUD_RUN_MCP_URL` (Netlify site-level env, value not in repo), `VITE_MCP_TRANSPORT=cloudrun`, `VITE_READ_ONLY=0`, `WORKBENCH_BASE=/workbench/` (netlify.toml), `VITE_MOCK`, `VITE_API_BASE`; broker: `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `CMS_AGENT_MCP_URL`, `CMS_AGENT_MCP_TOKEN_SECRET` | `CMS_AGENT_MCP_TOKEN`, `READ_ONLY`, `ALLOWED_ORIGIN`, `AUTH_MODE`, `IAP_AUDIENCE`, `CACHE_TTL_MS`, `STATIC_ROOT`, `MOCK_UPSTREAM` (`workbench-broker/.env.example`). Netlify functions: `AGENT_API_TOKEN` (legacy), `ADMIN_EMAIL_IDS` (session gate).

Dead documentation: `WORKSPACE_STORE_PATH`, `SNOOCLE_MCP_*`, `ANTHROPIC_VERSION`, the README's `NODE_ENV=production + json` guard (no code reads `NODE_ENV`).

## 6. Health checks and verification

- `GET /health` (also `/healthz`, `/`): `{status:"ok", service, store}` — unauthenticated, side-effect free, does **not** touch GCS or verify client connections (that is why "two releases took all clients down while health stayed green"). The deploy verifies variable *names*, not values.
- `repository_get_health` (MCP): per-repository readable/writable flags, backend label, `workspaceVersion`, build identity (`K_REVISION`), project dialect drift findings, healed-node counts.
- `npm run verify:deploy` (`scripts/verifyDeployment.ts`, needs `MCP_URL` + `MCP_API_TOKEN`): asserts the served tool surface and that each active project's endpoint/token resolve; optional scoped-token pin check.
- `project_test_connection` / `project_list_tools`: live tenant reachability.
- `workflow_list_runs` stall block and `project_get.driverHealth`: is any background driver alive.

## 7. Local development

```bash
npm ci && npm ci --prefix ui            # root typecheck needs ui types
npm run typecheck && npm test           # ~4 min
npm run serve:mcp                       # Cloud Run entrypoint locally (memory store) on :8080
npm run ui:dev                          # Vite ui at :5173 → paste a bearer, point at http://localhost:8080/mcp
npm run workbench:dev                   # workbench (VITE_MOCK defaults to fixtures)
WORKSPACE_STORE=memory npx tsx scripts/generateMcpToolReference.ts   # regenerate the tool reference
```

`npm run dev:legacy-netlify` starts the Netlify functions plane (legacy). Real GCS locally: `WORKSPACE_STORE=gcs GCS_BUCKET=… ` with Application Default Credentials.

## 8. Netlify specifics

`netlify.toml` builds both SPAs into `ui/dist` (workbench copied under `ui/dist/workbench`), publishes `ui/dist`, bundles `netlify/functions` with esbuild, and routes `/api/agent`, `/api/mcp`, `/api/session`, the OAuth well-known/endpoint paths, `/workbench/*` and the SPA catch-all. Only `/api/session` is on a live path. The Netlify project retirement plan is `docs/plan/RETIREMENT.md` (sign-off empty).
