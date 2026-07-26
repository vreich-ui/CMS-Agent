# CMS-Agent — Netlify → Google Cloud migration status

**Date:** 2026-07-26
**Old plane:** Netlify + Netlify Blobs — `workspaceVersion 89`, last workspace write **2026-07-19T12:30:02Z**
**New plane:** Cloud Run + GCS — `workspaceVersion 56`, last workspace write **2026-07-26T11:33:55Z**
**Method:** full `workspace.export_workspace` from both planes, field-level diff, plus a read-only sweep of all 11 repositories on each.

---

## Headline

**Your assumption is correct: the nodes are fresher on GCloud.** Of the 21 shared nodes, 14 are byte-identical and 7 differ — and in all 7, GCloud is the newer version. Netlify has had no workspace write since 19 July; GCloud has been the live editing surface since 21 July. For node definitions, the migration is done and Netlify is already de facto retired.

What did **not** come across is everything *around* the nodes: project credentials, one whole sub-pipeline, and the entire operational history.

There are also **three silent regressions** where GCloud is newer but worse. Those matter more than the missing history.

---

## FINISHED — migrated and verified

| # | Item | Evidence |
|---|---|---|
| 1 | **21-node Dr. Lurie pipeline** | all present; 14/21 byte-identical, 7/21 newer on GCloud |
| 2 | **Skill registry** | 12/12 skills, same ids, all `1.0.0` / `active`, instructions equivalent |
| 3 | **Controlled tool registry** | 31/31 toolIds identical, incl. `riskLevel`, `sideEffect`, `requiresApproval`, `timeoutMs`, metadata |
| 4 | **MCP tool surface** | ~129 tools served on both |
| 5 | **Storage layer** | GCS backend healthy; 9/9 repositories readable + writable; real CAS via `ifGenerationMatch` |
| 6 | **Graph integrity** | `workspace.validate_graph` → `valid:true`, 0 issues, 27 execution edges |
| 7 | **Project registry (structure)** | all 4 projects registered: `dr-lurie`, `monetizer`, `pdf-tool`, `snoocle` |
| 8 | **Publishing policy** | `publishEnabled:false`, `requiresExplicitPublish:true` on all 8 project records both planes — consistent and intentional |
| 9 | **`monetizer` project config** | identical on both planes |

### Genuine improvements made on GCloud (do not overwrite these)

- **Multi-project generalisation.** `learning_recorder` and `publication_controller` had "Dr. Lurie" hardcoded in their descriptions and metadata; GCloud replaces this with "the target project". `publication_controller.metadata` key renamed `drLuriePolicy` → `projectPolicyNotes`. This is the workspace becoming genuinely multi-tenant.
- **`publish_executor` gained the content_item materialization contract** — a new prompt paragraph specifying that the Dr. Lurie `content_item` body is strict (`additionalProperties:false`) and carries **no** `schema_version` field, so article fields must be rooted directly. This is exactly the kind of rule that causes a failed publish if absent.
- **`input_triage` renamed** "Publishing Input Triage" → "CMS Input Triage".
- **`publish_payload` now requires `artifact_plan`** (was `article_body` only) — closes the gap where a payload could be built without artifact verification.
- **`emotional_resonance` now requires `input_triage`.**
- **`dr-lurie` gained 3 artifact-write tools**: `save_artifact`, `create_artifact_from_url`, `create_artifact_upload_intent`.

---

## UNFINISHED — not yet migrated

Ordered by impact.

### 1. Project MCP credentials — all four projects · **BLOCKING**

| plane | endpointConfigured | tokenConfigured |
|---|---|---|
| Netlify | true (all 4) | true (all 4) |
| **GCloud** | **false (all 4)** | **false (all 4)** |

Eight environment variables unset on Cloud Run: `DR_LURIE_MCP_ENDPOINT`/`_TOKEN`, `MONETIZER_MCP_ENDPOINT`/`_TOKEN`, `PDF_TOOL_MCP_ENDPOINT`/`_TOKEN`, `SNOOCLE_MCP_ENDPOINT`/`_TOKEN`.

`project.test_connection("dr-lurie")` on GCloud returns:
> `"Project MCP endpoint is not configured (DR_LURIE_MCP_ENDPOINT)."`

**No project connection works on the canonical plane.** Nothing that touches an external project — contract fetch, artifact generation, publish — can run. This is the single item blocking everything else.

### 2. Snoocle sub-pipeline — 3 nodes never migrated

| node | kind | risk | produces | depends on | tools / skills |
|---|---|---|---|---|---|
| `snoocle_source_search` | research | read | `snoocle_song_sources.v1` | — | `web.search`, `web.fetch` / `web_research` |
| `snoocle_source_compare` | review | read | `snoocle_reconciliation_plan.v1` | `snoocle_source_search` | — |
| `snoocle_reconciler` | builder | read | `snoocle_song.v1` | `snoocle_source_compare` | — |

Present on Netlify (last touched 2026-07-17), absent from GCloud entirely — no nodes, no usage records, no change events. Their 14 change events and 12,554 tokens of usage history are also gone.

**Decision needed: is Snoocle in scope or was it deliberately dropped?** The `snoocle` *project* is registered on GCloud, which suggests it was meant to come across and the nodes were simply missed.

`snoocle_source_search` also carries `modelConfig: {"toolCallLimit": 8}` — **the only node-level model config anywhere in either plane.** Worth noting because it confirms `workspace.update_node_model_config` writes a real, optional field; it just isn't set on any Dr. Lurie node.

### 3. `pdf-tool` project config — regressed, not migrated · **HIGH**

| setting | Netlify | GCloud |
|---|---|---|
| `allowedTools` | 13 | **8** |
| `defaultToolPolicy` | `allowed` | **`blocked`** |
| `contentContract` | `article_body.v1` | **`content_source.v1`** |

Five tools dropped: `create_agent_artifact_job`, `search_images`, `update_image_search_candidate`, `import_image_from_url`, `import_images_from_url`.

Those are **all** of the artifact-generation and image-import capability. Combined with `defaultToolPolicy` flipping to `blocked`, the pdf-tool → Dr. Lurie Blob artifact protocol — which `article_body`, `artifact_plan`, `publish_payload` and `publish_executor` all mandate in their prompts — cannot execute on GCloud. Any article with an image will block.

### 4. `snoocle` project toolPolicies — 9 entries dropped

Netlify carries 16 policy keys, GCloud 7. Missing: `acquire_audio`, `analyze_audio`, `convert_audio`, `discover_song`, `normalize_audio`, `reconcile_song`, `save_song`, `trim_audio`, `analyze_and_store_song`. Consistent with §2 — the Snoocle branch was left behind as a unit.

### 5. `trust_factual.requiredInputs` — regression on GCloud

- Netlify: `dependsOn: ["draft_writer","research"]`, `requiredInputs: ["draft_writer","research"]` ✅ consistent
- GCloud: `dependsOn: ["draft_writer","research"]`, `requiredInputs: ["draft_writer"]` ❌ inconsistent

`research` was dropped from `requiredInputs` during or after migration. Netlify had it right. This is the D6 inconsistency from the earlier audit — now identified as a migration regression rather than a long-standing quirk. Every other node keeps the two lists identical.

### 6. Run history — all 21 runs

GCloud has 3 runs (all `independent_node`, all 2026-07-21). Netlify has 21 spanning 2026-07-10 → 2026-07-17: 10 completed, 7 failed, 2 running, 1 queued, 1 blocked.

Not carried over, including the only multi-node workflow history you have:

| runId | workflow | project | status |
|---|---|---|---|
| `run_1784213511374_gl5o0h` | publishing_conductor | dr-lurie | queued |
| `run_1784210671710_ytz2o6` | publishing_conductor | dr-lurie | running |
| `run_1784209484152_mkb5xb` | publishing_conductor | dr-lurie | running |
| `run_1783690013770_2u25y9` | publishing_conductor | **project-a** | blocked |

The 7 failed runs are your only record of what breaks in practice. If you keep one thing from Netlify, keep these.

*(`project-a` is registered in neither plane's `project_list` — a pre-existing orphan reference, flagged for completeness.)*

### 7. Stage outputs — 33 → 3

The most valuable single artifact is `run_1784213511374_gl5o0h`, which produced **17 consecutive stage outputs** from `input_triage` all the way through `publish_payload` — a complete pipeline traversal with real content. It is the closest thing you have to a golden-path regression fixture, and it exists only on Netlify.

Also Netlify-only: `artifact_plan` (×3), `publication_controller` (×2), and the three `snoocle_*` outputs.

### 8. Usage / telemetry — 57 records → 3

| | Netlify | GCloud |
|---|---|---|
| records | 57 | 3 |
| total tokens | 66,804 | 3,274 |
| cost estimate | $0.45363 | $0.02771 |
| nodes covered | 21 | 3 |
| `dr-lurie` project ledger | 46 records / $0.11647 | — |

Eighteen per-node usage histories absent on GCloud. Budget tracking on the canonical plane effectively starts from zero.

### 9. Learning observations — no overlap

Netlify's 4 (2026-07-16) and GCloud's 5 (2026-07-22) are entirely disjoint. GCloud's are net-new Dr. Lurie publishing-policy notes — not a migration. The 4 Netlify observations (workflow-runner state regression, publishing-conductor optimisation split, live-readiness/backend-gap notes, OpenAI adapter defect) are lost unless copied.

### 10. Change / audit ledger — 115 events, zero timeline overlap

| | Netlify | GCloud |
|---|---|---|
| events | 115 | 56 |
| range | 2026-07-12 → 2026-07-19 | 2026-07-21 → 2026-07-26 |

The GCloud log begins two days after the Netlify log ends. Netlify-only event types include 7 × `node.output_schema_updated`, 2 × `graph.reordered` and 1 × `node.model_config_updated` (the Snoocle one). The provenance of every node currently on GCloud lives on Netlify.

### 11. Workspace version snapshots — 2 → 0

Netlify holds 2 stored snapshots (`workspaceVersion` 2 and 3, both "UI graph reorder", 2026-07-10). GCloud holds none.

---

## Not a gap — verified clean on both

`evaluation` rubrics / results / regression reports (0/0), `dataset_list` (0/0), `feedback_list` (0/0), `optimizer_status` (empty/empty), `playbook_get` (null/null). These subsystems have never been used on either plane. Nothing to migrate.

---

## What to do, in order

**Before anything else — the three regressions.** These are cheap and they're actively wrong on your canonical plane:

1. Restore `research` to `trust_factual.requiredInputs`.
2. Restore `pdf-tool`: 5 allowedTools, `defaultToolPolicy: allowed`, `contentContract: article_body.v1`.
3. Restore `snoocle` toolPolicies — *if* Snoocle is in scope.

**Then, to make GCloud functional:**

4. Set the 8 project endpoint/token env vars on Cloud Run and verify with `project.test_connection` on all four.
5. Decide Snoocle: migrate the 3 nodes (with `snoocle_source_search`'s `modelConfig`), or formally drop them and deregister the project.

**Then, history — a judgement call.** There is no bulk-history migration tool; `workspace.import_workspace` handles nodes, and runs/usage/changes are separate repositories. Three options:

- **Copy nothing.** Keep Netlify frozen and read-only as an archive. Cheapest. You keep access to the failed runs and the 17-stage traversal by going to the old plane when you need them.
- **Copy selectively.** Port `run_1784213511374_gl5o0h`'s 17 stage outputs as a test fixture, plus the 4 learning observations. This is the 20% that carries most of the value.
- **Copy everything.** Requires writing a migration script against the repository interfaces. Only worth it if usage/cost continuity across the cutover matters to you.

My read: **selective**. The change ledger and usage records are audit trail, and Netlify can hold that as an archive indefinitely. The failed runs and the full traversal are engineering assets you'll actually reuse — those are worth porting.

**Do not retire Netlify until** items 1–5 are done and the selective copy (if chosen) has completed. Right now Netlify is the only plane that can reach any external project.
