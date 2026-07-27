# CMS-Agent — Test Protocol

**Version:** 1.0 · 2026-07-26
**Scope:** Cowork UI · MCP direct · LibreChat · Dr. Lurie workspace publish
**Canonical plane:** Cloud Run + GCS (`CMS_Agent_GCloud`)
**Live-publish policy for v1.0:** throwaway test article only, human confirmation at the publish call

---

## 0. Design principles

1. **Tiers gate each other.** Tier N+1 does not run until Tier N is green. No "it's probably fine".
2. **Every tier has negative cases.** A validator that only ever passes is not tested. Roughly a third of the assertions below assert *rejection*.
3. **Three surfaces, one workspace.** UI, MCP and LibreChat must agree on the same state after the same operation. Disagreement is a failure, not a quirk.
4. **Writes are reversible or disposable.** Test nodes are prefixed `zz_` and deleted in teardown. Test articles are unpublished.
5. **The change ledger is the receipt.** Every write in this protocol carries `actor`, `source`, and a `reason` naming its test id. If a test's writes can't be found in `changes.list`, the test didn't prove anything.

**Environment matrix**

| Surface | Endpoint | Auth | Notes |
|---|---|---|---|
| Cowork / MCP direct | `CMS_Agent_GCloud` | session MCP | canonical |
| Netlify UI | `cms-agent.netlify.app` → `/api/workspace-mcp` | Netlify Identity + `ADMIN_EMAIL_IDS` | **currently a different plane — see T0.1** |
| LibreChat | `34.135.240.226.nip.io` | app login | agent `Workspace Inspector` → `cms-agent-gcloud` |
| Dr. Lurie | `Dr_Lurie_MCP` | bearer | direct session connection |

---

## Tier 0 — Preconditions (blocking; must be green before anything else)

| id | Assertion | Tool | Status now |
|---|---|---|---|
| T0.1 | Both planes report the same `workspaceVersion` and node count | `repository.get_health` on both | ❌ **FAIL** — GCloud 56/21 nodes, Netlify 89/24 nodes |
| T0.2 | GCloud reaches the Dr. Lurie MCP | `project.test_connection("dr-lurie")` | ❌ **FAIL** — `DR_LURIE_MCP_ENDPOINT` not configured |
| T0.3 | Dr. Lurie MCP is itself alive | `Dr_Lurie_MCP.ping` | ✅ PASS |
| T0.4 | All repositories readable + writable | `repository.get_health` | ✅ PASS — 9/9 `gcs`, healthy |
| T0.5 | Graph is a valid DAG, no orphans | `workspace.validate_graph` | ✅ PASS |
| T0.6 | CI runs tests on every push | GitHub Actions | ❌ **FAIL** — no `.github/` in repo |
| T0.7 | `dr-lurie.allowedTools` identical across planes | `project.list` on both | ❌ **FAIL** — GCloud grants 3 artifact-write tools Netlify doesn't |

**T0 verdict: NO-GO.** Four blocking failures. T0.1/T0.2/T0.7 are one root cause (split-brain + unconfigured Cloud Run env). Fix per GUI plan §5 Phase 0.

**Drift detector (run on every CI build once both planes exist):**
```
export both planes → normalise (drop updatedAt/position) → deep-diff
FAIL if: node id sets differ, any node's prompt/allowedTools/assignedSkills/
         outputSchema differ, or any project's connection/policy differs
```

---

## Tier 1 — Read surface (MCP)

Sweep every read tool; assert envelope shape `{ok:true, data:{...}}` and non-degenerate content.

| id | Assertion | Status |
|---|---|---|
| T1.1 | `workspace.get_nodes` returns ≥21 nodes, each with all 18 required keys | ✅ PASS |
| T1.2 | `workspace.get_graph` edges ≡ union of all `dependsOn` | ✅ PASS (27 edges) |
| T1.3 | `constellation.get_structure` / `get_summary` / `get_metrics` respond | ✅ PASS |
| T1.4 | `skill.list` returns 12 skills, each with `instructions` + schemas | ✅ PASS |
| T1.5 | `tool.list` returns 31 tools with `riskLevel`/`sideEffect`/`requiresApproval` | ✅ PASS |
| T1.6 | `project.list` returns 4 projects with non-secret metadata only | ✅ PASS — no tokens leaked |
| T1.7 | `workflow.list_runs` returns run records with per-node timing | ✅ PASS (3 runs) |
| T1.8 | `changes.list` returns events with `before`/`after`/revision chain | ✅ PASS |
| T1.9 | **Negative:** no read response contains `Authorization`, `Bearer`, or a token env value | ✅ PASS |

---

## Tier 2 — Effective-config resolution

This is the tier that finds real misconfiguration. Run for **all 21 nodes**, not a sample.

| id | Assertion | Status |
|---|---|---|
| T2.1 | `node.get_effective_prompt` returns own prompt + any skill instructions | ✅ PASS |
| T2.2 | `node.get_effective_tools` allow-set ⊆ `node.allowedTools` | ✅ PASS |
| T2.3 | Every denial carries a machine-readable `denialReasons[]` | ✅ PASS |
| T2.4 | **No node has a `blocker`-severity skill conflict** | ❌ **FAIL** — `article_body` |
| T2.5 | **No node's skill requests a tool the node denies** | ❌ **FAIL** — `article_body`, `contract_intelligence` |
| T2.6 | **No node lists a tool its `riskLevel` forbids** | ❌ **FAIL** — `contract_intelligence` |
| T2.7 | `dependsOn` ≡ `requiredInputs` for every non-entry node | ❌ **FAIL** — `trust_factual` |
| T2.8 | `constellation.get_attention` reports every T2.4–T2.7 failure | ❌ **FAIL** — returns `items: []` |

**T2 verdict: 5 failures.** Detail in GUI plan §4 (D2, D3, D4, D6). T2.6 blocks the publish path.

---

## Tier 3 — Contract validation (positive + negative)

| id | Case | Expected | Status |
|---|---|---|---|
| T3.1 | Minimal valid `article_body.v1` | `valid:true` | ✅ PASS |
| T3.2 | Remote-URL image `src` | reject | ✅ PASS — *"Image media.src must be a materialized reference, not a remote, data, or blob URL."* |
| T3.3 | `data:` URI image `src` | reject | ⬜ not yet run |
| T3.4 | Media node missing `rendering.placement` | reject (conditional `allOf`) | ⬜ |
| T3.5 | `ctaText` without `ctaLink` | reject (`dependentRequired`) | ⬜ |
| T3.6 | Node id not matching `^n_[a-z0-9]+$` | reject | ⬜ |
| T3.7 | Uppercase / spaced slug | reject | ⬜ |
| T3.8 | `blobKey` from a different `requestId` | reject | ⬜ |
| T3.9 | PDF supplied as `type:"image"` | reject | ⬜ |
| T3.10 | Valid dry-run publish payload | `valid:true` | ✅ PASS |
| T3.11 | Payload with `dryRun:false` | reject (`const: true`) | ⬜ |

T3.3–T3.9 and T3.11 are mechanical table-driven cases — write them as a vitest `describe.each`.

---

## Tier 4 — Write round-trip + concurrency

Executed this session against the canonical plane, with teardown.

| id | Assertion | Status |
|---|---|---|
| T4.1 | `workspace.clone_node` creates node, bumps version | ✅ PASS — v53→54 |
| T4.2 | `workspace.update_node_prompt` with correct version succeeds | ✅ PASS — v54→55 |
| T4.3 | **Same write with stale version is rejected** | ✅ PASS (rejected) |
| T4.4 | **Rejection returns a typed conflict envelope** | ❌ **FAIL** — `MCP error -32603: Tool execution failed` |
| T4.5 | Rejected write emits **no** change event | ✅ PASS |
| T4.6 | Successful writes emit events with `before`/`after`/`actor`/`reason`/`correlation` | ✅ PASS |
| T4.7 | Revision chain links `parentRevisionId` → `resultingRevisionId` | ✅ PASS |
| T4.8 | `workspace.delete_node` removes node, bumps version | ✅ PASS — v55→56 |
| T4.9 | Teardown leaves graph valid and node count unchanged | ✅ PASS — 21 nodes, valid |
| T4.10 | Deleting a referenced node is rejected | ⬜ not yet run |
| T4.11 | Two concurrent writers: one wins, one gets a conflict, no lost update | ⬜ — depends on T4.4 |

**T4.4 is the one that matters for your multi-agent scenario.** See GUI plan D5.

---

## Tier 5 — Three-surface consistency

For each operation: perform on surface A, verify on B and C.

| id | Operation | Do on | Verify on | Status |
|---|---|---|---|---|
| T5.1 | Edit node prompt | Cowork/MCP | UI reload + LibreChat | ⬜ blocked by T0.1 |
| T5.2 | Edit node prompt | UI (legacy Nodes tab) | MCP + LibreChat | ⬜ blocked by T0.1 |
| T5.3 | Assign a skill | LibreChat editor agent | MCP + UI | ⬜ blocked by T0.1 |
| T5.4 | Add a dependency | UI (canvas) | MCP `get_graph` | ⬜ blocked by T0.1 |
| T5.5 | Each surface stamps a distinguishable `actor`/`source` in `changes.list` | all three | ledger | ⬜ |
| T5.6 | UI rejects an unauthenticated session | UI logged out | — | ⬜ |
| T5.7 | LibreChat read-only agent cannot write | LibreChat | ledger shows no event | ⬜ |

T5.1–T5.4 are blocked until the planes are reconciled — the UI and Cowork currently address **different workspaces**, so "consistency" is undefined.

---

## Tier 6 — Node & workflow execution (dry run)

**Executed 2026-07-27 against client 0 (`platform`), `executionMode: "mock"`, `budgetUsd: 1`, run `run_1785154072610_3tmmv9`. Zero model spend — mock needs no model calls, so this tier no longer has to wait for a paid window.**

| id | Assertion | Status |
|---|---|---|
| T6.1 | `node.prepare_execution` resolves inputs from upstream stage outputs | ✅ PASS — resolved prompt + skill instructions + effective tools, and reported `missingInputs: [review_aggregator, contract_intelligence]` with `readinessStatus: "missing_inputs"` rather than proceeding |
| T6.2 | `workflow.start_dry_run` completes the chain `input_triage → article_body` | ✅ PASS — 15 of 18 nodes completed through `article_body`; the 3 remaining are the publish stages |
| T6.3 | Every node output validates against its own `outputSchema` | ❌ **FAIL** — `article_body`'s mock output violates all six required fields of its own schema, and the node completed anyway. See F-1 |
| T6.4 | **Negative:** a node returning `{"output": {...}}` wrapper is rejected | ✅ PASS — `node.validate_output` rejects it (`$.artifact is required`, `$.summary is required`) |
| T6.5 | Run record carries `dryRun:true` throughout | ✅ PASS — on the run and on every node output |
| T6.6 | `workflow.retry_node` re-runs one node without disturbing others | ⬜ not run — blocked by F-4 (the tool advertises no `runId`/`nodeId`, so correct arguments cannot be derived from its schema) |
| T6.7 | `workflow.pause_run` / `resume_run` preserve stage outputs | ✅ PASS — all 15 stage outputs intact across pause → resume (`rev` 16 → 17). But see F-3: pause reports status `blocked` |
| T6.8 | `workflow.get_run_cost` returns per-node cost with its pricing caveat | ✅ PASS — per-node ledger, `mostExpensiveNodeId`, a budget block (`2.94% of $1`), and a `plan` recommending `late_stage_rerun` at `article_body`. See F-5 on mock cost accrual |
| T6.9 | **Negative:** `publication_controller` and `publish_executor` block on `approvalRequired` | ◑ **PARTIAL** — the run did stop before the publish stages, but recorded `approvalsRequired: []` and left status `running`. Nothing states a gate is holding. See F-2 |

### Findings

**F-1 — the mock runner is stale, and node output is not validated (highest severity).**
`article_body`'s mock output is `{schema_version, nodes}` — the OLD baked `article_body.v1` shape, from before the contract-as-truth wave generalized the node to an envelope. Its current `outputSchema` requires `artifact`, `summary`, `clientProjectId`, `clientObjectType`, `contractSource`, `body`. Fed back through `node.validate_output`: **invalid on all six**. The node nonetheless reported `completed` and its artifact was persisted to GCS, then consumed downstream. Two defects in one: the mock runner was never updated with the node, and nothing validates a node's output against its own schema at execution time — so T6.3 was not merely unproven, it was unenforced. A dry run therefore cannot certify the contract path; it certifies only that the graph advances.

**F-2 — a run that stops at a gate does not say so.**
`workflow.run_all` halted before `publish_payload`, which is the correct behaviour, but left `status: "running"` with `approvalsRequired: []` and no error. The UI keys its safety-hold display off `status === "blocked" || approvalsRequired.length > 0`, so a run stopped by the publish gate renders as one that simply stopped. The gate works; its reporting does not.

**F-3 — `pause_run` reports `blocked`, which already means two other things.**
There is no `paused` state in `executionStatuses`, so a deliberate pause is indistinguishable from a publish-gate hold or a budget hold by status alone.

**F-4 — `workflow.run_all` and `workflow.retry_node` advertise the wrong input schema.**
Both serve the generic node-mutation schema (`id`, `patch`, `create`, `positions`, …) with `additionalProperties: false`, and neither declares `runId`. `run_all` in fact requires `runId` — passing `id` fails validation. So the advertised contract is wrong in both directions: it omits the required parameter and forbids it. A strict client that validates before sending cannot call these tools at all. Same class as R-3, on the run controls.

**F-5 — mock runs accrue estimated cost against the budget ceiling.**
The mock run recorded 4,655 tokens and `$0.029415` against `budgetUsd: 1` despite making no model calls. A low ceiling would therefore block a run that costs nothing.

**F-6 — GCS 429 during `run_all`.** `artifacts/artifact_angle_strategy_….json` exceeded the object-mutation rate limit mid-run. The run recovered and continued, but a full run writes artifacts fast enough to trip Cloud Storage's per-object write limit.

**F-7 — `contract_intelligence` is not in the workflow sequence** though `article_body` declares it in both `dependsOn` and `requiredInputs`, and `workspace.validate_graph` still reports the graph valid. Either the conductor's sequence omits a required node or the dependency names something that is not a node; either way the graph validator does not catch it.

T6.4 matters — `publish_executor` and `publish_payload` prompts both explicitly forbid wrapping output in `actual/output/data/result/markdown`, which means it has happened.

---

## Tier 7 — Publish readiness gate (no side effects)

| id | Assertion | Status |
|---|---|---|
| T7.1 | Bare article body → `no_go` with itemised blockers | ✅ PASS — 5 blockers, 3 passes |
| T7.2 | Each checklist item returns actionable `detail` | ✅ PASS |
| T7.3 | Missing taxonomy blocks unless explicitly accepted-empty | ✅ PASS |
| T7.4 | Missing pinned approval blocks | ✅ PASS |
| T7.5 | Wrong `artifactProtocol` blocks | ✅ PASS — *"got (none)"* |
| T7.6 | `legacyFallbacksUsed` must be explicitly `false` | ✅ PASS |
| T7.7 | Fully-populated readiness input → `go` | ⬜ not yet run |
| T7.8 | Unverified media ref → `no_go` even with valid blobKey pattern | ⬜ |

**T7 verdict: the gate works.** It correctly refused a payload that wasn't ready, and named all five reasons. This is the strongest component tested.

Observed T7.1 response:
```
status: no_go   state: blocked_for_publish_execution
pass  article_body_valid · media_artifacts_verified · hard_content_path
fail  taxonomy · pinned_approval · release_behavior
      hard_artifact_protocol · hard_legacy_fallbacks
```

---

## Tier 8 — Live publish (throwaway article) — **GATED**

Do not enter Tier 8 until T0–T7 are green **on two consecutive full passes**.

Three independent locks are currently closed, by design:
1. `dr-lurie.publishingPolicy.publishEnabled = false`
2. `publish_executor.status = "draft"`, `metadata.activationRequired = true`
3. Readiness gate requires a pinned approval

**Procedure**

| id | Step | Guard |
|---|---|---|
| T8.1 | Generate `article_body.v1` with slug `zz-cms-agent-smoke-test-YYYYMMDD` | title/body clearly marked as a test |
| T8.2 | `article_body.validate` → `valid:true` | hard stop on fail |
| T8.3 | `publish.build_payload` → `publish.validate_payload` | hard stop on fail |
| T8.4 | `workflow.publish_readiness` → `go` | hard stop on `no_go` |
| T8.5 | Enable `publishEnabled` for `dr-lurie` | **human approval** |
| T8.6 | Activate `publish_executor` (`status:active`) | **human approval** |
| T8.7 | Pin approval on the request | **human approval**, recorded in ledger |
| T8.8 | `workflow.publish_run` | **human approval at the call** — irreversible |
| T8.9 | Verify via `Dr_Lurie_MCP.object_get` + live URL | — |
| T8.10 | `verify_article_images` if any media | — |
| T8.11 | **Unpublish** the test article | mandatory teardown |
| T8.12 | Re-close all three locks | mandatory teardown |
| T8.13 | Confirm ledger contains the full publish trail | — |

**Rollback:** `object_publish` with `unpublish`, or `changes.restore` to the pre-publish revision. Establish which applies *before* T8.8, not after.

**Standing rule:** T8.5–T8.8 are irreversible or policy-changing. Each requires explicit human go-ahead at the moment of the call. An agent running this protocol stops at T8.4 and reports.

---

## Tier 9 — Regression & quality

| id | Assertion |
|---|---|
| T9.1 | `npm test` (83 specs) green |
| T9.2 | `npm run test:ui` (11 specs) green |
| T9.3 | `npm run build` + `npm run ui:build` clean (`tsc --noEmit`) |
| T9.4 | `evaluation.run_regression` against the stored rubric shows no score drop |
| T9.5 | Drift detector (T0.1) green |
| T9.6 | `usage.get_budget_status` within budget after a full protocol pass |

---

## Execution modes

**Fast (per commit, ~2 min):** T0, T1, T3, T9.1–T9.3, T9.5.
**Full (nightly / pre-release):** T0–T7, T9.
**Live (manual, human present):** full pass ×2, then T8.

---

## Appendix A — Dry-run results, 2026-07-26

Executed against `CMS_Agent_GCloud` (canonical). All writes reverted; workspace ended at 21 nodes, `workspaceVersion 56`, graph valid.

**Passed (21):** T0.3, T0.4, T0.5, T1.1–T1.9, T3.1, T3.2, T3.10, T4.1, T4.2, T4.3, T4.5, T4.6, T4.7, T4.8, T4.9, T7.1–T7.6
**Failed (10):** T0.1, T0.2, T0.6, T0.7, T2.4, T2.5, T2.6, T2.7, T2.8, T4.4
**Not run:** T3.3–T3.9, T3.11, T4.10, T4.11, T5.*, T6.*, T7.7, T7.8, T8.*, T9.*

**Overall: NO-GO for live publish.** The gates and validators are sound — the failures are configuration and observability, not core logic. In order of what blocks what:

1. **T0.2** — the canonical plane has no Dr. Lurie connection. Nothing downstream of this can be tested end-to-end.
2. **T0.1 / T0.7** — two divergent workspaces. Any cross-surface test is meaningless until reconciled.
3. **T2.6** — `contract_intelligence` cannot call `project.call_tool` (`risk_level_exceeds_authorization`). The contract-fetch step of the publish path is structurally dead.
4. **T2.4 / T2.5** — `article_body` has a blocker-severity skill schema conflict and resolves to zero effective tools.
5. **T4.4** — version conflicts aren't typed, so concurrent agent editing has no recovery path.
6. **T2.8** — the attention endpoint reports none of the above, so none of it is visible in the product.
7. **T0.6** — no CI, so nothing above stays fixed.

**What went right, and is worth protecting:** the change ledger's fidelity (full before/after snapshots, revision chaining, actor attribution, request correlation), the readiness gate's itemised NO-GO, the `article_body.v1` validator's rejection of remote image sources, and optimistic concurrency actually rejecting stale writes. Those four are the load-bearing parts of a safe agent-editing system, and they work.

---

## Appendix C — T-1 conformance vs client 0 (platform), 2026-07-27

Executed against `CMS_Agent_GCloud` (canonical, workspace **v70**) with `platform` registered as client 0 (W-1) after ENV-3 landed. Note: `project.create` did not bump `workspaceVersion` — the project registry is a separate repository from the node workspace, so a connection change is invisible to any drift check keyed on `workspaceVersion` alone. Read-only throughout: the only client tools reachable were the five on platform's allow-list (`ping`, `registry_get`, `object_contract`, `object_inventory`, `object_validate`) — every mutating verb was refused by policy, not by intent.

### Verdict: **GO on client 0.** The mcp.ts move is verified in both directions.

Every failure below is workspace-side (node authoring and observability). Client 0 passed everything asked of it.

**Tier 0 — preconditions**

| id | verdict | evidence |
|---|---|---|
| T0.1 | **superseded** | "both planes report the same `workspaceVersion`" was written when split-brain was live. Netlify is now a deliberately frozen archive, so version equality is not the invariant any more — the replacement is R-0's code-level two-plane drift detector (136 tools identical, manifest-locked). |
| T0.2′ | ✅ PASS | `project.test_connection("platform")` → `ok:true`, `serverInfo.name: "Platform_MCP_Server"`, protocol `2025-06-18`. This independently confirms §0's claim that `serverInfo.name` now derives from site-identity. |
| T0.3′ | ✅ PASS | `ping` via `project.call_tool` → `ok:true`. |
| T0.4 | ✅ PASS | 9/9 repositories `gcs`, healthy, readable + writable. |
| T0.5 | ✅ PASS | `workspace.validate_graph` → `valid:true`, zero issues. |
| T0.6 | ⧗ pending merge | CI exists (wave-1 patch series) but is not on `main` yet. Becomes PASS on merge. |
| T0.7′ | **superseded** + PASS | Cross-plane allow-list equality is moot with one live plane. The meaningful check — every allow-listed tool actually exists on the remote — passes 5/5 against platform's 51 exposed tools. No phantom grants. |

**Tier 1 — read surface: 9/9 PASS.** 21 nodes with all 18 keys; 27 graph edges ≡ 27 `dependsOn` union; 12 skills; 31 tools all carrying `riskLevel`/`sideEffect`/`requiresApproval`; 5 projects; 3 runs with per-node `durationMs`; change events carrying `before`/`after` plus a `parentRevisionId`/`resultingRevisionId` chain. T1.9 negative swept clean — no `Bearer`, no token, no resolved endpoint URL in any response. Two naming notes: the revision-chain fields are `parentRevisionId`/`resultingRevisionId`, not the `baseRevisionId` this document assumed; and 7 of 12 skills still carry a placeholder `outputSchema: {"type":"object"}` (the R-2 flattening workaround, not a defect in itself).

**Tier 2 — effective-config resolution, all 21 nodes**

| id | verdict | detail |
|---|---|---|
| T2.1 | ✅ PASS | Effective prompt = own prompt + injected skill instructions. 9 of 21 nodes have instructions injected. |
| T2.2 | ✅ PASS | No node's allow-set exceeds its own `allowedTools`. No privilege escalation anywhere. |
| T2.3 | ✅ PASS | Every denial carries a non-empty `denialReasons`. |
| T2.4 | ✅ **PASS — fixed since Appendix A** | The `article_body` blocker-severity conflict is gone. The only conflicts left are `severity:"warning"` on `publication_controller` / `publish_executor` (`tool_policy`: "Tool not granted by effective policy: project.call_tool") — the publish gate working as designed. |
| T2.5 | ❌ FAIL (4) | `article_body`, `contract_intelligence`, `publish_payload`, `artifact_plan`. All four: the skill resolver reports `effectiveTools:["project.call_tool"]` while `node.get_effective_tools` reports that same tool `allowed:false, denialReasons:["approval_required"]`. This is R-5, and these four are the exhaustive current list. |
| T2.6 | ❌ FAIL (14) | **Wider than Appendix A recorded.** Not `contract_intelligence` — that one is now T2.5. Fourteen nodes carry `stage.save_output` (riskLevel `write`) in `allowedTools` while the node's own `riskLevel` is `read`, so the resolver can never grant it: `topic_opportunity`, `reader_insight`, `research`, `objection_mapping`, `input_triage`, `narrative_movement`, `angle_strategy`, `brief_architect`, `draft_writer`, `human_texture`, `trust_factual`, `emotional_resonance`, `reader_simulation`, `review_aggregator`. **Severity, verified against the executor:** nothing is functionally broken — `executor.ts:393` and `nodeRuntime.ts:107` call `saveStageOutput` directly, so stage outputs persist regardless of the grant. The defect is that 14 nodes advertise a capability that is permanently unreachable, which (a) misleads anyone reading the config and (b) plants a permanent false denial in every effective-tools report — exactly the noise that let `contract_intelligence`'s real problem hide. Fix is one of: raise those nodes to `riskLevel: write`, or drop the dead grant. |
| T2.7 | ✅ PASS on the correct reading | The assertion is scoped to *non-entry* nodes. The only mismatch is `input_triage` (`dependsOn: []` vs `requiredInputs: ["content_source.v1"]`) — it is the entry node, and `content_source.v1` is an external envelope, not an upstream node id. `trust_factual`, the node Appendix A recorded as failing, now matches. |
| T2.8 | ❌ FAIL | `constellation.get_attention` → `items: []` against 4 T2.5 and 14 T2.6 findings. R-10 unchanged. |

**Semantics caveat that matters for reading Tier 2:** the effective-resolution context carries no approvals, so *every* `requiresApproval` tool shows `approval_required` in this view. "Denied here" is not "denied at run time" — a run with a pinned approval resolves differently. Any future automated assertion on Tier 2 must account for this or it will report false failures forever.

**Tier 3 — contract validation against client 0's own validator: 10/10 PASS.** Per R-6, the client's `object_validate` was the only authority used; the local `article_body_validate` was not called.

Positive (4/4): `page_home`, `site_platform`, `nav_header`, `tax_platform` all return `summary.level: "ready"`, `eligible: true`, zero blockers.

Negative (6/6 correctly rejected):

| case | verbatim client refusal |
|---|---|
| `brandTokens` via `set_site_fields` | `"'brandTokens' cannot be patched via set_site_fields (the palette changes only via site_apply_theme)."` (`invalid_op`) |
| nonexistent patch op | `"Invalid discriminator value. Expected 'set_page_meta' \| 'upsert_section' \| …"` (`invalid_op`) |
| malformed section id | `"Section ids must match s_<lowercase alphanumerics>"` (`invalid_op`) |
| required field nulled | `schema_zod`: `"title: Invalid input: expected string, received undefined"` |
| dangling reference | `references`: `"page.template.ref \"tpl_does_not_exist_1234\" does not resolve to an existing template."` |
| leaf-rule violation | `structure_placeable`: `"Section type(s) with no standalone component: card — placing them directly on a page breaks the build…"` |

No documented constraint failed to enforce live. That is the strongest single result in this run: client 0's contract and its enforcement do not disagree.

### Client-side observations for the platform repo (not workspace defects)

1. **P-1 looks substantially done.** Client 0 now carries 16 published pages including a per-type manual (`page_manual` plus `content_item`, `page`, `section`, `section_template`, `site`, `taxonomy`, `template`, `theme`, `tracking_config`, `product`, `roles`, `lifecycle`, `navigation`, `genesis`), 2 navigations, a taxonomy, 5 section templates and a theme. The plan still lists P-1 as NOT DONE — worth re-marking. Note the manual is built as `page` objects; there are **zero `content_item` objects** on client 0 yet.
2. **Two different self-names.** `initialize` reports `serverInfo.name: "Platform_MCP_Server"`; `ping` reports `"server": "Platform_MCP"`. Harmless today, but a conformance surface that says two things about its own identity is the kind of thing site-identity was meant to make single-sourced.
3. **Possible PageType mislabel on `page_home`.** A rejection message for a card placed on `page_home` read `"Section types not allowed on PageType system"`, implying `page_home.pageType` is `"system"` rather than `"home"`. The rejection was correct either way (the leaf rule alone blocks it), so this is not a gate failure — but if `page_home` really is typed `system`, then `structure_home_footer` (blocks_publish for pageType `home`) is not applying to the home page. **Unresolved here on purpose:** confirming it needs `object_get`, which is deliberately not on client 0's allow-list. Widening that list is a Ring-1 change and wants approval, not an agent deciding on its own.

---

## Appendix B — Implementation notes

Put the protocol in the repo as `tests/protocol/`, one file per tier, driven by a shared MCP client so each tier is runnable standalone. Tiers 0–4 and 7 need no model calls and are cheap enough for CI. Tier 6 costs tokens — nightly, not per-commit. Tier 8 never runs unattended.

`vitest` is already configured for both projects; follow the existing convention (pure logic in framework-free modules under `tests/`, thin component specs under `ui/tests/`). Do not invent a second test runner.
