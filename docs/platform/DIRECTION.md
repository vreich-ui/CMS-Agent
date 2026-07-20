# Platform direction — Netlify → Google Cloud Run (decision record + phased plan)

Status: **decided** (July 2026). This is a docs-only decision record; no code changes
accompany it. Each phase below is independently shippable and leaves a functioning
system, growing from basic to advanced.

## 1. The decision

**Move the agentic workspace to Google Cloud — specifically Cloud Run — via a phased
strangler migration, execution plane first, keeping the TypeScript codebase.**

Two forces drove this:

1. **Netlify's execution ceiling.** Synchronous functions cap at 10–26 s and
   background functions at ~15 minutes. Long Publishing-Conductor runs (many nodes ×
   LLM calls × retries) and every planned improvement-engine workload (trial sweeps,
   batch judging, dataset exports, optimization loops) are batch jobs that need
   minutes-to-hours, not a per-step ceiling.
2. **The models already live in Google Cloud.** Co-locating the runtime with the
   models (same region) removes egress cost and shaves latency off every model
   round-trip — long agent loops make many.

This decision also *executes* the repo's own open architectural item: the two-plane
split (control vs execution) recorded in `docs/SESSION_HANDOFF.md` §5, which was
"NOT STARTED" at the time of writing. The execution plane lands on Google Cloud; the
control plane follows in the final phase.

## 2. Verified platform facts (July 2026)

Facts below were verified against vendor documentation and current secondary sources
in July 2026. Pricing figures are directional — re-verify against official pricing
pages before committing budget.

### Netlify (current platform)

- Synchronous functions: 10 s default, 26 s max (paid plans). Background functions:
  ~15 minutes, async invocation.
- **Async Workloads** (new 2026): durable multi-step orchestration with retries and
  persisted step results — but **each step still runs on function infrastructure with
  the ~15-minute ceiling**. No single multi-hour execution; no long-lived streaming
  sockets.
- **Netlify Blobs conditional writes** (new): `set()`/`setJSON()` accept `onlyIfNew`
  and `onlyIfMatch` (ETag compare-and-swap). This could close the documented
  lost-update race (`docs/constellation/data-model-gaps.md` §6) in place — single-key
  CAS only, no multi-key transactions.
- **Netlify Identity is a legacy/deprecated product** — auth migration is eventually
  required even if everything else stayed.

### Google Cloud (target platform)

- **Vertex AI Agent Engine is Python-only** (managed runtime packages a
  `requirements.txt`; supports ADK/LangGraph/LlamaIndex/custom *Python*). Google's ADK
  now has first-class TypeScript, but TS agents deploy to **Cloud Run**, not the
  managed Agent Engine runtime. ⇒ **Cloud Run is the only Google landing zone that
  preserves this TS/OpenAI-Agents-SDK codebase as-is.**
- **Cloud Run Services**: request timeout up to 60 min; native HTTP response
  streaming (fits MCP Streamable HTTP); WebSockets supported. Google **officially
  documents hosting remote MCP servers on Cloud Run** (Streamable HTTP recommended,
  SSE deprecated; authenticate with `--no-allow-unauthenticated` + `roles/run.invoker`).
  For stateful `Mcp-Session-Id` sessions: enable session affinity and/or externalize
  session state (Firestore/Memorystore).
- **Cloud Run Jobs**: task timeout up to **7 days** (GPU tasks 1 h). Fits hours-long
  batch: trial sweeps, exports, tuning orchestration.
- **Cloud Run Worker Pools** (GA 2026): persistent pull-based workers (Pub/Sub/queue
  consumers) with no request time limit; materially cheaper than always-on services
  for continuous background work.
- **Cloud Workflows**: declarative DAG orchestration, executions up to 1 year,
  callback-based waits (human-in-the-loop without polling). Coarse-grained sequencing
  only — inner LLM loops stay in Cloud Run code.
- **Storage with real concurrency control**: Firestore (transactions with automatic
  retry) and GCS (`ifGenerationMatch` preconditions + object versioning) — both
  strictly stronger than Blobs' single-key ETag CAS. Either permanently closes the
  lost-update race.
- **Firebase Auth / Identity Platform**: OAuth2/OIDC, free to 50k MAU — replaces
  deprecated Netlify Identity. **Firebase Hosting**: closest like-for-like for the
  React SPA (CDN, atomic deploys, rollbacks).
- **Cost at this project's scale**: scale-to-zero everywhere ≈ **$5–15/month** total
  infra (Cloud Run free tier: 2M requests, 180k vCPU-s, 360k GiB-s/month; Firestore/
  GCS/Tasks/Scheduler free tiers cover hobby scale) with 0.5–2 s cold starts. One
  always-warm instance (no cold starts on the interactive path) adds **~$40–50/month**.
  A 2-hour 1 vCPU/2 GB Cloud Run Job ≈ $0.16/run.

## 3. Alternatives considered (and rejected)

| Alternative | Why rejected | Revisit trigger |
|---|---|---|
| **Stay on Netlify** (adopt Async Workloads + Blobs `onlyIfMatch`) | The per-step 15-min ceiling, absence of long-lived streaming, deprecated Identity, and no model co-location all persist. Investing in Async-Workloads-specific orchestration builds exactly the code the migration must later unwind. | Only if long-running work is abandoned entirely. |
| **Big-bang full migration** | Highest risk; nothing ships until everything ships. The strangler sequence reaches the same end-state with a working system at every step. | Never — phases can simply be executed back-to-back if capacity allows. |
| **Vertex AI Agent Engine (ADK/Python rewrite)** | Python-only managed runtime; discards a working, tested TypeScript system. Managed Sessions/Memory Bank do not offset a full rewrite. | Only if a Python/ADK rewrite is independently desired later. |

## 4. Target architecture (end-state)

| Component | Today (Netlify) | Target (Google Cloud) |
|---|---|---|
| Control-plane MCP server (`/api/mcp`, authoring/history/supervision) | Netlify Function | Cloud Run **Service** (Streamable HTTP, session affinity, externalized session state) |
| Execution plane (Publishing Conductor runs; later improvement loops) | Same functions, ≤15 min | Cloud Run **Jobs** (long batch) + optional **Worker Pool** (queued runs), co-located with Vertex models |
| Orchestration of multi-step runs | In-process DAG walker | Same TS executor inside a Job; **Cloud Workflows + Cloud Tasks** only if/when runs span hours-to-days with waits |
| Run/workspace/state storage | Netlify Blobs (no transactions) | **Firestore** (documents needing transactions) + **GCS** (artifacts, versioned) |
| Auth | Netlify Identity (deprecated) + OAuth 2.1 | **Firebase Auth / Identity Platform** + existing MCP OAuth |
| React Constellation UI | Netlify hosting | **Firebase Hosting** (or Cloud Run) |
| Scheduled/deferred work | — | Cloud Scheduler + Cloud Tasks |
| Region | — | Same region as the Vertex models (egress + latency) |

The repository pattern (`src/agent/repository/` with parallel `memory/` + `blobs/`
implementations behind `RepositoryManager`) is the designed seam for Phase 2: GCP
backends are **additive** implementations, not rewrites.

## 5. Phased development plan (basic → advanced)

Each phase has entry criteria, deliverables, acceptance criteria, and a rollback
story. Netlify remains the front door until Phase 4 — every phase before that is
additive and reversible.

### Phase 0 — Decision recorded (this document) ✅

- Deliverable: this record + `docs/improvement/STRATEGY.md`.
- Optional micro-hardening (deliberately **not** done now, to keep this docs-only):
  adopt Blobs `onlyIfMatch` on `mutate()`'s save path to close the lost-update race
  while still on Netlify. One-line class of change; worth doing if Phase 2 is far off.

### Phase 1 — Execution plane on Cloud Run (basic functioning structure)

The smallest move that removes the 15-minute ceiling.

- **Containerize the existing repo**: one Dockerfile (Node ≥20, ESM). Netlify v2
  functions already use web-standard `Request`/`Response` handlers, so a thin Node
  server (e.g. Hono/Fastify adapter) can mount the same handlers; the run-executor
  path needs a plain CLI/HTTP entrypoint that invokes the existing
  executor/conductor (`workflow.run_all` semantics) directly.
- **Deploy as a Cloud Run Job** (and/or a small worker Service) in the same region
  as the Vertex models. Trigger initially by hand / Cloud Scheduler; the Netlify MCP
  can enqueue by calling a minimal authenticated endpoint.
- Storage still Netlify Blobs (read/written over HTTPS from GCP — acceptable
  latency for batch; this is temporary).
- **Acceptance**: a full Publishing-Conductor run that would exceed 15 minutes
  completes on Cloud Run; run records/usage appear in the existing repositories;
  Netlify paths untouched and still working.
- **Rollback**: delete the Cloud Run resources; nothing on Netlify changed.

### Phase 2 — State to GCS (correctness + independence) ✅ implemented

> **Status/decision update:** shipped as a **GCS-only backend** (`WORKSPACE_STORE=gcs`),
> not Firestore+GCS. Implementation review showed nothing needs multi-document
> transactions — the entire persistence model is JSON-at-keys with single-key optimistic
> concurrency — so GCS generation preconditions (`ifGenerationMatch`) cover it completely
> while **reusing every blob repository class unchanged** via a drop-in `BlobStoreClient`
> transport (`src/agent/repository/gcs/gcsStoreClient.ts`). The workspace document save
> is now ETag-conditional (hard CAS; concurrent writers get `workspace_version_conflict`),
> run saves already carried CAS, and first-write seeding is create-only. Cutover is
> freeze → migrate (`npm run job:migrate-store`) → `--verify` → flip env, instead of a
> dual-write window — right-sized for a single-operator system. Firestore remains the
> upgrade path if query patterns ever demand it. Procedure, acceptance checks, and the
> split-brain note: `docs/platform/PHASE2_RUNBOOK.md`.

- Original sketch (superseded above): Firestore/GCS repository implementations behind
  `RepositoryManager`; per-project namespacing folded in (shipped as the
  `GCS_KEY_PREFIX` seam); dual-run window then cut over.
- **Acceptance** (met — `tests/agent/gcsBackend.test.ts`): concurrent-writer tests prove
  the lost-update race closed for both runs and the workspace document; migration
  verify checks history byte-for-byte; `repository.get_health` reports `backend: "gcs"`.
- **Rollback**: flip `WORKSPACE_STORE` back to blobs during the window (source store is
  never mutated); after going live, bucket object versioning is the recovery mechanism.

### Phase 3 — Improvement Engine, GCP-native (advanced)

The deferred design — evaluation rubrics, LLM judges, feedback capture,
champion/challenger replay trials, GEPA-style prompt optimization, ACE playbooks,
model tiering, fine-tuning exports — built directly on the Cloud Run execution
plane so its heavy loops run as Jobs without time limits.

Full strategy, product choices, and its own basic→advanced staging:
**`docs/improvement/STRATEGY.md`**.

### Phase 4 — Control plane, UI, auth; retire Netlify

- Workspace MCP server → Cloud Run Service per Google's MCP hosting guidance
  (Streamable HTTP; session affinity; session state externalized to Firestore).
- React SPA → Firebase Hosting. Netlify Identity → Firebase Auth / Identity
  Platform (Identity is deprecated regardless). Wipe `/api/workspace-mcp` and the
  Identity plumbing as already planned in SESSION_HANDOFF §5.1.
- DNS cutover; decommission Netlify.
- **Acceptance**: existing MCP clients connect via OAuth to the Cloud Run endpoint;
  UI fully functional against it; no Netlify dependencies remain in `netlify.toml`
  paths that matter.

## 6. Sequencing rationale

The improvement engine deliberately comes **after** the execution plane (Phase 3
after Phase 1–2): its workloads are precisely the long batch jobs Netlify cannot
run, so building it first would mean building it twice. Conversely, Phases 1–2 are
small, mechanical, and de-risked by the repo's existing seams (web-standard
handlers; the repository pattern; the documented two-plane intent).
