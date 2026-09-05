# Data entity reference

Machine-friendly reference for every persisted entity: name, purpose, type source, id strategy, lifecycle, parent/references, versioning, timestamps, writers, readers, storage key, concurrency, migration, deletion, and a representative JSON example derived from the TypeScript types. Narrative and authority matrix: [../DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md). Keys are GCS object names under optional `GCS_KEY_PREFIX`.

Conventions: `writers`/`readers` name modules; "CAS" = compare-and-swap on the store ETag/generation; "unconditional" = last write wins.

---

## WorkspaceDocument

| Field | Value |
|---|---|
| Purpose | The single authoring document: node definitions (store overlay), conversational agents, relationships, stage-output mirror, learning observations, legacy events/versions, reduced-contract cache |
| Type | `WorkspaceDocument` — `src/agent/mcp/workspace/store.ts:61`; zod `workspaceDocumentSchema` `:198` |
| Id | fixed key |
| Key | `workspace/current.json` |
| Version | `schemaVersion: 1` (literal); `workspaceVersion` (monotonic per mutation); `currentRevisionId` (change-history chain) |
| Timestamps | `updatedAt` |
| Lifecycle | seeded from canonical nodes + seeded agents on first read (create-only); mutated in place forever |
| Parent / refs | contains nodes (`id`), agents (`agt_*`), relationships (`sourceId`/`targetId` → node ids), stage outputs, observations; `currentRevisionId` → `revisions/{id}` |
| Writers | `WorkspaceStateStore.mutate` (all `workspace_*`, `agent_update`, `skill_assign/unassign`, `stage_save_output`, `learning_*`, `changes_restore`, `optimizer_promote`, executor stage mirror, seeding) |
| Readers | every MCP read, `resolveConductorNodes`, runners (via nodes), UI |
| Concurrency | ETag CAS + `expectedWorkspaceVersion` + `baseRevisionId`; stale-read retry ×4 |
| Migration | zod defaults for later fields; tolerant parse drops invalid nodes and heals; canonical seed top-ups |
| Deletion | never; observations soft-deleted; `events[]` unbounded |

```json
{
  "schemaVersion": 1,
  "workspaceVersion": 412,
  "updatedAt": "2026-09-04T18:21:07.113Z",
  "currentRevisionId": "rev_1788200467113_k3d9qa",
  "nodes": [ { "$ref": "#WorkspaceNode" } ],
  "conversationalAgents": [ { "$ref": "#ConversationalAgentDefinition" } ],
  "relationships": [ { "id": "rel_1788100000000_ab12cd", "kind": "data", "sourceId": "research", "targetId": "draft_writer", "direction": "forward", "enabled": true, "createdAt": "…", "updatedAt": "…" } ],
  "stageOutputs": [ { "id": "stage_1788200467000_x1y2z3", "stage": "article_body", "value": { "clientObjectType": "content_item" }, "createdAt": "…" } ],
  "learningObservations": [ { "$ref": "#LearningObservation" } ],
  "versions": [],
  "events": [ { "id": "event_1788200467113_q9w8e7", "type": "node.prompt_updated", "nodeId": "draft_writer", "actor": "wolf", "workspaceVersion": 412, "beforeHash": "1a2b", "afterHash": "3c4d", "createdAt": "…" } ],
  "reducedContractCache": [ { "key": "dr-lurie:content_item:9f8e…", "projectId": "dr-lurie", "objectType": "content_item", "fingerprint": "9f8e…", "reduced": {}, "createdAt": "…" } ]
}
```

## WorkspaceNode

| Field | Value |
|---|---|
| Purpose | Stage definition (see [AGENT_ARCHITECTURE.md](../AGENT_ARCHITECTURE.md) §1) |
| Type | `WorkspaceNode` — `src/agent/workspace/nodeTypes.ts`; zod `workspaceNodeSchema` (`store.ts:141`, passthrough) |
| Id | human slug (`draft_writer`); canonical ids fixed in code |
| Key | inside `workspace/current.json`; canonical copies in code |
| Version | none per node (`updatedAt`); `provenance.promptVersion` hash captured on runs |
| Writers | `workspace_*` tools, `skill_assign`, `optimizer_promote`, seeding, `scripts/reseedStoreFromCanonical.ts` |
| Readers | `resolveConductorNodes` (overlay: store owns `name, description, prompt, schema, inputSchema, outputSchema, allowedTools, assignedSkills, modelConfig, executionConfig, metadata`; canonical pins `id, dependsOn, produces, riskLevel, position, status`) |
| Deletion | `workspace_delete_node` (canonical nodes guarded) |

```json
{
  "id": "draft_writer", "name": "Draft Writer", "kind": "drafting", "description": "…",
  "prompt": "Write the first full draft …",
  "inputSchema": { "type": "object" },
  "outputSchema": { "type": "object", "required": ["draft"], "properties": { "draft": { "type": "string" } } },
  "allowedTools": ["workspace.get_node", "stage.get_output", "stage.list_outputs"],
  "assignedSkills": ["editorial_craft"],
  "requiredInputs": ["brief_architect"], "produces": ["draft.v1"],
  "riskLevel": "read", "dependsOn": ["brief_architect"], "status": "active",
  "position": { "x": 0, "y": 1000 }, "updatedAt": "2026-08-30T10:00:00.000Z",
  "metadata": { "publishPayloadDeterministic": true },
  "modelConfig": { "provider": "openai", "model": "gpt-5.5", "maxTurns": 4, "toolCallLimit": 2, "timeout": 300000, "budgetUsd": 0.5, "maxOutputTokens": 8000 },
  "executionConfig": {}
}
```

## ConversationalAgentDefinition

| Field | Value |
|---|---|
| Purpose | `client_manager` chat agent definition used by `agent_converse` |
| Type | `src/agent/conversations/agentDefinitions.ts`; zod in `store.ts:163` (strict) |
| Id | `agt_[a-z0-9_]+` (canonical `agt_client_manager`); `agent_resolve` returns `agt_client_manager@<rev>` pinned refs |
| Key | `workspace/current.json.conversationalAgents[]` |
| Version | `rev` (incremented on update and canonical prompt upgrade) |
| Writers | seeding/upgrade (`ensureConversationalAgentSeeds`), `agent_update` |
| Readers | `agent_*`, `ConversationalRunner.resolveAgent` |

```json
{ "id": "agt_client_manager", "role": "client_manager", "name": "Client Manager", "prompt": "…", "modelConfig": { "provider": "openai", "model": "gpt-4.1", "timeoutMs": 90000, "maxOutputTokens": 16000 }, "skills": [], "status": "active", "rev": 3, "updatedAt": "…" }
```

## LearningObservation

| Field | Value |
|---|---|
| Type | `store.ts:32`; zod `learningObservationSchema` (strict) |
| Id | `learning_<ms>_<rand>` |
| Key | `workspace/current.json.learningObservations[]` (NOT `learning/*.json`) |
| Lifecycle | `status` absent/`active` → `archived` (`archivedAt`, `archivedReason`) |
| Refs | `runId`, `nodeId` (top-level and mirrored into `metadata`) |
| Writers | `learning_record_observation`, controlled tool, publisher, executor termination hook |
| Readers | `learning_list_observations` (defect C-1 on blob backends), `playbook_migrate_observations` |

```json
{ "id": "learning_1788200000000_ab12cd", "observation": "Live publish executed for dr-lurie request req_dtc_retinol_20260904_01.", "metadata": { "type": "publish_executed", "projectId": "dr-lurie", "requestId": "req_dtc_retinol_20260904_01", "runId": "run_1788199000000_x9y8z7" }, "runId": "run_1788199000000_x9y8z7", "createdAt": "…" }
```

## WorkflowExecutionRecord (Run)

| Field | Value |
|---|---|
| Purpose | Complete execution state of one workflow run |
| Type | `src/agent/workspace/executionTypes.ts:209` |
| Id | `run_<epochMs>_<6 base36>` (`makeRunId`); `trial_` prefix for replay runs |
| Key | `runs/{runId}.json`; index entry in `run-index/{projectId}.json` |
| Version | `rev` (CAS counter); no schema version |
| Timestamps | `startedAt`, `updatedAt`, `completedAt`; per node `startedAt/completedAt/durationMs`; `dispatch.dispatchedAt` |
| Parent / refs | `projectId` → project; `workflowId` → registry; node ids → canonical nodes; `requestId` (platform join key); `publishRequestId` (tenant object); `entrypoint.nodeId`; `releaseLedger[runId:requestId]` |
| Writers | executor (`createRun/saveRun/resetRun`), `workflow_*` status setters, tick (`driverHealth`), conductor job (`warnings`) |
| Readers | drivers, MCP `workflow_*`/`node_*`, publisher, constellation, tick, UI |
| Concurrency | `withRunLock` + CAS on `rev`; dispatch claims |
| Lifecycle | `queued → running → completed|failed|blocked|cancelled|paused`; reset rebuilds from `initialInput`/`entrypoint` preserving `requestId`, `operatorPublishDecision`, `publishingPolicySnapshot`, `nodeBudgetOverrides` |
| Deletion | never |

```json
{
  "runId": "run_1788199000000_x9y8z7", "workflowId": "publishing_conductor", "projectId": "dr-lurie",
  "requestId": "req_1788199000000_q1w2e3", "publishRequestId": "req_dtc_retinol_20260904_01",
  "status": "running", "currentNodeId": "article_body", "startedAt": "…", "updatedAt": "…",
  "executionMode": "openai", "dryRun": true, "rev": 37, "budgetUsd": 6,
  "publishingPolicySnapshot": { "autonomyMode": "autonomous", "publishEnabled": true, "publishableTypes": ["content_item"] },
  "operatorPublishDecision": "approved", "operatorDecisionSource": "explicit",
  "initialInput": { "instructions": "…", "trafficSource": "meta_ads", "awarenessStage": "problem_aware" },
  "nodes": [
    { "nodeId": "input_triage", "status": "completed", "startedAt": "…", "completedAt": "…", "durationMs": 8123, "output": {}, "produces": ["triage.v1"], "provenance": { "promptVersion": "9a1c…", "model": "gpt-5.5", "capturedAt": "…" }, "toolCalls": [ { "toolId": "stage.list_outputs", "status": "success", "durationMs": 40 } ], "lastDispatch": { "dispatchedAt": "…", "driver": "continuation_tick", "projectEndpointConfigured": true } },
    { "nodeId": "emotional_resonance", "status": "skipped", "skip": { "reason": "content class has no emotional review", "predicate": { "when": "content_class", "in": ["reference"] }, "evaluatedAt": "…" } },
    { "nodeId": "article_body", "status": "running", "dispatch": { "dispatchedAt": "…", "timeoutMs": 300000, "driver": "http_run_all", "projectEndpointConfigured": true }, "errorHistory": [ { "attempt": 1, "status": "failed", "code": "model_timeout", "dispatchedAt": "…", "driver": "continuation_tick", "recordedAt": "…" } ], "retry": { "attempt": 1, "notBefore": "…", "code": "model_timeout", "scheduledAt": "…" } },
    { "nodeId": "publish_executor", "status": "queued", "produces": ["publish_execution.v1"] }
  ],
  "artifacts": [ { "id": "artifact_1788199100000_a1b2c3", "nodeId": "input_triage", "type": "triage.v1", "value": {}, "createdAt": "…" } ],
  "stageOutputs": { "input_triage": {}, "research": {} },
  "errors": [], "warnings": ["driver_env_missing:DR_LURIE_MCP_ENDPOINT"],
  "approvalsRequired": [ { "nodeId": "publish_executor", "type": "approval_required", "reason": "…", "requestedAt": "…", "pending": true, "gateId": "publishing_conductor.publish_executor" } ],
  "driverHealth": { "lastSeenByTickAt": "…", "lastDrivenAt": "…", "silentTicks": 0 },
  "releaseLedger": { "run_1788199000000_x9y8z7:req_dtc_retinol_20260904_01": { "status": "pending", "requestId": "req_dtc_retinol_20260904_01", "performedAt": "…", "attempts": 1, "idempotencyKey": "release:run_1788199000000_x9y8z7:obj_123" } }
}
```

## RunIndexEntry / RunIndexBlob / RunIndexMeta

| Field | Value |
|---|---|
| Purpose | Compact per-project listing index so `workflow_list_runs` windows before fetching run blobs |
| Type | `src/agent/repository/blobs/BlobExecutionRepository.ts:24-33` (module-private) |
| Key | `run-index/{encodeURIComponent(projectId)}.json`, `run-index/!meta.json` |
| Writers | `createRun/saveRun/resetRun` upsert (CAS ×5 then unconditional); backfill on first read when meta absent; prune of ghosts |
| Deletion | ghost entries pruned; blobs never deleted |

```json
{ "runs": [ { "runId": "run_…", "projectId": "dr-lurie", "workflowId": "publishing_conductor", "status": "completed", "startedAt": "…", "updatedAt": "…", "requestId": "req_…" } ] }
```
```json
{ "backfilledAt": "2026-08-27T09:00:00.000Z" }
```

## ExecutionArtifact (blob copy)

| Field | Value |
|---|---|
| Type | `executionTypes.ts:180`; blob shape `{ runId, artifact }` (`BlobArtifactRepository.ts:6`) |
| Id | `artifact_<ms>_<rand>` (`buildArtifact`) |
| Key | `artifacts/{artifactId}.json` (duplicate of `run.artifacts[]`) |
| Writers | `persistArtifacts` on every run save (unconditional) |
| Readers | `BlobArtifactRepository.listArtifacts(runId)` (full prefix scan), `node_list_outputs` |
| Deletion | `resetRun` deletes the run's previous artifact blobs |

```json
{ "runId": "run_…", "artifact": { "id": "artifact_…", "nodeId": "article_body", "type": "article_body.v1", "value": { "clientObjectType": "content_item", "body": {} }, "createdAt": "…" } }
```

## ProjectConnectionConfig

| Field | Value |
|---|---|
| Purpose | Tenant/service registration: connection references, tool policy, publishing/capture policy, object dialect, site binding |
| Type | `src/agent/projects/projectTypes.ts` |
| Id | `projectId` `^[a-z0-9][a-z0-9-]{1,62}$` |
| Key | `projects/{projectId}.json` |
| Version | `definitionVersion` (code defaults migrate on read) |
| Writers | seed/migration (`BlobProjectRepository.ensureSeeded/get`), `project_create/update/delete`, genesis (`clientSiteBinding`, `mcpEndpoint`, `tokenSecretRef`), reconciler |
| Readers | executor preflight, adapter, publisher, converse, `project_*`, health (dialect audit) |
| Concurrency | unconditional (K-P4) |
| Deletion | `project_delete` (defaults refused; they re-seed) |

```json
{
  "projectId": "dr-lurie", "definitionVersion": 5, "name": "Dr. Lurie",
  "mcpEndpointEnvVar": "DR_LURIE_MCP_ENDPOINT", "mcpEndpoint": "https://drluriescience.netlify.app/mcp",
  "authMode": "bearer_env", "tokenEnvVar": "DR_LURIE_MCP_TOKEN", "tokenSecretRef": "projects/cms-agent-503015/secrets/dr-lurie-mcp-token/versions/latest",
  "allowedTools": [], "defaultToolPolicy": "allowed", "toolPolicies": { "wipe_blob_stores": "needs_approval" },
  "contentContract": { "contentContract": "content_source.v1" },
  "objectDialect": { "siteObjectId": "site_drlurie", "taxonomyRegistryObjectId": "taxonomy_registry", "objectIdSource": "request_id", "requestIdPattern": "^req_[a-z0-9_]+_\\d{8}_\\d{2}$", "defaultObjectType": "content_item", "voiceObjectId": "editorial_voice" },
  "publishingPolicy": { "publishEnabled": true, "requiresExplicitPublish": true, "description": "…", "autonomyMode": "autonomous" },
  "capturePolicy": { "maxPages": 0, "allowedCrawlOrigins": [], "allowedPathPrefixes": [], "sameOriginOnly": true, "respectRobots": true, "concurrency": 1, "delayMs": 1500, "authenticatedAccess": "prohibited", "rights": { "content": "prohibited", "media": "prohibited" }, "designReferences": [], "fidelity": { "mode": "source_faithful", "sourceDesignTreatment": "source_content_and_design" } },
  "clientSiteBinding": { "netlifySiteName": "drluriescience", "netlifySiteId": "…" },
  "status": "active"
}
```

## SkillDefinition / SkillVersionSnapshot / SkillEvent

| Field | Value |
|---|---|
| Type | `src/agent/skills/skillTypes.ts` |
| Id | `skillId` slug; `versionId`; `eventId` |
| Keys | `skills/current/{skillId}.json`, `skills/versions/{skillId}/{versionId}.json`, `skills/events/{eventId}.json` |
| Version | `version` string on the skill; `skillVersion` counter across the registry (max event version) |
| Writers | `BlobSkillRepository.save` — rewrites every current/version/event blob and deletes removed current blobs (no CAS) |
| Readers | `skill_*`, `skillResolver`, `node_get_effective_skills` |

```json
{ "skillId": "editorial_craft", "name": "Editorial craft", "description": "…", "version": "1.2.0", "status": "active", "instructions": "…", "inputSchema": {}, "outputSchema": {}, "allowedTools": ["stage.get_output"], "requiredArtifacts": [], "producedArtifacts": [], "examples": [], "preconditions": [], "completionCriteria": [], "blockerCriteria": [], "memoryPolicy": { "namespaces": [], "read": false, "write": false }, "toolPolicy": { "allow": [], "deny": [] }, "riskLevel": "read", "metadata": {}, "createdAt": "…", "updatedAt": "…" }
```

## WorkspaceChangeEvent / WorkspaceRevision (RecordEnvelope)

| Field | Value |
|---|---|
| Type | `src/agent/workspace/changeTypes.ts`; envelope `src/agent/repository/RecordEnvelope.ts` |
| Id | `evt_<ms>_<rand>`, `rev_<ms>_<rand>` |
| Keys | `changes/{eventId}.json`, `revisions/{revisionId}.json` |
| Version | envelope `schema_version` `workspace_change_event.v1` / `workspace_revision.v1` |
| Writers | `WorkspaceStateStore.mutate` → change sink (append-only) |
| Readers | `changes_*`, `getVersions`, UI History |
| Refs | `parentRevisionId`, `resultingRevisionId`, `baseRevisionId`, `correlation{runId, requestId}`, `target{type,id}` |

```json
{ "id": "evt_…", "record_type": "workspace_change_event", "schema_version": "workspace_change_event.v1", "created_at": "…", "updated_at": "…", "data": { "eventId": "evt_…", "type": "node.prompt_updated", "operation": "update", "target": { "type": "node", "id": "draft_writer" }, "actor": { "kind": "human", "id": "usr_wolf" }, "source": "mcp", "reason": "tighten hook", "parentRevisionId": "rev_…", "resultingRevisionId": "rev_…", "workspaceVersion": 412, "riskLevel": "read", "before": { "prompt": "…" }, "after": { "prompt": "…" }, "correlation": { "requestId": "req_…" }, "createdAt": "…" } }
```

## ModelUsageRecord

| Field | Value |
|---|---|
| Type | `src/agent/observability/modelUsageTypes.ts` |
| Id | `usageId` (`usage_…`) |
| Key | `usage/by-run/{runId}/{usageId}.json` or `usage/{usageId}.json` |
| Writers | runners (`actual`), executor mock estimates (`estimated`), `usage_record`, conversational runner |
| Readers | `summarizeModelUsage` (budget gates, `workflow_get_run_cost`), `usage_*`, model ladder |

```json
{ "usageId": "usage_…", "runId": "run_…", "workflowId": "publishing_conductor", "projectId": "dr-lurie", "nodeId": "draft_writer", "requestId": "req_…", "model": "gpt-5.5", "provider": "openai", "inputTokens": 18234, "outputTokens": 4210, "totalTokens": 22444, "cachedInputTokens": 1200, "costUsdEstimate": 0.2175, "currency": "USD", "status": "actual", "recordedAt": "…", "pricingAsOf": "2026-07-31", "pricingCatalogVersion": "2026-07-31.1", "metadata": { "driver": "continuation_tick" } }
```

## NodeTimingRecord

Key `node_timings/by-workflow/{workflowId}/{timingId}.json`; type `src/agent/workspace/nodeTimings.ts`; written by the executor after each terminal node state; read for p95 stall scaling and `workflow_get_run_cost`.

```json
{ "timingId": "timing_…", "runId": "run_…", "workflowId": "publishing_conductor", "nodeId": "research", "durationMs": 91230, "costUsd": 0.84, "outcome": "completed", "recordedAt": "…" }
```

## TickLedgerEntry / TenantDriverHealth

Keys `ticks/{tickId}.json` (48 h retention) and `driverHealth/{projectId}.json`; type `src/agent/workspace/driverHealth.ts`; written by the tick / conductor job (best-effort); read by `project_get/list`, stall block.

```json
{ "tickId": "tick_20260904T140200Z_ab12", "startedAt": "…", "finishedAt": "…", "scanned": 63, "driven": [ { "runId": "run_…", "code": "reenter_running", "statusBefore": "running", "statusAfter": "running", "steps": 1 } ], "refusals": [ { "runId": "run_…", "code": "skip_not_active" } ] }
```
```json
{ "projectId": "dr-lurie", "lastBackgroundDispatchAt": "…", "driver": "continuation_tick", "runId": "run_…" }
```

## EvalRubric / EvalRubricVersionSnapshot / EvalResult / PairwiseResult / FeedbackRecord / RegressionReport

Types in `src/agent/improvement/improvementTypes.ts`; keys `evaluation/rubrics/{rubricId}.json`, `evaluation/rubric-versions/{rubricId}/{versionId}.json`, `evaluation/results/{evalId}.json`, `evaluation/pairwise/{comparisonId}.json`, `evaluation/feedback/{feedbackId}.json`, `evaluation/regression/{reportId}.json` (RecordEnvelope); writers `evaluation_*`, `feedback_*`, judge, regression gate, ingestion jobs; readers optimizer, ladder, fine-tune readiness.

```json
{ "evalId": "eval_…", "rubricId": "rubric_draft_writer_v1", "nodeId": "draft_writer", "runId": "run_…", "subjectHash": "…", "subject": { "model": "gpt-5.5", "provider": "openai", "executionMode": "openai" }, "scores": [ { "criterionId": "hook", "score": 0.8 } ], "normalizedScore": 0.81, "pass": true, "judge": { "mode": "openai", "model": "gpt-5.5" }, "createdAt": "…" }
```
```json
{ "feedbackId": "fb_…", "kind": "outcome", "nodeId": "draft_writer", "runId": "run_…", "outcome": { "source": "tracking_sink", "metrics": { "sessions": 412, "engaged_rate": 0.37 } }, "actor": { "kind": "agent", "label": "tracking_ingest_job" }, "createdAt": "…" }
```

## ImprovementProposal / TrialRecord / EvalDataset / NodePlaybook

Keys `improvement/proposals/{proposalId}.json`, `improvement/trials/{trialId}.json`, `improvement/datasets/{datasetId}.json`, `improvement/playbooks/{nodeId}.json`; unconditional writes; proposal `status ∈ proposed|trialed|promoted|rejected`, `baselinePromptHash` guards promotion.

```json
{ "nodeId": "draft_writer", "items": [ { "id": "pb_…", "kind": "pitfall", "text": "Do not open with a definition.", "helpful": 4, "harmful": 0, "provenance": { "evalIds": ["eval_…"] }, "createdAt": "…" } ], "budget": { "maxItems": 12, "maxChars": 2400 }, "version": 7, "updatedAt": "…" }
```

## ConversationMirrorEntry (turn / trim_marker / supersession_tombstone) and ConversationTurnClaim

Types `src/agent/conversations/conversationTurnTypes.ts`; keys `conversations/{conversationId}.json` (array, ≤200 turns, CAS) and `conversation-turn-claims/{conversationId}/{turnId}.json` (CAS, never deleted); writers `ConversationalRunner`, GC job; readers audit, GC.

```json
[ { "recordType": "trim_marker", "conversationId": "obj:page_home", "projectId": "platform", "trimmedTurnCount": 12, "createdAt": "…" },
  { "recordType": "turn", "turnId": "t_run_123_0", "conversationId": "obj:page_home", "projectId": "platform", "agentRef": "agt_client_manager@3", "agentRev": "3", "actor": { "kind": "human", "id": "usr_123" }, "requestPreview": { "latestUserText": "Tighten the hero." }, "assistantText": "I can propose that change.", "toolCalls": [ { "id": "call_1", "name": "patch", "args": {} } ], "usage": { "inputTokens": 120, "outputTokens": 30, "costUsd": 0.00048 }, "createdAt": "…" } ]
```
```json
{ "conversationId": "obj:page_home", "turnId": "t_run_123_0", "requestHash": "…", "ownerToken": "uuid", "status": "completed", "response": { "assistant_text": "…", "usage": {}, "agent_rev": 3, "model": "gpt-4.1" }, "updatedAt": "…" }
```

## MemoryEnvelope (client memory) and TemplateLibraryRecord

Keys `memory/{projectId}.json` (ETag CAS) and `library/{templateId}/{version}.json` + `latest.json`; types `src/agent/memory/memoryEnvelope.ts`, `src/agent/library/templateLibraryTypes.ts`; content-hash versioning for the library.

```json
{ "templateId": "tpl_hero_split_a1b2", "version": 2, "objectType": "section_template", "name": "Hero split", "recipe": {}, "sectionTypesUsed": ["hero"], "provenance": { "runId": "run_…", "nodeId": "recipe_mint" }, "sourceProjectId": "zilberman", "contentHash": "…", "publishedAt": "…" }
```

## ManagedScopedBearerDocument

Key `auth/managed-scoped-bearers.v1.json` (single fleet document, CAS ×8, `revision`); type `src/agent/mcp/auth/managedScopedBearerCredentials.ts`; digests only.

```json
{ "contract": "managed_scoped_bearers.v1", "revision": 9, "credentials": [ { "digest": "<64 hex>", "projects": ["zilberman"], "toolAllowlist": ["agent_resolve", "agent_converse", "workspace_get_nodes", "workflow_start_dry_run", "workflow_run_all", "workflow_get_run", "workflow_get_run_cost", "workflow_publish_readiness", "workflow_publish_run", "workflow_set_operator_publish_decision", "visual_identity_propose"], "createdAt": "…", "netlifySiteId": "…", "netlifySiteName": "zilbermanfilmfoundation", "state": "active" } ] }
```

## McpSession and OAuth records (TTL envelopes)

Keys `mcp/session/{id}`, `mcp/oauth/client/{clientId}`, `mcp/oauth/code/{hash}`, `mcp/oauth/token/{hash}`, `mcp/oauth/refresh/{hash}`; envelope `{ value, expiresAt }` (`stateStore.ts`); expiry enforced on read; clients have no TTL.

```json
{ "value": { "id": "mcps_…", "protocolVersion": "2025-06-18", "clientInfo": { "name": "claude-ai" }, "actor": { "kind": "human", "id": "usr_wolf" }, "createdAt": "…", "lastSeenAt": "…", "expiresAt": "…" }, "expiresAt": 1788243600000 }
```
