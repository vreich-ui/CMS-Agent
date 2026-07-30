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

**R-2 ✅ Skill-compatibility resolver fix.** Done 2026-07-29 — `skills/schemaCompatibility.ts` replaces the `JSON.stringify` equality test with a real structural walk: a blocker now means a genuine contradiction (declared types that cannot both hold, contradicting property types recursively, disjoint enums, or a skill-required property the node's `additionalProperties:false` schema forbids), and the conflict names the offending field instead of asserting that two schemas are not byte-identical. Original note: any skill `outputSchema` with `additionalProperties`/`properties`/`required` reported blocker-incompatible regardless of actual compatibility; only bare `{"type":"object"}` passed. **Still open, deliberately:** the 7 flattened skill `outputSchema`s are now unblocked but not yet restored — writing real contracts for them is a data change with its own review, not a side effect of this fix.

**R-3 ✅ Coerce stringified JSON in `update_node_output_schema` / `_input_schema`.** Done 2026-07-27 via `store.coerceSchemaInput`, modelled on the `coerceNodeInput` that already defends `create_node` (the defense lives in the store, not in `coerceJsonObjectInput`). Both writers coerce before validating; `schema` is now advertised as `{type:["object","boolean"]}` instead of permit-anything `{}`, which reshaped two tools and required a deliberate manifest regeneration. **Correction to this item's premise:** R-3 was recorded as "the only reason the S4 Schemas tab is read-only", and that was wrong — S4 saves through `workspace.update_node`, which never touched the schema writers. The tab was never blocked by this; it is editable as of the same commit (see §2f). R-3's real beneficiaries are `ui/src/hooks/useWorkspace.ts` `updateOutputSchema` (the legacy textarea path) and any agent or script calling the dedicated writers.

**R-4 ✅ Typed version-conflict envelope.** `{ok:false, code:"version_conflict", currentVersion, currentRevisionId}` instead of bare `-32603`. Precondition for multi-agent editing and for the S4 save path. Also surface `error.data` detail generally — it exists but clients only see "Tool execution failed".

**R-5 ✅ Reconcile the two resolvers.** Done 2026-07-29 — `toolResolver.evaluateToolsForNode` is now the single authority and `resolveSkillsForNode` delegates to it, so a denial reason added to `toolPolicy.ts` reaches both surfaces at once. The skill resolver's private rule set (a plain set intersection plus a `publish.`-prefix risk check, blind to `tool.enabled`, the tool-vs-node risk ladder, and `requiresApproval`) is gone. `SkillResolvedPolicy` also gained `deniedToolReasons`, because a caller has to be able to tell a misconfiguration (`node_tool_not_allowed`) from a gate working as designed (`approval_required`) — `constellation.get_attention` now filters on exactly that and no longer reports the approval gate as a defect.

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

**R-22 ✅ The conductor ignores the live workspace by default — decide the default.** Settled in two halves: `nodes.ts` was re-seeded from live 2026-07-28 (#79, via `scripts/seedNodesFromWorkspace.ts`), and the default was flipped to `store` on 2026-07-29 — **both were needed**, because store mode provably cannot carry topology (`resolveConductorNodes` maps over the canonical list, so a store node with no canonical counterpart is ignored, and `overlayStoreNode` pins `dependsOn`/`produces`/`riskLevel`/`position`/`status`). Store mode carries authoring edits — prompt, schemas, tools, skills, model config — with no deploy; edges, risk levels and new nodes still require a deliberate re-seed plus redeploy, which is now a documented required step in `docs/platform/PHASE1_RUNBOOK.md`. Every run reports which source it used. Original note: Found while building R-17. `resolveConductorNodes()` returns the STATIC hardcoded definitions unless `WORKSPACE_NODES_SOURCE=store`, so a run executes `src/agent/workspace/nodes.ts` (last touched 2026-07-03), not the live workspace. The six nodes the contract-alignment wave rebuilt therefore do not participate in a run, and **`contract_intelligence` does not exist in the seeded set at all** — the real explanation of T-2's F-7 rather than a graph-validator gap. So **T-2 exercised an obsolete pipeline**. The gate is deliberate ("behavior is unchanged until an operator flips it after a side-by-side mock run confirms identical topology") — but the topology is no longer identical, so it now hides the alignment work rather than protecting it. **Wolf's call:** flip the default to `store`, or re-seed `nodes.ts` from live.

**R-23 ✅ THREE competing `article_body` schemas, and a name that no longer describes anything.** Landed 2026-07-28 (#85) — the node's own `outputSchema` is the single authority. Found by Wolf challenging the "legacy" claim — and it sharpens R-22.

| # | Where | Shape | Strict |
|---|---|---|---|
| 1 | `nodes.ts` seeded — what the conductor runs in static mode | `{artifact, summary}` | open |
| 2 | `store.ts:196` — installed as article_body's schema in **every fresh workspace** | `{schema_version, nodes[]}` — the legacy monolith | `additionalProperties: false` |
| 3 | Live workspace (v85) | `{artifact, summary, clientProjectId, clientObjectType, contractSource, body}` | open |

**Correction to §2i's F-1:** the old hand-written mock was NOT simply stale — it is **valid against #2**, verified. It was written to match the legacy monolith `store.ts` still installs. "The fixture drifted" was the wrong diagnosis; one node has three schemas and the fixture matched one of them.

**The naming debt.** The client's object types are `page`, `section`, `navigation`, `taxonomy`, `site`, `template`, `section_template`, `theme`, `product`, `content_item`, `tracking_config` — **there is no `article` object**. Nothing publishes an "article body"; a publish writes ONE object of the type named in `clientObjectType`, shaped by the client's contract at run time. #3 models that correctly, so the structure is right and the artifact name `article_body.v1` is a leftover from the Dr-Lurié-era monolith. #2 IS that monolith, the same legacy surface R-6 already targets via `article_body_validate` / `article_body_get_schema`.

Recommended: delete #2 (it silently overrides the seeded schema on every fresh workspace), resolve #1 via R-22, and rename the artifact to describe "one client object".

⚠️ *Not verified today.* The object-type list is from a live `object_contract` read recorded in `docs/plan/findings/`, not a fresh read — the client connections were down and the session's MCP link dropped. **Dr-Lurié is the authority to re-check**: the client brings its own publishing rules, so the client's contract decides this, not the workspace's vocabulary.

**R-18 ✅ Report why a run stopped.** Landed 2026-07-28 (#79). T-2 F-2: `run_all` halts before publish-risk nodes with `status: "running"` and `approvalsRequired: []`, so the gate is invisible to the UI and to an operator. Record the hold. Also F-3: add a distinct `paused` state — `pause_run` currently reports `blocked`, which already means publish-gate hold and budget hold.

**R-19 ✅ Fix the advertised input schemas on `workflow.run_all` / `workflow.retry_node`.** Landed 2026-07-28 (#79). T-2 F-4: both serve the generic mutation schema, omitting the required `runId` while `additionalProperties: false` forbids it. A strict client cannot call them. Same class as R-3.

**R-20 ☐ Mock runs should not accrue cost against `budgetUsd`.** T-2 F-5: a mock run recorded $0.029 estimated against the ceiling despite making no model calls.

**R-21 ☐ Graph validation misses a dependency that is not a node.** T-2 F-7: `article_body` declares `contract_intelligence` in `dependsOn` and `requiredInputs`, it is absent from the conductor sequence, and `validate_graph` still returns valid.

**R-24 ✅ Retire the legacy `save_json_blob_*` publish dialect for dr-lurie.** Landed 2026-07-29 (#89). Dr. Lurié is a tenant of the same object substrate as client 0, and the ratified alignment doc froze the legacy pipeline and directed that `save_json_blob_*` must not be allowlisted for the project — but the publish hook still spoke it, and under `defaultToolPolicy: "allowed"` the whole family plus the five-agent per-stage tools were callable by default. The hook now speaks the object dialect (`object_create → object_checkout → object_validate → object_patch → object_publish → object_checkin`, validating before any patch, never releasing); per-site parameters (owning site object id, taxonomy registry, request-id shape, who mints the object id) moved into an `objectDialect` block on the project config instead of literals in the hook; and the retired families are blocked in two layers — named in the seeded `toolPolicies`, and refused by shape in `executablePolicy.ts` so an unenumerated variant cannot slip through. `agent-publishing-instructions.md` deleted; the dr-lurie knowledge block rewritten for the object path. **One value to confirm at enablement:** `siteObjectId: "site_drlurie"` is inferred by symmetry with the documented `tax_drlurie` — the dr-lurie endpoint was unreachable from that session, so it was never read off the live server.

**R-25 ✅ Split `project.call_tool` into a read-only variant so contract discovery stops being approval-gated.** Landed 2026-07-29 (#91). T-2 (`run_1785340011864_qpyjr0`) proved the engine works end-to-end in live mode — the first real run since E-1…E-4 — and immediately found the next defect: `contract_intelligence` could not fetch the platform `content_item` contract. `project.call_tool` covers BOTH read-only discovery AND external writes, and is approval-gated because of the write half — correctly — but that also blocked the read half every content-building node needs on every run: `requiresApproval: true` meant the node runner's effective-tools filter dropped it whenever a run carried no approved tool ids, and the node correctly refused to fabricate a contract rather than proceed on nothing. New controlled tool `project.call_read_tool` (riskLevel `read`, `requiresApproval: false`) is permitted only a fixed, server-side allowlist — `object_contract`, `registry_get`, `object_inventory`, `object_get`, `object_list`, `object_validate`, `ping` — enforced in `ProjectMcpAdapter.callReadTool` before any transport and never from caller input; anything else is refused with a distinct `read_tool_operation_not_permitted` code naming the attempted operation. Everything else `project.call_tool` honors still applies unchanged — per-project `toolPolicies`/`defaultToolPolicy`, the executable project policy's legacy-artifact-fallback blocks, and the connection/auth path — because `callReadTool` delegates straight into the existing, untouched `callTool` once the allowlist clears. Granted alongside the existing `project.call_tool` (which nodes keep, for a future write) on `contract_intelligence`, `article_body`, `artifact_plan` and `publish_payload`; `publication_controller` and `publish_executor` are unchanged — write-variant only, since neither ever does discovery. `project.call_tool` itself was not touched: still `write` / `external_write` / `requiresApproval: true`, the only path to an external write. A wire-level MCP tool `project.call_read_tool` mirrors the controlled-tool version for direct operator/script use (manifest 136 → 137).

**E — live-mode readiness (2026-07-29).** Four independent defects that between them meant the pipeline could not run end-to-end in live model mode and reach the client. Detail in §2k.

**E-1 ✅ `executionMode` no longer defaults silently.** Live (`openai`) is the default at every entry point and `mock` is the explicit opt-in for cheap CI runs; every run additionally reports what produced it (`workflow.get_run` / `workflow.list_runs` carry a top-level `mode` block: executionMode, `live`, node source, and a prose notice).

**E-2 ✅ Tool-using nodes get a workable agent-loop turn budget.** `maxTurns` was read straight off `toolCallLimit`, conflating tool calls with model round-trips; `research` — the first node holding `web.search` + `web.fetch` — exhausted it before emitting output. Now per-node (`modelConfig.maxTurns`, else `toolCallLimit + headroom` for a tool-using node), and exhaustion reports as `max_turns_exceeded` naming the node, the budget and the knob, instead of a generic `model_error`.

**E-3 ✅ The publish nodes can reach the client.** `publish_executor` and `publication_controller` carry `project.call_tool`; both previously resolved `allowed:false` with `["node_tool_not_allowed","approval_required"]`, so activating `publish_executor` would have produced a publisher that could not reach the client at all. Paired with a closed-set assertion in `publishRun` that the gates are unchanged, and tests that a node holding the grant still cannot publish without them. **This does not open a publish gate** — see §2k.

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

## 2k. Execution log — 2026-07-29, wave 11 (live-mode readiness: E-1…E-4, R-2, R-5, R-24)

**Publish gates stayed closed throughout, and this wave opened none of them.** `publishingPolicy.publishEnabled`
is still `false`, the per-project `*_PUBLISH_ENABLED` flags are untouched, `approved`/`live` still have to be
passed explicitly, the readiness policy still has to return GO, and `release_to_production` still appears in no
execution path. E-3 grants a *capability* to two publish-risk nodes; it satisfies no gate.

| id | outcome |
|---|---|
| E-1 ✅ | **Live model execution is the default.** `executionMode` defaulted to `"mock"` at every entry point — `workflow.start_dry_run`, `node.execute`, `buildInitialRun`, `advanceRun`, `nodeRuntime`, and the Cloud Run job — so the pipeline's default behavior was to emit deterministic placeholder artifacts that are structurally indistinguishable from real model output, with nothing saying so. Both halves of the recorded choice were taken: the default is now `openai`, **and** every run states what produced it. The failure mode this trades into is loud rather than silent — without the provider key the first node fails `invalid_node_configuration` naming the missing variable, and the job refuses to mint a run at all. Blast radius was real and is the point: ~30 tests across 18 files relied on the implicit default and now declare `executionMode: "mock"` explicitly. |
| E-2 ✅ | **Turn budget is per node and its exhaustion is actionable.** `run_1785235767862_uvjm83` died with `["model_error", "Max turns (4) exceeded"]`. `maxTurns` came straight from `toolCallLimit`, but with `parallelToolCalls` disabled every tool call costs its own turn and the node still needs a final turn to emit structured output — so a node holding two web tools ran out mid-search. Resolution is now explicit `modelConfig.maxTurns` → `toolCallLimit + headroom` for a tool-using node → small default for a tool-free one, and a new `max_turns_exceeded` code names the node, the resolved budget, the tool count and the knob that raises it. Retries are not spent re-exhausting the same cap. Tool-using nodes stay on the OpenAI runner; `AnthropicNodeRunner` still has no tool loop. |
| E-3 ✅ | **`publish_executor` / `publication_controller` can reach the client.** Both assign `dr_lurie_contract_intelligence`, which requests `project.call_tool`, while neither node granted it — so both resolved `allowed:false` with `["node_tool_not_allowed","approval_required"]`, and this is what `constellation_get_attention` had been warning about. Both now carry the grant. Because it is a capability increase on publish-risk nodes it ships with the locks asserted beside it: `PUBLISH_GATE_NAMES` is a closed set that `evaluateGates` verifies structurally, nothing in that function reads a node's tool list, and tests cover a node holding the grant with the gates closed (dry-run plan, zero external calls) plus each gate closed independently. `project.call_tool` is `requiresApproval: true`, so the grant still needs per-run approval before the tool executes — a second, independent lock. |
| E-4 ✅ | **`WORKSPACE_NODES_SOURCE` decided and documented** — see R-22. Default flipped to `store`; the re-seed is now a required, documented deploy step for anything store mode cannot carry. |
| R-2 ✅ | Structural schema compatibility replaces `JSON.stringify` equality. |
| R-5 ✅ | One tool authority; the skill resolver delegates. `constellation.get_attention` stops reporting the approval gate as a defect, which removed two permanent items from the board. |
| R-24 ✅ | Legacy `save_json_blob_*` dialect retired (#89). |

**What the two resolvers agreeing actually changed.** Before, `skill.resolve_for_node` reported
`project.call_tool` as granted on `article_body`, `contract_intelligence`, `publish_payload` and
`artifact_plan` while `node.get_effective_tools` reported `allowed:false` for the same nodes — the
disagreement T-1 Tier 2 found four times and §2i reproduced inside a single `node.prepare_execution`
payload. With one authority the four now report denied-pending-approval on both surfaces, which is the
truthful answer; and because the denial reason travels, the attention feed can tell that apart from a
node that genuinely lacks a grant.

Suite: **882 root** (was 861), both typechecks, both builds, all three locks green.

**Follow-ups this wave deliberately did not take:** restoring real `outputSchema`s to the 7 flattened
skills (unblocked by R-2, but a data change with its own review); and confirming
`objectDialect.siteObjectId` for dr-lurie against its live server (R-24).

---

## 2l. Execution log — 2026-07-29, wave 12 (R-25: the read-only tool split)

**The live end-to-end run wave 11 recommended actually ran.** `run_1785340011864_qpyjr0` is the first
real live-mode run through the engine — E-1…E-4 and the R-2/R-5 fixes held, the run reached
`contract_intelligence`, and that node immediately hit the next defect rather than a repeat of the
old one: `project.call_tool` dropped out of its effective tools with no approval context, so the node
correctly blocked rather than fabricate a contract. No publishable article was produced, and none
should have been — this is the node's own refusal working, not a crash.

Root cause named precisely in the task: `project.call_tool` conflates two different questions —
*can this node read the client's contract* and *can this node write to the client* — under one
`requiresApproval: true` flag that is only correct for the second question. R-25 answers them
separately: `project.call_read_tool` (new controlled tool, `requiresApproval: false`, fixed
server-side allowlist) for the first; `project.call_tool` (unchanged) for the second.

**What changed:**
- `src/agent/projects/projectMcpAdapter.ts` — `READ_TOOL_ALLOWLIST` and `ProjectMcpAdapter.callReadTool`.
  The allowlist check runs first, before any transport, against a *hardcoded* list (never the caller's
  `tool` argument in any form); once cleared, execution is `callTool` itself, untouched — so every
  existing guarantee (`toolPolicies`, `defaultToolPolicy`, connection/auth) applies identically.
- `src/agent/tools/toolRegistry.ts` — new controlled tool `project.call_read_tool`
  (`riskLevel: "read"`, `sideEffect: "external_read"`, `requiresApproval: false`), whose handler also
  runs the project's `enforceCallToolPolicy` hook before delegating to `callReadTool` — the same
  ordering `project.call_tool`'s own handler already used, so a name that is both outside the
  allowlist and independently policy-blocked (a `save_json_blob_*` name, say) is caught by the policy
  layer first, not silently re-labeled with the new code.
- `src/agent/mcp/workspace/tools.ts` — wire-level `project.call_read_tool`, mirroring `project.call_tool`'s
  existing wire tool, for direct operator/script use outside node execution.
- `src/agent/workspace/nodes.ts` — `project.call_read_tool` granted to `contract_intelligence`,
  `article_body`, `artifact_plan`, `publish_payload` (alongside the existing `project.call_tool`, kept
  for a future write). `publication_controller` / `publish_executor` untouched.
- `dr_lurie_contract_intelligence` skill (`seededSkills.ts`) and the `contract_intelligence` node prompt
  now name `project.call_read_tool` as the discovery surface, so the node's own prompt text stops
  pointing at the tool that was just proven to fail it.

**A side effect worth naming rather than hiding:** granting the skill `project.call_read_tool`
reintroduced two `attn_skill_requests_denied_tool_*` warnings for `publication_controller` /
`publish_executor` — the SAME skill is assigned to all six contract-intelligence-family nodes, and
those two correctly don't grant the new tool. This is real signal (the skill now formally requests
something two of its six host nodes deny, by design), not the old R-5 regression it superficially
resembles; `constellationTools.test.ts` documents the distinction inline. `project.call_tool` itself
still resolves `approval_required` — unaffected — on every node that holds it.

Suite: **907 root** (was 893), typecheck clean, all three locks green (manifest 136 → 137, surfaceHash
`e020e80d…` → `61b0a12c…`), node/skill seed drift clean.

**Follow-up not taken here:** re-running `run_1785340011864_qpyjr0`'s scenario live to confirm
`contract_intelligence` now completes end-to-end — this wave fixes the mechanism and covers it with
unit/wire tests, but a fresh live run against the real client is the next deliberate, budget-spending
step, same caveat as wave 11's.

---

## 2m. Execution log — 2026-07-29, wave 13 (T-2 live shakeout: four defects, $4.37 in one node)

Wave 12's follow-up got taken: `run_1785340011864_qpyjr0` (T-2) actually ran `project.call_read_tool`
end to end. It resolved `allowed:true` with no denial reasons on all four content-building nodes — the
split itself works — but the call kept failing with a bare `validation_error`, `contract_intelligence`
retried it roughly 25 times across its whole 28-turn budget, and the node alone cost $4.37. The run's
own budget gate (`budgetUsd: 5`) never caught it mid-flight either: the run finished at $5.26
(`percentUsed 105.25`, `overBudget: true`, `blocked: false`).

**B1 — `project.call_read_tool` (and `project.call_tool`) rejected a valid-looking `tool.test` call.**
Reproduced live against the deployed MCP server with exactly the reported shape
(`toolId project.call_read_tool`, `nodeId contract_intelligence`,
`input {"projectId":"platform","tool":"object_contract","arguments":{"object_type":"content_item"}}`)
and got the same `{ok:false, error:{code:"validation_error", message:"validation_error"}}`. Neither the
read tool's own input schema nor the shared project-call schema is wrong — both parse the reported
shape fine in isolation (confirmed directly). The bug is in forwarding: `tool.test`'s wire schema
declares `input: {}` with no JSON-Schema `type`, so an MCP client has no signal to send a nested object
and sends the JSON text instead; `tool.get_execution` on the failing record showed `inputSummary` as a
*string* containing the JSON, not an object, proving the value reaching `executeTool` was still
serialized. Calling the wire-level `project.call_read_tool` tool *directly* (typed `arguments: {type:
"object"}` in its own schema) worked and returned real contract data — isolating the defect to the
untyped forwarding path, not the read-tool split or the remote connection.
Fix: `executeTool` (`src/agent/tools/toolExecutor.ts`) now coerces a JSON-stringified top-level input
back into an object before any controlled tool's schema sees it (`coerceJsonObjectInput`, extracted to
`src/agent/tools/jsonCoercion.ts` so both the MCP tool layer and the controlled-tool gateway share one
implementation instead of two). Fixed at the single gateway, so `tool.test` and the live node runners
are defended the same way. New wire-level regression test in `projectTools.test.ts` reproduces the
exact reported call through `tool.test` end to end and asserts it now reaches the contract.

**B2 — controlled-tool validation failures carried no diagnostic detail, which is what turned B1 into
$4.37.** `error.code` and `error.message` were both the literal string `"validation_error"` — no field
path, no expected/received shape — so the model had nothing to self-correct on and re-sent its whole
accumulated context every retry turn. Zod already carries a path and a readable message per issue;
`toolExecutor.ts` now builds one line per issue (`field.path: message`, with the actual received value
attached and redacted through the existing secret filter) instead of discarding it, and
`OpenAINodeRunner.ts`'s tool-execute wrapper forwards that detail in the thrown `Error` (the SDK's
default tool-error handler passes a thrown error's message straight back to the model, so this is the
one hop that needed the detail attached). Covered in `toolRuntime.test.ts`: the message names the
specific field instead of repeating the bare code, and a secret-looking received value is still
redacted in the enriched detail.

**B3 — no in-node cost circuit breaker.** `budgetUsd` was checked exactly once, before a node's whole
agent loop started; nothing looked again until the run's between-node gate noticed afterward that one
node had spent the entire budget and overrun it. `OpenAINodeRunner.ts` now uses a `Runner` instance
(instead of the bare `run()` function) *only* when a node carries `budgetUsd`, and listens for
`agent_start` — which the SDK fires once per model turn with the run's cumulative token usage so far —
to abort via signal before the next turn if the running total (prior nodes' spend plus this node's
turns so far) would already clear the ceiling. Reports a distinct `budget_exceeded`, separate from
`cancelled`/`model_error`, naming the node and the estimated spend. Behavior is unchanged for every node
that does not configure `budgetUsd` — the bare `run()` path is untouched. Covered in a new
`openaiNodeRunnerBudgetGuard.test.ts`: a fake `Runner` simulates a cheap turn, an expensive turn, then a
third turn start, and the node is aborted with `budget_exceeded` at that third-turn boundary rather than
only being discovered afterward; a second test confirms the `Runner` path is never touched when no
budget is configured.

**B4 — context economy.** `contract_intelligence` cost $0.54 in an earlier round without fetching and
$4.37 once it started fetching — re-sending a large client contract across many turns compounds, and
much of that specific jump was B1/B2's retry storm rather than a separate cost driver. What's fixed
here: `contract_intelligence`'s prompt now mandates an actual *reduction* of the fetched body schema
(required fields, id patterns, enums, strictness) rather than "a faithful reduction of it," which
previously permitted passing the full raw contract through verbatim. Separately — and this is the
sharper, confirmed defect — `article_body`, `artifact_plan`, and `publish_payload` were granted
`project.call_read_tool` in wave 12 (#91) alongside `contract_intelligence`, but only
`contract_intelligence`'s own prompt was updated to name it; the other three nodes' prompts still told
the model to validate through `project.call_tool` — the approval-gated write variant — which would
strand them on their own `object_validate` calls exactly as `project.call_tool` originally stranded
`contract_intelligence`. All three now name `project.call_read_tool` for their read-only contract and
validation calls, matching `contract_intelligence`.
**Not done in this wave** (scope boundary, not an oversight): actually moving the contract fetch to the
conductor level, ahead of any node's own agent loop, so it is fetched exactly once per run regardless of
how many content-building nodes need it, and each node receives only its own slice (`article_body` the
body schema and id rules, `artifact_plan` the media policy, `publish_payload` the workflow sequence and
validation surface) as plain input rather than a tool call it makes itself. That is an architecture
change to how `contract_intelligence` runs, not a bug fix, and deserves review on its own rather than
being folded into a defect-fix wave.

**Also confirmed, by tracing the actual code (not assumed): node definitions are re-resolved fresh on
every node dispatch, not snapshotted once at run start.** `resolveConductorNodes()` — called inside
`advanceRun`, i.e. once per `workflow.run_node` / `run_next_node` / `run_all` step — reads live from the
workspace store every time in the default `store` mode (`WORKSPACE_NODES_SOURCE` unset or `!==
"static"`), and the persisted run record (`NodeExecutionState`) never carries a node's prompt/tools/
schema in the first place, only execution bookkeeping. A `workspace.update_node_prompt` edit made
mid-run is picked up by that same run's next dispatch of that node. `article_body`'s round-2 output
still quoting `project.call_tool` was not a staleness bug, then — it was PR91 (#91) itself only having
updated `contract_intelligence`'s prompt text (in `nodes.ts`) while granting the tool to all four nodes;
the diff literally shows one prompt string changed and three `allowedTools` arrays gaining the entry
with no matching prompt change. Fixed above, as part of B4.

Suite: **913 root** (was 907), typecheck clean (scoped to the modules this wave touched — `ui/`'s own
missing `@rjsf/utils` type declarations are a pre-existing, unrelated gap in this sandbox, not something
this wave introduced or could fix).

**Follow-up not taken here:** the conductor-level fetch-once-and-slice redesign named under B4, and a
fresh live re-run of T-2's scenario to confirm the actual dollar cost drops now that the validation loop
and its silent failure mode are fixed.

---

## 2n. Execution log — 2026-07-29, wave 14 (T-2's follow-up: the blocker is cost, not capability)

Wave 13's follow-up got taken: `run_1785352838155_l544ye` proved the contract fetch itself now works —
`contract_intelligence` reached zero blockers and 13 constraints reduced from the live platform
contract. The blocker moved from "the call fails" to "the call is expensive": $2.57 / 502,397 input
tokens for `contract_intelligence` alone, and a run-level budget gate that let one node carry a $3
ceiling to $4.17 (139% over) in a single dispatch. Five fixes.

**F1 — moved the contract fetch out of the agent loop.** `contract_intelligence` was re-sending the
raw fetched contract on every one of its (already-capped-at-8) turns — roughly 60K input tokens/turn.
Fetched the real platform `object_contract(content_item)` response live to ground the fix in actual
data rather than a guessed shape (a JSON-Schema `body_schema`, a `constraints[]` array, `publish_policy`
/ `media_policy` / `creation_policy` objects, a `workflow` block, `patch_ops[]`, `auxiliary_inputs[]`):
- `src/agent/workspace/contractReduction.ts` — `reduceContract(raw, source, objectType)`, a pure,
  deterministic function. Keeps `body_schema` whole (structural, not prose — downstream nodes validate
  against it), extracts id/slug conventions from the constraints array itself (there is no separate
  key for them on the one real shape inspected), folds `media_policy` with the media-relevant
  `auxiliary_inputs` notes, extracts the taxonomy source and its blocking constraint, keeps every
  constraint with its severity/`enforced_live` (description bounded to ~160 chars, not the full
  paragraph), drops `publish_policy.denial_codes` and `workflow.patch_error_codes` (literally the
  "error catalogues" the task called out), keeps `workflow.sequence`, and reduces `patch_ops` to op
  name + top-level required fields (dropping each op's recursive `arg_schema` `$defs`, the actual bulk
  of `patch_ops`' size). Anything unrecognized is preserved under a bounded `unmapped`, never silently
  dropped — matching contract_intelligence's own "say so as an assumption" policy for a silent
  contract, and keeping the reducer honest for a client shaped differently than the one inspected.
- `src/agent/workspace/contractPrefetch.ts` — `getReducedContract({runId, projectId}, deps)`: calls
  `ProjectMcpAdapter.callReadTool("object_contract", ...)` directly (a plain function call, not a tool
  the model invokes), still honoring the project's executable policy before any transport (mirrors
  `project.call_read_tool`'s own handler ordering). Cached per (runId, projectId, objectType) through
  the same `RunScopedCache` `getRunContext` already uses, so a run never re-fetches mid-run. Object type
  resolves: an explicit override → the project's own `objectDialect.defaultObjectType` → the pipeline's
  current single-client-family default (`"content_item"`) — see next paragraph for why the middle rung
  exists.
- `ProjectObjectDialect` (`projectTypes.ts`) gained `defaultObjectType`, alongside the existing
  `siteObjectId`/`taxonomyRegistryObjectId` per-site parameters, set to `"content_item"` for `dr-lurie`
  (`DR_LURIE_DEFINITION_VERSION` 5 → 6 so a persisted stale config re-seeds it). `platform` has no
  static definition file in this repo (it is a live-only project record) — the `"content_item"` fallback
  is what keeps the mechanism working for it today; an operator can set `objectDialect.defaultObjectType`
  on the live record once a second client needs a different object type.
- `executor.ts`'s `executeRunnableNode` calls the prefetch for any node whose `metadata.contractPrefetch`
  is `true` (set on `contract_intelligence`), BEFORE dispatching it, and injects the result into the
  node's own input as `prefetchedContract` (or `prefetchError`, best-effort — a fetch failure becomes
  the node's own explicit blocker, never an executor crash).
- `contract_intelligence`'s prompt rewritten: this is now a validation-and-pass-through step over
  `prefetchedContract`, not a discovery one. It no longer re-fetches the primary contract itself;
  `project.call_read_tool` stays granted only for something genuinely missing from the prefetch (a
  registry/taxonomy lookup, or a different object type than what was prefetched).
- **Not done here** (scope boundary): per-downstream-node slicing of `contract_intelligence`'s own
  output (article_body/artifact_plan/publish_payload each reading only their relevant field) — lower
  marginal value once the primary fetch is no longer the cost driver, and each already reads named
  fields (`bodySchema`, `mediaConvention`, `publishPolicy`, ...) from a payload that is now reduced
  rather than the raw multi-KB contract.

**F2 — the per-turn budget check (wave 13's B3) watched the wrong ceiling.** It checked a node's own
`modelConfig.budgetUsd` — a rare, node-specific knob — never the RUN's `budgetUsd` (the one
`workflow.start_dry_run` actually sets and the between-node gate in `advanceRun` evaluates). A single
node's turns could still carry the run straight through its real ceiling before the gate got another
look — precisely what happened: $1.60 → $4.17 against a $3 ceiling in one `contract_intelligence`
dispatch. `OpenAINodeRunner.ts` now resolves the tighter of the two (node config, run-level) as the
effective ceiling the in-loop guard watches, reusing the exact `agent_start`-hook mechanism wave 13
built — this is a one-line widening of what counts as "the budget," not new machinery.

**F3 — `workflow.resume_run`'s own reported remedy was unreachable.** The budget gate's block reason
says "Raise budgetUsd and resume," but `resume_run` took only `runId` — there was no tool call that
could actually raise it. `resume_run` split out of the shared pause/cancel/resume tool map (the only
one of the three that needed an extra field) with an optional `budgetUsd`; omitted, resume behaves
exactly as before. `updateRunStatus` (`executor.ts`) gained an optional `patch` parameter carrying it
through to the saved run — the run's own between-node gate re-evaluates the new ceiling against
accrued spend on the very next advance and clears `budgetBlock` itself once it passes.

**F4 — `learning_recorder` depended on `publication_controller` completing, which a dry run's own
design never lets happen** (every dry run blocks at the publish-risk gate unless explicitly approved) —
zero observations were ever recorded from any dry run. Generalized by `kind` (`node.kind === "learning"`,
matching the `isPublishRisk` precedent of a semantic node property, not a hardcoded id): `advanceRun`
now fires it as a best-effort side effect — `recordTerminationObservations` — the moment the run
reaches ANY of completed/blocked/failed, restoring the run's own status/currentNodeId immediately after
so this side observation can never override the run's real outcome. Separately, and load-bearing for
the fix to mean anything in a real (non-mock) run: `learning.record_observation`'s controlled tool was
`requiresApproval: true`, but `approvedToolIds` is never populated for normal node dispatch (only
`tool.test`'s diagnostic path sets it) — identically to how `project.call_tool` stranded
`contract_intelligence` before the read-tool split (#91). Recording an internal, workspace-local
observation never touches a client or publishes anything, so it does not need human gating;
`requiresApproval` is now `false`. Every new observation is stamped with `runId`/`nodeId` (both the
controlled tool and the wire-level tool) — the existing 32 records predate this and carry neither field,
unfixable retroactively.

**F5 — timeout/cost audit.** `draft_writer` had no configured timeout (defaulted to 60s) and failed
with `model_timeout` on a large brief; 300s was set live and it passed. Only 3 of 21 nodes had an
explicit timeout at all (`research`, `trust_factual`, `contract_intelligence` — all tool-heavy), yet
`draft_writer`'s failure had nothing to do with tool calls — a single large-output generation call can
simply take longer than 60s. The global fallback (`OpenAINodeRunner.ts`/`AnthropicNodeRunner.ts`) is
now 120s; `draft_writer` carries its own confirmed 300s override, and the other large-output assembly
nodes (`human_texture`, `article_body`, `publish_payload`, `brief_architect`) carry 180s as a reasoned
middle tier. `research`'s cost variance (5x: $0.76/145K tokens vs $0.14/21K tokens on an identical
config) is capped with `modelConfig.budgetUsd: 1`, which the F2 fix above now actually enforces mid-turn
rather than only after the fact.

Suite: **935 root** (was 916 going in — wave 13 landed at 913, then two more tests were added for the
prior wave's own coverage before this wave started), typecheck clean, node/skill seed drift clean,
manifest lock clean (`workflow_resume_run`'s schema changed — regenerated deliberately).

**Follow-up not taken here:** a fresh live end-to-end re-run of `run_1785352838155_l544ye`'s scenario to
confirm `contract_intelligence`'s actual dollar cost lands under the $0.10 target now that the fetch is
deterministic; setting `objectDialect.defaultObjectType` on platform's live (non-static) project record
so F1's prefetch resolves it from project config rather than the pipeline-wide fallback.

---

## 2o. Execution log — 2026-07-30, wave 15 (T-2 re-run: two defects, PASS otherwise)

That live end-to-end re-run wave 14 recommended actually happened
(`run_1785352838155_l544ye`'s scenario): `article_body` produced a contract-correct `content_item` — 8
nodes all matching `^n_[a-z0-9]+$`, no `schema_version` under the strict schema, taxonomy correctly
omitted because `tax_platform` is empty, `requestId` matching the contract pattern, `legacyFallbacksUsed`
false — and the run halted at `publication_controller` with `approval_required`, exactly as designed. T-2
**PASSED**. Two defects surfaced anyway:

**G1 — `learning_recorder` timed out (`model_timeout`), because F5's audit had nothing to size it from.**
F5 (wave 14) sized every node the T-2 run actually exercised. `learning_recorder` depended on
`publication_controller` completing, which a dry run's own design never allows, so before F4 it had
never run once — zero observed profile, not merely an unmeasured one. F4 made it fire for the first time
ever on THIS run, straight into the 120s global default, on a node whose input is an entire run's worth
of stage outputs (potentially every one of the other 18 executed nodes) — a larger input than the single
large brief that earned `draft_writer` its own 300s override. It now carries that same 300s override
(`nodes.ts`). Re-checked every other node F5 sized: all of them (`research`, `trust_factual`,
`contract_intelligence`, `brief_architect`, `draft_writer`, `human_texture`, `article_body`,
`publish_payload`) sit on the main DAG before `publication_controller` and so actually ran and completed
in the live T-2 pass — `learning_recorder` was the only node whose timeout was never actually informed by
a real execution.

**G2 — a run's top-level `errors` array kept resolved failures forever.** This run ended with
`errors: ["draft_writer:model_timeout", "learning_recorder:model_timeout"]` even though `draft_writer`
had, in between, been retried (`workflow.retry_node`) and completed successfully. `retryNode` resets the
node's OWN state — status, output, `node.errors` — back to queued, but never touched the run-level
`errors` array those failures were appended to, so a resolved failure stayed there permanently,
indistinguishable from a live one. `executeRunnableNode` (`executor.ts`) now supersedes a node's prior
`run.errors` entries the moment that node completes — retried or not — so the array reflects current
status rather than accumulating every historical attempt. `learning_recorder`'s own (genuine, current)
`model_timeout` entry is untouched by this run, exactly as it should be until G1's timeout fix is proven
live.

Scope held deliberately narrow per the request: nothing else touched, publish gates stay closed.

Suite: **938** (was 935), typecheck clean (pre-existing unrelated `ui/src/types/workspace.ts` `@rjsf/utils`
module-resolution error, present before this wave too).

**Follow-up not taken here:** a fresh live re-run to confirm `learning_recorder` now completes within
300s and actually records its first-ever observation.

---

## 2p. Execution log — 2026-07-30, wave 16 (T-2 re-run #2: F1 regressed cost UP, not down)

`run_1785405350649_9u5mjz` re-ran T-2 against `platform` specifically to measure F1's contract-prefetch
win. It didn't land: `contract_intelligence`'s own cost went **UP** ($2.57 → $3.79), and the run's
between-node budget gate blocked at 118% of a $4 ceiling. Four fixes:

**H1 — platform's `ProjectObjectDialect` was entirely absent, which is what made F1 no-op for it.**
`project_get(dr-lurie).knowledge.site` carries `siteObjectId`/`taxonomyRegistryObjectId`/
`requestIdPattern`; `project_get(platform).knowledge` had no `site` block at all — confirmed live.
Worse: `project.update`'s patchable fields (`name`, `mcpEndpointEnvVar`, `authMode`, `tokenEnvVar`,
`allowedTools`, `defaultToolPolicy`, `toolPolicies`, `contentContract`, `status`) do not include
`objectDialect` — there is **no live MCP path that can ever set it**. The only mechanism that writes
`objectDialect` onto a persisted record is `migrateDefaultProjectConfig` re-seeding from a code-defined
default, which requires the project to be IN `defaultProjectConnections` in the first place (see H3).
`src/agent/projects/platform/definition.ts` is new: a faithful mirror of platform's live record
(captured via `project.get` 2026-07-30 — same `toolPolicies`, `defaultToolPolicy: "allowed"`,
`contentContract`, `status`), so the first migration is additive-only, plus the new `objectDialect`:
`siteObjectId: "site_platform"`, `taxonomyRegistryObjectId: "tax_platform"`,
`objectIdSource: "server_minted"` (unlike dr-lurie's caller-supplied request id), `requestIdPattern`
matching the live-observed `req_article_kugel_lifecycle_20260730_01`, and
`defaultObjectType: "content_item"`.

**H2 — the prefetch's object-type resolution had a silent literal fallback.** `contractPrefetch.ts`
resolved `objectType` as `requestedObjectType ?? config.objectDialect?.defaultObjectType ?? "content_item"`
— a hardcoded guess when NEITHER of the first two resolved. The guess happened to be right for both
known clients today, but there was no way to tell "guessed right" from "guessed wrong" from outside the
function, and it is exactly the kind of self-disabling optimization the request called out: it cost a
full live run to detect. The literal fallback is gone; an unresolvable object type now returns a NAMED
failure (`code: "prefetch_object_type_unresolved"`) naming the project. `executor.ts`'s prefetch
dispatch also now stamps a run-visible `state.warnings` entry (`contract_prefetch_failed:<code>`) on any
prefetch failure — previously visible ONLY inside the affected node's own input, which is precisely why
nobody noticed until the cost regression.

**H3 — platform was live-registered via `project.create` (W-1) but absent from
`defaultProjectConnections`, so it never once passed through `migrateDefaultProjectConfig`** (a project
not in that list is a guaranteed no-op for that function) — the one active project a code-defined config
bump could never reach. `defaultProjects.ts` now includes `platformProjectConfig` (H1), which also means
`project.delete("platform")` is now protected (`default_project_protected`), same as the other three
default projects. Added `src/agent/projects/projectDialectAudit.ts`: a pure audit over active,
publish-hook-bearing projects (`getProjectHooks(id)?.executePublish !== undefined` — pdf-tool/monetizer
have no publish hook and are correctly never flagged) missing required `objectDialect` fields, wired into
`BlobProjectRepository.health()` / `MemoryProjectRepository.health()` (`details.objectDialectFindings`
when non-empty). Separately, and load-bearing for that health check to mean anything:
`RepositoryManager.getRepositoryHealth()` never once called `projectRepository.health()` — the project
registry had no representation in the aggregate health summary at all. `project` is now a member of
`RepositoryHealthSummary`, surfaced through the existing `repository.get_health` tool.

**H4 — F2b's in-loop guard (wave 14) was fully engaged for `contract_intelligence` and still didn't stop
it.** Confirmed the "whichever ceiling is tighter" resolution is algebraically correct with no
node-level `budgetUsd` (`nodeBudgetUsd ?? runBudgetUsd`); the real gap is that the guard's `agent_start`
check only ever sees CUMULATIVE usage from turns already completed — it fires before a turn's own usage
is known, so it can only ever abort the turn AFTER the one whose own cost is what crosses the ceiling.
With F1 silently no-op'd (H1/H2), `contract_intelligence` fell back to raw self-discovery, and each
subsequent turn re-sent the whole growing conversation — whichever turn's own cost tipped it past the
ceiling had already run by the time the next turn's check could react, landing at 118% over. The guard
now also reserves against the UPCOMING turn's own prospective size, estimated from the exact input the
SDK is about to send it (`agent_start`'s third argument, `turnInput` — previously unread), the same
estimate-then-gate shape the existing pre-dispatch check already uses, just applied at every turn instead
of only once. Verified the new regression test actually fails without the fix (reverted the runner change
and re-ran it) before confirming it passes with the fix.

Scope held deliberately narrow per the request: the editorial nodes (F5) are untouched and working
(`research` $0.76→$0.38, `brief_architect` $0.26→$0.04, no timeouts).

Suite: **952** (was 938), typecheck clean (same pre-existing unrelated `ui/src/types/workspace.ts`
`@rjsf/utils` module-resolution error).

**Follow-up not taken here (next PR, per explicit instruction):** `article_body` produces nodes with
empty `private.strategy`/`private.intent` on every block despite the `content_item` contract declaring
both — `narrative_movement`/`angle_strategy` already produce exactly this editorial reasoning upstream;
`article_body` needs to carry it through per node, strictly in `private` (reader-visible strings stay
clean, which they currently are). Also not done here: a fresh live re-run of platform's scenario to
confirm `contract_intelligence`'s cost actually drops now that its prefetch engages.

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

**Wave 11 executed 2026-07-29** (E-1…E-4, R-2, R-5; R-24 landed separately as #89) — see §2k.

**Wave 12 executed 2026-07-29** (R-25, found by actually running wave 11's recommended live end-to-end run) — see §2l.

**Wave 13 executed 2026-07-29** (T-2's live shakeout: B1 validation-error input coercion, B2 diagnostic
detail on tool errors, B3 in-loop budget circuit breaker, B4 read-tool prompt naming + reduction
mandate; node-definition resolution timing confirmed by tracing the code) — see §2m.

**Wave 14 executed 2026-07-29** (T-2's follow-up, capability proven — the blocker was cost: F1
conductor-level deterministic contract prefetch+reduction, F2 the in-loop budget guard watching the
run's real ceiling, F3 `resume_run` can actually raise `budgetUsd`, F4 `learning_recorder` fires on any
run termination and its tool is no longer unreachably approval-gated, F5 timeout/cost audit) — see §2n.

**Wave 15 executed 2026-07-30** (T-2 re-run PASSED; G1 `learning_recorder`'s own missed timeout — F5 had
no execution to size it from — given the same 300s override `draft_writer` needed; G2 `run.errors`
superseded on completion so a retried-and-resolved failure stops looking like a live one) — see §2o.

**Wave 16 executed 2026-07-30** (T-2 re-run #2 against platform: F1 regressed cost UP instead of down;
H1 platform's `ProjectObjectDialect` populated — the one active project no live MCP path could ever set
it on; H2 the prefetch's silent `"content_item"` guess replaced with a named
`prefetch_object_type_unresolved` failure plus a run-visible warning; H3 platform joined
`defaultProjectConnections` so it self-heals like the other three defaults, and a new project-dialect
audit is wired into the (previously entirely absent from the aggregate) project repository health check;
H4 the in-loop budget guard now reserves against the UPCOMING turn's own prospective size, not just
cumulative usage from turns already completed) — see §2p.

Next, in the order I would take them:
1. **A live end-to-end run, again** — wave 14 fixed every mechanism `run_1785352838155_l544ye` hit and covered each with unit/integration tests, but nothing has re-run that scenario live end-to-end since. Worth doing deliberately (it spends model budget) with `budgetUsd` set, reading `mode` to confirm live/store execution as before, and this time watching `contract_intelligence`'s actual dollar cost against the $0.10 target, whether `learning_recorder` actually records observations, and whether the run reaches a publishable `article_body`.
2. **R-8** — promoted by wave 4's findings 2–4: three separate allow-list/reporting defects surfaced the moment the connections came up (`platform`'s `allowedTools: []`, the vanished `requiredPdfToolCapabilities` source of truth, the missing `resume_agent_artifact_job` / `get_image_model_policy` grants). Two hand-kept lists with no declared requirement is the condition that caused the original pdf-tool regression.
3. **The 7 flattened skill `outputSchema`s** — R-2 removed the false blocker that forced them to stay placeholders; writing their real contracts is now unblocked and is the next thing an operator editing schemas in S4 will walk into.
4. **R-20** — mock runs still accrue estimated cost against `budgetUsd` despite making no model calls. Cheap, and it matters more now that mock is an explicit choice people make for cost reasons.
