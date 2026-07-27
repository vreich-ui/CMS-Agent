# CMS-Agent — Session Handoff

_Handoff for a fresh session. Repo: `vreich-ui/CMS-Agent`. Supersedes the 2026-07 MCP-hardening handoff._
_Written 2026-07-26 after the audit/alignment session. **Read `docs/plan/SESSION-BRIEF.md` first, then `docs/plan/CHANGE-PLAN.md`.**_

---

## 1. TL;DR

The workspace was audited end-to-end, aligned around one principle — **the client's live contract is the only content truth, fetched at runtime** — and a governing change plan was written. The canonical control plane is **Cloud Run + GCS** (workspace v69, graph valid). The Netlify plane is a frozen archive. The image pipeline (storage grant → pdf-tool → client blob → verified ArtifactReference) is **proven working live**. Six nodes and six skills were rebuilt contract-driven; every change is in the workspace change ledger under actor `cowork-alignment` / `cowork-migration`.

**All further work is governed by `docs/plan/CHANGE-PLAN.md` — 25 items with IDs (ENV/W/R/P/T) and a dependency spine. No code or MCP changes outside approved plan items.**

## 2. Standing blockers (nothing client-facing works until these)

Cloud Run env vars, set by Wolf manually (values live in Netlify site config; they never pass through MCP):
`DR_LURIE_MCP_ENDPOINT/_TOKEN` (ENV-1) · `PDF_TOOL_MCP_ENDPOINT/_TOKEN` (ENV-2) · ~~`PLATFORM_MCP_ENDPOINT/_TOKEN` (ENV-3)~~ **done 2026-07-27**.
Verify with `project_test_connection` — it fails closed, which is correct.

ENV-1 and ENV-2 remain. With ENV-3 in, client 0 is registered and **T-1 passed GO** (TEST-PROTOCOL Appendix C): the mcp.ts move is verified in both directions and nothing on the client side blocks anything.

## 3. The client model

- **platform** = client 0 — canonical; its site is the self-README; conformance target; first live publish (T-3) publishes *engine docs* there.
- **dr-lurie** = client 0001 — first real publication. Publishing stays triple-locked (policy + draft executor + pinned approval) until T-4.
- **pdf-tool** = **service (Ring 0), never delete, never agent-reconfigurable** — it is the artifact engine, called via `project.call_tool`.
- **snoocle / monetizer** = fake registrations, delete (W-2).

Protection rings (ratified): Ring 0 services — publishing agents may call, never reconfigure; Ring 1 client connections — adjustable behind `needs_approval`; Ring 2 method (nodes/prompts/skills) — the agents' editable surface, ledgered. Enforcement is R-7/R-7b.

## 4. Known bugs — read before touching anything

1. ~~**`workspace_update_node_*` silently wipe omitted fields**~~ **FIXED (R-1, wave 3)** — they now refuse a patch missing their target field. Note `workspace_update_node` itself always merged correctly (`{...existing, ...patch}`), so a minimal patch through it is safe.
2. Skill/node schema compatibility check false-blocks any skill `outputSchema` beyond bare `{"type":"object"}` (R-2). Current skills are flattened to work around it.
3. `update_node_output_schema`/`_input_schema` reject client-stringified JSON args (R-3); use `workspace_update_node` instead.
4. ~~Version conflicts surface as untyped `-32603`~~ **FIXED (R-4, wave 3)** — failures now carry a `code` plus details, conflicts report `currentVersion`/`currentRevisionId`, and the JSON-RPC message leads with the code instead of one constant sentence.
5. `skill_resolve_for_node` and `node_get_effective_tools` disagree on effective tools for some nodes (R-5).
6. `article_body_validate`/`article_body_get_schema` are a drifted local schema — **never trust them**; the client's `object_validate` is the authority (R-6 retires them).
7. ~~No CI (R-0)~~ **FIXED (wave 1)** — GitHub Actions runs typecheck, both suites, both builds, and a two-plane drift detector on every push. 742 root + 55 ui tests.
8. `constellation.get_attention` returning `[]` against real defects (R-10) — **FIXED (wave 3)**; it now reports skill blockers, denied skill tool requests, dependsOn/requiredInputs disagreements, ungrantable tool grants, and unconfigured client connections.

## 5. What a fresh session should do

1. Read `docs/plan/SESSION-BRIEF.md` (state + model guidance + rings) and `docs/plan/CHANGE-PLAN.md` (the work, by ID).
2. Ask Wolf which plan IDs are approved/next, or check the change ledger (`changes_list`) for what has landed since this handoff.
3. Verify plane state before acting: `repository_get_health` (expect `gcs`, v≥69), `workspace_validate_graph`, `constellation_get_attention`, `project_list`.
4. Immediately startable without ENV: R-0 (CI), R-11 read-only (S4 inspector), W-2, W-3. Deliver repo changes as a patch-series zip (no push access).

**Wave 1 ran 2026-07-26** (`docs/plan/CHANGE-PLAN.md` §2b): W-3 done (workspace **v70**), W-2 partial (both records disabled; snoocle de-seeded in the repo patch; **monetizer kept** — `feedback.ingest_monetizer` depends on it), R-0 done (CI + two-plane drift detector, 136-tool manifest), R-11 read-only done. Suite: 707 root + 55 ui tests, green.
**Wave 2 ran 2026-07-27**: W-1 (platform = client 0, deny-by-default + 5 read-only contract tools) and T-1 (Tiers 0–3, **GO**). Bug-list updates from it: bug 2 (R-2) is no longer *blocking* anything — no blocker-severity skill conflict survives; the T2.6 finding grew from 1 node to **14** (all carrying an ungrantable `stage.save_output`, harmless to execution but the noise that hid the real defect); and `project.create` does not bump `workspaceVersion`, so drift checks keyed on it are blind to connection changes.
**Wave 3 ran 2026-07-27**: R-4, R-1, R-10 and the T2.6 cleanup (live workspace **v84** plus the seeded code defaults). See CHANGE-PLAN §2d.
Standing habit earned the hard way, twice: **after any workspace-data fix, check whether the code-defined defaults carry the same defect.** snoocle and the 14 ungrantable tool grants were both re-seeding traps — the data write looks complete and the next fresh workspace undoes it.

Deep background per topic: `docs/plan/findings/` (migration, image pipeline, contract alignment, tool bugs, voice object, fleet alignment, self-describing engine) and `docs/plan/GUI-PLAN.md` / `TEST-PROTOCOL.md`.
