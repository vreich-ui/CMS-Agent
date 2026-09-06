# CMS-Agent — AI Context Briefing

Load this before changing the repository. It is a compressed, evidence-backed statement of how the system actually works at commit `40424c4` (2026-09-05). Deeper detail: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md), [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md), [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md), [PUBLISHING_ARCHITECTURE.md](PUBLISHING_ARCHITECTURE.md), [DEPLOYMENT.md](DEPLOYMENT.md), [SECURITY.md](SECURITY.md), [KNOWN_ISSUES.md](KNOWN_ISSUES.md), [GLOSSARY.md](GLOSSARY.md), [reference/MCP_TOOLS.md](reference/MCP_TOOLS.md), [reference/DATA_ENTITIES.md](reference/DATA_ENTITIES.md). Repo rules for agents: [../AGENTS.md](../AGENTS.md).

## 1. Identity

CMS-Agent is a TypeScript (Node 22 in Docker/CI, `.nvmrc` says 24; ESM, `tsx`, zod 4, `@openai/agents`, `@modelcontextprotocol/sdk`) workspace and orchestration service for content workflows. It exposes one MCP Streamable-HTTP endpoint (151 tools) and runs multi-node agent workflows ("conductors") that write, review, materialize media for and publish content into tenant sites. Tenant sites are separate Netlify-hosted MCP servers from `vreich-ui/platform`; they own published content. CMS-Agent owns workflow definitions, run state, evaluations and learning state.

Production: Google Cloud Run service `cms-agent-mcp` (project `cms-agent-503015`, `us-central1`) + Cloud Run jobs (`continuation-tick` every 2 min, `site-credential-reconciler` daily, `conductor-run` on demand), all from one image (`Dockerfile.mcp` / `Dockerfile`), all reading and writing one GCS bucket `cms-agent-503015-cms-agent-state` (`WORKSPACE_STORE=gcs`). Netlify hosts only two static SPAs (`ui/`, `workbench/`) that call the Cloud Run `/mcp` directly with a pasted bearer. Everything under `netlify/functions/` is legacy (the `mcp` function has 502'd since 2026-08-14; `session` is the only one on a live path).

## 2. Ten facts that override older documentation

1. Orchestration is `src/agent/workspace/executor.ts` (`advanceRun`, `executeRunnableNode`), not `src/agent/runtime/`. `runtime/runAgent.ts` + `createAgent.ts` + `skills/{contentDraft,editorialReview,seo,publish}.ts` are a dead `/api/agent` scaffold that never calls a model. There is no `src/agent/workflows/`.
2. `WORKSPACE_NODES_SOURCE` defaults to **`store`** (`executor.ts:338`). Node prompts, schemas, tool grants, model config and `metadata` flags (merged per key) come from `workspace/current.json` overlaid on the canonical literals; everything the overlay does not name — `id`, `kind`, `dependsOn`, `produces`, `requiredInputs`, `riskLevel`, `status`, `position` — is pinned to code (`overlayStoreNode`, `executor.ts:346-363`).
3. Four workflows are registered: `publishing_conductor` (25 nodes), `capture_conductor` (16), `clone_conductor` (18), `visual_identity` (2). Registration happens by side-effect import (`captureConductorWorkflow.ts`, `cloneConductorWorkflow.ts`, `visualIdentityWorkflow.ts`); importing `executor.ts` pulls them in. The shared publishing tail is `publish_payload → publication_controller → publish_executor → release_executor → learning_recorder`.
4. Every run record carries `dryRun: true`; workflow runs are created through `startDryRun()` (from `workflow_start_dry_run`, `site_duplicate`, the capture→clone chain, the conductor job CLI) and `node_execute` creates `independent_node` runs; the default `executionMode` is `"openai"` and runs publish live when gates pass. `executionMode: "mock"` is the only side-effect-free mode.
5. Publish authority is `resolvePublishAuthority(run)` (`workspace/publishDecision.ts`): `run.operatorPublishDecision === "approved"` **or** `run.publishingPolicySnapshot.autonomyMode === "autonomous"`; `withheld` always blocks. Caller flags (`approved: true`) are inert. `publishRun` (`workspace/publisher.ts`) applies five closed gates: `operator_enabled`, `publish_authorized`, `explicit_live`, `operator_not_withheld`, `controller_decision_go`.
6. Whether `publish_executor` runs the engine path (`publishRun`) or a model turn depends on the **store row's** `metadata.publishExecutorDeterministic` (`"execute"` / `true` / absent); canonical `nodes.ts` sets none. The repo cannot tell what production does; query `workspace_get_node {"id":"publish_executor"}`.
7. Article publishing hooks exist only for `dr-lurie` and `platform` (`projects/projectHooks.ts`); other tenants get `no_publish_executor`. Clone/capture publish objects through `workspace/objectPublishExecution.ts` instead.
8. Learning observations live inside `workspace/current.json` (not `learning/*.json`). The only learned state that reaches a prompt is the per-node playbook `improvement/playbooks/{nodeId}.json`, injected by both runners on every dispatch. Automatic reflection/promotion are flag-gated, default off.
9. `WORKSPACE_STORE=json` is in-memory; `JsonWorkspaceStore` is unused. Netlify Blobs is a migrated-off legacy backend.
10. The wire tool surface is locked by `docs/mcp-tool-manifest.json` (CI `npm run test:drift`); node literals are locked by `npm run nodes:check`; the tenant chat credential scope by `docs/site-credential-scope-lock.json` (`npm run test:scope`).

## 3. Runtime shape

```
Client (SPA / connector / admin chat / test)
  → POST /mcp  (mcpServerMainRun.ts → controlPlaneRouter.ts → mcp/http/mcpEndpoint.ts)
      auth: MCP_API_TOKEN | OAuth token (mcp/oauth/*) | scoped bearer (MCP_SCOPED_TOKENS_JSON or auth/managed-scoped-bearers.v1.json)
      session: optional Mcp-Session-Id (mcp/session/*)
  → handleMcpJsonRpc (mcp/workspace/server.ts) → createWorkspaceTools (tools.ts + agentTools/changesTools/constellationTools/improvementTools/siteDuplicationTools/siteCredentialTools/visualIdentityTools)
  → tool.execute → repositoryManager (runtime/repositories.ts, lazy singleton) → Blob*Repository over GcsStoreClient (registered by bootstrapWorkspaceStore())
  → workflow_run_* → executor.runNextNode (withRunLock) → NodeRunner (OpenAI Agents SDK | Anthropic | Mock) → controlled tools (tools/toolExecutor.ts) → ProjectMcpAdapter → tenant /mcp
Jobs: runContinuationTickMain.ts (scan runs → runNextNode), runConductorJobMain.ts (one run to terminal), reconcileSiteCredentialsMain.ts, plus migrate/gc/ingest entrypoints without deploy scripts.
```

Per node dispatch (in order): reclaim stale claim → find runnable node → run budget gate → concurrent reviewer batch (≤4) → skip predicates → publish-risk gate → deterministic route → client auth preflight → CAS claim save (`dispatch{dispatchedAt,timeoutMs,driver}`) → runner (prompt = instructions + JSON{input, dependencyOutputs ≤48k chars each, playbook, outputSchema}; tools with `toolCallLimit`; `Promise.race` timeout) → output validation (custom JSON-Schema subset) → retry policy (≤2 retries, backoff 60 s·2^(n−1)) → CAS save → best-effort commit (stage mirror into the workspace document, usage, timing).

## 4. Data ownership (short form)

| Data | Truth | Key |
|---|---|---|
| Node definitions (how they run) | store document, seeded from code | `workspace/current.json` |
| Topology, risk levels | code (`nodes.ts` & siblings) | — |
| Run state, outputs, receipts, approvals, release ledger | run record | `runs/{runId}.json` (+ `run-index/{projectId}.json`, `artifacts/{id}.json` copies) |
| Published content | tenant MCP | tenant |
| Projects | `projects/{projectId}.json` (unconditional writes) | |
| Credentials | env / Secret Manager values; records hold names/refs; chat bearers as digests in `auth/managed-scoped-bearers.v1.json` | |
| Usage, timings, ticks, driver health | append-only records | `usage/by-run/…`, `node_timings/…`, `ticks/…`, `driverHealth/…` |
| Skills, changes, revisions, evaluation, improvement, conversations, memory, library, sessions, OAuth | see [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §3 | |

Concurrency: workspace document = ETag CAS + `expectedWorkspaceVersion` + `baseRevisionId`; runs = per-process lock + CAS on `rev` + dispatch claims; many other writers are unconditional (KNOWN_ISSUES K-P4). No cross-key transactions.

## 5. Invariants (MUST)

- Call `bootstrapWorkspaceStore()` in any new entrypoint before touching repositories.
- Mutate runs only via `executor.ts` functions under `withRunLock`; mutate the workspace only via `WorkspaceStateStore.mutate` (it validates, bumps `workspaceVersion`, snapshots a revision, appends an event, records change history).
- Never add a publish gate or a caller-side authority flag; never let a node grant satisfy a gate; in engine code only `release_executor` may call `release_to_production` (on the model path the tenant's tool policy is the only enforcement).
- Never widen the publish charter (`publishableTypeCharter.ts`). Canonical publish nodes carry `project.call_tool` by design; changing tool grants on a `publish`/`admin` node is a reviewed operator decision made through `workspace_update_node_tools`, never through a re-seed.
- Secrets: names/refs only in records and responses; redaction on outputs.
- Keep `*Main.ts` wrappers side-effect only; logic modules must import cleanly (Docker build-time guard imports them).
- After editing node literals: `npm run nodes:update`, redeploy, and `npm run store:update` for fields the store overlays. After changing a tool's name/description/schema: `npm run drift:update`. After changing `SITE_CLIENT_MANAGER_TOOLS`: `npm run scope:update` + reconciler `--apply`.
- Netlify functions must not import sibling functions.

## 6. Do not assume

- that `README`-era Netlify facts are live (Blobs store, `/api/workspace-mcp`, Identity proxy, `/api/agent`);
- that a `dryRun` run is safe, or that `workflow_run_all` cannot publish (it can under autonomous policy);
- that `learning_list_observations` works on the GCS backend once a conversation-turn ledger exists (KNOWN_ISSUES C-1);
- that cancelling a run stops the in-flight model call (it does not; the result is discarded);
- that the continuation tick honours SIGTERM (it does not, C-3);
- that `tool_list_executions` is durable (in-process map);
- that `MCP_EXPOSED_TOOL_PREFIXES=site` exposes `site_credentials_*` (it does not);
- that the two deploy artifacts (`cloudbuild.deploy.yaml`, `scripts/deploy-mcp.sh`) produce the same service (memory, min-instances, SA and env differ);
- that `.env.example` is complete (dozens of code-read variables are missing) or that `WORKSPACE_NODES_SOURCE=static` is the default.

## 7. Where to change what

| Change | Files | Locks / follow-ups |
|---|---|---|
| Add an MCP tool | `src/agent/mcp/workspace/tools.ts` or a `*Tools.ts` module (zod + JSON Schema + `execute`) | `npm run drift:update`; add to `tests/agent/mcp/*ToolSchemas.test.ts` if node/project/run family; regenerate `docs/reference/MCP_TOOLS.md` (`npx tsx scripts/generateMcpToolReference.ts`) and classify it in the script's CURATED table |
| Add/alter a node | canonical literal file + `workspaceStoreNodes.ts` seed; deterministic route in `executor.ts` if engine-side | `npm run nodes:update`, `tests/agent/workspace/canonicalNodes*.test.ts`, `store:update` |
| Add a workflow | `composeWorkflowNodes` + `registerWorkflow` in a new `*Workflow.ts`; routes module; `gateRegistry.ts`; charter | import it from `executor.ts` (side-effect registration) |
| Add a tenant with article publishing | `projects/<tenant>/definition.ts` + `hooks.ts` (`executePublish`, readiness, knowledge, voice) + `projectHooks.ts` map + `defaultProjects.ts` | Secret Manager token; `cloudbuild.deploy.yaml` client var check list if env-based |
| Change persistence | `repository/interfaces/*` + Memory + Blob implementations; key convention in `DATA_ARCHITECTURE.md` §3 | `tests/agent/gcsBackend.test.ts` (the only CAS-honouring double) |
| Change auth | `mcp/http/mcpEndpoint.ts`, `mcp/auth/*` | `tests/agent/mcp/{oauth,scopedBearerTokens,managedScopedBearerCredentials,mcpEndpoint}.test.ts` |
| Change deploy | `cloudbuild.deploy.yaml` (trigger) — never `--set-env-vars`; `scripts/deploy-mcp.sh` in lockstep | `tests/deploy/cloudbuildDeploy.test.ts` |
| Change the chat contract | `conversations/conversationContract.ts` + `CLIENT-MANAGER-CONTRACT.md` (additive versions only) | `tests/agent/conversations/*` |

## 7a. Module map with responsibilities (read before grepping)

| Module | Responsibility | Touch it when |
|---|---|---|
| `src/agent/entrypoints/mcpServerMain.ts` / `mcpServerMainRun.ts` | node:http server, CORS, body cap, startup validation of scoped tokens, `bootstrapWorkspaceStore()` | adding a path, changing CORS |
| `src/agent/mcp/http/controlPlaneRouter.ts` | path → handler (`/mcp`, `/health`, OAuth) | new HTTP endpoint |
| `src/agent/mcp/http/mcpEndpoint.ts` | auth (static → scoped → OAuth), sessions, JSON-RPC envelope, scoped request checks | auth or session semantics |
| `src/agent/mcp/workspace/server.ts` | JSON-RPC methods, catalog exposure, alias resolution, error envelope | new MCP method, alias, exposure rule |
| `src/agent/mcp/workspace/tools.ts` + `agentTools/changesTools/constellationTools/improvementTools/siteDuplicationTools/siteCredentialTools/visualIdentityTools.ts` | the 151 tools (zod + JSON Schema + execute) | adding/changing a tool |
| `src/agent/mcp/workspace/store.ts` | workspace document model, zod schemas, `mutate()` funnel, seeding, tolerant parse | any workspace field |
| `src/agent/workspace/executor.ts` | run lifecycle, dispatch order, deterministic routes, gates, retries, claims | orchestration behaviour |
| `src/agent/workspace/nodes.ts` + `captureConductorNodes.ts` + `cloneConductorNodes.ts` + `visualIdentityNodes.ts` + `workspaceStoreNodes.ts` | canonical node literals and the seed union | node definitions (regenerate locks) |
| `src/agent/workspace/{captureConductorRoutes,cloneConductorRoutes}.ts` | deterministic capture/clone stage implementations | capture/clone behaviour |
| `src/agent/workspace/{publisher,publishDecision,publishExecution,publishPayload,publicationController,releaseExecution,objectPublishExecution,publishableTypeCharter,gateRegistry}.ts` | publishing tail | anything that touches a tenant |
| `src/agent/workspace/runContinuation.ts`, `driverHealth.ts`, `nodeRetryPolicy.ts`, `skipPredicates.ts`, `conductor.ts`, `runContext.ts` | tick selection/budgets, silence detection, retry policy, skip rules, run cache, run context injection | driver behaviour, cost controls |
| `src/agent/workspace/{artifactMaterialization,visualStandardMaterialization,contractPrefetch,voicePrefetch,sitePrefetch,contentItemShell}.ts` | deterministic tenant/PDF-Tool interactions before publishing | media, contracts, voice |
| `src/agent/execution/runners/*` | model dispatch, tool loop, truncation retry, budget guard, image refs | provider behaviour |
| `src/agent/tools/*` | controlled tools nodes may call, policy, executor | node capabilities |
| `src/agent/skills/*` | skill registry (blob/memory), resolver, validator, seeds | skills |
| `src/agent/projects/*` | tenant registry, admin, MCP client/adapter, secrets, dialect, per-tenant hooks | tenants |
| `src/agent/capture/*` | crawl/map/theme/emit/score engines (vendored `.mjs`), clone engine, site genesis, credential reconciler, MCP boundary | genesis, capture fidelity |
| `src/agent/repository/*` | interfaces, memory + blob repositories, GCS transport, run index | persistence |
| `src/agent/conversations/*` | `agent_converse` runner, providers (OpenAI Chat Completions, Anthropic Messages), transcript sanitiser, claims, GC | chat contract |
| `src/agent/improvement/*` | rubrics/judge, optimizer, playbooks, regression, model ladder, ingestion | learning loop |
| `src/agent/observability/*` | usage/pricing, constellation metrics, redaction | cost, attention feed |
| `scripts/*` | drift detectors and locks, store seeding/reseeding, deploy scripts, doc generators | CI locks, deploy |

## 7b. Run and node state machines

Node: `queued → running → completed | failed | blocked | skipped | cancelled`; a `queued` node may carry `retry{notBefore}` (orchestrator backoff) or `skipOverride`. Run: `queued → running → completed | failed | blocked | cancelled | paused` where `blocked` means one of three things distinguished by markers — publish-approval hold (`approvalsRequired[]`), budget hold (`budgetBlock`), or a client-auth / engine refusal on the node; `paused` is an operator pause. A run becomes `completed` only in `advanceRun`'s no-runnable-node branch, and a run whose publish node holds a refusal receipt is forced back to `blocked`. `workflow_reset_run` rebuilds from `initialInput`/`entrypoint` keeping `requestId`, `publishRequestId`, `operatorPublishDecision`, `publishingPolicySnapshot`, `nodeBudgetOverrides`. Late-stage entry seeds an entry node and its ancestors as completed after validating the supplied output.

## 7c. Tenant model

A project record (`projects/{projectId}.json`) is seeded from a code default (`projects/defaultProjects.ts`) and migrated forward by `definitionVersion`. Connection resolution is env-first, record-second for both endpoint (`mcpEndpointEnvVar` → `mcpEndpoint`) and token (`tokenEnvVar` → `tokenSecretRef`), so an executor plane needs no per-tenant env once records carry both. Per-tenant behaviour hooks (`projectHooks.ts`) are hard-wired by id: publish execution (dr-lurie, platform), readiness checklist, executable call policy, knowledge and editorial-voice fallback for `client_manager`. Genesis (`site_duplicate {newSite}`) mints a Netlify site, installs fleet env vars and a scoped chat bearer (11 tools, `SITE_CLIENT_MANAGER_TOOLS`), registers the project with a derived endpoint, seeds a conservative capture policy, and kicks a capture/clone run. The daily reconciler re-mints chat bearers whose scope drifted.

## 7d. Chat contract in one paragraph

`agent_converse` (wire `client_manager.turn.v1`, `CLIENT-MANAGER-CONTRACT.md`) takes a strict request (agent ref, project, conversation/turn ids, actor with a stable non-email id, bounded context, ≤200 messages / 256k chars, ≤96 tools), claims `(conversation_id, turn_id)` with a CAS create (duplicates wait for and replay the stored result), assembles the prompt as canonical `client_manager` prompt → project knowledge → editorial voice → caller context as untrusted JSON, makes exactly one provider request with the caller's tools in the provider's format, sanitises the transcript before sending (unanswered `tool_use` gets a synthetic error result; one retry with flattened tool exchanges on a provider shape rejection; then `conversation_needs_reset`), records one turn into the ≤200-turn mirror and one usage record, and returns `assistant_text` / `tool_calls` proposals it never executes. Typed error codes are frozen (`unknown_project | project_disabled | agent_unresolved | transcript_too_large | model_timeout | model_error | budget_exceeded | invalid_turn_request | provider_quota | provider_rate_limit | conversation_needs_reset`).

## 8. Verification commands

`npm run typecheck` (needs `npm ci --prefix ui`), `npm test` (~4 min, no network), `npm run test:drift`, `npm run test:glossary`, `npm run test:objects`, `npm run test:scope`, `npm run test:ui`, `npm run nodes:check` / `store:check` (live store), `MCP_URL=… MCP_API_TOKEN=… npm run verify:deploy` (live surface), `npx tsx scripts/generateMcpToolReference.ts --check`.

## 9. Highest-value open problems (from KNOWN_ISSUES.md)

C-1 learning list defect · K-A1 publish path decided by store metadata · K-A2 hard-wired publish hooks · K-P2 one hot workspace document with unbounded `events[]` · K-D1 double dispatch after claim expiry · K-P4 unconditional writers · K-P5 no retention · C-8 permanent stuck chat claims · I-1 deploy drift · K-O1 no request log.
