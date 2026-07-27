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
| T-2 ☐ | Full dry-run pipeline vs client 0 (Tier 6) | contract-driven method proven on a second client | T-1 |
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
