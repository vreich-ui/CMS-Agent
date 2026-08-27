# WP-00 Contract Capture — Conductor Workbench Pass 2

Live capture against the Cloud Run CMS_Agent MCP workspace, 2026-08-26. One JSON envelope per verb
at the top level of this directory (`<verb>.json`), raw payloads under `raw/`. `README.md` (this
file) is the index.

Node ids used for per-node captures: `draft_writer` (publishing_conductor), `capture_crawl`
(capture_conductor), `clone_intake` (clone_conductor). Run ids used: `run_1787690045355_411vjm`
(newest, failed) and `run_1787678554270_stw73q` (2nd-newest, cancelled, richest node detail).
Project id used where required: `dr-lurie`.

## Verb table

| verb | callable? | notable arg names | response summary |
|---|---|---|---|
| workspace_get_graph | yes | `workflowId?` (optional) | no-args: flat store view, 48 nodes/92 edges (union of all 3 conductors). With `workflowId`: that conductor's real run topology — publishing_conductor 24n/50e, capture_conductor 16n/28e, clone_conductor 18n/35e |
| workspace_get_nodes | yes | none — schema takes **no properties at all** | 48 nodes, identical set to the flat `workspace_get_graph`. Does **not** accept `workflowId` (rejected client-side) |
| workspace_get_node | yes | `id` | one node's full definition (prompt, schemas, allowedTools, modelConfig, position, metadata) |
| workspace_get_node_effective_config | yes | `id` | resolved config (prompt/schemas/modelConfig/assignedSkills/effectiveTools/riskLevel/approvalRequirements), no secrets |
| workspace_validate_graph | yes | none | `{valid, issues[]}` — workspace currently valid, 0 issues |
| workspace_validate_node | yes | `id` (+ optional patch/create/update/etc.) | `{valid:boolean}` for an id-only call; a `patch` argument triggered a client-side schema rejection in this session (see Findings) |
| workflow_list_runs | yes | `limit`, `status`, `workflowId`, `projectId`, `from`/`to`, `cursor` | paged run summaries; `matchedCount`, `hasMore`, `nextCursor`. Explicit `limit:5` triggered proxy errors twice; omitting `limit` worked (see Findings) |
| workflow_get_run | yes | `runId` | full run record: `nodes[]` (each with `startedAt`/`completedAt`/`durationMs`), `artifacts[]`, `stageOutputs`, `mode{}`, `stall`. Bad id → `{ok:true, data:{run:null, mode:null, stall:null}}`, not an error |
| workflow_get_run_cost | yes | `runId` | per-node cost ledger + `plan.nodeTimingAggregates` (workflow-wide EMA/p50/p95 duration history per node) |
| workflow_get_run_context | yes | `runId` **and** `projectId` (both required) | project contract, article-body schema, tool policy, object contracts, full node registry (dependsOn/riskLevel/produces) |
| workflow_publish_readiness | yes | `projectId` (+ optional `runId`/`articleBody`/`readiness`) | GO/NO-GO checklist array with per-item status/detail |
| node_list_executions | **partially** | `runId`, `nodeId`, `executionId`, `artifactType`, `from`/`to` | `runId` alone works and returns `{executions:[<full run record>]}`. **Any call including `nodeId` fails** at the transport/proxy layer (see Findings) |
| node_get_effective_prompt | yes | `nodeId` | `{prompt, nodePrompt, skillInstructions}` — merged node+skill prompt text |
| node_get_input_schema | yes | `nodeId` | `{schema}` (JSON Schema or `null` if unset/unknown id) |
| node_get_output_schema | yes | `nodeId` | `{schema}` (JSON Schema) |
| node_get_effective_skills | yes | `nodeId` | resolved skill policy: skillIds, merged instructions, memoryPolicies, effective/requested/denied tools |
| node_get_effective_tools | yes | `nodeId` | every registry tool with `allowed:boolean` + `denialReasons[]` |
| node_get_latest_output | **no** (in this session) | `nodeId`, `runId`, `executionId`, `artifactType`, `from`/`to` | every call including `nodeId` failed at the proxy layer, same as node_list_executions |
| node_list_outputs | yes | `nodeId`, `runId`, `executionId`, `artifactType`, `from`/`to` | array of `{createdAt,id,nodeId,runId,type,value}` |
| stage_list_outputs | yes | `stage?` (optional) | array of `{createdAt,id,stage,value}` — 436 rows workspace-wide; `id` is a composite `<runId>:<execId>:<stage>` string |
| stage_get_output | yes | `id` | `{output:{id,stage,value,createdAt}}` or `{output:null}` for a bad id |
| changes_list | yes | `nodeId`, `actorKind`, `operation`, `source`, `from`/`to`, `limit`, `cursor` | paged change events; each carries `actor:{kind,id?,label}`, `before`/`after` full node snapshots, `parentRevisionId`/`resultingRevisionId` |
| changes_get | yes | `eventId` | one change event, or `{event:null}` for a bad id |
| changes_compare | yes | `fromRevisionId`, `toRevisionId` | `{diff:{nodes:{added,removed,changed[]}, relationships:{...}}}`. Bad revision id **throws a bare string** `unknown_revision: <id>`, not a JSON envelope |
| playbook_get | yes | `nodeId` | `{playbook, rendered}` — `null`/`""` when no playbook exists yet for that node |
| learning_list_observations | yes | `includeArchived?` | flat array; `{id, observation, createdAt}` always present, `nodeId`/`runId`/`metadata` **optional** (only on workflow-originated observations) |
| optimizer_status | yes | `nodeId?` | `{proposals[], trials[], modelLadder{...}}` — read-only, confirmed |
| optimizer_analyze | not tested | `nodeId` (required), `from`/`to` | deprioritized in this pass; description implies read-only |
| evaluation_list_rubrics | yes | `nodeId?`, `status?` | array of rubric definitions with `criteria[]` |
| evaluation_list_results | yes | `nodeId`, `rubricId`, `runId`, `trialId`, `from`/`to`, `limit` | array of eval results; `judge.mode` is `"openai"` (live) or `"mock"` (regression trial) |
| project_list | yes | none | 6 registered project MCP connections (dr-lurie, fernwell, monetizer, pdf-tool, platform, zilberman) with policy/connection metadata, no secrets |
| agent_list | yes | none | 1 conversational agent (`client_manager`) with `promptState` drift flag |
| tool_list | yes | none | 49 controlled-tool registry entries |
| skill_list | yes | none | 12 reusable skills |
| dataset_list | yes | `nodeId?` | 6 replay datasets with embedded `cases[]` |
| usage_get_summary | yes | `runId`/`nodeId`/`projectId`/`workflowId`/`status`/`from`/`to` | token/cost totals, `byModel`/`byNode`/`byProject` breakdowns |
| usage_get_budget_status | yes | `runId`/`projectId`/`budgetUsd` | `{spentUsdEstimate, remainingUsdEstimate, budgetUsd, percentUsed, status}` |
| repository_get_health | yes | none | per-store backend health map (gcs, writable/readable, versions) + build revision |
| constellation_get_attention | **no** (in this session) | `projectId?` | every call (no-args and with `projectId`) failed at the transport/proxy layer, 100% reproducible |
| constellation_get_metrics | not tested | `projectId?`, `runId?`, `from`/`to` | deprioritized after `get_attention`'s failure pattern was confirmed; needs a follow-up capture |
| constellation_get_summary | yes | `projectId?`, `from`/`to` | agent/relationship/run counts + usage totals; no-args failed once, `projectId:"dr-lurie"` succeeded |
| constellation_get_structure | yes | none | 48 agent summaries + `relationships[]` (empty, stored typed relationships unused) + `derivedExecutionEdges[]` (92, from `dependsOn`) |

## Findings

**1. `workspace_get_nodes` / `workspace_get_graph` and `workflowId` — the "20 of 43 nodes invisible" claim does not hold.**
Live counts: the workspace has **48 nodes total**, not 43. `workspace_get_graph` with no args and
`workspace_get_nodes` (which takes no arguments at all — its JSON Schema is
`{additionalProperties:false, properties:{}}`, so it can never accept a `workflowId` filter) both
return the exact same 48-node set. The union of the three per-conductor topologies obtained via
`workspace_get_graph({workflowId})` — publishing_conductor 24 nodes, capture_conductor 16 nodes,
clone_conductor 18 nodes (58 with overlap on `publish_payload`, `publication_controller`,
`publish_executor`, `release_executor`, `learning_recorder`, which are shared terminal nodes across
conductors) — is **exactly** the same 48-node set the two flat read verbs report, with zero nodes in
either direction's diff (`comm -23`/`comm -13` on the sorted id lists both came back empty). So:
`workspace_get_graph` accepts `workflowId` and returns that conductor's real run topology (per its
tool description); `workspace_get_nodes` does not and never has. Every node in every conductor is
visible to both flat read verbs — nothing is invisible to them in this live workspace.

**2. `node_list_executions` does not return `null`; it does something arguably worse — it silently returns the whole run record instead of a filtered node-execution list, and any call naming a `nodeId` fails outright.**
- `node_list_executions({runId})` (runId only, no nodeId) **works** and returns
  `{ok:true, data:{executions:[<one element>]}}` where that one element is **structurally identical
  to `workflow_get_run`'s `data.run` object** — the full run with all 22 nodes, all artifacts, all
  stageOutputs. It is not a per-node-execution list at all; it's the run object wrapped in a
  1-element array under a differently-named key.
- Every call that includes a `nodeId` — `{nodeId}` alone, `{nodeId, runId}` together, `{nodeId, runId}`
  repeated with different node ids (`draft_writer`, `capture_crawl`, `clone_intake`) — failed 100% of
  the time (5+ attempts) with the exact same transport-layer error:
  `Error POSTing to endpoint: event: message\ndata: {"jsonrpc":"2.0","id":<n>,"error":{"code":-32600,"message":"Anthropic Proxy: Invalid content from server","data":null}}`.
  This is JSON-RPC `-32600` (Invalid Request) raised by the **Anthropic proxy in front of the MCP
  session**, complaining about the content the CMS_Agent server sent back — not a normal MCP tool
  error and not visible as a JSON payload at all. The most likely explanation is the server returns a
  bare/invalid content block (e.g. a literal top-level `null`, or a non-string/non-object content
  entry) when the nodeId-filtered code path finds nothing or hits an internal type mismatch. This is
  consistent with, and probably the origin of, the "returns null" folklore in the handoff — the
  client-visible symptom is a hard proxy failure, not a clean `null`.
- `node_get_latest_output` (a sibling read verb with the same `nodeId`/`runId`/`executionId` filter
  shape) exhibits the **identical failure signature** whenever `nodeId` is present, which strongly
  suggests a shared code path bug rather than something specific to `node_list_executions`.
- `constellation_get_attention` also fails with the **identical** proxy error text on every call
  (no-args and `projectId`-qualified), which further suggests this is a systemic serialization defect
  in some shared response-building helper, not three unrelated bugs. Track B4 should look for one
  root cause across all three verbs.

**3. Per-node timings live in two different places with two different shapes — do not conflate them.**
- **Per-run, per-node actuals**: `workflow_get_run({runId}).data.run.nodes[]` — each element carries
  `startedAt` (ISO string), `completedAt` (ISO string, absent while running/queued),
  `durationMs` (number, absent while running/queued), directly as sibling keys on the node entry
  alongside `nodeId`, `status`, `produces`, `output`, `warnings`, `input`. A `queued` node has none of
  these three fields. Field names are exactly `startedAt` / `completedAt` / `durationMs` — no
  alternate spelling was observed.
- **Cross-run historical aggregates**: `workflow_get_run_cost({runId}).data.plan.nodeTimingAggregates`
  — an object keyed by nodeId, each value `{nodeId, count, emaDurationMs, p50DurationMs,
  p95DurationMs}`. This is explicitly documented in the tool's own description as "measured per-node
  duration history (EMA/p50/p95/count) for this run's workflow, read-only" and is unrelated to the
  specific run being queried — it's workflow-wide history. `repository_get_health` also names a
  dedicated `nodeTiming` store (`backend:"gcs", version:"node_timings.v1"`), confirming this is a
  first-class persisted store, not a derived-on-the-fly stat.
- P2-05's real-timeline work should read from `workflow_get_run.data.run.nodes[].{startedAt,
  completedAt, durationMs}` for an actual run's Gantt/timeline, and from
  `workflow_get_run_cost.data.plan.nodeTimingAggregates` only for historical-estimate/ETA display.

**4. `constellation_get_attention` is fully broken from this client, not just malformed.**
Every attempt — no args, and `{projectId:"dr-lurie"}` — failed identically and reproducibly with the
same proxy-layer `-32600 Invalid content from server` error described in finding #2. No JSON payload
was ever obtained; there is nothing to type-check because nothing valid is ever returned. This is a
harder failure than "malformed JSON" — the proxy is refusing to forward the server's response at all,
which likely means the server is emitting something outside the MCP content-block contract entirely
(most plausibly a bare `null` or a non-string primitive as a content item, given `get_attention`'s own
description promises "No composite scores" and is one of the newest/most complex verbs — R-10
configuration-defect detection — added to the registry). Track B4 should treat this as: find what
`constellation_get_attention` actually serializes when it has zero attention items or zero R-10
defects to report (an empty-state edge case is the prime suspect), and make sure that shape is valid
MCP content. `constellation_get_metrics` was not independently re-verified in this pass but is worth
suspecting for the same root cause since it shares response-building code with `get_attention` and
`get_summary`/`get_structure` (which both work fine).

**5. Yes — change records carry an `actor` field, and it has exactly the shape U4 needs.**
Every event returned by `changes_list` and `changes_get` carries
`actor: {kind: "human"|"agent"|"system", id?: string, label: string}` (the `kind` enum is also
declared directly on `changes_list`'s own `actorKind` filter parameter, confirming the three values
are exhaustive). Observed live values in this workspace: `{"kind":"agent","label":"Claude (oauth)"}`,
`{"kind":"agent","id":"cowork-wave","label":"Coword execution session"}`. `changes_list` also accepts
`actorKind` as a direct server-side filter, so U4 can filter to `agent`- or `system`-attributed
learning changes without a client-side scan. Contrast: `learning_list_observations` records do **not**
carry an `actor` field at all — only `id`, `observation`, `createdAt`, and optionally `nodeId`/`runId`/
`metadata`. If U4 needs actor-attribution specifically on *learning* observations (as opposed to
*change* events), that data does not exist on this verb today and would need to come from correlating
an observation's `runId`/`nodeId`/`createdAt` against `changes_list` separately, or from a schema
change upstream.

## Error-envelope shapes (exact, from live probes — see `raw/error-shapes.json`)

**Not-found is not an error at all — it is `ok:true` with the payload's key set to `null`.** This
pattern was confirmed identically across five different verbs:

```json
// workflow_get_run({runId:"run_does_not_exist"})
{"ok":true,"data":{"run":null,"mode":null,"stall":null}}

// workspace_get_node({id:"node_does_not_exist"})
{"ok":true,"data":{"node":null}}

// node_get_input_schema({nodeId:"node_does_not_exist"})
{"ok":true,"data":{"schema":null}}

// stage_get_output({id:"not_a_real_stage_output_id"})
{"ok":true,"data":{"output":null}}

// changes_get({eventId:"evt_does_not_exist"})
{"ok":true,"data":{"event":null}}
```

**One exception found**: `changes_compare` with an unknown revision id throws a **bare, unstructured
string**, not a JSON envelope and not even a JSON-RPC error object with a `code` field — just the text:

```
unknown_revision: rev_does_not_exist_1
```

**Missing-required-argument validation never reaches the server at all in this session** — it is
caught client-side by the MCP tool-calling harness against the tool's declared JSON Schema, and comes
back as a single generic string with **no `code`, no field name, and no `issues[]` array**:

```
validation_error: input did not match the tool schema.
```

This exact string was produced for every schema violation attempted: a missing required property
(`workspace_get_node` called with no `id`; `workflow_get_run_context` called with no `projectId`), and
an extra/forbidden property (`workspace_get_nodes` called with a `workflowId` argument, which its
schema's `additionalProperties:false` forbids). **There is no richer validation envelope to design
against for WP work that assumed one** — any UI/type work expecting `{code, issues:[{path, message}]}`
or similar needs to either (a) accept this generic string as the only client-visible validation error,
or (b) construct its own pre-flight validation client-side before calling, since the server-side
validation error (if one differs from this) was never actually observed — every missing-arg attempt in
this session was intercepted before the request left the client.

## Verbs not captured, and why

- **`node_get_latest_output`** — every call including a `nodeId` failed with the proxy-layer
  `-32600 Invalid content from server` error (see Finding #2); no successful payload obtained.
- **`constellation_get_attention`** — every call (no-args and `projectId`-qualified) failed
  identically with the same proxy-layer error; no successful payload obtained (see Finding #4).
- **`constellation_get_metrics`** — not independently attempted after `get_attention`'s failure
  pattern was confirmed and `workflow_get_run_cost.plan.nodeTimingAggregates` was found to satisfy the
  per-node timing-history need this pass prioritized; recommend a follow-up capture given it likely
  shares code with `get_attention`.
- **`optimizer_analyze`** — deprioritized in favor of `optimizer_status` (confirmed read-only) under
  time constraints; its own tool description ("Evidence-cited diagnosis... read-only" character, no
  mutation language) makes it safe to capture in a follow-up pass, it just wasn't reached.

All other verbs listed in the WP-00 brief were captured successfully with a real live payload.
