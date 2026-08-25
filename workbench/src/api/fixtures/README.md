# Fixture provenance (WP-02)

Captured 24 Aug 2026 against the live `CMS_Agent` MCP workspace. Every file below is
live-data-first; the mockup (`spec/mockup.html` script block) is used only where noted,
strictly for presentation fields the live API does not carry.

| File | Live verb(s) | Records | Mockup-sourced fields / fallback |
|---|---|---|---|
| `workflows.json` | `workspace_get_graph`, `workspace_get_nodes`, `workflow_list_runs` (node order for clone/capture, since those two workflows' nodes are absent from `workspace_get_graph`) | 3 workflows | `icon`, `short`, `desc` marketing copy and phase **labels** are from the mockup (API carries no display copy). Node membership/order is live. |
| `nodes.json` | `workspace_get_graph`/`workspace_get_nodes` (23 publishing_conductor nodes, incl. `prompt`, `model`) + mockup fallback for the 19 mockup-known clone/capture nodes (name/kind/risk/tools/skills/desc/fan — **not resolvable live**, `workspace_get_node` returns `null` for every clone/capture id) | 43 nodes | Fallback: all clone_conductor and capture_conductor node facts are mockup-sourced (labelled below). `fit_adjudicator` has **no** source at all — id and position come from live run data only; kind/risk/fan/tools/skills are `null`/`[]`, not invented. |
| `projects.json` | `project_list` | 6 | `pol` counts are tallied live from each project's `toolPolicies`, not copied from the mockup — see disagreements below. |
| `runs.json` | `workflow_list_runs` (list) + `workflow_get_run_cost` (per-run `totalCostUsdEstimate`, called once per run — the list endpoint carries no cost field) | 39 (of 60 total; the `independent_node` regression-trial row was excluded as not a real workflow run) | None. `started`/`dur` are derived from live `startedAt`/`updatedAt` (UTC). |
| `tools.json` | `tool_list` | 42 | None — full live registry, not the mockup's 10-tool excerpt. |
| `skills.json` | `skill_list` (id/version) + live `assignedSkills` on each node (`assignedTo`, richer shape used per the task's preference) | 12 | None for the 12 skill ids/versions (live matches mockup's set exactly). `assignedTo` is live and disagrees substantially with the mockup — see below. |
| `observations.json` | `learning_list_observations` | 10 | None. Mockup showed only 8 (truncated ids, missing one record — see below). |
| `rubrics.json` | `evaluation_list_rubrics` (criteria/weights) + `evaluation_list_regression_reports` (score/verdict, newest report per node) | 5 | None. Only `contract_intelligence` has a regression report; the other 4 nodes' `score`/`verdict` are `null` because no report exists yet (matches mockup's nulls). |
| `datasets.json` | `dataset_list` | 6 | `note` uses the live `name` field (the API's `note`/description field is `null` on every dataset; `name` is the closest live equivalent and carries the same content the mockup showed as `note`). |
| `comparePairs.json` | none — **mockup `CMP_QUEUE` verbatim**, reshaped to `{kind,node,brief,champ,a,b}` | 3 | Entirely mockup-sourced/illustrative, as instructed. No live "compare queue" verb exists on this MCP surface. |
| `usage.json` | `usage_get_summary` (unfiltered, and once per `workflowId`) + `workflow_list_runs` (`page.matchedCount` per workflow, for `avgPerRun`) | 3 workflows | `weekTotal` is the **all-time** total cost (`costUsdEstimate` from the unfiltered summary), not a rolling 7-day figure — `usage_get_summary` has no time-window default and none was specified; labelled here as a fallback interpretation of the mockup's `weekTotal` key. `runCount` = sum of the 3 workflows' live run counts (49); note the unfiltered grand total ($67.73) exceeds the 3 workflows' summed totals ($60.68) because it also includes non-workflow usage (regression-trial/`independent_node` runs, `improvement_judge`). |
| `readiness.json` | `dataset_finetune_readiness` (`nodeId: contract_intelligence`) | 1 | None. `recommendation` uses the API's full `reason` string (more informative than the bare `recommendation` enum value `"accumulate"`, which is folded into the sentence). |
| `agents.json` | `agent_list` | 1 | None. Only one agent is currently defined workspace-wide (`agt_client_manager`); the mockup did not model this store at all. |

## Where the live workspace disagrees with the mockup

1. **clone_conductor has 9 live nodes, not 8.** A node called `fit_adjudicator`
   (produces `clone_fit_adjudication.v1`) runs between `theme_bind` and `layout_restamp`
   in every live clone run. It is absent from the mockup's `NODES`/`WORKFLOWS.clone_conductor`
   and from `workspace_get_node` (returns `null`) — it only exists in `workflow_list_runs`
   run histories and `usage_get_summary`'s `byNode` breakdown.
2. **clone_conductor and capture_conductor nodes are invisible to `workspace_get_graph` /
   `workspace_get_nodes` / `workspace_get_node`.** Those three tools return **only** the
   23 `publishing_conductor` nodes, even though clone/capture workflows run live today
   (a clone run fired minutes before this capture, 24 Aug 14:36 UTC). Their topology,
   tool/skill/risk facts had to come from the mockup or from run-history inference.
3. **Skill assignment on publishing_conductor nodes is substantially different live.**
   Per live `assignedSkills`: `topic_opportunity`→`seo_review`, `brief_architect`→
   `article_structuring`+`editorial_craft`, `human_texture`/`emotional_resonance`→
   `editorial_craft` (mockup said `editorial_review`/none), and `contract_intelligence`,
   `artifact_plan`, `article_body`, `publish_payload` **all** carry the `contract_intelligence`
   skill live. Conversely, `article_body_builder`, `artifact_handling`, `editorial_review`,
   `publication_readiness` and `learning_observation` are registered skills (`skill_list`)
   but are **assigned to zero nodes** in the live graph, despite the mockup showing them
   each on one node.
4. **Project tool-policy counts disagree for 4 of 6 projects.** Only `dr-lurie`
   (18/1/15) and `platform` (31/6/0) match the mockup exactly. Live counts: `zilberman`
   a:25/n:0/**b:0** (mockup: 24/0/1), `pdf-tool` a:10/n:0/**b:0** (mockup: 10/0/1),
   `fernwell` a:7/n:0/**b:0** (mockup: 7/0/1), `monetizer` a:6/n:0/**b:0** (mockup: 6/0/1).
   None of the live `toolPolicies` on these 4 projects contain a single `"blocked"` entry.
5. **`tool_list` has 42 controlled tools, not 10.** The mockup's `TOOLS` array was a
   curated excerpt; the live registry includes full `file.*`, `artifact.*`, `blob.*`,
   `project.*`, `capture.*`, `clone.*`, `repository.*` and `usage.*` families.
6. **`learning_list_observations` has 10 records, not 8** — the mockup's `OBS` array
   omits `learning_1784723853122_3r68f3` (22 Jul, Dr. Lurie taxonomy registry rules) and
   uses shortened/truncated ids throughout; this fixture uses full live ids.
7. **Only one agent exists** (`agt_client_manager`, `promptState: "diverged"` from its
   shipped canonical text) — the mockup did not model an agents store, so there is nothing
   to disagree with, but it's worth flagging that the workspace runs a single conversational
   agent today, not a roster.

## Scratch files
All intermediate `_*.py` / `_*.json` / `_*.jsonl` build scripts used to assemble these
fixtures from raw tool output have been deleted; only the 13 fixture JSON files and this
README remain in this directory.
