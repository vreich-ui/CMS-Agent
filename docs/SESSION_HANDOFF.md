# CMS-Agent — Session Handoff

_Handoff for a fresh session. Repo: `vreich-ui/CMS-Agent`. Supersedes the 2026-07 MCP-hardening handoff._
_Written 2026-07-26 after the audit/alignment session. **Read `docs/plan/SESSION-BRIEF.md` first, then `docs/plan/CHANGE-PLAN.md`.**_

---

## 1. TL;DR

The workspace was audited end-to-end, aligned around one principle — **the client's live contract is the only content truth, fetched at runtime** — and a governing change plan was written. The canonical control plane is **Cloud Run + GCS** (workspace v69, graph valid). The Netlify plane is a frozen archive. The image pipeline (storage grant → pdf-tool → client blob → verified ArtifactReference) is **proven working live**. Six nodes and six skills were rebuilt contract-driven; every change is in the workspace change ledger under actor `cowork-alignment` / `cowork-migration`.

**All further work is governed by `docs/plan/CHANGE-PLAN.md` — 25 items with IDs (ENV/W/R/P/T) and a dependency spine. No code or MCP changes outside approved plan items.**

## 2. Standing blockers — **none as of 2026-07-27 (re-verified after redeploy)**

All three client connections verified live on revision **cms-agent-mcp-00028-8f4**: `platform` → `Platform_MCP_Server` 0.1.0, `dr-lurie` → `Dr_Lurie_MCP_Server` 0.1.0, `pdf-tool` → `pdf-tool-agent-artifacts` 0.2.0. The merged code is confirmed live by function, not by assumption: a **stringified** schema sent to `workspace_update_node_output_schema` was accepted, which only post-R-3 code does. Workspace **v85**.

Verify with `project_test_connection` — it fails closed, which is correct. **Caution when it reports 401:** the transport bearer (`*_MCP_TOKEN`) and the client's *storage* credential are different layers. A transport 401 fails the whole call; a storage 401 comes back as a **successful** call carrying `isError:true` and a Netlify Blobs 401 inside the tool result.

Left over: **ENV-4**, cleanup only — drop the unused `SNOOCLE_*` vars, keep `MONETIZER_*` (`feedback.ingest_monetizer` depends on it).

### The deploy trap, now fixed at source

It bit twice: `--set-env-vars` / `--set-secrets` REPLACE a service's entire environment, and the runbook's copy-pasteable command listed only the four store/CORS variables — so every release silently deleted the six client-connection variables while `repository.get_health` stayed green (workspace state is GCS, independent of the revision). It reads as a credentials problem and is not one.

Fixed by changing the thing people actually copy, not just adding a warning:

- **`scripts/deploy-mcp.sh`** — one committed release command. Merge-style `--update-env-vars` / `--update-secrets`, image tagged with the git SHA so "which commit is live?" is answerable, prints the serving revision's full environment, then runs the verification below.
- **`npm run verify:deploy`** — `MCP_URL=… MCP_API_TOKEN=… npm run verify:deploy`. Hashes the served tool surface and compares it to the committed manifest (catches a stale revision — health checks cannot), and reports endpoint/token configuration per project (catches a wiped environment). Both incidents, one command.
- Runbook commands corrected in PHASE4 (service) and PHASE2 (conductor job). PHASE1's `--set-*` is left as-is because it *creates* the job, with a note not to copy it into an update.
- To drop one variable later: `--remove-env-vars KEY`. Never re-list everything with `--set-*`.

**Merging is not deploying.** There is no CI/CD for the MCP image; `cloudbuild.mcp.yaml` only builds it. Confirm the live revision before concluding a fix shipped.

With ENV-3 in, client 0 is registered and **T-1 passed GO** (TEST-PROTOCOL Appendix C): the mcp.ts move is verified in both directions and nothing on the client side blocks anything.

## 3. The client model

- **platform** = client 0 — canonical; its site is the self-README; conformance target; first live publish (T-3) publishes *engine docs* there.
- **dr-lurie** = client 0001 — first real publication. Publishing stays triple-locked (policy + draft executor + pinned approval) until T-4.
- **pdf-tool** = **service (Ring 0), never delete, never agent-reconfigurable** — it is the artifact engine, called via `project.call_tool`.
- **snoocle / monetizer** = fake registrations, delete (W-2).

Protection rings (ratified): Ring 0 services — publishing agents may call, never reconfigure; Ring 1 client connections — adjustable behind `needs_approval`; Ring 2 method (nodes/prompts/skills) — the agents' editable surface, ledgered. Enforcement is R-7/R-7b.

## 4. Known bugs — read before touching anything

1. ~~**`workspace_update_node_*` silently wipe omitted fields**~~ **FIXED (R-1, wave 3)** — they now refuse a patch missing their target field. Note `workspace_update_node` itself always merged correctly (`{...existing, ...patch}`), so a minimal patch through it is safe.
2. Skill/node schema compatibility check false-blocks any skill `outputSchema` beyond bare `{"type":"object"}` (R-2). Current skills are flattened to work around it.
3. ~~`update_node_output_schema`/`_input_schema` reject client-stringified JSON args (R-3)~~ **FIXED (wave 5)** — `store.coerceSchemaInput` parses a stringified schema, accepts object or boolean, and refuses anything else rather than writing it. The advertised `schema` parameter is now `{"type":["object","boolean"]}`. Note the plan's claim that this gated the S4 Schemas tab was wrong — S4 saves via `workspace_update_node` and never called these writers; the tab is editable as of the same wave.
4. ~~Version conflicts surface as untyped `-32603`~~ **FIXED (R-4, wave 3)** — failures now carry a `code` plus details, conflicts report `currentVersion`/`currentRevisionId`, and the JSON-RPC message leads with the code instead of one constant sentence.
5. `skill_resolve_for_node` and `node_get_effective_tools` disagree on effective tools for some nodes (R-5).
6. ~~`article_body_validate`/`article_body_get_schema` are a drifted local schema~~ **FIXED (R-6 + R-23 delete half)** — both tools and the workspace-local `{schema_version, nodes}` schema (Zod and JSON forms) are deleted; the article_body node's own `outputSchema` is the single workspace-side authority, and the client's `object_validate` is the authority beyond it.
7. ~~No CI (R-0)~~ **FIXED (wave 1)** — GitHub Actions runs typecheck, both suites, both builds, and a two-plane drift detector on every push. 742 root + 55 ui tests.
8. `constellation.get_attention` returning `[]` against real defects (R-10) — **FIXED (wave 3)**; it now reports skill blockers, denied skill tool requests, dependsOn/requiredInputs disagreements, ungrantable tool grants, and unconfigured client connections.

## 5. What a fresh session should do

1. Read `docs/plan/SESSION-BRIEF.md` (state + model guidance + rings) and `docs/plan/CHANGE-PLAN.md` (the work, by ID).
2. Ask Wolf which plan IDs are approved/next, or check the change ledger (`changes_list`) for what has landed since this handoff.
3. Verify plane state before acting: `repository_get_health` (expect `gcs`, v≥69), `workspace_validate_graph`, `constellation_get_attention`, `project_list`.
4. Immediately startable without ENV: R-0 (CI), R-11 read-only (S4 inspector), W-2, W-3. Deliver repo changes as a patch-series zip (no push access).

**Wave 1 ran 2026-07-26** (`docs/plan/CHANGE-PLAN.md` §2b): W-3 done (workspace **v70**), W-2 partial (both records disabled; snoocle de-seeded in the repo patch; **monetizer kept** — `feedback.ingest_monetizer` depends on it), R-0 done (CI + two-plane drift detector, 136-tool manifest), R-11 read-only done. Suite: 707 root + 55 ui tests, green.
**Wave 2 ran 2026-07-27**: W-1 (platform = client 0, deny-by-default + 5 read-only contract tools) and T-1 (Tiers 0–3, **GO**). Bug-list updates from it: bug 2 (R-2) is no longer *blocking* anything — no blocker-severity skill conflict survives; the T2.6 finding grew from 1 node to **14** (all carrying an ungrantable `stage.save_output`, harmless to execution but the noise that hid the real defect); and `project.create` does not bump `workspaceVersion`, so drift checks keyed on it are blind to connection changes.
**Wave 3 ran 2026-07-27**: R-4, R-1, R-10, the T2.6 cleanup (live workspace **v84** plus the seeded code defaults), and the **R-11 write path** (unblocked by R-4). See CHANGE-PLAN §2d. Editing a node now happens in S4, not the legacy JSON textareas — every write carries a mandatory reason, a confirmed diff, and an `expectedWorkspaceVersion`.
**Wave 4 ran 2026-07-27**: ENV-1 + ENV-2 landed and verified end-to-end, W-2 closed (`snoocle` deleted — the deploy had rolled out). See CHANGE-PLAN §2e. Three findings promote **R-8** to the front of the repo queue: `project.list` reports `platform`'s `allowedTools` as `[]` while five `toolPolicies` grants are live and callable (so `toolPolicies` is the enforced list and any UI reading `allowedTools` misrenders client 0 as capability-free); `article_body`'s `requiredPdfToolCapabilities` enum — the authoritative pdf-tool capability set the earlier findings cited — no longer exists, generalized away by the contract-as-truth wave, leaving the 14-tool allow-list hand-kept against nothing; and the artifact job lifecycle is allow-listed except its resume leg (`resume_agent_artifact_job` denied while `create_agent_artifact_job` is granted, so an approval-blocked job cannot be resumed through the workspace).

**Wave 5 ran 2026-07-27**: R-3 (schema-writer coercion) plus **the S4 Schemas tab, now editable** through the same discipline as every other field — diff, mandatory reason, version guard. See CHANGE-PLAN §2f for the six design decisions, of which three are traps: schemas are held as text so mid-edit invalidity shows a blocker instead of silently reverting; clearing a schema is refused because `undefined` round-trips into `{"type":"object"}` (the R-1 failure mode in a different hat); and the deprecated `schema` alias is written in lockstep with `outputSchema` so it cannot trail a stale copy. Suite 780 root / 72 ui.

Second standing habit, earned in wave 5: **a blocker recorded once and then cited by later documents acquires the appearance of having been verified.** R-3 was written down as the only thing keeping the Schemas tab read-only, that note was repeated in the component itself, and neither was true — S4 never called the writers R-3 fixes. Re-derive a claimed dependency from the code before building on it.

**Wave 6–7 ran 2026-07-27** — the explanation layer, in two passes. Wave 6: `ui/src/explain.ts`, the vocabulary registry for coded enum values (risk rungs, run states, actor kinds, the 8 tool denial reasons, permission states, resolution layers, conflict severities), rendered by `components/Glossary.tsx` and generated into `docs/ui-glossary.md`. Wave 7 corrected the brief — what was wanted was **object** descriptions: `ui/src/objectModel.ts` describes the engine's 11 core object types plus the Phase 7 family, rendered by `components/ObjectAbout.tsx` and generated into `docs/engine-objects.md` **and 12 `content_source.v1` envelopes** (`docs/generated/`) that feed the P-1 / R-12 publish path to client 0. Three CI locks now: manifest, glossary, objects. See CHANGE-PLAN §2g and §2h.

**Deployment trap that has now bitten twice — read before deploying.** `PHASE4_RUNBOOK.md`'s step-2 `gcloud run deploy` uses `--set-env-vars`, which **REPLACES the service's whole environment** and lists only the four store/CORS variables. Re-running it to ship code silently deletes ENV-1/2/3, so all client connections fail closed with "endpoint is not configured" **while `repository.get_health` stays green**, because workspace state is in GCS and independent of the revision. It looks like a credentials problem and is not one. Use `--update-env-vars`, or list every variable. A rollback to a pre-ENV revision has the identical symptom. The runbook now carries this warning inline. Observed live at the end of this session: all three connections dropped and the deployed surface had reverted to pre-R-3 code, i.e. the revision serving traffic predated the day's merges.

**Wave 9 ran 2026-07-27**: R-16 (the executor now validates each node's output against its own schema and fails closed — no stage output, no artifact) and R-17 (mock fixtures derived from schemas, with a CI guard that every canonical node's mock validates). See CHANGE-PLAN §2j.

⚠️ **New, and it outranks both fixes — R-22.** `resolveConductorNodes()` defaults to the STATIC hardcoded definitions in `src/agent/workspace/nodes.ts` (last touched 2026-07-03) and ignores the live workspace unless `WORKSPACE_NODES_SOURCE=store`. The seeded `article_body` requires two fields where the live one requires six, carries no contract-intelligence skill and no `project.call_tool`, and **`contract_intelligence` is not a seeded node at all**. So the contract-alignment wave's live edits do not participate in a run, T-2 exercised an obsolete pipeline, and no dry run can validate the contract-driven method until the default flips or `nodes.ts` is re-seeded from the live workspace. Wolf's decision.

Standing habit earned the hard way, THREE times now (snoocle, the 14 ungrantable grants, and now the entire node set): **after any workspace-data fix, check whether the code-defined defaults carry the same defect.** snoocle and the 14 ungrantable tool grants were both re-seeding traps — the data write looks complete and the next fresh workspace undoes it.

Deep background per topic: `docs/plan/findings/` (migration, image pipeline, contract alignment, tool bugs, voice object, fleet alignment, self-describing engine) and `docs/plan/GUI-PLAN.md` / `TEST-PROTOCOL.md`.
