# W8.1 — artifact_materializer design spec

Decided 2026-08-31. Supersedes nothing; implemented by W8.2–W8.4.

## Node split

| node | kind | model | emits |
|---|---|---|---|
| `artifact_plan` (existing id) | adapter | **one turn, `allowedTools: []`** | `materialization_spec.v1` |
| `artifact_materializer` (**new**) | executor | **none** | `artifact_plan.v1` — unchanged shape |

Topology: `brief_architect` + `contract_intelligence` → `artifact_plan` → `artifact_materializer` → `article_body`;
`publish_payload.dependsOn` → `artifact_materializer` (was `artifact_plan`).
`artifact_plan` keeps its `skipWhen {when: "no_media_slots"}`; `artifact_materializer` gets the same predicate, so a
zero-media run skips both and `publishRequestId.ts`'s mint-at-skip path is unchanged.

## Correction to the W8/W9 plan

The plan states downstream is untouched because the artifact is still `artifact_plan.v1`. That is true of the *shape*
and false of the *binding*: three readers key on the **node id** `artifact_plan`, not on the artifact name.

1. `runContext.ts` `buildRunContext` — `stageOutputs.artifact_plan.requestId` (the publish request-id lift).
2. `readinessContentChecks.ts` `artifactPlanVerifiedMediaRefsOf` — `stageOutputs.artifact_plan`.
3. `contentItemShell.ts` `readContentItemShell` — `run.nodes.find(n => n.nodeId === "artifact_plan")`.

Fix: one leaf module `src/agent/workspace/materializedPlan.ts` (no imports, so no cycle — `readinessContentChecks.ts`
lives under `projects/` and must not pull in a `workspace/` graph) exporting the preference order
`["artifact_materializer", "artifact_plan"]` plus `materializedPlanOf(stageOutputs)` and `materializerNodeIds`. All three
call sites read through it. The fallback is not cosmetic: late-stage-entry runs seed `artifact_plan`'s output directly,
and every run recorded before this change carries the plan under the old id.

## Files

- `src/agent/workspace/artifactMaterialization.ts` — **new**, the engine. Computes only; the executor owns every state
  transition. Mirrors `captureConductorRoutes.ts` exactly, including its three outcomes.
- `src/agent/workspace/materializedPlan.ts` — **new**, the leaf reader above.
- `src/agent/workspace/executor.ts` — new branch, gated on `metadata.artifactMaterializerDeterministic === true`, placed
  beside the capture/clone branches and **after** the T14.4 dispatch-claim stamp (whose condition gains
  `readArtifactMaterializer(nextNode) !== undefined` — this stage reaches the network and must not look idle to
  `assessRunStall`). The S3-item-8 content-item shell trigger moves from `nextNode.id === "artifact_plan"` to
  `"artifact_materializer"`: the shell must exist before the artifact bridge's first create, and `artifact_plan` no
  longer creates anything.
- `nodes.ts` / `publishingTail.ts` — topology + the `artifact_plan` limit revert (W8.4).

## Outcomes (identical contract to `CaptureStageOutcome`)

- `completed` — every slot terminal. Executor validates against the node's own `outputSchema`, completes, records **no**
  usage (R-20: a $0 event stays $0).
- `pending` — ≥1 slot non-terminal. Executor re-queues (`status: "queued"`, drop `startedAt`/`dispatch`), persists job
  state, `run.currentNodeId` stays. Never a wait loop inside one 30s project-call window.
- `refused` — live run blocks with the code verbatim; mock run falls through to `MockNodeRunner` with a run-visible
  warning, so CI graph traversal keeps working.

## Per-dispatch loop

Cross-dispatch state lives in `run.stageOutputs["artifact_materializer:jobs"]` (`:`-suffixed so it can never collide
with a node id), shape `{ dispatches: number, slots: { [slotId]: { jobId?, status, attempts, createdAt, updatedAt,
artifact?, publicPath?, error? } } }`.

For each slot, in order, **one** bridge round trip per dispatch:

1. **adopt** — `get_agent_artifact_by_slot {site_id, request_id, slot}`. A materialized artifact is this slot's canonical
   one: record key/sha256/contentType/size/publicPath, mark `has_trusted_artifact`, **create nothing**. This is what
   makes a re-run free.
2. **create** — only when adoption found nothing *and* no `jobId` is persisted. `create_agent_artifact_job`
   `{site_id, request_id, artifact_kind, filename, slot, idempotency_key: "<runId>:<requestId>:<slotId>", wait: false}`
   plus `prompt` + `requirements` (image) or `template_id` + `data` (pdf). **`wait: false`** deliberately: the bridge's
   default inline wait makes a 4-slot dispatch's duration unbounded inside a 30s window. The `jobId` is persisted
   **before** the first poll, so no key can ever get a second job.
3. **poll** — `get_agent_artifact_job_status {site_id, request_id, job_id}`, once. Terminal success → record evidence,
   `has_trusted_artifact`. Terminal failure → slot `blocked`, carrying the job's `errorDetail` verbatim (including
   `renderer_unavailable:*` / `RENDERER_MISMATCH`). Running → leave pending, `attempts++`.

`site_id` comes from the project's `objectDialect.siteObjectId` (same source as `captureSiteObjectId`); absent ⇒
refusal, never a guess. `request_id` is `spec.requestId`; absent ⇒ refusal.

Bound: `metadata.maxPollDispatches` (default **40**). Exceeded ⇒ `refused`
(`artifact_materialization_poll_budget_exhausted`), retryable — the persisted `jobId`s mean a retry adopts.

## `materialization_spec.v1`

`{artifact, summary, clientProjectId, clientObjectType, contractSource?, artifactProtocol?, requestId,
requestIdConvention?, slots: [{slotId, purpose, placement?, desiredKind: "image"|"pdf", prompt?, styleRefs?,
requirements?, templateId?, renderData?}], notes?, blockers?}`.

Same `if/then` guard as today: a non-empty `slots` requires `artifactProtocol`.

## Acceptance (W8.3)

Mocked bridge, `tests/agent/workspace/artifactMaterialization.test.ts`:
(a) 3 images + 1 PDF materialize across N dispatches with **exactly 4** create calls;
(b) re-run after completion → **0** creates;
(c) PDF terminal failure → `blocked` carrying the renderer error verbatim;
(d) the emitted envelope validates against the existing `artifact_plan` `outputSchema`;
(e) total model calls = **0**.
