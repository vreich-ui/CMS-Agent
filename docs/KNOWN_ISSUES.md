# CMS-Agent — Known Issues, Defects and Risks

Status: audit of commit `40424c4` (2026-09-05); **post-merge verification at `921367e` (2026-09-06)** re-confirmed every entry below that is marked *reproduced* or *re-verified*, added K-M9, K-A9–K-A11 and D-13–D-15, and shipped `scripts/repro/knownIssues.ts` (offline reproductions of C-1, C-3, C-12, K-M4, K-M5, K-M9 — run with `WORKSPACE_STORE=memory npx tsx scripts/repro/knownIssues.ts`; each prints REPRODUCED until fixed). Every entry carries severity (Critical / High / Medium / Low), confidence, evidence (file:line), a failure scenario, a recommended fix, and whether **documentation** alone or **implementation** must change. Sections: **C** confirmed defects, **K-D/A/M/P** suspected risks by domain, **I** infrastructure, **T** tests, **D** documentation contradictions. Ids are referenced from the other docs. The audit's change set is documentation plus two small doc-adjacent changes: the `.env.example` comment for `WORKSPACE_NODES_SOURCE` (C-4) and a new generator script `scripts/generateMcpToolReference.ts`. No functional code was changed.

## C. Confirmed defects (reproduced or unambiguous in code)

### C-1 `learning.list_observations` breaks once any conversation-turn ledger exists — **High**, confidence: confirmed (reproduced by `scripts/repro/knownIssues.ts`: one ledger hides the real observations, two ledgers throw)
- **Fixed (quick-fix wave 2).** `listObservations` now delegates to the workspace repository (the actual write path) instead of parsing every blob under `learning/` as an observation; `scripts/repro/knownIssues.ts` prints NOT REPRODUCED. See also T-1 below (three `BlobLearningRepository` tests added).
- Evidence: `src/agent/repository/blobs/BlobLearningRepository.ts:21-27` lists prefix `learning/` and, if any blob exists, parses every blob as a `LearningObservation` and never consults the workspace document; `BlobLearningRepository.ts:11` writes ledgers under `learning/conversation-turn-gc/<project>/<conversation>.json` (`{supersessions, references}`, no `createdAt`).
- Scenario: one ledger → the ledger document is returned as an "observation" and the real observations (in `workspace/current.json`) are hidden; two ledgers → `sort` throws `Cannot read properties of undefined (reading 'localeCompare')` and `learning_list_observations` / the controlled `learning.list_observations` tool fail for every caller. Today no code in `src/` calls `recordConversationTurnSupersession/Reference`, so the defect is latent; the first caller (or a hand-written blob) triggers it. The `learning/{observationId}.json` convention the code expects here was never the write path (observations live in the workspace document).
- Fix (implementation): make `listObservations` delegate to `workspaceRepository.listObservations` (the actual store) and move the ledger under its own prefix (`conversation-turn-gc/`), or filter by a distinct prefix. Add a blob-backend test.

### C-2 `WORKSPACE_STORE=json` is in-memory; `JsonWorkspaceStore` is dead code — **Medium**, confirmed
- Evidence: `RepositoryManager.ts:122-157` branches only on `blobs`/`gcs`; `JsonWorkspaceStore` (`mcp/workspace/store.ts:654`) has no reference; `WORKSPACE_STORE_PATH` is read nowhere; README claimed file persistence and a `NODE_ENV=production` guard that does not exist.
- Scenario: a developer relies on `json` for local persistence and loses every edit on restart.
- Fix: documentation (done here) + either wire `JsonWorkspaceStore` behind `json` or delete it.

### C-3 Continuation tick ignores the SIGTERM abort signal — **Medium**, confirmed (reproduced by `scripts/repro/knownIssues.ts`: an already-aborted signal still runs a full tick)
- **Fixed (quick-fix wave 2).** `runContinuationTick` now checks `signal` before doing any work and again at the top of the per-run and per-node advance loops; `scripts/repro/knownIssues.ts` prints NOT REPRODUCED.
- Evidence: `entrypoints/runContinuationTickJob.ts:31,89` accepts `signal` but `runContinuationTickJob` never passes it to `runContinuationTick` (`workspace/runContinuation.ts:229` has no signal parameter); the wrapper comment (`runContinuationTickMain.ts:5-9`) promises graceful stop.
- Scenario: Cloud Run sends SIGTERM (task timeout / scale-down); the tick keeps dispatching until the hard kill; the in-flight node's claim expires and is re-dispatched later (cost duplication, K-D1). The deadline-margin logic (`DISPATCH_DEADLINE_MARGIN_MS`) mitigates only the planned case.
- Fix (implementation): thread `signal` into `runContinuationTick` and check it in the per-run loop.

### C-4 `WORKSPACE_NODES_SOURCE` default is documented as `static`, code default is `store` — **Medium**, confirmed
- Evidence: `.env.example:34-40` (pre-fix) vs `executor.ts:338` (`=== "static" ? "static" : "store"`); `docs/platform/DIRECTION.md`, `docs/SESSION_HANDOFF.md` repeat "defaults to static".
- Scenario: an operator believes production runs compiled nodes; it runs store rows (prompts, tool grants, deterministic flags).
- Fix: documentation (done) and the `.env.example` comment/value corrected in this change set (the example no longer forces `static`).

### C-5 Three tools sit outside the namespace scheme — **Low**, confirmed
- Evidence: internal names `site_credentials_plan|apply|execution_status` contain no `.` (`mcp/workspace/siteCredentialTools.ts`); `isToolExposed` takes the segment before the first `.` (`server.ts:22-27`), so `MCP_EXPOSED_TOOL_PREFIXES=site` exposes `site_duplicate*` but not these, and the manifest counts 24 namespaces for what are 22 domains.
- Fix (implementation): rename internals to `site.credentials_plan` etc. (aliases keep the wire names) and regenerate the manifest.

### C-6 Server `instructions` describe a Netlify endpoint — **Low**, confirmed
- Evidence: `mcp/workspace/server.ts:112` "Session-aware Netlify Streamable-HTTP MCP endpoint…" served by Cloud Run. Fix: implementation (string edit) + `npm run drift:update` is **not** needed (instructions are not in the manifest).

### C-7 Publisher validates article bodies against the canonical schema, the executor against the store overlay — **Medium**, confirmed
- Evidence: `publisher.ts:277,464` use `getWorkspaceNode("article_body")?.outputSchema` (canonical `nodes.ts`); dispatch validates with the resolved (store-overlaid) node schema (`executor.ts` `validateOutput(output, node.outputSchema)`).
- Scenario: a `workspace_update_node_output_schema` edit on `article_body` accepted at execution time is refused at publish time as `no_valid_article_body` (or vice versa).
- Fix (implementation): resolve the node through `resolveConductorNodes` in the publisher; document that canonical remains the publish authority until then.

### C-8 A stuck `agent_converse` claim is permanent — **Medium**, confirmed
- Evidence: `conversations/conversationalRunner.ts:53-62,93-103`; `BlobConversationTurnRepository.claim` returns `pending` for any pending claim; claims have no TTL and are never deleted.
- Scenario: the instance handling a turn dies after `claim` and before `completeClaim/failClaim`; every retry with the same `(conversation_id, turn_id)` waits `timeout_ms + 5 s` polling GCS every 20 ms (up to ~6 000 reads) then fails `model_timeout`. Platform must mint a new `turn_id`.
- Fix (implementation): claim `updatedAt` + lease expiry (e.g., > 2× `timeout_ms` ⇒ reclaimable); exponential poll backoff.

### C-9 Cancelling a run does not stop an in-flight model call — **Medium**, confirmed (design, undocumented)
- Evidence: `mcp/workspace/tools.ts:640,826` set status only; runner abort is bound to timeout only (`OpenAINodeRunner.ts:522-570`).
- Scenario: `workflow_cancel_run` during a 5-minute `draft_writer` call: the call completes, usage is recorded, the CAS save fails, output is discarded.
- Fix: documentation (done) or plumb a cancellation check/abort into the runner context.

### C-10 Executor job images are not kept in sync by the trigger — **Medium**, confirmed
- **Fixed (ops/pin-job-images).** The job list moved out of the `_EXECUTOR_JOBS` substitution — which only the trigger could read, and which no longer needs to be kept in step with anything — into `deploy/executor-jobs.txt`. `scripts/pin-job-images.sh` reads that one file, and BOTH release paths run that one script (`cloudbuild.deploy.yaml`'s `sync-executor-planes` step and `scripts/deploy-mcp.sh`), so they cannot disagree. Planes are now pinned by **digest** to the artifact the deployed revision resolves to, not by tag. `npm run check:job-images` reports drift without deploying, and `cloud-run-plane.yml` runs it daily.
- Evidence (pre-fix): `cloudbuild.deploy.yaml:45` `_EXECUTOR_JOBS: continuation-tick` only.
- Scenario: realised on 2026-09-07, on two jobs this entry did not anticipate. `site-credential-reconciler` was several builds behind; it rotates every tenant's scoped credential from the allowlist compiled into the image, so running it would have re-narrowed all four tenants to an older, smaller allowlist and **exited 0 looking like a success**. `tracking-ingest` was behind and missing the code that stamps `projectId`, so a tenant admin's Insights panel showed nothing while the data sat in the store. Three repins were done by hand that day.
- Correction to this entry's original framing: `continuation-tick` was the one job that never drifted — it was the only name in `_EXECUTOR_JOBS`. The defect was never the sync logic, which was sound; it was that the list was a hand-maintained parallel copy, and the two jobs added later were never in it.
- Update (2026-09-08): all five planes in `deploy/executor-jobs.txt` now have both a deploy script and a schedule script, `continuation-tick` included, and `tests/deploy/executorJobs.test.ts` asserts that direction rather than recording its absence. Being *listed* and being *reproducible* were two different properties, and only the first was ever checked.
- Post-merge note (2026-09-06), still open: whether `conductor-run` still exists is **unverifiable from the repo** — it is named only by the Blobs-era PHASE1 runbook and a 2026-08-04 cost note (`docs/plan/HANDOFF.md:514`). It is deliberately NOT in `deploy/executor-jobs.txt`: an audit of the live project on 2026-09-07 found only the three jobs above. If it is ever found to exist, adding it is one line.

### C-11 `TASK_TIMEOUT_MS` is set by nothing, so the tick's deadline guard uses a default that may not match the job — **Medium**, confirmed
- **Fixed (ops/tick-deploy-and-hygiene).** `scripts/deploy-continuation-tick.sh` declares the job's whole shape and DERIVES `TASK_TIMEOUT_MS` from the same shell variable as `--task-timeout`, so the two cannot be typed apart; `tests/deploy/continuationTickScript.test.ts` fails if anyone replaces the derivation with a literal. The 2026-09-08 recon found the live job already carrying `TASK_TIMEOUT_MS=600000` beside `--task-timeout 600` — correct, but set by hand and recorded nowhere, which is the same defect wearing a right answer. The script's default mode now proves that equality on demand instead of trusting it.
- Evidence: `runContinuation.ts:141-147` (comment says it exists so code and `--task-timeout` "cannot drift"); no deploy artifact or runbook sets it (`docs/platform/CONTINUATION_TICK.md:58-64`).
- Scenario: job `--task-timeout` raised above 300 s: the guard is merely conservative; set below 300 s: the guard over-estimates the remaining task time, starts a dispatch that cannot finish, and the platform kills the node mid-flight (the 2026-09-04 shape). Fix: set the env var wherever `--task-timeout` is set (runbook + a job deploy script).

### C-12 Two deploy artifacts for one service disagree — **Medium**, confirmed
- **Fixed.** `scripts/deploy-service.sh` is now the only place the service's shape is written down — sizing, scaling, runtime identity, env-var list, secret list. `cloudbuild.deploy.yaml`'s `deploy()` runs it and `scripts/deploy-mcp.sh` runs it; neither carries a second copy. Same fix shape as `deploy/executor-jobs.txt` (C-10). The trigger's values survived, because those are what production had been running.
- Evidence: [DEPLOYMENT.md](DEPLOYMENT.md) §3 (`cloudbuild.deploy.yaml:90-102` vs `scripts/deploy-mcp.sh:79-82`): memory 1Gi vs 512Mi, min-instances 1 vs 0, runtime SA set vs omitted, different client-variable sets, `MCP_ALLOWED_ORIGINS` only in the script.
- Scenario: a hand deploy after a trigger deploy halves memory and drops min-instances (cold starts on the OAuth/consent path) — sizing flags are explicit, not merge-preserving; a first deploy from the script lacks three client connections.
- **Three things the fix turned up**, each live on the service and named by NEITHER artifact, each surviving only because both paths use merge-style flags (a fresh service would have lacked them; one `--set-*` would have deleted them):
  - `ZILBERMAN_MCP_ENDPOINT` + `ZILBERMAN_MCP_TOKEN` — a **fourth tenant configured entirely by hand**.
  - `TRACKING_SINK_URL` on the service, which `feedback_ingest_tracking` reads.
  - `TRACKING_SINK_TOKEN`, now a Secret Manager binding rather than the plaintext env var it was before revision `00236-pcz`.
  All five are named in the shared script.
- **And one live defect.** `MCP_ALLOWED_ORIGINS` was corrupted — `https://cms-agent.netlify.app`, `https://cmslhost:5173-agent.netlify.app`, `http://loca`: an earlier hand deploy spliced `http://localhost:5173` into the middle of the first origin and truncated the remainder. `http://localhost:5173` was therefore never an allowed origin and two nonsense ones were. Corrected in place 2026-09-07 (revision `00240-jjm`); exact-match origin checking means the garbage entries were unreachable rather than permissive. This is precisely the delimiter hazard `deploy-mcp.sh` warns about in its own comment, which is why the shared script builds the list with the `^|^` prefix and a `join()` rather than by hand.

### C-13 `site_credentials_apply` refuses unless two variables were set by hand — **Low**, confirmed
- Evidence: `siteCredentialTools.ts:75-92` refuses without `SITE_CREDENTIAL_RECONCILER_GCP_PROJECT/REGION`; no repo deploy artifact sets them (a hand-set value would survive the merge-style deploys, so the live state is UNKNOWN). Fix: add them to the trigger's `--update-env-vars` (infra).

### C-14 Tool catalog is rebuilt on every JSON-RPC message — **Low**, confirmed
- Evidence: `server.ts:106` `createWorkspaceTools(context)` inside `handleMcpJsonRpc`; 151 closures + zod schemas per call; batches multiply it. Fix: memoize per process keyed by exposure/allowlist; harmless today.

### C-15 `resources/read workspace://export` and `workspace_export_workspace` return the whole document — **Low**, confirmed
- Evidence: `server.ts:132-135`, `store.ts:571`. Scenario: a connector "resource" read pulls every stage output and observation (MBs) into model context. Fix: paginate or exclude `stageOutputs` by default.

### C-16 Two of the strategy review's three dimensions read fields the sink has never sent (S-04b) — **High**, confirmed
- **Partly fixed (this change set): the absence is now reported. The missing evidence itself is an open contract decision — see the fix note below.**
- Evidence: `improvement/strategyReview.ts` `topicOf` reads `topic|primary_topic|topic_id|taxonomy_term`, `funnelStageOf` reads `funnel_stage|stage|funnel`, and `rowEventCount` read `n|count|event_count|eventCount`. kugel-data `netlify/functions/_shared/rollups.ts` `shapeObjectRow` emits a frozen projection — `object_id`, `variant_id`, `day` and nine `MEASURE_COLUMNS` (`pageviews, exposures, sessions, completion_rate, cta_ctr, buy_click_rate, purchase_rate, revenue_cents, p75_dwell_ms`) — and none of those keys is among them.
- Scenario: on every real weekly run `groupObjectRows` returned an empty map for both dimensions, so `dimensionLines` returned early with no lines *and no `belowBar` note*. TOPIC WEIGHTS and FUNNEL-STAGE AGGRESSION have therefore never once been able to produce a line, while the proposal text told the editor its evidence was "the tracking sink's by=object rollups grouped by topic and funnel stage". Only ANGLE MIX, which reads observations rather than rollups, has ever run. Independently, `rowEventCount` returned 0 for every real row, so the `n >= 100` half of the bar could not have been cleared even if a label had existed.
- Fixed here: `rowEventCount` now reads `exposures`, then `pageviews` behind it (the sink's own documented fallback denominator), falling through on a zero rather than a nullish value because kugel-data's `toNumber` renders a NULL column as 0; every run reports a `grain` entry per dimension (`rowsExamined`, `rowsLabelled`, `available`, `detail`); a dimension with no labelled row writes a named `belowBar` note instead of an empty section; and the proposal names only the dimensions it actually grouped by, plus a "Not read this run" line for the others.
- **Open (implementation, needs a decision):** the labels themselves. Either the sink starts carrying a topic and a funnel stage on the `by=object` grain, or the review resolves them per `object_id` through the tenant MCP. Note that *funnel stage has no per-object meaning anywhere in the platform today*: there (`packages/core/lib/admin/analytics-object-drilldown-logic.ts`) it names the event funnel of one object — pageview → read_progress → completion → cta_click → buy_click — not a taxonomy over objects. Topic is resolvable: the platform mints `taxonomy_term` ids via the `add_term` op (`packages/core/server/lib/object-verbs.ts`). So the two halves are not the same decision.
- See also T-14 below: the tests proved these readers against a row shape no deployment produces, which is why the suite stayed green while two thirds of the loop was dead.

### C-17 `feedback.list` applied `limit` before the project filter — **Medium**, confirmed
- **Fixed.** `limit` is withheld from the repository when a `projectId` is supplied and applied to the MATCHING records instead (`improvement/projectScope.ts` `newestMatchingProject`).
- Evidence (pre-fix): `mcp/workspace/improvementTools.ts` passed the parsed filters — `limit` included — into `evaluationRepository.listFeedback(filters)` and only then called `filterRecordsByProject`.
- Scenario: a tenant's Insights card asking for N got **the workspace's newest N narrowed to their own** — routinely a handful on a busy multi-tenant workspace, and sometimes zero while that tenant had hundreds of records in the store. An empty card meaning "you have no feedback" and one meaning "your feedback is older than the workspace's newest N" are different answers, and the panel could not tell them apart.
- The reason recorded for leaving it — that over-fetching would make a tenant's page cost scale with the whole workspace's write volume — **did not hold**. `BlobEvaluationRepository.listFeedback` already loads every envelope under `evaluation/feedback/` and applies `limit` in memory afterwards; there is no cursor and no store-side limit, so passing one down saved no reads at all. The blob cost is identical either way.
- What over-fetching *does* cost is run lookups for unstamped legacy records, so `newestMatchingProject` walks newest-first in batches of 50 and stops as soon as the page is full: a workspace whose records are stamped (everything since S-07) costs zero lookups, and an unstamped tail costs only as many distinct runs as it takes to fill `limit`.
- `learning.list_observations` is unaffected — `listObservations` takes no `limit`.
- Noticed while landing S-07 (#273); not a defect that pre-dates it, since nothing was project-filtered before.

### T-15 `newestFirst` is not newest-first at sub-millisecond resolution — **Low**, confirmed
- Evidence: records written in a tight loop share a `createdAt` millisecond; the sort is stable, so tied records come back in insertion order, i.e. **oldest first**. Surfaced while writing C-17's tests — an assertion that a 3-record page returned `["newest", "middle"]` got `["old", "middle"]`.
- Scenario: cosmetic in the UI (a handful of same-millisecond records display in the wrong order), but a `limit`-capped page can drop the genuinely newest record of a tied group. Not fixed here; the fix is a tiebreak on the monotonically-increasing record id.

### C-18 Genesis wrote a per-site copy of an account-level variable, creating a second source of truth — **High**, confirmed
- **Fixed (C-11's open decision, now answered by evidence).** Both quick-fix waves deferred C-11 as "does `TRACKING_SINK_URL`/`TOKEN` exist as team-level Netlify env? If yes → genesis stops copying and checks by name." A live audit on 2026-09-07 settled it: they are ACCOUNT-level variables on the `vreich` team, scoped builds+functions across all contexts, inherited by all 19 sites. Genesis copied them per site anyway.
- Evidence: `capture/siteGenesis.ts` `GENESIS_FLEET_ENV_VARS` installed both through `setEnvVar(accountId, siteId, …)`. A site-level Netlify variable OVERRIDES the account-level one of the same name.
- Scenario, and it was live: `drluriescience` held a site-level `TRACKING_SINK_TOKEN` whose production/deploy-preview/branch-deploy contexts carried a 20-character value the sink rejects (probed: HTTP 401, versus 415 for the account value), while its `dev` context still held the old account value and `dev-server` was empty — the signature of a half-finished edit. The account token had been rotated to a 48-character value at some point and this copy was never updated. **The site kept working only because Netlify snapshots env vars into functions at DEPLOY time and it had not been redeployed since.** The next rebuild for any reason — publishing an article — would have baked in the dead token and silently stopped that tenant's tracking, fire-and-forget, with nothing reporting it.
- Fixed here: the sink pair is marked `inherited`, genesis never writes a site-level copy, and a new `accountEnvVarExists` checks the ACCOUNT collection by name (deliberately without `?site_id=`, which would answer with the very site-level copy this check exists to stop trusting). Names only — the response body is never read. A 404 is a clean "no" that becomes a human checklist entry; any other non-2xx refuses, because "we could not tell" must never be recorded as "configured". `NETLIFY_AUTH_TOKEN` is NOT account-level on this team and is still copied.
- The stale override itself was corrected during the 2026-09-07 token rotation, so no tenant is currently stranded.
- **Open, unrelated to genesis:** the account-level `TRACKING_SINK_TOKEN` is stored with `is_secret=false`, i.e. readable by anyone with account access. Netlify forbids the `all` context on secrets, so making it secret means splitting it into explicit contexts.

### C-19 `store:check`'s drift is CANONICAL being stale, and the documented remedy would delete a live capability — **High**, confirmed (measured against the live store 2026-09-08)
- **Do NOT run `store:update`, and do NOT pass `--allow-prompt-shrink`, on the drift as it stands.** The script is sound; the direction is wrong for this particular divergence.
- Measured drift (`WORKSPACE_STORE=gcs GCS_BUCKET=cms-agent-503015-cms-agent-state npm run store:check`): three writes and two refusals, all on two nodes.

  | pair | store → canonical | effect of applying |
  |---|---|---|
  | `brief_architect.outputSchema` | 5699 → 3871 chars | removes 21 schema paths |
  | `artifact_plan.outputSchema` | 4129 → 2542 | removes 19 |
  | `artifact_plan.schema` | 4129 → 2542 | removes 19 |
  | `brief_architect.prompt` | 9910 → 3939 (**−60%**) | refused by the 40% ceiling |
  | `artifact_plan.prompt` | 9369 → 5206 (**−44%**) | refused by the 40% ceiling |

- **What the removed paths are.** Both schemas lose the whole `style` block on their media slots — `style.visualStandardId` (with `minLength`), `style.override`, `style.instructions`. That is the hook by which a planned media slot carries a **brand visual standard**. `visualStandardId` is a live platform concept (`packages/core/admin/ImageryBoard.tsx`, `server/lib/brand-imagery-examples.ts`, `visual-standard-examples-jobs.ts`, `object-verbs.ts`, `mcp-tool-handlers.ts`) and appears **nowhere in CMS-Agent's `src/`**. Canonical `nodes.ts` has never known about it; the live store does.
- **So the store is AHEAD of canonical here, not behind.** `overlayStoreNode` lets the store's prompt and schema override canonical, so the live behaviour IS the store's. Pushing canonical would silently strip the visual-standard hook from the two nodes that plan every generated image, and the two prompt refusals are almost certainly the instructions for filling that same block — which is why they are the same two nodes.
- **Why this is a trap and not just a stale file.** A red `store:check` reads as "the store drifted, re-seed it", and the documented remedy for a refusal is `--allow-prompt-shrink`. Someone clearing the drift in good faith would delete a capability, and `store:check` would then go green — the loss looks like tidiness. `store:check` is not in CI (it needs a live store), so nothing else would catch it.
- **Correct direction:** bring `nodes.ts` up to the live store (`scripts/seedNodesFromWorkspace.ts`, `npm run nodes:update`), not the reverse. That path currently refuses too — 14 problems as of 2026-09-07 — so the two-way divergence is real and needs a person to reconcile it node by node, starting with `brief_architect` and `artifact_plan`.
- Related: K-A9 (every tail node's deterministic route is a store-overridable flag and `store:update` restores none of them) is the same hazard in a different field.

## K-D. Distributed-systems risks

### K-D1 Double dispatch after claim expiry — **High**, confidence: high (documented incidents in code)
- Evidence: reclaim rule `executor.ts:1431-1448` (`dispatchedAt + timeoutMs + 90 s`); per-phase re-stamp `executor.ts:2925-2947`; runner usage recorded before the run save (`OpenAINodeRunner.ts:465`); `executor.ts:2925-2933` describes the `article_body` re-dispatch loop (390 s stale claim vs ~645 s of legitimate work) and the earlier `gap_adjudicator` loop; `runContinuation.ts:250` cites the 2026-09-04 task-timeout kill that re-dispatched a node 12.7 min and ~$0.60 later.
- Scenario: a slow-but-alive node exceeds `timeout + 90 s` (tool loops, validation loops, provider stalls beyond the SDK timeout); a second driver reclaims and re-runs it; the first finishes, its CAS save fails, its cost stands. With three drivers polling (tick every 2 min, run_all callers, conductor job) the window is realistic.
- Fix: heartbeat the claim from inside the runner (re-stamp every N seconds while the model call is alive) instead of timeout arithmetic; make reclaim require `now > lastHeartbeat + margin`.

### K-D2 Run save, artifact blobs and index entry are not atomic — **Medium**, high
- Evidence: `BlobExecutionRepository.saveRun:234-244` writes the run (CAS), then `persistArtifacts` (unconditional), then `upsertIndexEntry` (CAS ×4 then one unconditional write); `resetRun` deletes old artifact blobs after writing the new run.
- Scenario: crash between writes → index missing the run (self-heals on next save), orphan `artifacts/*.json`, or artifacts newer than the run. Readers tolerate it; `BlobArtifactRepository.listArtifacts` scans the entire `artifacts/` prefix for one run.
- Fix: drop the artifact side-blobs (the run record already holds them) or write them under `artifacts/by-run/{runId}/`; treat the run record as the only truth.

### K-D3 Wall-clock assumptions across instances — **Low**, medium
- Evidence: claims, stall assessment, retry backoff, TTL envelopes and `makeId` all use the local clock. Cloud Run clocks are NTP-synced; skew of seconds is within the 90 s margin. Documented, no fix required beyond K-D1.

### K-D4 The stale-read reconciliation loop assumes eventual consistency that GCS no longer has — **Low**
- Evidence: `store.ts:353-383` (`STALE_READ_RETRIES`) exists for Netlify Blobs; on GCS reads are strong so it never fires. Harmless; documentation notes it.

## K-A. Agent-system risks

### K-A1 Publish executor behaviour is configuration in the store, not code — **High**, high
- Evidence: canonical `publish_executor` and `publication_controller` carry no deterministic flags (`nodes.ts` dump); `scripts/reseedStoreFromCanonical.ts` header: "Those two flags exist only in the LIVE STORE's metadata today"; `executor.ts:2303-2315` three-way behaviour; `overlayStoreNode` (`executor.ts:346-363`) merges canonical and store metadata per key, so the flag exists only as long as the store row carries it; default node source is `store`.
- Scenario: a `workspace_update_node_metadata` / `workspace_update_node` / `workspace_import_workspace` write that omits the key (these replace the row's `metadata` field — `mcp/workspace/tools.ts:719`), or a fresh workspace document (new bucket / `GCS_KEY_PREFIX`, seeded from `workspaceStoreSeedNodes()`), silently switches production from engine publishing (gated) to a model turn holding `project.call_tool`, where `publishRun`'s five gates never run. (`scripts/reseedStoreFromCanonical.ts` deliberately excludes `publish_executor.metadata` from its allowlist and cannot drop the flag.) Nobody can tell which mode is live without querying the store.
- Fix (implementation): move the flags into canonical literals (the gate/execute choice is code policy, not tenant configuration) and pin them in `overlayStoreNode`; until then document (done) and add a startup/health check that reports the live mode.

### K-A2 Article publishing is hard-wired to two tenants — **High** for the stated product goal, high confidence
- Evidence: `projects/projectHooks.ts:123-127` (`dr-lurie`, `platform`, `fernwell` — the last without `executePublish`); `publisher.ts:362-366` refuses `no_publish_executor`.
- Scenario: a genesis-minted tenant (zilberman, genesis-lab) or fernwell runs `publishing_conductor` to the end and cannot publish an article; autonomous publishing "for every client" is not possible for them. The verb sequence is shared across tenants (`objectDialect.ts`); the dialect is parameterised per tenant (`objectIdSource` request_id vs server_minted, site/taxonomy object ids).
- Fix (implementation): a generic platform-dialect hook selected by `objectDialect` presence rather than by project id; keep per-project hooks for policy/readiness only.

### K-A3 Schema authority split (see C-7) — Medium.

### K-A4 Context explosion on wide dependencies — **Medium**, medium
- Evidence: `OpenAINodeRunner.ts:426` builds `dependencyOutputs` for every `dependsOn` with a per-dependency cap of 48 000 chars; `brief_architect` has 8 dependencies, `article_body` 6 → up to ~384 k / 288 k chars (≈ 100 k / 75 k tokens) plus playbook and schema, before tool results (32 k each).
- Scenario: provider context overflow or truncation-retry doubling, cost spikes; the W12 truncation retry treats it as output truncation.
- Fix: a total prompt budget (sum across dependencies) and schema-aware projection of dependency outputs.

### K-A5 Model-produced JSON validated by a home-grown JSON-Schema subset — **Medium**, medium
- Evidence: `execution/outputValidator.ts` (custom validator; `strict: false` on the SDK `json_schema`); node schemas are operator-editable (`validateJsonSchema` checks only `type` keywords).
- Scenario: a schema using `$ref`/`$defs`, `format`, `contains` or `propertyNames` (keywords the validator does not implement; it does enforce `pattern`, `oneOf`/`anyOf`/`allOf`/`not`, `if/then/else`) silently lets a malformed body through to `publish_payload`; conversely a keyword the validator interprets differently from the provider may reject valid output. Fix: adopt Ajv (or the SDK's strict mode) and lock the supported keyword set; test parity with `canonicalNodesSchemaParity`.

### K-A6 Learned state can contaminate runs without provenance checks — **Medium**, medium
- Evidence: playbooks are injected into every dispatch unconditionally (`OpenAINodeRunner.ts:390-391`, `AnthropicNodeRunner.ts:100-101`); `playbook.apply_delta` and `playbook.migrate_observations` accept free text from any full bearer; `optimizer.promote` requires `baselinePromptHash` but `workspace_update_node_prompt` does not; helpful/harmful counters never retire an item on their own — only budget eviction (`playbook.ts:41-45`) or an explicit `retire` delta does.
- Scenario: a low-quality curation pass or an agent writing its own "lesson" becomes executable prompt text for all later runs of that node; no regression gate runs automatically on playbook changes.
- Fix: route playbook changes through the change history (they are not today — no revision, no `changes_restore`), require evidence ids, run `evaluation_run_regression` before enabling.

### K-A7 Workflow registration by side-effect import — **Low**, high
- Evidence: `captureConductorWorkflow.ts`, `cloneConductorWorkflow.ts`, `visualIdentityWorkflow.ts` register on import; a script importing only `workflowRegistry.ts` sees one workflow (observed in this audit). Fix: explicit `registerAllWorkflows()` called by the registry.

### K-A9 Every tail node's deterministic route is a store-overridable flag, and `store:update` restores none of them — **High**, confirmed (2026-09-06)
- Evidence: the executor reads `contractIntelligenceDeterministic`, `publishPayloadDeterministic`, `publicationControllerDeterministic`, `publishExecutorDeterministic`, `releaseExecutorDeterministic`, `learningRecorderDeterministic` from `node.metadata` (`executor.ts:1179-1185`, `:1975`, `:2184`, `:2244`, `:2425`, `:2498`); the overlay merges metadata per key with the store winning (`executor.ts:358`); `scripts/reseedStoreFromCanonical.ts` `RESEED_ALLOWLIST` (`:84-121`) contains no tail-node metadata entry, and only `--set-publish-executor-mode` touches one flag. Canonical sets `releaseExecutorDeterministic: true` (`nodes.ts:4221`) — but `release_executor` also holds `project.call_tool`, and both live tenants allow `release_to_production` (`platform/definition.ts:63`; `drLurie/definition.ts:83`).
- Scenario: one `workspace_update_node_metadata {id:"release_executor", patch:{metadata:{releaseExecutorDeterministic:false}}}` (full bearer, change history only) turns the release step into a model turn that can call `release_to_production` itself, with no idempotency ledger; nothing in the repo would notice and `npm run store:update` would not undo it. K-A1 is the same defect on `publish_executor`; this entry generalises it.
- Fix (implementation): pin the tail nodes' deterministic flags in code (read from the canonical literal, not the overlay) or add them to the reseed allowlist and refuse `false` on `publish`/`admin` nodes in `WorkspaceStateStore.mutate`. Until then: documentation states the condition (PUBLISHING_ARCHITECTURE §2.0 (d)).

### K-A10 Nodes that are not publish-risk hold `project.call_tool`, and nothing verb-level stops them — **High**, confirmed (2026-09-06)
- **Fixed (quick-fix wave 2).** The node path now refuses `object_publish`/`release_to_production`/`trigger_netlify_build`/`deploy` for every node that is not `publish_executor`/`release_executor`, whatever tenant policy says.
- Evidence: canonical `publishing_conductor` grants `project.call_tool` to `contract_intelligence`, `artifact_materializer`, `article_body` and `publish_payload` (riskLevel `write`) besides the three `publish` nodes (enumerated via `getWorkflowDefinition(id).canonicalNodes()`); `article_body` is always a model turn; the publish-risk dispatch gate covers only `publish`/`admin` risk (`executor.ts:586`); the node-facing `project.call_tool` handler forwards any `tool` name straight to `ProjectMcpAdapter.callTool` (`toolRegistry.ts:176`) with no forbidden-verb set and no executable policy hook; `composeWorkflowNodes`' structural refusal looks for `object_publish`/`release_to_production` in `allowedTools` (`publishingTail.ts:207-227`), where only controlled tool ids ever appear, so it never fires for `project.call_tool`. Tenant policy: `dr-lurie` `defaultToolPolicy: "allowed"`, `platform` `object_publish`/`release_to_production: "allowed"`.
- Scenario: `article_body`'s model, prompted to "fetch the contract", calls `project.call_tool {tool:"object_publish"}` instead; CMS-Agent forwards it; only the tenant's own server-side rules (external contract) can refuse. No operator decision, no controller decision, no gate.
- Fix (implementation): a server-side verb denylist on the node path (`object_publish`, `release_to_production`, `trigger_netlify_build`, `deploy`) for every node that is not `publish_executor`/`release_executor`, mirroring `cloneEngine.ts:122`; or replace `project.call_tool` on builder nodes with `project.call_read_tool`.

### K-A11 `learning_recorder` observations are model-generated by default — **Medium**, confirmed (2026-09-06)
- **Fixed (quick-fix wave 2).** The canonical `learning_recorder` node now carries `metadata.learningRecorderDeterministic: true`, so `publishing_conductor`, `capture_conductor` and `clone_conductor` all take the deterministic route by default (they compose the same canonical node rather than defining their own).
- Evidence: the deterministic, templated route (`learningRecord.ts`, "no model call and no free-text generation") runs only when `metadata.learningRecorderDeterministic === true` (`executor.ts:2494-2498`); no canonical literal sets it (`nodes.ts` 0 matches, `cloneConductorNodes.ts` 0, `captureConductorNodes.ts` only a comment). Consumers (`optimizer_analyze`, playbook curation, attention feed) treat every observation alike.
- Scenario: a playbook is curated from an observation that says the publish succeeded because the model believed it did. Fix (implementation): set the flag in canonical code or make the deterministic record the default; until then, documentation labels the source (AGENT_ARCHITECTURE §6).

### K-A12 `provider: "anthropic"` is fully wired in code and bound to no key on Cloud Run — **Medium**, confirmed (2026-09-08)
- Evidence: `runnerRegistry.ts:15-18` routes any node whose `modelConfig.provider` is `anthropic` to `AnthropicNodeRunner`, which fails validation with "ANTHROPIC_API_KEY is required for anthropic execution" (`AnthropicNodeRunner.ts:80`) when the variable is unset. The 2026-09-08 recon found `ANTHROPIC_API_KEY` bound by NEITHER the `continuation-tick` job NOR the `cms-agent-mcp` service (`docs/platform/continuation-tick.live-shape.md`). Meanwhile genesis provisions that same key name into the Netlify `fleet_shared_keys` set for tenant sites (`tests/agent/capture/siteGenesisTrackingProvisioning.test.ts:161`), so the fleet already assumes it exists somewhere.
- Nothing is broken today: no node or rubric outside tests declares `provider: "anthropic"`.
- Scenario: the first node flipped to that provider fails on the tick plane within two minutes, across four tenant sites, as a per-node *validation* error rather than a deploy error — so it reads as a bad node, not as a missing binding, and the deploy that "caused" it will look clean. Fix: bind the secret on both planes before any node is switched, or make the runner refuse at registration time with a message that names the plane.

### K-A8 Unbounded agent loops are bounded — verified, no issue
- `maxTurns`, `toolCallLimit`, timeouts, `MAX_STEPS`/`maxSteps`, `CONCURRENT_DISPATCH_LIMIT`, tick budgets, retry caps and budget gates all exist and are tested. Recursive tool use is impossible: nodes cannot call `workflow.*`/`node.execute` (not in the controlled registry).

## K-M. MCP risks

### K-M1 Catalog size — **Medium**, high: ~124 KB / ~30–35 k tokens per `tools/list`; connectors with the full bearer load all 151 tools. Fix: default `MCP_EXPOSED_TOOL_PREFIXES` per credential; split admin namespaces behind a second endpoint or scope.
### K-M2 Namespace irregularity — see C-5.
### K-M3 Hand-maintained JSON Schema beside zod — **Medium**, medium: `tools.ts` declares both; locked only for node/project/run tools and controlled tools (`tests/agent/mcp/*ToolSchemas.test.ts`). Fix: derive JSON Schema from zod (`z.toJSONSchema` in zod 4) and snapshot the whole manifest's schemas (the manifest already hashes them).
### K-M4 Self-asserted actor attribution — **Medium**, high, **reproduced** (`scripts/repro/knownIssues.ts`): `mcpEndpoint.ts:56-68` accepts `x-workspace-actor {kind:"human", id}` from any bearer; change history then shows a human. Fix: only honour the header for the (retired) proxy path; derive actor from the credential.
### K-M5 Tool-grant widening via MCP — **Medium**, high, **reproduced** (`scripts/repro/knownIssues.ts`): `workspace_update_node_tools` can grant `project.call_tool` (or any controlled tool) to any node with only change history as a guard. Canonical publish nodes carry `project.call_tool` by design (`publisher.ts:139-147`), and `reseedStoreFromCanonical.ts:292` deliberately names `workspace.update_node_tools` as the reviewed path for such a grant — so the risk is not the grant itself but that a full bearer (including an agent) can make it without review. Fix: require `adminApproved`/operator actor for tool-grant changes on `publish`/`admin` nodes in `WorkspaceStateStore.mutate`, or emit a distinct change-history event type the attention feed surfaces.
### K-M6 Batch calls run concurrently — **Low**: `Promise.all` over JSON-RPC arrays lets two mutations race inside one request; CAS makes it safe but conflict-prone.
### K-M7 500 responses echo `error.message` — **Low**: `mcpEndpoint.ts:195` returns raw messages; secrets are not expected in them but tenant error bodies can be.
### K-M9 A tenant's scoped chat bearer acts on ANY run by `runId` — **High**, confirmed, **reproduced** (`scripts/repro/knownIssues.ts`, 2026-09-06)
- Evidence: `isScopedMessageAllowed` (`mcpEndpoint.ts:112-123`) checks the tool allowlist, then `requestedProject(params.arguments)`; a call with no `projectId`/`project_id` argument passes (`project === undefined`). The tenant chat allowlist `SITE_CLIENT_MANAGER_TOOLS` (`capture/siteGenesis.ts:123-138`, locked) includes `workflow_get_run`, `workflow_get_run_cost`, `workflow_run_all`, `workflow_publish_run` (`projectId` optional) and `workflow_set_operator_publish_decision`, all addressed by `runId` (`tools.ts:317,325,345,430`); `buildToolContext` passes only `allowedToolNames`, so no handler re-checks the run's project.
- Reproduction: a bearer scoped to `platform` reads a `dr-lurie` run (200) and sets its `operatorPublishDecision` to `approved` (200); the same call with `projectId:"dr-lurie"` is refused (401). Run ids must be known (not listable with that bearer), so the exposure is cross-tenant *if a run id leaks* (logs, receipts, chat context) or is guessed.
- Fix (implementation): resolve the run first and enforce `run.projectId ∈ policy.projects` for scoped bearers on every run-addressed tool (one helper in `toolKit.ts` or a check in `mcpEndpoint.ts` after lookup); add the case to `tests/agent/mcp/scopedBearerTokens.test.ts`.

### K-M10 A scoped bearer calling an unfiltered list tool sees every tenant — **High**, closed for the two tools that ship (2026-09-07, S-07)
- The rule K-M9 established covers tools addressed by a run or a project. It does **not** cover a tool whose unfiltered answer is the whole workspace: `isScopedMessageAllowed` let a call through when `requestedProject` returned `undefined`, on the theory that the tool allowlist alone bounded it. That theory holds only while every allowlisted tool is addressed by something.
- Closed for `feedback_list` and `learning_list_observations`, the two the platform admin's Analytics → Insights tab calls, in three parts that are only safe together: (1) `FeedbackRecord` (`improvement/improvementTypes.ts`) and `LearningObservation` (`mcp/workspace/store.ts`) carry an optional `projectId`; (2) both list tools filter on it via `improvement/projectScope.ts` — a record matches when its stamp equals the project, **or** it is unstamped and its `runId` resolves to a run of that project, and a record whose project cannot be established is dropped (fail closed); (3) `PROJECT_REQUIRED_SCOPED_TOOLS` in `mcpEndpoint.ts` refuses either tool from a scoped bearer that supplies no project at all. Without (3), (1) and (2) are decoration: the leak is the *unfiltered* call.
- **Standing constraint.** `PROJECT_REQUIRED_SCOPED_TOOLS` is a hand-maintained list of wire names, not an argument-driven rule, because "unfiltered, this returns everyone's rows" is a fact about a tool's semantics that no argument reveals. Any future list-across-projects tool added to `SITE_CLIENT_MANAGER_TOOLS` must be added there in the same commit, or it ships as a cross-tenant read.
- **`playbook_get` and `optimizer_status` stay out of the tenant scope, permanently, unless nodes become tenant-scoped.** They are keyed by NODE, and nodes are workspace-wide — one shared graph every tenant's runs execute. There is no project to partition by, so this is not a smaller version of the same fix: granting either would hand one tenant the workspace's shared learning state (every other tenant's curated playbook lessons and optimizer proposals). The Insights tab's two remaining cards are handled on the Platform side instead. `tests/agent/capture/siteClientManagerScope.test.ts` pins the exclusion.
- Ingest note: `feedback.ingest_tracking` stamps records with `CMS_AGENT_PROJECT_ID` (`dr-lurie`), a **separate** input from its `projectId` argument, which is the tracking sink's partition (`drlurie`). The two ids name one tenant in two namespaces and a scoped bearer's `policy.projects` holds only the CMS-Agent spelling; stamping the partition id would hide a tenant's own rows from it with no error anywhere. Unset stamps nothing and the job still exits 0.

### K-M8 Managed-bearer registry read on every non-static request — **Low**: `findAnyScopedBearerTokenPolicy` reads `auth/managed-scoped-bearers.v1.json` then possibly the OAuth token blob for every OAuth/scoped call (2 GCS reads before dispatch). Fix: short in-process cache keyed by document generation.

## K-P. Persistence risks

### K-P1 Ephemeral fallback by omission — **Medium**, high: `WORKSPACE_STORE` unset ⇒ `memory` everywhere (`RepositoryManager.ts:103`), including a Cloud Run job whose env was created without it; the job would "succeed" scanning an empty store (exactly the Netlify tick incident). `gcs` without the factory throws, but `memory` never does. Fix: refuse `memory` when `K_SERVICE` is set unless `ALLOW_MEMORY_STORE=1`.
### K-P2 One hot document — **High**, high: `workspace/current.json` holds nodes, agents, relationships, **stage output mirrors**, **learning observations**, the reduced-contract cache and an append-only `events[]` list; every mutation (including each node completion's stage mirror and every observation) is a full-document read-validate-write under CAS, and `events[]` never shrinks. Scenario: concurrent runs across tenants contend on one object; version conflicts rise with load; the document grows unbounded (parse + write cost per mutation grows with history). Fix: split stage outputs and observations into per-run/per-record keys (they already exist on the run record); cap or externalize `events[]`.
### K-P3 Artifact dual write and orphan bytes — **Medium** (see K-D2); artifact bytes on PDF-Tool/tenant storage are never reclaimed when runs reset.
### K-P4 Unconditional writers → lost updates — **Medium**, high: `BlobProjectRepository.save`, `BlobImprovementRepository.savePlaybook/saveProposal`, `BlobSkillRepository.save` (rewrites every skill/version/event blob and deletes missing ones — a concurrent `skill.create` can be erased), `BlobDriverHealthRepository`, `BlobUsageRepository`, `persistArtifacts`, `clientMemoryStore.recordTemplates` (`memory/{projectId}.json`, read-modify-write with no precondition). Two admins editing a project record or two curation passes on a playbook lose one write silently. Fix: ETag CAS via `getBlobJsonWithEtag` (already used elsewhere), and per-skill writes.
### K-P5 No retention anywhere except ticks and conversation trims — **Medium**, high: `runs/`, `run-index/`, `usage/`, `node_timings/`, `artifacts/`, `changes/`, `revisions/`, `evaluation/*`, `improvement/*`, `conversation-turn-claims/`, `mcp/session/*`, `mcp/oauth/*` grow forever; the tick and constellation metrics fetch the whole run fleet every cycle (`runContinuation.ts:254`, `listRuns({})` → `fetchAllRuns`). Fix: retention job (archive runs older than N days to a cold prefix, drop expired session/OAuth blobs and completed claims).
### K-P6 Schema migration is implicit — **Medium**, medium: no `schemaVersion` bump has ever happened; compatibility relies on optional fields; no test loads an old record (T-6). Fix: add fixture documents from production shapes per era and a read test.
### K-P7 Reduced-contract cache keyed by fingerprint lives in the hot document — **Low**: cap 20, but every put is a full-document write (K-P2).
### K-P8 `BlobSkillRepository.load` reads every version and event blob on every load — **Low/Medium**: grows with history; skills are loaded on `skill.*` calls and node skill resolution.

## K-O. Observability

### K-O1 No application-level request log for MCP calls — **Medium**, high
- Evidence: `mcp/http/mcpEndpoint.ts` mints `requestId` (`:70`) and never logs it; no `console.*` in the endpoint, router or tool dispatch; no tracing dependency in `package.json`.
- Scenario: "who called `workflow_publish_run` at 14:02 and with what result" is answerable only if the call mutated something with change history; read-only and failed calls leave no trace beyond Cloud Run's `POST /mcp 200`.
- Fix (implementation): one structured line per `tools/call` (tool, actor kind/id, project arg, latency, ok/code, requestId, `K_REVISION`), with redaction.

### K-O2 Build identity is half-wired — **Low**: `SERVICE_GIT_SHA`/`SERVICE_DEPLOYED_AT` read null (`RepositoryManager.ts:76-77`; the comment at `:63-65` says so); only `K_REVISION` identifies the build. Fix: stamp in `cloudbuild.deploy.yaml` `--update-env-vars`.

## I. Infrastructure

| Id | Severity | Finding | Fix |
|---|---|---|---|
| I-1 | Medium | Deploy artifact drift (C-12) | unify |
| I-2 | ~~Medium~~ **Fixed** | `TASK_TIMEOUT_MS` unset (C-11) | derived from `--task-timeout` in `scripts/deploy-continuation-tick.sh` |
| I-3 | Medium | `conductor-run` image not synced (C-10) | `_EXECUTOR_JOBS` |
| I-4 | Medium | No scripted rollback; `route-to-latest` only moves traffic forward | document `gcloud run services update-traffic --to-revisions` or add a `rollback` action to `cloud-run-plane.yml` |
| I-5 | Medium | `/health` is shallow (no store, no client check); deploy verification checks variable names not values; `SERVICE_GIT_SHA` never stamped | add a `/ready` that reads `repository_get_health`; stamp SHA in the trigger |
| I-6 | Low | Dozens of code-read variables (≥55 by static grep, more counting dynamically composed names) absent from `.env.example`; `SNOOCLE_*`, `ANTHROPIC_VERSION`, `WORKSPACE_STORE_PATH` are dead | regenerate `.env.example` from [DEPLOYMENT.md](DEPLOYMENT.md) §5 |
| I-7 | Medium | Legacy Netlify functions remain deployed and routed — **re-verified 2026-09-06** on the production deploy of `921367e` (8 functions, 13 redirects): `/api/mcp` 502, `/api/agent` 502, `/api/session` 401 (alive), `/.well-known/oauth-authorization-server` 200 (a live OAuth authorization server minting tokens into Netlify Blobs that the Cloud Run verifier never reads). Dead 502 surface plus a decoy auth surface (`AGENT_API_TOKEN`, Netlify OAuth) | remove functions except `session`; keep the modules for tests |
| I-8 | Low | `MCP_ALLOWED_ORIGINS` only on the script path; a trigger-only fresh deploy denies the SPAs | add to trigger |
| I-9 | Low | Ingest/GC jobs have no deploy artifact; whether they run is unknown | scripts like the reconciler's |
| I-10 | Medium | `ANTHROPIC_API_KEY` bound on neither the tick job nor the service, while the provider path is complete (K-A12) | bind on both planes before any node declares `provider: "anthropic"` |
| I-10 | Info | Secrets: no value leakage found in code, logs or records; `.dockerignore` excludes `.env*`; CI uses no secrets | — |

## T. Tests (from the test-suite audit; 290 files / ~2 760 tests, all passing, ~4 min)

| Id | Severity | Gap | Files |
|---|---|---|---|
| T-1 | High | **Fixed (quick-fix wave 2).** C-1 has no test; blob-backend behaviour of `BlobLearningRepository` untested — A1 added three tests covering both the read-delegation fix and the ledger-prefix move | `src/agent/repository/blobs/BlobLearningRepository.ts` |
| T-2 | High | Publishing verbs have no captured-schema conformance test (capture has `mcpBoundaryConformance.test.ts`; publish uses hand-written `CallToolFn` fakes) | `publisher.ts`, `publishExecution.ts`, `objectPublishExecution.ts`, `releaseExecution.ts`, hooks |
| T-3 | High | Release-ledger idempotency tested as a pure function only, never through `runNextNode` + CAS + re-dispatch | `executor.ts:2417-2479`, `releaseExecution.test.ts` |
| T-4 | High | Run-index CAS retry/exhaustion/prune untested; fakes never return `modified:false` except `gcsBackend.test.ts` | `BlobExecutionRepository.ts:139-172` |
| T-5 | Medium | Zero behavioural tests for `BlobEvaluation/Improvement/DriverHealth/NodeTiming/Usage/Artifact/Skill` repositories | `src/agent/repository/blobs/*`, `skills/skillRegistry.ts` |
| T-6 | Medium | No backward-compat test loading old workspace documents / run records lacking newer fields | `store.ts`, `executor.ts` |
| T-7 | Medium | Netlify Blobs non-CAS degrade path only single-instance tested | `blobClient.ts:56-75` |
| T-8 | Medium | Entrypoint `*Main.ts` wrappers and real `GcsStoreClient` construction untested | `entrypoints/*Main.ts` |
| T-9 | Medium | `CLIENT-MANAGER-CONTRACT.md` is not machine-diffed against the zod schemas | `conversations/conversationContract.ts` |
| T-10 | Medium | Workbench Playwright (109) and broker (84) suites are not in CI | `.github/workflows/ci.yml` |
| T-11 | Low | `skills/publish.test.ts` locks a TODO stub; legacy `runAgent` tests count as coverage of nothing live | `src/agent/skills/publish.ts` |
| T-12 | Low | `capture/engine/screenshot-normalize.mjs`, `side-by-side.mjs` unreferenced by tests; production use UNKNOWN | — |
| T-14 | High | **Fixed (C-16).** `strategyReview.test.ts` proved the object-grain readers against fixture rows carrying `funnel_stage`, `topic` and `n` — keys no sink has ever sent — so a whole dimension could be dead in production with the suite green. The file now carries two fixture sets: `sinkObjectRows()` (kugel-data's real `shapeObjectRow` projection, which every production-behaviour assertion uses) and `labelledObjectRows()`, explicitly named as a hypothetical sink and used only to prove the grouping arithmetic. A column list pinned to `shapeObjectRow` fails here if either side drifts. **The general lesson is unfixed: no other cross-repo wire shape in this suite is pinned to its producer.** | `tests/agent/improvement/strategyReview.test.ts`, kugel-data `_shared/rollups.ts` |
| T-13 | Info | Tests validating mocks rather than contracts: every `callTool` fake-based publish test, `clientMemoryWriteWiring` (asserts fake called), `monetizerIngestJob`/`trackingIngestJob` (fetch stubs) — acceptable as unit tests, not as integration evidence | — |

## D. Documentation contradictions resolved by this change set (code wins)

| Id | Old statement (location) | Reality |
|---|---|---|
| D-1 | README: Netlify Blobs is the durable store; `WORKSPACE_STORE` supports `memory|json|blobs`; keys `learning/{observationId}.json`; `NODE_ENV=production` guard | GCS via `gcs`; `json` = memory; observations in the workspace document; no guard |
| D-2 | README/.env.example: `/api/agent` + `AGENT_API_TOKEN` required; Snoocle project default (`src/agent/projects/snoocle/definition.ts`) | legacy function; no snoocle definition exists |
| D-3 | README: 18-node graph, "stops at publication_controller with approval_required", "publishing execution disabled", "no approval execution path" | 25-node graph, five-gate publish path, autonomous policy, release executor |
| D-4 | README: "Identity secure proxy" connection mode, `/api/workspace-mcp` | deleted 2026-08-27; SPAs call Cloud Run directly |
| D-5 | AGENTS.md: orchestration in `src/agent/runtime`, workflows in `src/agent/workflows`, "one reusable base agent" (OpenAI Agents SDK), publish flags | orchestration in `src/agent/workspace/executor.ts`; no workflows dir; base agent is a legacy scaffold |
| D-6 | `.env.example`, DIRECTION.md, SESSION_HANDOFF: `WORKSPACE_NODES_SOURCE` defaults to static | defaults to store (C-4) |
| D-7 | DIRECTION/PHASE4: UI "control plane toggle Netlify/Cloud Run", "Netlify not retired" | Cloud Run is the only plane (`ui/src/connection.ts`) |
| D-8 | PHASE1/HANDOFF/dr-lurie policy §8.2/STRATEGY: `--approved` / `approved:true` / `DR_LURIE_PUBLISH_ENABLED=true` authorize publishing | authority = `resolvePublishAuthority`; `approved` deprecated; `publishEnabled` defaults true |
| D-9 | CAPTURE-CLONE-SPEC: three workflows; `publish.mjs` vendored | four workflows; `publish.mjs` deleted (T15.7) |
| D-10 | README: `MCP_STATE_STORE` values `blobs|memory` only; `dev` starts Netlify | `gcs` implies durable; `npm run dev` = `serve:mcp` |
| D-11 | LibreChat kit: 21-node pipeline | 25 canonical / ~48 seeded |
| D-12 | `netlifyFunctionIsolation.test.ts:19` comment: workbench's only data path is `/api/workspace-mcp` | workbench uses Cloud Run transport |
| D-13 | `workflow_publish_run` JSON-schema description (`tools.ts:462`): `live` "Must be true … otherwise a dry-run plan is returned" | code treats an omitted `live` as live (`publisher.ts:157`, `input.live !== false`); only an explicit `live:false` yields the plan — the tool description is the stale side (functional file, not changed here) |
| D-14 | This doc set at `40424c4`: "only `session` is live" among the Netlify functions | probe 2026-09-06: `session` 401 (alive) **and** the OAuth authorization server 200 (alive); `mcp`/`agent` 502 — corrected in README, ARCHITECTURE, MCP_ARCHITECTURE, DEPLOYMENT, AI_CONTEXT |
| D-15 | This doc set at `40424c4`: `conductor-run` listed as a live production plane | existence unverifiable from the repo (runbook + 2026-08-04 note only) — hedged in README, ARCHITECTURE, DEPLOYMENT, AI_CONTEXT, AGENTS |
| D-16 | This doc set at `40424c4` and older docs: "only `release_executor` speaks `release_to_production`", "an agent cannot publish without an operator" | true only in engine code / for run-based paths under the conditions in PUBLISHING_ARCHITECTURE §2.0 — reworded in AGENTS, ARCHITECTURE, SECURITY, GLOSSARY, AI_CONTEXT |
| D-17 | ARCHITECTURE at `40424c4`: `web.search` returns nothing because `WEB_PROVIDER` defaults to `disabled` | it is an unconditional stub (`toolRegistry.ts:165`); the variable is echoed, never branched on |

Historical plans (`docs/plan/*`, `docs/platform/*`, `docs/constellation/*`, `docs/SESSION_HANDOFF.md`) are retained with a HISTORICAL banner; see [docs/README.md](README.md).
