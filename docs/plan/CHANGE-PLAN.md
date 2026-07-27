# Consolidated change plan — CMS-Agent workspace, repo, and fleet integration

**Date:** 2026-07-26 · **Rule in force: no code or MCP changes until this plan is approved.**
Everything below is planned, not executed. Each change has an ID for reference during execution.

---

## 0. Platform repo — verified state (fresh clone, commit `14cc787`, PR #476, merged today 18:43)

Checked against the repo, not your words. The split is real:

| claim | verdict | evidence |
|---|---|---|
| mcp.ts moved to core | ✅ DONE | `packages/core/server/functions/mcp.ts`, 4,612 lines, `configureMcp()` + fail-closed `requireSiblings()` |
| Dr-Lurié shim at old path | ✅ DONE | 40-line shim; legacy article trio injected as optional handlers, stays repo-root, "frozen and untouched" |
| Platform site shim | ✅ DONE | 23 lines, no legacy trio — "the correct outcome, not a gap" |
| `serverInfo.name` from site-identity | ✅ DONE | `getSiteIdentity().mcpServerName`; platform announces `Platform_MCP_Server`, drlurie byte-identical to historical literals |
| Branded examples de-sited | ✅ DONE | one historical comment left; examples now `req_publish_launch_…` |
| `create-site` generates the shim | ✅ DONE | `mcpShimTemplate()` + server names from slug + `/mcp` redirects, test-covered |
| Platform self-README content | ❌ NOT DONE | `sites/platform/data/site/` is create-site bootstrap placeholders only; articles/sections/themes dirs empty |
| Voice/vox object type | ❌ NOT DONE | zero hits in `packages/core/schema` |

The two NOT DONEs are expected — they're in this plan (P-1, P-2). One risk I flagged earlier is closed: server names can't collide.

---

## 1. Change list

Legend: **W** = workspace data via MCP (reversible, ledgered) · **R** = CMS-Agent repo code · **P** = platform repo · **ENV** = deployment config (Wolf, manual) · **T** = test/protocol execution.
Status: ☐ planned · ⧗ blocked · ✅ done this session.

### ENV — deployment (Wolf, manual; nothing else can bypass this)

| id | change | notes |
|---|---|---|
| ENV-1 ✅ | Set `DR_LURIE_MCP_ENDPOINT` / `DR_LURIE_MCP_TOKEN` on Cloud Run | **Done 2026-07-27** (Wolf). Verified: `test_connection` → `Dr_Lurie_MCP_Server` 0.1.0; `project.call_tool("dr-lurie","ping")` → `Dr_Lurie_Science_MCP`. First paste was the wrong token (401); the fix was re-copying the right one |
| ENV-2 ✅ | Set `PDF_TOOL_MCP_ENDPOINT` / `PDF_TOOL_MCP_TOKEN` on Cloud Run | **Done 2026-07-27** (Wolf). Verified: `test_connection` → `pdf-tool-agent-artifacts` 0.2.0, and the **brokered chain proven through `project.call_tool`** — see §2e |
| ENV-3 ✅ | Set `PLATFORM_MCP_ENDPOINT` / `PLATFORM_MCP_TOKEN` on Cloud Run | **Done 2026-07-27** (Wolf). Verified: `endpointConfigured`/`tokenConfigured` both true, `test_connection` → `Platform_MCP_Server` |
| ENV-4 ☐ | After W-2: remove `SNOOCLE_*` env vars | **Now actionable** — W-2 closed 2026-07-27, snoocle is deleted from the registry. Cleanup only. **Scope narrowed:** keep `MONETIZER_*` — `feedback.ingest_monetizer` still uses that connection (see W-2) |

Verify each with `project.test_connection` — currently fail-closed, which is correct.

### W — workspace data changes (MCP; each carries actor/reason; ledgered; reversible)

| id | change | depends on | detail |
|---|---|---|---|
| W-1 ✅ | **Register `platform` as client 0** — `project.create` per the registration contract: `projectId: platform`, `mcpEndpointEnvVar: PLATFORM_MCP_ENDPOINT`, `tokenEnvVar: PLATFORM_MCP_TOKEN` | ENV-3 | then `test_connection` → `list_tools` → allow-list read-only contract tools first (`object_contract`, `registry_get`, `object_inventory`, `object_validate`, `ping`), widen later behind the same gate as dr-lurie |
| W-2 ✅ | **Retire `snoocle`; keep `monetizer`** — `project.delete snoocle` succeeded 2026-07-27 once the deploy carried the de-seeded defaults; registry is now dr-lurie / monetizer / pdf-tool / platform | none | Both records **disabled** via `project.update` (ledgered, reversible) — `project.delete` refuses a code-defined default ("re-seeded on read"). Repo commit removes snoocle from `defaultProjectConnections`, so `project.delete snoocle` works once it lands. **monetizer is NOT a fake registration**: `improvement/monetizerIngest.ts` imports `monetizerProjectConfig` to power the `feedback.ingest_monetizer` tool, so deleting it drops a live tool from the wire surface. Retiring it is a decision about the Phase 7 outer loop, not registry hygiene. pdf-tool untouched — Ring 0 |
| W-3 ✅ | **Generalize `learning_recorder` prompt** — last mechanical "Dr. Lurie" in contract-logic context | none | Done, workspace v69→v70. Now "project artifact/rendering failures", matching the node's own description. Full-node patch used deliberately (R-1) |
| W-4 ⧗ | **Generalize the five editorial-voice nodes** (`topic_opportunity`, `research`, `brief_architect`, `draft_writer`, `trust_factual`) to fetch voice from the client | **P-2 (voice object)** | do NOT do earlier — there is nowhere to fetch voice from; premature generalization degrades writing quality |
| W-5 ⧗ | **Split `dr_lurie_dtc_science_editorial`** into a client-neutral craft skill + per-publication voice record | P-2, W-4 | the skill's content seeds the first `vox_drlurie_default` record |

### R — CMS-Agent repo changes (need CI first; ordered)

**R-0 ✅ CI (GitHub Actions).** `npm test` + `npm run test:ui` + both builds on every push, plus the two-plane drift detector. **Gates everything below** — 94 tests, zero automation today; nothing on this list stays fixed without it.

**R-1 ✅ Data-loss fix: single-field `update_node_*` writers.** `update_node_tools/_skills/_dependencies/_metadata/_model_config` write `undefined` over the target field when the patch omits it — reproduced: `ok:true` while wiping `allowedTools`. Fix: reject a patch missing the target field. *Highest severity on the list.*

**R-2 ☐ Skill-compatibility resolver fix.** Any skill `outputSchema` with `additionalProperties`/`properties`/`required` reports blocker-incompatible regardless of actual compatibility; only bare `{"type":"object"}` passes. Current skills work because we flattened them — the next properly-specified skill re-triggers it.

**R-3 ✅ Coerce stringified JSON in `update_node_output_schema` / `_input_schema`.** Done 2026-07-27 via `store.coerceSchemaInput`, modelled on the `coerceNodeInput` that already defends `create_node` (the defense lives in the store, not in `coerceJsonObjectInput`). Both writers coerce before validating; `schema` is now advertised as `{type:["object","boolean"]}` instead of permit-anything `{}`, which reshaped two tools and required a deliberate manifest regeneration. **Correction to this item's premise:** R-3 was recorded as "the only reason the S4 Schemas tab is read-only", and that was wrong — S4 saves through `workspace.update_node`, which never touched the schema writers. The tab was never blocked by this; it is editable as of the same commit (see §2f). R-3's real beneficiaries are `ui/src/hooks/useWorkspace.ts` `updateOutputSchema` (the legacy textarea path) and any agent or script calling the dedicated writers.

**R-4 ✅ Typed version-conflict envelope.** `{ok:false, code:"version_conflict", currentVersion, currentRevisionId}` instead of bare `-32603`. Precondition for multi-agent editing and for the S4 save path. Also surface `error.data` detail generally — it exists but clients only see "Tool execution failed".

**R-5 ☐ Reconcile the two resolvers.** `skill_resolve_for_node` says `effectiveTools:["project.call_tool"]` where `node_get_effective_tools` says `allowed:false` for the same nodes. One semantics, one answer; the GUI can't render two truths.

**R-6 ☐ Retire `article_body_validate` / `article_body_get_schema`.** Drifted local copy; the client's `object_validate` is the authority. Either remove, or repoint as a thin proxy that calls the client contract — never a local schema again.

**R-7 ☐ Project record: `kind: client|service`, `clientNumber`, `contentSubstrate`.** The `project.update` patch schema has no metadata field today, so this is a repo schema change, not a data write. Sets: platform `{client, 0, object}`, dr-lurie `{client, 1, object}`, pdf-tool `{service}`. This is what stops a service being mistaken for a deletable client again.

**R-8 ☐ Contract-driven allowlist reconciliation.** `project.list_tools` + the workspace's declared required capabilities → effective allowlist with drift *reported*. Two hand-kept lists caused the pdf-tool regression; this makes it structural.

**R-9 ☐ `requestId` on runs and usage records.** The change ledger already carries `correlation.requestId`; runs and usage don't. This is the join key between platform workflow records and workspace runs — without it the learning corpus sees outcomes without method.

**R-10 ✅ Attention resolution.** `constellation.get_attention` must report: blocker-severity skill conflicts, skill-requested-but-denied tools, `dependsOn`≠`requiredInputs`, unconfigured project connections, and (after R-12) stale docs. Today it returns `[]` against real defects.

**R-11 ✅ S4 node inspector — read-only AND write path both landed.** Three-layer rendering per node: Method (stored, always) / Effective (resolved, always) / Identity (live contract fetch — greyed "client contract unreachable (`<ENV_VAR>`)" when down, run controls disabled, `fetchedAt` always shown, never stale-as-live). Tabs: Prompt, Tools (own vs effective with `denialReasons`), Skills (with conflicts), Overview, Schemas. Connection badge on the project selector. **Write path ships only after R-4.** This closes your stated gap: seeing node instructions and attributes.

**R-12 ☐ Docs generator + Tier D.** Introspection → self-description artifacts (stamped `workspaceVersion`/`revisionId`) → `content_source.v1` envelopes → normal pipeline → client 0. Tier D diffs published `sourceWorkspaceVersion` against live workspace; stale → attention item. Repo-analysis narrative docs regenerate in CI on merge; per-object mechanics docs derive from introspection only.

**R-13 ☐ Protocol as code.** `tests/protocol/`, one file per tier, shared MCP client; Tiers 0–4, 7, D in CI (no model calls); Tier 6 nightly; Tier 8 never unattended.

**R-14 ☐ S5 Operate / S6 History.** Per the GUI plan — after S4 stabilizes.

**R-15 ☐ UI/engine type correspondence test.** `ui/src/types/workspace.ts` re-declares engine types by hand and has drifted: `WorkflowExecutionRecord` is missing `rev`, `entrypoint`, `budgetUsd`, `budgetBlock`; `RunBudgetBlock` and `WorkflowEntrypoint` have no UI counterpart. Trees are isolated at build time so duplication is structural — add the correspondence test `toolDenialReasons` / `executionStatuses` / `workspaceActorKinds` already have.

**R-16 ✅ Validate node output against its own `outputSchema` at execution time.** Done 2026-07-27 — the executor validates after the runner returns and **fails closed**: status `failed`, the schema issues named in `errors`, and neither the stage output nor the artifact written, so a malformed value cannot reach a downstream node or the ledger. Proven by forcing a runner to return the exact literal T-2 caught. Original note: T-2 F-1: `article_body` completed and persisted an artifact that fails all six required fields of its own schema. Nothing checks it. *Highest severity on the current list* — it means a dry run cannot certify the contract path, only that the graph advances.

**R-17 ✅ Refresh the mock runner against the current node schemas.** Done 2026-07-27 — `execution/mockOutputFromSchema.ts` derives fixtures FROM each node's schema, including `anyOf`/`oneOf`/`allOf`; a drift guard asserts every canonical node's mock validates, plus the strictest schema in the repo. Also removed a SECOND hand-written copy of the same fixtures from `executor.ts`. Original note: T-2 F-1: the mock output for `article_body` is the pre-contract-as-truth `{schema_version, nodes}` shape. Mock fixtures must be derived from each node's `outputSchema` rather than hand-written, or they will drift again the next time a node is generalized.

**R-22 ☐ The conductor ignores the live workspace by default — decide the default.** Found while building R-17. `resolveConductorNodes()` returns the STATIC hardcoded definitions unless `WORKSPACE_NODES_SOURCE=store`, so a run executes `src/agent/workspace/nodes.ts` (last touched 2026-07-03), not the live workspace. The six nodes the contract-alignment wave rebuilt therefore do not participate in a run, and **`contract_intelligence` does not exist in the seeded set at all** — the real explanation of T-2's F-7 rather than a graph-validator gap. So **T-2 exercised an obsolete pipeline**. The gate is deliberate ("behavior is unchanged until an operator flips it after a side-by-side mock run confirms identical topology") — but the topology is no longer identical, so it now hides the alignment work rather than protecting it. **Wolf's call:** flip the default to `store`, or re-seed `nodes.ts` from live.

**R-23 ☐ THREE competing `article_body` schemas, and a name that no longer describes anything.** Found by Wolf challenging the "legacy" claim — and it sharpens R-22.

| # | Where | Shape | Strict |
|---|---|---|---|
| 1 | `nodes.ts` seeded — what the conductor runs in static mode | `{artifact, summary}` | open |
| 2 | `store.ts:196` — installed as article_body's schema in **every fresh workspace** | `{schema_version, nodes[]}` — the legacy monolith | `additionalProperties: false` |
| 3 | Live workspace (v85) | `{artifact, summary, clientProjectId, clientObjectType, contractSource, body}` | open |

**Correction to §2i's F-1:** the old hand-written mock was NOT simply stale — it is **valid against #2**, verified. It was written to match the legacy monolith `store.ts` still installs. "The fixture drifted" was the wrong diagnosis; one node has three schemas and the fixture matched one of them.

**The naming debt.** The client's object types are `page`, `section`, `navigation`, `taxonomy`, `site`, `template`, `section_template`, `theme`, `product`, `content_item`, `tracking_config` — **there is no `article` object**. Nothing publishes an "article body"; a publish writes ONE object of the type named in `clientObjectType`, shaped by the client's contract at run time. #3 models that correctly, so the structure is right and the artifact name `article_body.v1` is a leftover from the Dr-Lurié-era monolith. #2 IS that monolith, the same legacy surface R-6 already targets via `article_body_validate` / `article_body_get_schema`.

Recommended: delete #2 (it silently overrides the seeded schema on every fresh workspace), resolve #1 via R-22, and rename the artifact to describe "one client object".

⚠️ *Not verified today.* The object-type list is from a live `object_contract` read recorded in `docs/plan/findings/`, not a fresh read — the client connections were down and the session's MCP link dropped. **Dr-Lurié is the authority to re-check**: the client brings its own publishing rules, so the client's contract decides this, not the workspace's vocabulary.

**R-18 ☐ Report why a run stopped.** T-2 F-2: `run_all` halts before publish-risk nodes with `status: "running"` and `approvalsRequired: []`, so the gate is invisible to the UI and to an operator. Record the hold. Also F-3: add a distinct `paused` state — `pause_run` currently reports `blocked`, which already means publish-gate hold and budget hold.

**R-19 ☐ Fix the advertised input schemas on `workflow.run_all` / `workflow.retry_node`.** T-2 F-4: both serve the generic mutation schema, omitting the required `runId` while `additionalProperties: false` forbids it. A strict client cannot call them. Same class as R-3.

**R-20 ☐ Mock runs should not accrue cost against `budgetUsd`.** T-2 F-5: a mock run recorded $0.029 estimated against the ceiling despite making no model calls.

**R-21 ☐ Graph validation misses a dependency that is not a node.** T-2 F-7: `article_body` declares `contract_intelligence` in `dependsOn` and `requiredInputs`, it is absent from the conductor sequence, and `validate_graph` still returns valid.

### P — platform repo (their side; for the record, so dependencies are visible)

| id | change | unblocks |
|---|---|---|
| P-1 ◑ | Client-0 self-README content — **appears substantially done** (16 published pages incl. a per-type manual; zero `content_item` objects yet). Re-verify and close — Claude Code bootstrap for narrative; taxonomy terms (`engine`, `node`, `skill`, `tool`, `policy`) registered so generated docs resolve | T-3 |
| P-2 ☐ | Voice object type (`vox_`, modeled on theme, resolve-by-reference) + `vox_drlurie_default` seed | W-4, W-5 |
| P-3 ☐ | Machine-readable request-id pattern in `object_contract` (today prose-only in the `id_object` constraint) | closes the orphaned-artifact class fleet-wide |
| P-4 ☐ | Delete the two orphaned test artifacts (needs admin): sha `5b62bc51…` under `req_smoke_imagepipeline_20260726_01` (soft-delete) and `req_cms_agent_image_smoke_20260726` (orphan — needs reconcile or direct blob access) | hygiene |

### T — execution milestones (protocol runs, in order)

| id | milestone | gate | depends on |
|---|---|---|---|
| T-1 ✅ | Conformance vs client 0: Tiers 0–3 | **GO on client 0** — see TEST-PROTOCOL Appendix C. mcp.ts move verified both directions; all remaining failures are workspace-side | ENV-3, W-1 |
| T-2 ◑ | Full dry-run pipeline vs client 0 (Tier 6) — **executed 2026-07-27 in `mock` mode at zero model spend.** 6 of 9 assertions PASS, T6.3 **FAIL**, T6.9 partial, T6.6 blocked. Seven findings, see §2i and TEST-PROTOCOL Tier 6 | contract-driven method proven on a second client | T-1 |
| T-3 ☐ | **First live publish (Tier 8) = engine docs to client 0** | human approval at the publish call; replaces throwaway smoke articles permanently | T-2, P-1, R-12 |
| T-4 ☐ | Dr. Lurié readiness → live (Tier 7 → 8) | the three locks open deliberately: `publishEnabled`, `publish_executor` activation, pinned approval — each human-gated | ENV-1/2, T-3 |

---

## 2. Dependency spine

```
ENV-3 ──► W-1 ──► T-1 ──► T-2 ──┐
R-0 ──► R-1..R-6 (fixes)        ├──► T-3 (live: docs to client 0)
        R-12 (docs gen) ────────┘
P-1 (client-0 content) ─────────┘
P-2 (voice) ──► W-4 ──► W-5          (independent track)
ENV-1/2 ────────────────────► T-4 (Dr. Lurié live)
R-4 ──► R-11 write path;  R-11 read-only has no blockers
```

**Can start immediately, in parallel:** R-0 (CI), R-11 read-only (inspector), W-2 (delete fake projects), W-3 (learning_recorder), ENV-1/2/3 (yours).

**Deliberately deferred:** W-4/W-5 until voice exists (P-2) — generalizing voice-bearing prompts with nowhere to fetch voice from trades quality for purity.

---

## 2b. Execution log — 2026-07-26, wave 1 (approved: R-0, R-11 read-only, W-2, W-3)

| id | outcome |
|---|---|
| W-3 ✅ | `learning_recorder` prompt generalized. Workspace **v69 → v70**, graph still valid. |
| W-2 ◑ | snoocle + monetizer records **disabled**; snoocle removed from the code-defined defaults so its delete will stick; monetizer deliberately kept (see above). Remaining step: run `project.delete snoocle` after the repo patch lands. |
| R-0 ✅ | `.github/workflows/ci.yml` — workspace (typecheck + tests), ui (tests + build), drift, and a `CI` summary job that fails on a skipped/cancelled dependency. No secrets required. |
| R-0 ✅ | `scripts/twoPlaneDrift.ts` + `docs/mcp-tool-manifest.json` — drives both plane adapters in-process; asserts plane parity (**136 tools identical**), manifest lock, and alias parity. `npm run test:drift` / `npm run drift:update`. |
| R-11 ◑ | Read-only S4 inspector: three named layers, five tabs, consistency warnings, connection badge. Write path still gated on R-4. |

Suite after the wave: **707 root tests** (was 668), **55 ui tests** (was 45), both builds green, drift clean.

**Findings that change the plan.** (1) `project.delete` cannot retire any code-defined default — every such retirement is a repo change first, workspace second; W-1's future symmetry should assume this. (2) monetizer is load-bearing, so W-2 and ENV-4 both narrow to snoocle. (3) R-4 is worse than "untyped error": `handleMcpJsonRpc` returns `-32603 "Tool execution failed"` with the real cause in `error.data`, which MCP clients do not surface — the `default_project_protected` refusal above was indistinguishable from a server crash until it was read from source. That makes R-4 a prerequisite for *diagnosing* anything, not only for the S4 save path.

---

## 2c. Execution log — 2026-07-27, wave 2 (W-1 + T-1, unblocked by ENV-3)

| id | outcome |
|---|---|
| ENV-3 ✅ | Confirmed live from the workspace side: both `connection` booleans true on first read. |
| W-1 ✅ | `platform` registered as client 0 — deny-by-default, five read-only contract tools allowed (`ping`, `registry_get`, `object_contract`, `object_inventory`, `object_validate`). All five verified present among the 51 tools platform exposes: no phantom grants. Publishing policy server-forced disabled, as designed. |
| T-1 ✅ | **GO on client 0.** Tier 0 green (T0.1/T0.7 superseded by the R-0 drift detector; T0.6 pending merge). Tier 1 9/9. Tier 2 finds 4 R-5 disagreements + 14 ungrantable tool grants + the T2.8 attention gap, and confirms T2.4 is FIXED. Tier 3 10/10 against the client's own validator, including 6/6 correct refusals. Full detail: TEST-PROTOCOL Appendix C. |

**What T-1 settles.** The mcp.ts split works in both directions: platform announces itself from site-identity, serves its contract, and enforces that contract exactly as documented — no drift between the two. Nothing found on client 0 blocks anything. Every open failure is workspace-side authoring or observability.

**Findings that change the plan.** (1) **T2.6 is 14 nodes, not one** — and verified harmless to execution (the executor calls `saveStageOutput` directly), so it is a config-honesty defect rather than a functional one, but it is the noise that hid `contract_intelligence`. (2) **T2.4 is fixed** — no blocker-severity conflicts remain anywhere; the two survivors are `warning` and are the publish gate working. (3) **T2.7 passes** on the assertion's own "non-entry node" wording — `input_triage` is the entry node. (4) **Tier 2 has an approval-context artifact**: effective resolution carries no approvals, so every `requiresApproval` tool reads `approval_required` there; automating this tier without accounting for it would produce permanent false failures. (5) **`project.create` does not bump `workspaceVersion`** — the project registry is a separate repository, so any drift check keyed on `workspaceVersion` alone is blind to connection changes. (6) **P-1 looks substantially done** on client 0, and three client-side observations are logged in Appendix C for the platform repo.

---

## 2d. Execution log — 2026-07-27, wave 3 (approved: R-4, R-1, T2.6 cleanup + R-10)

| id | outcome |
|---|---|
| T2.6 ✅ | 14 nodes stripped of the ungrantable `stage.save_output` grant — **in the live workspace** (v70 → v84, graph valid, verified: the tool now denies with `node_tool_not_allowed` first, i.e. the node no longer requests it) **and in `publishingConductorNodes`**, which would otherwise have re-seeded the defect into every new workspace. The set was recomputed from the tool registry rather than trusted from the earlier sweep. |
| R-4 ✅ | Typed failure envelopes. `code` + structured details; conflicts carry `currentVersion`/`currentRevisionId`; `ProjectAdminError` codes surface generically; the JSON-RPC message leads with the code. Message text kept byte-compatible so existing callers that match on it still work. |
| R-1 ✅ | The five single-field `update_node_*` writers now refuse a patch that omits their target field. Regression test verified by reverting the guard (8 failures, including the field-survival assertion). |
| R-10 ✅ | `get_attention` reports five previously invisible classes, each evidence-cited. Absent inputs skip their check rather than reporting a false clean; entry nodes are exempt from the dependency check. |
| R-11 ✅ | **Write path shipped**, R-4 having removed its stated blocker. Prompt / tools / skills are editable; a mandatory reason (≥8 chars), a field-level diff confirmation, and a version-guarded minimal patch gate every write; a conflict reports the version someone else landed on and offers an explicit reload rather than retrying silently. **Schemas editable as of 2026-07-27** (§2f) — the read-only note attributing it to R-3 was a mis-diagnosis. No `actor` is sent — the server's verified identity wins, and a tool-supplied actor would override it. |

Suite after the wave: **742 root tests** (was 707), 55 ui, both builds, drift clean.

**Findings.** (1) The T2.6 defect existed in **both** the live workspace and the code defaults — fixing data alone would have been undone by the next fresh workspace, exactly the snoocle trap. Worth a standing habit: after any workspace-data fix, check whether the seeded defaults carry the same thing. (2) R-4 nearly shipped as a breaking change — three existing tests match on the conflict message text, and they were right to; the fix is additive-only. (3) `get_attention` on a fresh workspace now legitimately reports the three unconfigured default clients, so "no runs" and "nothing wrong" are finally distinguishable. (4) The two-plane drift detector caught the one wire-surface change in this wave (`get_attention`'s description) and required a deliberate manifest regeneration — R-0 paying for itself twice in two waves.

---

## 2e. Execution log — 2026-07-27, wave 4 (ENV-1 + ENV-2 landed; W-2 closed)

| id | outcome |
|---|---|
| ENV-1 ✅ | `dr-lurie` reachable. `test_connection` → `Dr_Lurie_MCP_Server` 0.1.0, protocol 2025-06-18; `project.call_tool("dr-lurie","ping")` → `Dr_Lurie_Science_MCP`. |
| ENV-2 ✅ | `pdf-tool` reachable. `test_connection` → `pdf-tool-agent-artifacts` 0.2.0. |
| — ✅ | **The brokered artifact chain is proven through `project.call_tool` on the GCloud plane** — not just via direct session connectors as in the 2026-07-26 image-pipeline proof. `dr-lurie.get_pdf_tool_storage_grant` → `pdf-tool.list_pdf_templates` + `get_image_search_policy`, each passing the whole grant as `storage`, both returning real data out of Dr. Lurie's Blob stores (11 templates; live 5-provider search policy). This is the T-4 precondition that could not be tested before. |
| W-2 ✅ | `project.delete snoocle` returned `deleted:true` — so **the Cloud Run deploy has picked up the merged code** (the de-seeded `defaultProjectConnections`). That closes the second standing blocker recorded in §4. Registry is now dr-lurie / monetizer / pdf-tool / platform. |
| — ✅ | Attention re-read after the connections came up: the three unconfigured-client items are **gone**, leaving only the two `warning`s that are the publish gate working as designed. Workspace **v84**, `gcs` healthy, all nine stores readable/writable. |

**Findings.**

1. **A 401 here has two distinct layers, and they look identical in `test_connection`.** The transport bearer (`*_MCP_TOKEN`, what CMS-Agent presents to the client) is separate from the client's *storage* credential. Calling `pdf-tool.list_pdf_templates` with the transport fixed but **no `storage` grant** returns `ok:true` at the MCP layer with `isError:true` and `Netlify Blobs has generated an internal error (401 status code)` inside the tool result. Read the envelope before re-blaming the bearer: a transport 401 fails the whole call, a storage 401 comes back as a successful call carrying a tool-level error.
2. **`project.list` misreports `platform`'s grants.** It shows `allowedTools: []` while `toolPolicies` grants five read-only contract tools — and those five really are callable (`ping` resolved `permission:"allowed"` and answered). So `allowedTools` and `toolPolicies` are two lists that can disagree, and the *enforced* one is `toolPolicies`. Any UI reading `allowedTools` (the S4 connection badge, the project selector) will render client 0 as having zero capability. Straight into **R-8**'s remit; worth a display fix before S5.
3. **R-8 lost its workspace-side source of truth.** `docs/plan/findings/image-pipeline-status.md` derived the authoritative pdf-tool capability set from `article_body`'s `requiredPdfToolCapabilities` enum — that enum no longer exists, having been generalized away by the contract-as-truth wave (correctly: it was a hardcoded client convention). The 14-tool allow-list is now hand-kept with nothing declaring what is required, which is exactly the condition that caused the original pdf-tool regression.
4. **Two allow-list gaps in the artifact job lifecycle**, both pre-existing rather than regressions: `create_agent_artifact_job` is allowed but **`resume_agent_artifact_job` is not**, so a job that blocks awaiting operator approval cannot be resumed through the workspace; and `get_image_model_policy` is not allowed though model routing is read from it. Both are read/resume legs of flows whose other halves are granted.
5. **`article_body` holds the grant that matters and it now works.** Its prompt requires validating through the client's own validator via `project.call_tool`; the node grants that tool, and effective resolution denies it only with `approval_required` (the known no-approval-context artifact of that read), not `node_tool_not_allowed`. `publish_executor` by contrast is denied with **both** reasons — it genuinely lacks the grant, which is the publish lock holding. When T-4 opens the locks, granting `publish_executor` `project.call_tool` is a deliberate step, not a bug fix.

---

## 2f. Execution log — 2026-07-27, wave 5 (R-3 + the S4 Schemas tab)

| id | outcome |
|---|---|
| R-3 ✅ | `store.coerceSchemaInput` — a string is JSON-parsed before validation, an object passes through, a **boolean** passes through (`true`/`false` are legal JSON Schemas, including stringified), and an array/number/null/missing value is refused with `invalid_schema: …` rather than written. Both schema writers coerce before `validateJsonSchema`. The advertised `schema` parameter is tightened from `{}` to `{"type":["object","boolean"]}`. |
| R-11 (schemas) ✅ | **The S4 Schemas tab is editable**, through the identical write discipline as every other field: field-level diff, mandatory ≥8-char reason, version-guarded minimal patch, no `actor`. `inputSchema`/`outputSchema` are threaded through `NodeDraft` → `draftFromNode` → `draftChanges` → `buildNodePatch` → `saveBlockers`. |

**Design decisions worth knowing, because each one is a trap avoided.**

1. **Schemas live in the draft as TEXT, not parsed objects.** The operator edits JSON by hand and mid-edit text is routinely invalid; holding the raw text means a stray keystroke shows a blocker instead of silently reverting the field to the last value that happened to parse.
2. **Diffed semantically, so reformatting never reaches the ledger.** Re-indenting or collapsing to one line is not a change. Key *reordering* is (JSON.stringify is order-sensitive) — that is a deliberate edit to the stored document, not cosmetics. Unparseable text always reports as a change, so "Nothing has changed" can never hide a typo the operator is looking straight at.
3. **Clearing a schema is refused outright.** `{...existing, inputSchema: undefined}` round-trips through `normalizeNode` into `{"type":"object"}` — a silent rewrite dressed up as a deletion. The blocker tells the operator to write `{}` if that is what they mean. This is the R-1 failure mode wearing a different hat.
4. **The deprecated `schema` alias is written in lockstep with `outputSchema`.** The dedicated MCP writer sets both, and `normalizeNode` falls back to `schema` when `outputSchema` is absent; writing only one would leave the alias trailing a stale copy of the schema, visible in this very tab. It is rendered read-only with a note saying it is derived.
5. **Only a CHANGED schema field is validated.** A node whose stored schema is already unparseable must not become uneditable in every other respect — otherwise one bad field locks the whole node.
6. **The parse verdict renders inline while typing** as well as in the save bar, so a dropped brace is visible where it was dropped. The invalid state is a real border colour, not a class that styles nothing.

**Finding: R-3 was mis-attributed in the plan.** The item read "the only reason the S4 Schemas tab is read-only", and `NodeInspector.tsx` said the same in the tab body. Both were wrong: the S4 write path saves via `workspace.update_node` with a merged patch object and never calls the schema writers, and `update_node` always merged correctly. The tab could have been editable at any point since R-11. R-3 remains a real fix for real callers — `useWorkspace.updateOutputSchema` (the legacy textarea path) calls the writer directly, as would any agent or script using the dedicated tools — but it was never what gated the tab. Worth noting as a pattern: a blocker recorded once and then cited by later documents acquires the appearance of having been verified.

Suite after the wave: **780 root** (was 769), **72 ui** (was 68), typecheck clean both projects, both builds green, drift clean after a deliberate manifest regeneration.

---

## 2g. Execution log — 2026-07-27, wave 6 (the explanation layer)

**The brief:** client 0 is `platform`, whose site is the engine's self-README, so it is worth documenting how the engine works in human terms — and enhancing the existing habit of pairing UI with its own explanations, secondary where the layout allows.

**What the audit found.** The house voice was already consistent (one `muted` sentence under each `h2`, declarative, paired with its limit) and `PRODUCT_VISION.md` already mandates the behaviour: *"when something is highlighted the interface should also explain why."* The gap was not missing prose. It was **undocumented vocabularies** and **explanation trapped in `title=` attributes**:

- `risk-badge` (`read`/`write`/`publish`/`admin`) — the ladder that gates tool access at execution time — had **no legend anywhere in the product**, and the load-bearing fact (a node's own risk level is the *ceiling* for the tools it may call) appeared in no surface at all.
- `execution-pill`, `actor-chip`, `permission-chip` — colour-coded families with no legend, though `information-architecture.md` states outright that "colour never carries status alone".
- The Tools tab's **"Why" column printed raw resolver enums** (`risk_level_exceeds_authorization`) on the one screen whose entire purpose is explaining why a tool did not resolve.
- The Method/Effective/Identity model and the three permission states existed **only in `title=` tooltips** — which fail touch, keyboard, screen-reader, fine-motor and cognitively-loaded users (MDN), and which this project's own accessibility spec already rules out as a sole channel.

| what | outcome |
|---|---|
| `ui/src/explain.ts` | The vocabulary registry: 7 vocabularies, 30 terms, each with the raw code, a human label, a plain sentence, and — for anything a human can act on — a remedy. Framework-free, tested by root vitest, per the standing architectural constraint. |
| `toolDenialReasons` | The resolver's 8 refusal codes were inline string literals in `toolPolicy.ts`. They are **user-facing**, so they are now a declared `as const` contract in `toolTypes.ts` and `reasons` is typed against it — a new refusal cannot be added without appearing in the vocabulary a human reads. |
| `components/Glossary.tsx` | Level-2 progressive disclosure over a vocabulary. Native `<details>`: keyboard-operable and screen-reader-navigable with no ARIA or key handling of our own, no `z-index`, no absolute positioning, collapsed by default. |
| Applied | Inspector (denial reasons, risk, layers, severities), Access page (permissions), Changes ledger (actors), Run summary (run states). |
| `docs/ui-glossary.md` | **Generated** from the same registry by `scripts/generateGlossary.ts`, locked in CI (`npm run test:glossary`) exactly as the tool manifest is. |

**Research the design rests on, so it is not relitigated.** NN/g on progressive disclosure: at most two levels, and the progression mechanism must be obvious. The U.S. Web Design System's disclosure guidance: do not condense content *"if users need to see most or all of the information on a page"*, and *"aim for informative labels … rather than vague ones like 'Click here'"*. Hence two rules held throughout: **trigger text is phrased as the question the reader would ask**, and **a per-row denial reason is never collapsed** — the plain-language label renders inline because for that row it *is* the primary content; only the fuller definition and remedy sit behind the disclosure. The raw code always stays beside the label, because operators grep for it, agents emit it, and the runbooks quote it.

**Why the registry is data rather than copy in components.** These same definitions are what client 0 has to publish as the engine's self-README (P-1 / R-12). One registry feeds the interface and the generated document; two copies would drift, and glossary drift is the invisible kind — nobody re-reads a definitions page, so a stale one is trusted indefinitely. The generator is deliberately **the shape R-12 needs** (a stamped artifact derived from introspection, not hand-authored prose) rather than R-12 itself, so that work inherits it instead of replacing it.

**A note on one deleted test, because the judgement is the point.** A rule asserting "a term's label must differ from its de-underscored code" caught exactly one real defect — `tool_disabled`, whose label was the circular "Tool disabled", now "Switched off in the registry". It then flagged `approval_required` and `needs_approval`, where the de-underscored form *is* the product's established term (it appears verbatim in the Access page copy and in `permissionMeta`), so diverging would have been the inconsistency. Label informativeness is a judgement, not a predicate; a rule needing a growing exemption list teaches people to add exemptions instead of thinking. The fix was kept, the rule was dropped, and the reasoning is recorded in the test file so it is not re-added. What replaced it is mechanical and meaningful: labels must be distinct within a vocabulary.

Suite after the wave: **797 root** (was 780), **82 ui** (was 72), typecheck clean both projects, both builds, drift clean, glossary lock verified to bite.

**Still open, deliberately** (named rather than silently skipped): the `WorkflowControls` button row still does not say that Reset discards run state or that Run All spends real money; the Design canvas does not say that dragging a node mints a ledger revision; `PublishReadinessPanel`'s hard-constraints checkbox and release-behavior options remain unexplained on the irreversible path; `Validator.tsx` still has no help text at all. Those are copy-and-consequence work on individual surfaces, not vocabulary — a second pass, and the registry does not block them.

---

## 2h. Execution log — 2026-07-27, wave 7 (the engine's object model)

**Correction to wave 6's brief.** Wave 6 built a glossary of coded ENUM VALUES. What was actually asked for was **object descriptions** — the engine's own object types, described for humans, in a form that can be applied to client 0. Wave 6 is not wasted (the badge vocabularies genuinely had no legend) but it answered a narrower question. This wave answers the one that was asked.

| what | outcome |
|---|---|
| `ui/src/objectModel.ts` | The engine's 11 core object types — workspace, node, skill, project, run, stage output, change event, artifact, relationship, learning observation, tool — each with what it is, why it exists, how it is identified, its lifecycle, its relations, where it is seen, and the trap that most often costs someone time. Plus a 12th entry naming the Phase 7 improvement objects rather than implying the model stops at publishing. |
| `components/ObjectAbout.tsx` | "What is a node?" as a collapsed disclosure at the TOP of a surface — "what am I looking at" precedes "what do these badges mean". Same native `<details>` mechanics as `Glossary`. Applied to the node inspector and the run summary. |
| `docs/engine-objects.md` | Generated human document. |
| `docs/generated/engine-objects.content_source.json` | **12 `content_source.v1` envelopes, ready for the publishing pipeline.** This is the P-1 / R-12 path made concrete: the engine's self-description enters client 0 the same way any other content does — through the nodes, the reviews and the publish gate — rather than as hand-written pages bypassing the pipeline it is meant to demonstrate on itself. |
| CI | `npm run test:objects` locks both artifacts to the registry, alongside the manifest and glossary locks. |

**Verified against the engine, not against my reading of it.** Every tool cited in an object description is asserted to exist in `docs/mcp-tool-manifest.json`, in wire form, and not to be a deprecated alias — so a renamed tool fails CI rather than leaving a confidently wrong sentence in front of an operator. And the emitted envelopes were validated through `project.validate_handoff` against client 0: `valid: true`, zero issues. That check was then confirmed non-vacuous by feeding it an empty summary, which it rejected with the exact schema issue.

**Two findings from the object-model audit.**

1. **The UI's duplicated type file has already drifted from the engine.** `ui/src/types/workspace.ts` re-declares engine types by hand, and `WorkflowExecutionRecord` there is missing `rev`, `entrypoint`, `budgetUsd` and `budgetBlock` — so the UI has no type-level awareness of run CAS concurrency or budget pausing, and `RunBudgetBlock` / `WorkflowEntrypoint` have no UI counterpart at all. The trees are isolated at build time (`ui/tsconfig.json` includes only `ui/src`; no alias), so duplication is structural; what is missing is the correspondence test that `toolDenialReasons` / `executionStatuses` / `workspaceActorKinds` now have. Worth an R item.
2. **`ArtifactReference` is not an engine type.** It is the external pdf-tool payload shape, surviving here only as a string field inside `article_body.v1`. Several findings documents refer to it as though it were a first-class object. The engine's artifact object is `ExecutionArtifact`.

**Citations re-anchored.** The disclosure-pattern guidance in source comments and tests cited GOV.UK, a UK-government design system. The primary market is the USA, so those are now NN/g (US) and the U.S. Web Design System, which give the same guidance in their own words: do not condense content "if users need to see most or all of the information on a page", and "aim for informative labels … rather than vague ones like 'Click here'". No behaviour change.

Suite after the wave: **806 root** (was 797), **88 ui** (was 82), typecheck clean both projects, both builds, all three locks green.

---

## 2i. Execution log — 2026-07-27, wave 8 (T-2, Tier 6)

**Ran at zero model spend.** `workflow.start_dry_run` defaults to `executionMode: "mock"`, so the protocol's "Tier 6 costs tokens — nightly, not per-commit" note is only true of the `openai` mode. The whole chain was exercised against client 0 for nothing, with `budgetUsd: 1` as a belt-and-braces ceiling. Run `run_1785154072610_3tmmv9`, 15 of 18 nodes completed through `article_body`.

**Result: 6 PASS, 1 FAIL, 1 partial, 1 not run.** Full table and evidence in TEST-PROTOCOL Tier 6.

The FAIL is the one that matters. **`article_body` completed, and persisted an artifact, whose value fails all six required fields of that node's own `outputSchema`** — the mock runner still emits the pre-contract-as-truth `{schema_version, nodes}` shape. Fed back through `node.validate_output` it is invalid on every required field. So two things are true at once: the mock fixtures drifted when the node was generalized, and **nothing validates a node's output against its schema at execution time**. T6.3 was not unproven, it was unenforced. The consequence is that a dry run certifies only that the graph advances — not that the contract path works — which is precisely what T-2 was supposed to establish before T-3.

Seven findings became R-16 through R-21 plus the earlier R-15. Two are worth reading even if the rest are queued: a run halted by the publish gate reports `status: "running"` with no approval recorded, so the gate is invisible to the UI (R-18); and `workflow.run_all` / `retry_node` advertise the generic mutation schema, omitting the `runId` they require while forbidding it via `additionalProperties: false` (R-19) — the same defect class as R-3, on the run controls.

Also observed, live and in one payload: **R-5 reproduced.** `node.prepare_execution` returned `resolvedSkills.effectiveTools: ["project.call_tool"]` alongside `resolvedEffectiveTools` marking `project.call_tool` `allowed: false`. The two resolvers disagree inside a single response.

**T-3 should not proceed on this.** The publish locks are all still closed and correct, but the evidence T-2 was meant to produce — that the contract-driven path builds a valid client object — was not produced, because the thing that would have caught the failure does not exist yet (R-16). Fix R-16/R-17, re-run Tier 6, then reconsider.

---

## 2j. Execution log — 2026-07-27, wave 9 (R-16 + R-17)

**R-16 — the missing check.** The executor now validates every node's output against that node's own `outputSchema` before it counts as completed, and fails closed: `status: "failed"`, the individual schema issues in `errors`, and **neither the stage output nor the artifact written**. Verified by forcing a runner to return the exact literal T-2 caught: `["output_schema_violation", "$.artifact is required", "$.summary is required"]`, zero artifacts, no stage output. Note where the gap was — the single-node path (`nodeRuntime`) already validated; only the workflow path did not, so the more casual path was the stricter one.

**R-17 — fixtures derived from schemas.** `execution/mockOutputFromSchema.ts` generates mock output FROM each node's schema: const, enum, type unions, recursive required, minLength, minItems, minProperties, numeric bounds, best-effort pattern, and `anyOf`/`oneOf`/`allOf`. Dry-run markers are applied as HINTS only where the schema permits, so a strict schema is never polluted to make a fixture read nicely. `anyOf`/`oneOf` are resolved by generating a candidate per branch and letting the REAL validator pick one that holds against the full schema — siblings, `dependentRequired` and nested `if`/`then` included — rather than guessing.

That combinator support was NOT in the first attempt, and Wolf's challenge exposed it: against `articleBodyJsonSchema` the generator emitted `public: {}` and failed with `"$.nodes[0].public must match at least one allowed schema"`. The drift guard missed it because it only covered the seeded schemas, none of which use `anyOf`. The guard now also covers that schema — the strictest in the repo, exercising `additionalProperties:false`, a pattern, an enum, `minItems`, nesting, `anyOf` and `dependentRequired` at once.

Two smaller things surfaced:

1. **A second hand-written copy of the same fixtures lived in `executor.ts`**, exported only for tests. Two implementations of "what a mock output looks like" is how they drifted apart unnoticed; there is now one.
2. **A test was codifying the bug.** `workspaceExecution.test.ts` asserted `toMatchObject({ schema_version: "article_body.v1" })` — a shape the node's own schema does not allow. It passed only because nothing validated the output. It now asserts the node satisfies its declared schema.

See R-22 and R-23 for what this uncovered; **R-23 corrects §2i's F-1 diagnosis.**

Suite: **827 root** (was 806), 88 ui, both typechecks, both builds, all three locks green.

---

## 3. What was already completed this session (for the ledger)

✅ pdf-tool capability restored (14 tools, `article_body.v1` contract, deny-by-default kept) · ✅ `verify_agent_artifact` granted · ✅ image loop proven live end-to-end · ✅ 6 nodes + 6 skills aligned to contract-as-truth (workspace v56→v69) · ✅ `trust_factual` regression fixed · ✅ `contract_intelligence` unblocked (risk level) · ✅ graph valid, attention clean, 11/13 skill-bearing nodes conflict-free (2 remaining warnings are the publish gate working as designed).

---

## 4. Approval

Say **go** (or mark exceptions by ID) and I execute in this order: **W-2, W-3** (workspace, reversible) → **R-11 read-only + R-0** delivered as a patch series via the zip handoff → **W-1 + T-1** the moment ENV-3 lands. Everything else follows the spine.

**Wave 1 executed 2026-07-26** — see §2b. **Wave 2 executed 2026-07-27** (W-1 + T-1) — see §2c.

**Wave 3 executed 2026-07-27** (R-4, R-1, R-10, T2.6) — see §2d.

**Wave 4 executed 2026-07-27** (ENV-1, ENV-2, W-2) — see §2e.

**Nothing is blocked on Wolf.** Both former blockers cleared 2026-07-27: the ENV-1/ENV-2 tokens are correct (all four connections handshake, and the brokered chain runs through `project.call_tool`), and the Cloud Run deploy has picked up the merged code (proven by `project.delete snoocle` succeeding). The only ENV item left is **ENV-4**, pure cleanup: drop the now-unused `SNOOCLE_*` vars, keep `MONETIZER_*`.

**Wave 5 executed 2026-07-27** (R-3 + the S4 Schemas tab) — see §2f.

Next, in the order I would take them:
1. **T-2** — full dry-run pipeline vs client 0. Unblocked by T-1, and now that ENV-1/2 are live it can exercise the real client path rather than a stubbed one. It executes nodes (model spend), so it is a deliberate step rather than a sweep.
2. **R-8** — promoted by wave 4's findings 2–4: three separate allow-list/reporting defects surfaced the moment the connections came up (`platform`'s `allowedTools: []`, the vanished `requiredPdfToolCapabilities` source of truth, the missing `resume_agent_artifact_job` / `get_image_model_policy` grants). Two hand-kept lists with no declared requirement is the condition that caused the original pdf-tool regression.
3. **R-2** (skill-schema resolver) — no longer blocking anything, but it is what forces the 7 placeholder skill `outputSchema`s to stay flattened. Now that schemas are editable in S4, this is the next thing an operator will walk into.
4. **R-5** (reconcile the two resolvers) — the inspector currently renders the disagreement rather than resolving it, which is honest but not a fix.
