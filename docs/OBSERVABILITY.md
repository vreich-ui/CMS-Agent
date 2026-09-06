# CMS-Agent — Observability

Status: current as of commit `40424c4` (2026-09-05). Evidence classes as in [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. What exists

| Signal | Where | Format | Consumer |
|---|---|---|---|
| Cloud Run request logs | Cloud Logging (platform) | Cloud Run's own HTTP log per request | operators |
| MCP server startup / drain | `mcpServerMain.ts` `console.error` | text (`listening on :8080 (store=gcs)`) | Cloud Logging |
| Conductor job progress + summary | `runConductorJob.ts` — progress lines on stderr, **one compact JSON line on stdout** (`runId, projectId, outcome, status, steps, nodes[], approvalsRequired, errors, cost, nextStep`) | JSON | Cloud Logging structured entry |
| Continuation tick summary | `runContinuationTickJob.ts` `summarizeTick` → `{event:"workflow.continuation_tick", tickId, scanned, driven[], timedOut, driverSilent?, refusals[]}`; failures `workflow.continuation_tick_failed`, `workflow.continuation_tick_driver_silent` | JSON | Cloud Logging; exit code 1 on driver silence or store failure |
| Tick ledger (durable) | `ticks/{tickId}.json` (48 h), `driverHealth/{projectId}.json`, `run.driverHealth` | records | `project_get/list`, `workflow_list_runs` stall block |
| Run record itself | `runs/{runId}.json`: per-node `status`, `startedAt/completedAt/durationMs`, `warnings[]`, `errors[]`, `errorHistory[]` (superseded attempts), `dispatch`/`lastDispatch` (which driver, when, timeout, endpoint visible?), `skip` record, `provenance{promptVersion, model}`, `toolCalls[]` stubs; run-level `warnings[]`, `driverHealth`, `retryBackoffUntil` | JSON | `workflow_get_run` (compact by default; `detail:"full"`), UI |
| Structured stage events inside outputs | `event: "publication_decision" | "publish_execution" | "release_execution" | "operator_publish_decision" | "budget_halt" | "blockers_advisory" | "blockers_waived" | "content_class"` | inside stage outputs / warnings | readers of the run |
| Usage / cost | `usage/by-run/{runId}/*` — tokens, `costUsdEstimate` (placeholder catalog, version-stamped), `status: estimated|actual`, `metadata` (never prompts/secrets) | records | `usage_*`, `workflow_get_run_cost`, budget gates |
| Node timings | `node_timings/by-workflow/…` — duration, cost, outcome per terminal node state | records | p95 for stall assessment, `get_run_cost` |
| Repository health | `repository_get_health`: backend, readable/writable per repo, `workspaceVersion`, build identity (`K_REVISION`, `K_SERVICE`; `SERVICE_GIT_SHA`/`SERVICE_DEPLOYED_AT` unwired → null), dialect drift, healed nodes | JSON | UI overview, deploy verification |
| Change history | `changes/*`, `revisions/*` with actor, source, reason, before/after, `correlation{runId, requestId}` | records | UI History, `changes_*` |
| Constellation metrics | `observability/constellationMetrics.ts` — attention feed (failed runs, approvals, degraded storage, unconfigured projects), relationship strength from runs | computed on read (full-fleet run scan) | UI |
| Legacy adapter | `observability/consoleObservability.ts` (`agent.run.started/ended/errored`, `agent.tool.called`) | console | only `runAgent.ts` (legacy) |
| OpenAI Agents tracing | `AGENT_TRACING_ENABLED=true` attaches trace metadata to SDK runs | provider-side | OpenAI dashboard (not wired by default) |

## 2. What does not exist

- **No per-request application log for MCP calls**: `mcpEndpoint.ts` mints a `requestId` (`req_<ts>_<rand>`) but never logs it; tool name, caller, latency and outcome are not written anywhere except (for mutations) the change history and (for run advances) the run record. Cloud Run's HTTP log shows only `POST /mcp 200`. (K-O1)
- No tracing library (no OpenTelemetry/Langfuse/Sentry in `package.json`); no span propagation to tenant MCP calls.
- No metrics exporter; no alerting definitions in the repo (Cloud Scheduler failure alerts on the jobs are assumed, not configured here).
- No log for the in-request run drivers (`workflow_run_*`) beyond the run record.
- Tool-execution audit (`tools/toolExecutor.ts`) is an in-process map: `tool_list_executions` returns nothing from other instances or after a restart; the per-node `toolCalls[]` stubs are the durable trace.

## 3. Run correlation

| Identifier | Minted by | Propagates to |
|---|---|---|
| `runId` (`run_<ms>_<rand>`) | `startDryRun` | usage, node timings, artifacts blobs, tick ledger, change correlation (`correlation.runId`), observations (`runId`), trial runs (`trial_` prefix) |
| `requestId` (`req_<ms>_<rand>`) | run creation (platform/workspace join key) | every usage record of the run; **not** a publish id |
| `publishRequestId` (`req_<flow>_<topic>_<yyyymmdd>_<nn>`) | operator / `artifact_plan` / conductor mint | tenant object (`requested_id`), release ledger key, publish receipts |
| MCP `requestId` | `buildToolContext` | change history `correlation.requestId` only |
| `tickId` | tick | stdout line + `ticks/{tickId}.json` + `run.driverHealth` |
| `turnId` / `conversationId` | Platform | claims, mirror, usage `metadata` |
| `K_REVISION` | Cloud Run | `repository_get_health.build.revision` — "which build answered" |

## 4. Debugging recipes

| Symptom | Where to look |
|---|---|
| Run "running" forever | `workflow_get_run` → `stall` block (`assessRunStall`): in-flight node's `dispatch.dispatchedAt/timeoutMs/driver`, `driverHealth.lastSeenByTickAt/lastRefusal`; tick stdout lines; `ticks/` ledger |
| Node failed, reason gone after retry | `nodes[].errorHistory[]` (bounded attempts with code/message/driver) |
| Half the nodes fail with "endpoint not configured" | `nodes[].lastDispatch.projectEndpointConfigured` + `driver` — one plane lacks the tenant env; `project_get.connection.endpointSource/tokenSource` |
| Which commit is live | `repository_get_health.build.revision` → Cloud Run revision → image tag = SHORT_SHA; or `cloud-run-plane.yml` `report` |
| Publish refused | `stageOutputs.publish_executor` receipt (`gates[]` with reasons), `approvalsRequired[].gateId`, `operatorPublishDecision`, `publishingPolicySnapshot` |
| Cost overrun | `workflow_get_run_cost` ledger (per node, most expensive, budget), `usage_list_records {runId}` |
| Store degraded | `repository_get_health.storageHealth` + per-repo `details` (`healedDroppedNodes`, `objectDialectFindings`) |
| Who changed a prompt | `changes_list {target node}` → actor/source/reason/correlation; `changes_compare` |

## 5. Recommendations (not implemented)

Log one structured line per MCP `tools/call` (tool, actor kind, project arg, latency, ok/code, requestId, `K_REVISION`); wire `SERVICE_GIT_SHA`/`SERVICE_DEPLOYED_AT` in the deploy; export tick/run outcome counters; add a retention job for `runs/` and `usage/` ([KNOWN_ISSUES.md](KNOWN_ISSUES.md) K-O1, K-P5).
