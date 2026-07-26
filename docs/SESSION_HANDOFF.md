# CMS-Agent — Session Handoff

_Handoff for a fresh session. Repo: `vreich-ui/CMS-Agent`. Supersedes the 2026-07 MCP-hardening handoff._
_Written 2026-07-26 after the audit/alignment session. **Read `docs/plan/SESSION-BRIEF.md` first, then `docs/plan/CHANGE-PLAN.md`.**_

---

## 1. TL;DR

The workspace was audited end-to-end, aligned around one principle — **the client's live contract is the only content truth, fetched at runtime** — and a governing change plan was written. The canonical control plane is **Cloud Run + GCS** (workspace v69, graph valid). The Netlify plane is a frozen archive. The image pipeline (storage grant → pdf-tool → client blob → verified ArtifactReference) is **proven working live**. Six nodes and six skills were rebuilt contract-driven; every change is in the workspace change ledger under actor `cowork-alignment` / `cowork-migration`.

**All further work is governed by `docs/plan/CHANGE-PLAN.md` — 25 items with IDs (ENV/W/R/P/T) and a dependency spine. No code or MCP changes outside approved plan items.**

## 2. Standing blockers (nothing client-facing works until these)

Cloud Run env vars, set by Wolf manually (values live in Netlify site config; they never pass through MCP):
`DR_LURIE_MCP_ENDPOINT/_TOKEN` (ENV-1) · `PDF_TOOL_MCP_ENDPOINT/_TOKEN` (ENV-2) · `PLATFORM_MCP_ENDPOINT/_TOKEN` (ENV-3).
Verify with `project_test_connection` — it fails closed, which is correct.

## 3. The client model

- **platform** = client 0 — canonical; its site is the self-README; conformance target; first live publish (T-3) publishes *engine docs* there.
- **dr-lurie** = client 0001 — first real publication. Publishing stays triple-locked (policy + draft executor + pinned approval) until T-4.
- **pdf-tool** = **service (Ring 0), never delete, never agent-reconfigurable** — it is the artifact engine, called via `project.call_tool`.
- **snoocle / monetizer** = fake registrations, delete (W-2).

Protection rings (ratified): Ring 0 services — publishing agents may call, never reconfigure; Ring 1 client connections — adjustable behind `needs_approval`; Ring 2 method (nodes/prompts/skills) — the agents' editable surface, ledgered. Enforcement is R-7/R-7b.

## 4. Known bugs — read before touching anything

1. **`workspace_update_node_tools/_skills/_dependencies/_metadata/_model_config` silently wipe fields omitted from the patch** (return `ok:true` while destroying data). **Use full `workspace_update_node` patches only** until R-1 lands.
2. Skill/node schema compatibility check false-blocks any skill `outputSchema` beyond bare `{"type":"object"}` (R-2). Current skills are flattened to work around it.
3. `update_node_output_schema`/`_input_schema` reject client-stringified JSON args (R-3); use `workspace_update_node` instead.
4. Version conflicts surface as untyped `-32603` (R-4); the real detail is nested in `error.data`.
5. `skill_resolve_for_node` and `node_get_effective_tools` disagree on effective tools for some nodes (R-5).
6. `article_body_validate`/`article_body_get_schema` are a drifted local schema — **never trust them**; the client's `object_validate` is the authority (R-6 retires them).
7. No CI (R-0). 94 tests exist; nothing runs them automatically.

## 5. What a fresh session should do

1. Read `docs/plan/SESSION-BRIEF.md` (state + model guidance + rings) and `docs/plan/CHANGE-PLAN.md` (the work, by ID).
2. Ask Wolf which plan IDs are approved/next, or check the change ledger (`changes_list`) for what has landed since this handoff.
3. Verify plane state before acting: `repository_get_health` (expect `gcs`, v≥69), `workspace_validate_graph`, `constellation_get_attention`, `project_list`.
4. Immediately startable without ENV: R-0 (CI), R-11 read-only (S4 inspector), W-2, W-3. Deliver repo changes as a patch-series zip (no push access).

Deep background per topic: `docs/plan/findings/` (migration, image pipeline, contract alignment, tool bugs, voice object, fleet alignment, self-describing engine) and `docs/plan/GUI-PLAN.md` / `TEST-PROTOCOL.md`.
