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
| ENV-1 ☐ | Set `DR_LURIE_MCP_ENDPOINT` / `DR_LURIE_MCP_TOKEN` on Cloud Run | copy from Netlify site config; blocks all client-0001 work |
| ENV-2 ☐ | Set `PDF_TOOL_MCP_ENDPOINT` / `PDF_TOOL_MCP_TOKEN` on Cloud Run | blocks the image pipeline via `project.call_tool` |
| ENV-3 ☐ | Set `PLATFORM_MCP_ENDPOINT` / `PLATFORM_MCP_TOKEN` on Cloud Run | endpoint = platform site's `/mcp` (now live per §0); token minted platform-side |
| ENV-4 ☐ | After W-2: remove `SNOOCLE_*` env vars | cleanup only, after deletion. **Scope narrowed:** keep `MONETIZER_*` — `feedback.ingest_monetizer` still uses that connection (see W-2) |

Verify each with `project.test_connection` — currently fail-closed, which is correct.

### W — workspace data changes (MCP; each carries actor/reason; ledgered; reversible)

| id | change | depends on | detail |
|---|---|---|---|
| W-1 ☐ | **Register `platform` as client 0** — `project.create` per the registration contract: `projectId: platform`, `mcpEndpointEnvVar: PLATFORM_MCP_ENDPOINT`, `tokenEnvVar: PLATFORM_MCP_TOKEN` | ENV-3 | then `test_connection` → `list_tools` → allow-list read-only contract tools first (`object_contract`, `registry_get`, `object_inventory`, `object_validate`, `ping`), widen later behind the same gate as dr-lurie |
| W-2 ◑ | **Retire `snoocle`; keep `monetizer`** | none | Both records **disabled** via `project.update` (ledgered, reversible) — `project.delete` refuses a code-defined default ("re-seeded on read"). Repo commit removes snoocle from `defaultProjectConnections`, so `project.delete snoocle` works once it lands. **monetizer is NOT a fake registration**: `improvement/monetizerIngest.ts` imports `monetizerProjectConfig` to power the `feedback.ingest_monetizer` tool, so deleting it drops a live tool from the wire surface. Retiring it is a decision about the Phase 7 outer loop, not registry hygiene. pdf-tool untouched — Ring 0 |
| W-3 ✅ | **Generalize `learning_recorder` prompt** — last mechanical "Dr. Lurie" in contract-logic context | none | Done, workspace v69→v70. Now "project artifact/rendering failures", matching the node's own description. Full-node patch used deliberately (R-1) |
| W-4 ⧗ | **Generalize the five editorial-voice nodes** (`topic_opportunity`, `research`, `brief_architect`, `draft_writer`, `trust_factual`) to fetch voice from the client | **P-2 (voice object)** | do NOT do earlier — there is nowhere to fetch voice from; premature generalization degrades writing quality |
| W-5 ⧗ | **Split `dr_lurie_dtc_science_editorial`** into a client-neutral craft skill + per-publication voice record | P-2, W-4 | the skill's content seeds the first `vox_drlurie_default` record |

### R — CMS-Agent repo changes (need CI first; ordered)

**R-0 ✅ CI (GitHub Actions).** `npm test` + `npm run test:ui` + both builds on every push, plus the two-plane drift detector. **Gates everything below** — 94 tests, zero automation today; nothing on this list stays fixed without it.

**R-1 ☐ Data-loss fix: single-field `update_node_*` writers.** `update_node_tools/_skills/_dependencies/_metadata/_model_config` write `undefined` over the target field when the patch omits it — reproduced: `ok:true` while wiping `allowedTools`. Fix: reject a patch missing the target field. *Highest severity on the list.*

**R-2 ☐ Skill-compatibility resolver fix.** Any skill `outputSchema` with `additionalProperties`/`properties`/`required` reports blocker-incompatible regardless of actual compatibility; only bare `{"type":"object"}` passes. Current skills work because we flattened them — the next properly-specified skill re-triggers it.

**R-3 ☐ Coerce stringified JSON in `update_node_output_schema` / `_input_schema`.** `coerceJsonObjectInput(data.schema)` + declare `schema: {type:["object","boolean"]}` — the defense `create_node` already has, per the codebase's own documented client-stringify behavior.

**R-4 ☐ Typed version-conflict envelope.** `{ok:false, code:"version_conflict", currentVersion, currentRevisionId}` instead of bare `-32603`. Precondition for multi-agent editing and for the S4 save path. Also surface `error.data` detail generally — it exists but clients only see "Tool execution failed".

**R-5 ☐ Reconcile the two resolvers.** `skill_resolve_for_node` says `effectiveTools:["project.call_tool"]` where `node_get_effective_tools` says `allowed:false` for the same nodes. One semantics, one answer; the GUI can't render two truths.

**R-6 ☐ Retire `article_body_validate` / `article_body_get_schema`.** Drifted local copy; the client's `object_validate` is the authority. Either remove, or repoint as a thin proxy that calls the client contract — never a local schema again.

**R-7 ☐ Project record: `kind: client|service`, `clientNumber`, `contentSubstrate`.** The `project.update` patch schema has no metadata field today, so this is a repo schema change, not a data write. Sets: platform `{client, 0, object}`, dr-lurie `{client, 1, object}`, pdf-tool `{service}`. This is what stops a service being mistaken for a deletable client again.

**R-8 ☐ Contract-driven allowlist reconciliation.** `project.list_tools` + the workspace's declared required capabilities → effective allowlist with drift *reported*. Two hand-kept lists caused the pdf-tool regression; this makes it structural.

**R-9 ☐ `requestId` on runs and usage records.** The change ledger already carries `correlation.requestId`; runs and usage don't. This is the join key between platform workflow records and workspace runs — without it the learning corpus sees outcomes without method.

**R-10 ☐ Attention resolution.** `constellation.get_attention` must report: blocker-severity skill conflicts, skill-requested-but-denied tools, `dependsOn`≠`requiredInputs`, unconfigured project connections, and (after R-12) stale docs. Today it returns `[]` against real defects.

**R-11 ◑ S4 node inspector — read-only DONE, write path still blocked on R-4.** Three-layer rendering per node: Method (stored, always) / Effective (resolved, always) / Identity (live contract fetch — greyed "client contract unreachable (`<ENV_VAR>`)" when down, run controls disabled, `fetchedAt` always shown, never stale-as-live). Tabs: Prompt, Tools (own vs effective with `denialReasons`), Skills (with conflicts), Overview, Schemas. Connection badge on the project selector. **Write path ships only after R-4.** This closes your stated gap: seeing node instructions and attributes.

**R-12 ☐ Docs generator + Tier D.** Introspection → self-description artifacts (stamped `workspaceVersion`/`revisionId`) → `content_source.v1` envelopes → normal pipeline → client 0. Tier D diffs published `sourceWorkspaceVersion` against live workspace; stale → attention item. Repo-analysis narrative docs regenerate in CI on merge; per-object mechanics docs derive from introspection only.

**R-13 ☐ Protocol as code.** `tests/protocol/`, one file per tier, shared MCP client; Tiers 0–4, 7, D in CI (no model calls); Tier 6 nightly; Tier 8 never unattended.

**R-14 ☐ S5 Operate / S6 History.** Per the GUI plan — after S4 stabilizes.

### P — platform repo (their side; for the record, so dependencies are visible)

| id | change | unblocks |
|---|---|---|
| P-1 ☐ | Client-0 self-README content — Claude Code bootstrap for narrative; taxonomy terms (`engine`, `node`, `skill`, `tool`, `policy`) registered so generated docs resolve | T-3 |
| P-2 ☐ | Voice object type (`vox_`, modeled on theme, resolve-by-reference) + `vox_drlurie_default` seed | W-4, W-5 |
| P-3 ☐ | Machine-readable request-id pattern in `object_contract` (today prose-only in the `id_object` constraint) | closes the orphaned-artifact class fleet-wide |
| P-4 ☐ | Delete the two orphaned test artifacts (needs admin): sha `5b62bc51…` under `req_smoke_imagepipeline_20260726_01` (soft-delete) and `req_cms_agent_image_smoke_20260726` (orphan — needs reconcile or direct blob access) | hygiene |

### T — execution milestones (protocol runs, in order)

| id | milestone | gate | depends on |
|---|---|---|---|
| T-1 ☐ | Conformance vs client 0: Tiers 0–3 | machine verdict on the mcp.ts move, both directions | ENV-3, W-1 |
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

## 3. What was already completed this session (for the ledger)

✅ pdf-tool capability restored (14 tools, `article_body.v1` contract, deny-by-default kept) · ✅ `verify_agent_artifact` granted · ✅ image loop proven live end-to-end · ✅ 6 nodes + 6 skills aligned to contract-as-truth (workspace v56→v69) · ✅ `trust_factual` regression fixed · ✅ `contract_intelligence` unblocked (risk level) · ✅ graph valid, attention clean, 11/13 skill-bearing nodes conflict-free (2 remaining warnings are the publish gate working as designed).

---

## 4. Approval

Say **go** (or mark exceptions by ID) and I execute in this order: **W-2, W-3** (workspace, reversible) → **R-11 read-only + R-0** delivered as a patch series via the zip handoff → **W-1 + T-1** the moment ENV-3 lands. Everything else follows the spine.

**Wave 1 executed 2026-07-26** — see §2b. Next without new approval: `project.delete snoocle` once the patch lands. Next needing approval: **R-4** (now the highest-value repo fix — it gates both diagnosis and the S4 write path), then **R-1**.
