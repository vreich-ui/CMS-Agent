# Conductor Workbench — Development Handoff

**To:** the Opus runner session orchestrating this build
**From:** the design session (Claude, Cowork), 24 Aug 2026
**Owner:** Wolf (single operator; final authority on all decisions)
**Companion files (attach both to your session):** `proposal.html` (the design rationale), `mockup.html` (the executable visual spec)

---

## 0. What you are building and why it exists

A single-operator console — "Conductor Workbench" — replacing the current constellation-centric UI of the CMS agent workspace. The full rationale is in `proposal.html`; the finished look, layout, palette, copy tone, and interaction model are in `mockup.html`, which runs standalone in any browser. **The mockup is the spec.** Design decisions are already made; do not re-litigate them in sub-sessions.

The backend already exists: a Netlify Streamable-HTTP MCP endpoint (`CMS_Agent`) exposing ~150 tools over the workspace running on Google Cloud. Every UI capability maps to an existing verb (the mapping table is in §6). **No backend work is in scope.** The UI is a thin client.

Non-negotiable quality bar, from Wolf directly: **intuitiveness, ease, and clarity outrank feature count.** A smaller UI that is instantly legible beats a complete UI that needs explaining. Every review gate below enforces this.

## 1. Your role as runner (Opus)

You orchestrate; you do not write bulk code. Your token spend should be roughly **10–15% of the project** — plans, reviews, integration decisions, and unblocking. If you find yourself writing components, delegate instead.

Responsibilities:

1. Maintain `PROGRESS.md` at repo root: work-package status, decisions made, open questions for Wolf.
2. Dispatch one work package (WP) per sub-session, with the exact inputs listed for it in §5 — never "here is the repo, figure it out."
3. Review each WP against its acceptance criteria and the UX checklist (§7), primarily from **screenshots** (both themes) and the build/test output, reading code only where the screenshots or diffs raise questions.
4. Grant at most **one revision cycle** per WP to the same builder session; if it fails twice, escalate the WP to yourself or split it smaller.
5. Ask Wolf (do not guess): anything in §9.

Rules that keep cost down without hurting quality:

- A sub-session gets only the files it needs: the relevant mockup sections, the token stylesheet, the files it will touch, and its WP text. Never the whole repo, never the whole proposal.
- Sub-sessions copy markup/CSS patterns from `mockup.html` rather than inventing their own. Reusing the mockup's class vocabulary and tokens is the single largest cost and consistency saver in this project.
- No speculative abstractions, no component libraries, no CSS framework migrations, no state-management frameworks beyond what §3 prescribes. Refuse "while I'm here" refactors.
- Verify cheap-first: build green → Playwright smoke screenshots → your visual review. Never spend your own tokens on what a script can check.
- Commit per WP with a message naming the WP id. Small, revertable steps.

## 2. Model assignments for sub-sessions

| Model | Use for | Never use for |
|---|---|---|
| **Opus** (you) | Planning, WP dispatch, screenshot/diff review, integration decisions, WP-R review gates, anything twice-failed | First-pass feature code |
| **Sonnet** | All feature work packages (default builder) — components, data layer, interactions, wiring | — |
| **Haiku** | Mechanical, fully-specified work: fixtures from provided JSON, token/CSS extraction, icon sprite, table renderers where the mockup shows the exact result, test boilerplate, PROGRESS.md upkeep | Anything involving layout judgment, interaction design, API semantics, or error handling |

Guideline split of total tokens: Opus ≤15%, Sonnet ~65%, Haiku ~20%. When unsure between Haiku and Sonnet, ask: "is the correct output fully determined by the spec I'm handing over?" Yes → Haiku. Any judgment required → Sonnet. Quality is the priority; Haiku is a tool for the boring parts, not a target quota.

## 3. Prescribed architecture (do not reopen)

- **Stack:** Vite + React + TypeScript. Plain CSS with custom properties — **extract the mockup's `:root` token system verbatim into `src/styles/tokens.css`** (light on bare `:root`, dark under `@media (prefers-color-scheme: dark)` guarded with `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`; theme toggle cycles auto → light → dark, persisted to localStorage in try/catch). Keep the mockup's class vocabulary (`.card`, `.nrow`, `.chip`, `.risk`, `.gate`, `.lbl`, etc.) as the design system.
- **Fonts:** Google Fonts — Spectral (600, wordmark/page titles only), IBM Plex Sans (400/500/600, UI), IBM Plex Mono (400/500, ids/data/labels). Real fallback stacks.
- **State:** TanStack Query for server state (every MCP verb call), one small Zustand store for UI state (current workflow, bound run, selected node, active tab, theme). Nothing else.
- **Data layer:** `src/api/client.ts` — a thin fetch wrapper for the MCP Streamable-HTTP endpoint (initialize once, carry the `Mcp-Session-Id` header, `tools/call` for everything). `src/api/verbs.ts` — one typed function per verb in §6. **`src/api/fixtures/`** — JSON fixtures mirroring real responses (source them from the data embedded in `mockup.html`), and a `VITE_MOCK=1` mode that serves fixtures instead of the network. All Phase 1–2 UI work builds against fixtures; live wiring is its own WP.
- **Safety:** all mutating verbs (`workflow_*` controls, `workspace_update_*`, `optimizer_promote`, decisions) go through a single `confirmAction()` wrapper that names the verb and its effect. Read verbs never confirm. A `VITE_READ_ONLY=1` flag disables all mutations for early deploys.
- **Testing:** one Playwright smoke spec per surface: renders in both themes, primary interaction works, screenshot saved to `shots/`. No unit-test suite beyond this — the smoke specs are the regression net and your review medium.
- **Hosting:** static SPA output; deployable to Netlify today, moved to GCloud later by redeploy. No coupling either way.
- **Secrets:** none in the UI, ever. The client talks to the endpoint; tokens stay in env on the server side. The Keys screen displays presence/source only (as in the mockup).

## 4. Phasing (matches the proposal; each phase ends with a review gate)

- **Phase 0** — scaffold, tokens, shell, data layer with fixtures.
- **Phase 1** — read-only workbench + runs (highest value, zero risk). Ships as the daily driver.
- **Phase 2** — run controls, start-run modal, gate panel (mutations begin; `confirmAction` mandatory).
- **Phase 3** — node editing with live/pinned truth-telling, validate-before-save, history/diff.
- **Phase 4** — registry + command palette + legacy retirement.
- **Phase 5** — learning surfaces (flywheel, observations→playbooks, Compare A/B, evaluate, optimizer, datasets) + node Learning tab.

## 5. Work packages

Format: **WP-id · model · depends-on** — scope. *Inputs to hand the sub-session.* **Done when.**

### Phase 0

**WP-01 · Sonnet · —** Scaffold Vite+React+TS; extract `tokens.css` and base element styles from `mockup.html` (both themes + toggle); app shell: top bar (wordmark, nav, workflow switcher with icons + short descriptions, theme toggle, ⌘K stub), screen router. *Inputs: mockup.html; §3.* **Done when:** shell renders in both themes; switcher lists the three conductors + planned fourth with icons; Playwright smoke passes.

**WP-02 · Haiku · WP-01** Fixtures: extract the `WORKFLOWS/NODES/PROJECTS/RUNS/TOOLS/SKILLS/OBS/RUBRICS/DATASETS` data objects from `mockup.html` into `src/api/fixtures/*.json`, one file per store, valid JSON, no invention. *Inputs: mockup.html script section only.* **Done when:** fixtures import cleanly and a checksum table in the PR message lists counts (23/8/11 nodes, 15 runs, 8 observations, 5 rubrics, 6 datasets).

**WP-03 · Sonnet · WP-02** Data layer: MCP client (session header lifecycle, error normalization), typed verb functions for §6 read verbs, TanStack Query hooks, `VITE_MOCK` fixture mode. *Inputs: §3, §6, fixtures dir, client file if exists.* **Done when:** a demo page lists workflows and runs from fixtures; switching `VITE_MOCK` off targets the real endpoint (untested against prod is acceptable here).

### Phase 1 — read-only workbench + runs

**WP-11 · Sonnet · WP-03** Node rail + workbench frame: phase-grouped topological rail, status dots, dim/hide unengaged toggle, Build/Run mode bar, selection state, bound-run chip in top bar. *Inputs: mockup workbench section, fixtures, shell files.* **Done when:** matches mockup in both themes; keyboard up/down moves selection; run binding dims unengaged nodes.

**WP-12 · Sonnet · WP-11** Center inspector, read-only tabs: "This run" (execution record, tool calls, output preview, gate/error cards), Prompt (read-only view + diverged badge), Tools, Skills, Schemas, Model & limits, Dependencies (pinned notice verbatim from mockup), History (list only). *Inputs: mockup center section, fixtures, WP-11 files.* **Done when:** every tab renders for `publish_executor`, `draft_writer`, `theme_bind`; empty states present; no dead controls (buttons not yet functional render disabled with tooltip "Phase 2/3").

**WP-13 · Sonnet · WP-03** Runs surface: Live cards (with stall badge slot), History table with the three filters, row → binds run and opens workbench. *Inputs: mockup runs section, fixtures.* **Done when:** filters compose; row click lands on the workbench with that run bound and its stopped node selected.

**WP-14 · Sonnet · WP-13** Grid view: runs × nodes matrix per workflow, status-colored cells, cell click binds that run, column headers rotated as in mockup, horizontal scroll contained. *Inputs: mockup grid section, fixtures.* **Done when:** publishing conductor grid reproduces the mockup's readable regression story pixel-close in both themes.

**WP-15 · Haiku · WP-03** Library screen: workflow cards with icon, one-line function, description, stats, last-run chip, planned card; two buttons wired to existing routes. *Inputs: mockup library section, fixtures.* **Done when:** visual match, both themes.

**WP-R1 · Opus** Phase review: run all smokes, review screenshots against §7, file revision notes per WP (max one cycle each). Deploy a read-only build for Wolf.

### Phase 2 — run control

**WP-21 · Sonnet · WP-R1** Run dock + controls: bound-run card, progress, cost vs budget, pause/resume/cancel/reset/retry/run-next/run-until wired through `confirmAction` to their verbs; optimistic status updates with rollback on error; timeline bars from real `durationMs`. *Inputs: mockup dock section, §6 control verbs, WP-11/12 files.* **Done when:** each control fires the right verb in mock mode (verb name asserted in smoke test), disabled states match run status.

**WP-22 · Sonnet · WP-21** Start-run modal: workflow/project/execution/dry/budget/brief, project connection health inline, input validated via `node_validate_input` before enabling Start; launches `workflow_start_dry_run` and binds the run. *Inputs: mockup modal, §6.* **Done when:** invalid input blocks with a reason; started run appears bound.

**WP-23 · Sonnet · WP-21** Gate panel: blocked-run detection, gate copy per gate node, readiness evidence viewer (`workflow_publish_readiness`), approve/decline via `workflow_set_operator_publish_decision` + resume. This is publish-risk UI — clarity over brevity; the panel must always answer "why is this stopped and what happens if I click." *Inputs: mockup gate, §6.* **Done when:** the three real gate cases (theme_bind, publication_controller, publish_executor) each render correct copy and actions.

**WP-R2 · Opus** Phase review as WP-R1, plus: manually trace every mutating path to confirm `confirmAction` coverage and that read-only flag disables all of them.

### Phase 3 — node editing

**WP-31 · Sonnet · WP-R2** Prompt editing: editable prompt with save (`workspace_update_node_prompt`), diff vs canonical (`changes_compare`), effective-prompt preview (`node_get_effective_prompt`) showing skill + playbook injections distinctly. *Done when:* save → History gains an entry (fixture-simulated); effective preview visibly distinguishes injected content.

**WP-32 · Sonnet · WP-31** Tools & skills editing: add/remove from registry pickers with risk badges (`workspace_update_node_tools/skills`), effective-skills resolution view. *Done when:* pickers read the registry fixture; approval-requiring tools flagged.

**WP-33 · Sonnet · WP-31** Schemas + model config: JSON editors with `workspace_validate_node` before save (blocking errors shown inline at the offending path), model & limits form. *Done when:* an intentionally broken schema is refused with a legible reason.

**WP-34 · Sonnet · WP-31** History: full change feed with diff and restore (`changes_list/compare/restore`), restore confirms and refreshes the editor. *Done when:* diff renders added/removed lines in the mockup's diffline style.

**WP-R3 · Opus** Phase review + the "truth-telling" audit: every field in every editor tab carries live or pinned marking, and pinned fields name the re-seed step.

### Phase 4 — registry, palette, retirement

**WP-41 · Haiku · WP-R2** Registry read screens: projects (policy bars, test-connection button), keys (presence/source only), tools, skills, agents, usage — tables/cards exactly as mocked. *Done when:* visual match both themes.

**WP-42 · Sonnet · WP-41** Command palette: index of nodes, runs, workflows, projects, screens, actions; fuzzy filter; keyboard complete; the graph-overlay stub (G) opens a read-only rendering of `workspace_get_graph` (simple layered DAG or the constellation view embedded — cheapest correct option; it is an overlay, not a screen). *Done when:* ⌘K reaches any node in ≤3 keystrokes of typing + Enter.

**WP-43 · Opus (decision) + Haiku (execution)** Legacy retirement list: enumerate old-UI surfaces to retire, confirm list with Wolf, remove/redirect. *Done when:* Wolf signs off the list.

### Phase 5 — learning

**WP-51 · Sonnet · WP-R2** Flywheel + observations + playbooks: stage counts from live stores, observation feed with curate → `playbook_curate` flow (lesson draft pre-filled from the observation, operator edits, budget shown), playbook viewer with rendered injection. *Done when:* curating an observation (mock) moves the flywheel counts and the lesson appears in the node's Learning tab.

**WP-52 · Sonnet · WP-51** Compare (A/B): pairwise split screen for text/template/image candidates, keyboard 1/2/0/x, blind mode, verdict → `feedback_record` + preference pair, visible 200-pair meter, queue plumbing from trials/candidates/manual pick-two-outputs. Interaction quality matters most here — verdicts must feel one-keystroke cheap. *Done when:* ten verdicts take under twenty seconds by keyboard alone.

**WP-53 · Sonnet · WP-51** Evaluate + optimizer + datasets: rubric list/editor (versioned), regression watchboard with baseline/verdict, optimizer proposals with prompt diff + trial scores + promote/auto-promote/shadow actions, datasets list with replay action, fine-tune meters. *Done when:* the contract_intelligence held-gate story reads exactly as in the mockup.

**WP-54 · Sonnet · WP-51** Node Learning tab wiring into the workbench (playbook lessons, observations mentioning node, rubric status, readiness meters) + run-inspector capture buttons (approve/reject/edit-and-approve/record-observation → `feedback_record`/`learning_record_observation`). *Done when:* capture actions appear on every completed node output and name their verb.

**WP-R5 · Opus** Final review: full-app screenshot pass both themes, UX checklist, cost report to Wolf, live-endpoint smoke (read verbs) if Wolf provides the endpoint.

## 6. Verb map (UI action → MCP tool)

Read: `workspace_get_graph`, `workspace_get_nodes`, `workspace_get_node`, `workspace_get_node_effective_config`, `node_get_effective_prompt/skills/tools`, `node_get_input_schema/output_schema`, `workflow_list_runs`, `workflow_get_run`, `workflow_get_run_context`, `workflow_get_run_cost`, `node_list_executions`, `stage_list_outputs`, `stage_get_output`, `changes_list/get/compare`, `project_list`, `project_test_connection`, `tool_list`, `skill_list`, `skill_resolve_for_node`, `agent_list`, `usage_get_summary`, `usage_get_budget_status`, `learning_list_observations`, `playbook_get`, `evaluation_list_rubrics/results/regression_reports`, `dataset_list`, `dataset_finetune_readiness`, `feedback_list`, `optimizer_status`, `repository_get_health`.

Mutating (always `confirmAction`): `workflow_start_dry_run`, `workflow_run_all/run_next_node/run_until/run_node`, `workflow_pause_run/resume_run/cancel_run/reset_run/retry_node`, `workflow_set_operator_publish_decision`, `workflow_publish_run` (Phase ≥2 only, extra confirm), `node_validate_input` (read-shaped, no confirm), `workspace_update_node_prompt/tools/skills/model_config/input_schema/output_schema/metadata`, `workspace_validate_node` (no confirm), `changes_restore`, `skill_update/assign/unassign/restore_version`, `learning_record_observation/archive_observation`, `playbook_curate/apply_delta/migrate_observations`, `feedback_record`, `evaluation_create_rubric/update_rubric/run/run_regression/restore_rubric_version`, `optimizer_analyze/propose/run_trial/promote/auto_promote`, `dataset_build/export_sft/export_preferences`.

Known live-data facts sub-sessions may rely on: 3 workflows (23/8/11 nodes); 6 projects; run statuses include `queued running paused completed failed blocked cancelled skipped`; runs carry `currentNodeId`, `mode.executionMode` (`openai`/`mock`), `dryRun`, per-node `startedAt/completedAt/durationMs`, `stall` on running rows; prompt/tools/skills/schemas/model-config edits are live via store overlay while topology/riskLevel are seed-pinned (surface this exactly as the mockup does).

## 7. UX acceptance checklist (applied by Opus at every WP-R gate)

1. **Two-click rule:** any node attribute of the active workflow reachable in ≤2 clicks from the workbench; anything in the app in ≤3 or via ⌘K.
2. **Blocked is never a dead end:** every blocked/failed state names the cause and offers the next action on the same screen.
3. **Actions say what they do:** buttons name the outcome; confirms name the verb and effect; toasts confirm in past tense. No icon-only mutating controls.
4. **Truth about editability:** every editable surface marks live vs pinned; pinned explains the re-seed path.
5. **Empty states teach:** each empty panel says what fills it and links there (the learning surfaces especially).
6. **Both themes, every screen:** no color defined only in one theme; screenshots reviewed in both.
7. **Keyboard:** palette, rail navigation, Compare verdicts, Escape closes overlays; visible focus states.
8. **Density without noise:** tabular numbers aligned, ids in mono, one accent color (amber) reserved for attention/gates — semantic status colors never reused decoratively.
9. **Nothing pretends:** controls not yet wired render disabled with a phase tooltip, never as silent no-ops.
10. **Latency honesty:** every network-backed panel has loading and error states; errors show the backend's own message.

## 8. Cost-control summary (the contract you enforce)

- Mockup-first: copy, don't redesign. Deviation from the mockup requires a note in PROGRESS.md and is a review flag.
- Fixtures-first: no live endpoint until WP-R1 passes; live wiring is a config flip, not a rewrite.
- One WP per sub-session; minimal input set; no repo-wide reads; one revision cycle max before escalation.
- Haiku for the deterministic, Sonnet for judgment, Opus for review — see §2 split targets.
- Playwright smokes are the regression net; you review screenshots, not codebases.
- No new dependencies beyond §3 without your explicit approval recorded in PROGRESS.md.

## 9. Ask Wolf before proceeding (do not assume)

1. The MCP endpoint URL + auth arrangement for the dev build (and whether a staging workspace exists, or read-only against production is preferred for Phase 1).
2. Where to deploy dev builds (Netlify now, GCloud later was the stated direction — confirm).
3. Whether Phase 2 mutating verbs may target production runs or should stay behind `VITE_READ_ONLY` until he flips it.
4. The legacy-retirement list (WP-43) before anything is removed.
5. Blind-mode default in Compare (proposal recommends blind with reveal-after-verdict).

## 10. Definition of done (project)

All phases reviewed through WP-R5; every checklist item in §7 passing on every surface; live read-verbs verified against the real workspace; mutating verbs verified against at least one dry run end-to-end (start → pause → resume → gate decision → cancel/reset); PROGRESS.md complete with decisions log and final cost report; Wolf has driven a real triage session (open blocked run → understand → act) without asking a question the UI failed to answer. That last sentence is the actual acceptance test.
