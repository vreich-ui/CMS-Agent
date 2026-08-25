# Fixture provenance (workbench-verb-fixes)

Recaptured 25 Aug 2026 against the live `CMS_Agent` MCP workspace, replacing the WP-02
fixture set below. The WP-02 fixtures were captured live but then **reshaped to match
the app's UI types** (`../types.ts`) and, for clone/capture nodes, backfilled from
`spec/mockup.html` where `workspace_get_node` returned nothing. That reshaping was the
bug: the UI's `types.ts`/mapping code was written against the *reshaped* field names, so
loading real data through the Netlify transport rendered blank (empty risk badges, empty
tool/skill lists, missing descriptions) because the real live field names never matched.

Every file below is now the **raw verb response payload, verbatim** — the `data` field
of a live tool result, including its one-level wrapper key (e.g. `{nodes:[...]}`,
`{runs:[...],page:{...}}`) — with no reshaping to UI field names and no mockup
backfill. All mapping from these raw shapes to `../types.ts` happens in exactly one
place, `api/adapters.ts`'s `to<Entity>()` functions, and **both** transports (this
fixture mode, via `client.ts`'s `MOCK_HANDLERS` + `mockStore.ts`, and the live Netlify
transport) call the same adapter from `api/verbs.ts` — so this fixture set is a real
regression net for the live mapping, not a check against a parallel fiction. A few
fixtures are trimmed for size (verbose per-attempt telemetry, long instruction text) —
noted per file below; every field an adapter actually reads is kept verbatim.

| File | Live verb(s) | Records | Notes |
|---|---|---|---|
| `nodes.json` | `workspace_get_nodes` (`{nodes:[...]}`, no arguments — the schema takes none) | 23 | **Only `publishing_conductor`'s nodes.** `workspace_get_node(s)`/`workspace_get_graph` return nothing for clone_conductor/capture_conductor node ids, live, full stop — not a fixture gap. `toNode()` maps `riskLevel`→risk, `allowedTools`→tools, `assignedSkills`→skills, `description`→desc, `dependsOn.length`→fan. |
| `workflowCatalog.ts` | none — **not a fixture, not fetched.** A `.ts` module (not JSON) holding the 3 conductor workflows' display copy (icon/short/desc) and phase groupings, the same content the old `workflows.json` held. HANDOFF has no "list workflows" verb; this is app config. Every node id listed in every phase array *was* cross-checked against live data — publishing_conductor's 23 against `workspace_get_nodes`, clone/capture's 20 against node ids observed in real `workflow_list_runs` histories (their only live trace, since the workspace verbs above never return them). |
| `projects.json` | `project_list` (`{projects:[...]}`) | 6 | Verbatim. `toProject()` derives `ok` from `connection.endpointConfigured && connection.tokenConfigured` (live carries no single flag) and tallies `pol.{a,n,b}` from `toolPolicies`' values. |
| `runs.json` | `workflow_list_runs` (`{runs:[...],page:{...}}`, `limit:100`) | 55 (of 66 total; 11 `independent_node`/`trial_reg_*`/`node_run_*` rows excluded as regression-trial/single-node runs, not real workflow runs — same exclusion the WP-02 README documented) | The **full** real run history, not a curated subset, so count-derived UI text (Library screen's per-workflow "needing attention") matches live truth. Each row's `nodes[]` trimmed to `{nodeId,status}` (dropping `warnings`/`lastDispatch`/`produces`/`durationMs`/`skip` — verbose per-attempt telemetry `toRun()` never reads) and `mode` trimmed to `{executionMode}` (dropping its long notice string). `toRun()` maps `runId`→id, `workflowId`→wf, `projectId`→proj, `currentNodeId`→cur (falling back to the first non-completed/non-skipped node when absent, as on `workflow_get_run`'s single-run object), `nodes.filter(completed).length`→done, `errors.length`→err. |
| `runCosts.json` | `workflow_get_run_cost({runId}).ledger` — per-run, **not bulk** | 9 of 55 | Cost is a single-run detail lookup live, never a bulk one — the app itself only ever fetches it for the one bound run (`workflowGetRun` in verbs.ts). A `runId` absent here has no fixture cost data; `toRun()` reports `cost:0`/`budget:null` for it, the type's own "nothing spent yet" default, never a fabricated figure. `plan` (the resume/reuse recommendation) is dropped — no adapter reads it. |
| `tools.json` | `tool_list` (`{tools:[...]}`) | 42 | Verbatim. `toToolDef()` maps `toolId`→id, `description`→desc, `riskLevel`→risk. |
| `skills.json` | `skill_list` (`{skills:[...]}`) | 12 | Verbatim fields kept; `examples`/`preconditions`/`completionCriteria`/`blockerCriteria`/`memoryPolicy`/`toolPolicy` stripped per skill (not read by any adapter or UI tab) and the two longest `instructions` texts (`contract_intelligence`, `editorial_craft`) shortened — both trims are size-only, every field `toSkill()` reads (`skillId`, `version`, `name`, `description`, `status`) is untouched. `assignedTo` has no live field at all — `verbs.ts`'s `skillList()` derives it from `workspace_get_nodes`' `assignedSkills` via `adapters.assignedSkillsByNode()`. |
| `observations.json` | `learning_list_observations` (`{observations:[...]}`) | 11 | Verbatim. `toObservation()` maps `observation`→txt, `nodeId`→node, `runId`→run, `createdAt`→when (short date). |
| `rubrics.json` | `evaluation_list_rubrics` (`{rubrics:[...]}`) | 5 | Verbatim fields kept; each criterion's `guidance` and each rubric's `metadata` dropped (size only — not read by `toRubric()`). `crit`←criteria.length, `top`←the highest-`weight` criterion's name (both derived, live has no single "headline criterion" field). |
| `regressionReports.json` | `evaluation_list_regression_reports` (`{reports:[...]}`) | 2 (both `contract_intelligence` — the only node with any regression history) | Verbatim. Composed with `rubrics.json` in `evaluationListRubrics()` (verbs.ts): the newest report per node (by `createdAt`) supplies `score`/`verdict`; a node with none gets `null` for both, not a guess. |
| `datasets.json` | `dataset_list` (`{datasets:[...]}`) | 6 | Each `cases[]` item trimmed to `{caseId,nodeId}` (the full live case objects are large; `toDataset()` only ever reads `cases.length`). `note`←`name` (live's own `note`/description field is `null` on every dataset). |
| `usage.json` | `usage_get_summary` (unfiltered, and once per known workflow) + `workflow_list_runs({workflowId,limit:1}).page.matchedCount` (per workflow, for `avgPerRun`'s denominator) | 3 workflows | Composed fixture — live has no single verb with a per-workflow cost breakdown; `verbs.ts`'s `usageGetSummary()` makes the same multi-call composition against live. `weekTotal` is actually the **all-time** total (`usage_get_summary` has no rolling time window) — `UsageTab.tsx` already labels it "all-time total" honestly. |
| `readiness.json` | `dataset_finetune_readiness` (`{readiness:{...}}`, `nodeId: contract_intelligence`) | 1 | Verbatim. `recommendation` uses the live `reason` field (a fuller sentence than the bare `recommendation` enum, which it folds in) when present. |
| `agents.json` | `agent_list` (`{agents:[...]}`) | 1 | Only one agent is currently defined workspace-wide. Its `prompt` (a long multi-paragraph system prompt) is truncated with an explanatory note — no adapter or UI tab reads agent prompt text; every field `toAgent()` reads (`id`,`name`,`role`,`modelConfig.model`,`promptState`,`skills`,`rev`,`status`,`updatedAt`) is untouched. |
| `comparePairs.json` | none — **illustrative, not live**, unchanged from WP-02 | 3 | No live "compare queue" verb exists on this MCP surface — left as-is per instruction. |

## The clone/capture node gap is real, not a fixture limitation

`workspace_get_graph` / `workspace_get_nodes` / `workspace_get_node` only ever return
`publishing_conductor`'s 23 nodes, live — confirmed by calling each directly during this
recapture. Clone/capture node ids (`clone_intake`, `theme_bind`, `fit_adjudicator`,
`capture_crawl`, …) exist only as strings inside `workflow_list_runs` run histories and
`workflowCatalog.ts`'s phase arrays — there is no live source for their name / kind /
risk / tools / skills / prompt / model, so `nodes.json` does not, and cannot, include
them. The UI's existing empty states carry this honestly: `workspaceGetNode()` returns
`null` for any of them and `Center.tsx` renders a "not found" card naming the verb that
came back empty, rather than a synthesized placeholder. This also means the command
palette's node index (built from `workspace_get_nodes`) can only ever jump to
publishing_conductor nodes — see `tests/palette.spec.ts`.

## Where the recapture disagrees with the WP-02 (reshaped) fixture set

1. **`nodes.json` is 23 records, not 43.** WP-02 filled the 20 clone/capture ids in from
   `spec/mockup.html` (a fabrication this task removed) — see the gap note above.
2. **`runs.json` is 55 records, not 39**, and is the full live run history rather than a
   curated subset — several tests' hardcoded counts (Library screen's "needing
   attention" totals, the flywheel's observation count) were updated to match.
3. **A handful of hardcoded run ids in the test suite drifted from live reality** between
   WP-02's capture and this one (runs that were `blocked` on a gate 24 Aug have since
   resumed/progressed) — `tests/runcontrol.spec.ts`'s `publication_controller` gate-panel
   case now binds a different, still-live-accurate run (`run_1787472547111_vzovz4`)
   rather than keeping a stale id or fabricating a scenario the fixture never captured.
4. **`skills.json`/`rubrics.json`/`datasets.json` are trimmed for size** (see the table
   above) — WP-02's fixtures were not, because they were pre-shrunk by the mockup-shaped
   reshaping this task removed.

## Scratch files
All intermediate build scripts used to assemble these fixtures from raw tool output were
written to `/tmp` (per the task's scratch-work constraint) and are not part of this
directory; only the fixture JSON files, `workflowCatalog.ts` (in `api/`, not here), and
this README remain.
