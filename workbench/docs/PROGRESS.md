# Conductor Workbench — PROGRESS

Runner: Opus session (Cowork), started 24 Aug 2026.
Spec: `spec/mockup.html` (executable spec) · `spec/proposal.html` (rationale) · `spec/HANDOFF.md` (contract).
App root: `app/`.

## Standing decisions (§9 answered by default — Wolf to confirm)

Wolf instructed: "Run this entire development on your own and stop only when absolutely required or finished."
Therefore the five §9 questions are answered with the safest defaults and flagged for confirmation:

| # | Question | Default taken | Reversal cost |
|---|---|---|---|
| 1 | MCP endpoint URL + auth for dev build | Not supplied → **fixtures-first throughout**. `VITE_MCP_URL` is read from env at runtime; unset ⇒ `VITE_MOCK=1` behaviour. Live smoke deferred. | Set one env var. |
| 2 | Deploy target for dev builds | Static SPA build (`app/dist`), Netlify-ready, zero Netlify coupling. Not deployed by this session. | Redeploy. |
| 3 | May Phase 2 mutations hit production? | **No.** `VITE_READ_ONLY` defaults to **1**. All mutating verbs are blocked at the `confirmAction` layer until Wolf flips it. | Set env var to 0. |
| 4 | Legacy-retirement list (WP-43) | List **enumerated, nothing removed.** Removal awaits Wolf's sign-off. | n/a |
| 5 | Blind-mode default in Compare | **Blind on, reveal after verdict** (proposal's recommendation). | Toggle in UI. |

## Architecture notes
- Tokens + base CSS extracted **verbatim** from `mockup.html` (lines 5–32 → `tokens.css`, 33–280 → `base.css`). Class vocabulary is the design system; components consume it, they do not restyle it.
- Deps: react, react-dom, @tanstack/react-query, zustand, @playwright/test. No others without a note here.

## Work package status
(updated as WPs land)

## Phase 0 — complete
- **WP-01** (shell, tokens, store, primitives, TopBar) — done. Tokens/base CSS lifted verbatim from the mockup; no new CSS has been written anywhere in this project since.
- **WP-02** (fixtures) — done, and **sourced from the live workspace (v651) rather than the mockup's constants.** See `app/src/api/fixtures/README.md` for per-file provenance.
- **WP-03** (data layer) — done. 82/82 HANDOFF §6 verbs typed and covered; fixture mode default-on; TanStack hooks; `confirmAction` gate.
- **WP-04** (auth + MCP credential broker) — **NEW SCOPE**, added on Wolf's instruction that user auth and MCP credential assignment are part of this project. `server/` — 39 tests passing.

### Deviation from HANDOFF §3 (recorded as the handoff requires)
§3 sketched `client.ts` as a direct MCP Streamable-HTTP wrapper holding the session header. That cannot satisfy §3's own absolute rule ("Secrets: none in the UI, ever") once real credentials exist, because a static SPA cannot hold a bearer token safely. **The MCP protocol therefore moved server-side into the WP-04 broker**; `client.ts` stays a thin fetch wrapper, but its transport target is `/api/mcp` on the broker. Consequences, all favourable: read-only mode becomes a *server-enforced* guarantee rather than a client-side courtesy; unknown verbs are default-denied; the token exists only in one outbound header server-side.

## What the live workspace disagrees with the mockup about (findings, not bugs)
These came out of building against real data and are worth Wolf's eye:
1. **`clone_conductor` has 9 nodes live, not 8.** An undocumented `fit_adjudicator` runs between `theme_bind` and `layout_restamp` in every live clone run.
2. **`workspace_get_graph` / `get_nodes` / `get_node` only ever return publishing_conductor's 23 nodes.** Clone and capture topology is invisible to those verbs despite both workflows running daily. The UI cannot show real node facts for 20 of 43 nodes until the workspace exposes them.
3. **Skill assignments differ substantially from the mockup**, and 5 registered skills (`article_body_builder`, `artifact_handling`, `editorial_review`, `publication_readiness`, `learning_observation`) are assigned to **zero** nodes live.
4. **No per-node timing data exists** — `node_list_executions` returns `durationMs: null` throughout, so the dock's timeline is currently a deterministic placeholder, not real data. Flagged rather than faked.
5. Project tool-policy counts, tool registry size (42, not 10) and run volume (39, not 15) all differ from the mockup's hand-drawn values. The UI uses the real numbers everywhere.

## Phase 1 — complete (WP-R1 gate passed)
- **WP-11/12** workbench rail + centre inspector (9 tabs, read-only) + read-only dock — done.
- **WP-13/14** Runs: Live / History / Grid — done.
- **WP-15** Workflows library — done.
- Gate: `npm run build` green; **8/8 Playwright specs pass**; screenshots reviewed in both themes.
- Review findings fixed: leftover mockup footer copy ("mockup — …no new server work required") replaced with a truthful live/pinned statement.
- **What the real grid reveals:** `publication_controller` is the chronic stopping point — 18 of 39 runs are blocked, 6 failed. Most runs are not failing, they are waiting on a human approval that had nowhere to happen. That is the single strongest argument for the gate panel, which is Phase 2's WP-23.

## Recorded deviations from the mockup

### `.btn.pri` is no longer amber (WP-R gate — a11y/design review, 2026-08-24)

`spec/mockup.html:84` defines `.btn.pri{background:var(--acc-soft); border-color:var(--acc-dim); color:var(--acc);}` — the accent (amber) color, applied verbatim in `tokens.css`/`base.css` since WP-01. The design review's §7 checklist scored this a **Fail**: §7.8 requires "one accent colour (amber) reserved for attention/gates — semantic status colours never reused decoratively," but `.btn.pri` made amber the default color of every ordinary primary action in the app (Save, Start run, Promote, Sign in, Run regression now, verdict buttons, …) — the exact opposite of reserving it.

**Change:** `.btn.pri` is now a neutral ink fill (`background:var(--ink); color:var(--bg)`, lightening to `var(--muted)` on hover) — clearly primary (highest-contrast button on the page) without borrowing the attention color. Nothing else changed: `.btn.danger` (red) still marks irreversible/high-stakes actions — the Dock's "Approve & resume" gate button and StartRunModal's live-run Start were already `danger`, not `pri`, so they were never amber to begin with. Amber itself is untouched everywhere it's actually semantic: the gate card (`.gate`), blocked chips/dots/badges, focus rings, the wordmark, and the "GATE" panel border/label all still read amber, so a blocked run still visually outranks every ordinary screen in the app — if anything more clearly, now that amber isn't also the color of a dozen unrelated buttons.

**Why this wins over matching the mockup:** §7.8 is an explicit WP-R acceptance criterion, and the mockup shipped the same contradiction the criterion exists to catch (its own `spec/proposal.html` states the "gates and risk are visible form" principle that `.btn.pri` violates). Given a straight choice between reproducing `mockup.html` verbatim and meeting the acceptance criterion it was itself supposed to satisfy, the criterion wins. This is a one-token CSS change (plus a matching `:hover` rule) — no JSX/component changes were needed, since every existing `variant="pri"` vs. `variant="danger"` call site was already correctly assigned by risk level.

### `--acc`/`--ok` get darker text-only variants for two badges (a11y S2)

`.risk.publish` and `.pin.live` render `--acc`/`--ok` as small (9.5–10px) text on a light tint of the same color. Computed WCAG contrast (see `A11Y-REVIEW.md`'s table) showed both failing 4.5:1 in light mode (3.46:1 and 4.07:1) — and raising the tint percentage, the review's suggested fix, actually *lowers* contrast further (it moves the background toward the text's own color). The real fix needed a darker text color for just these two badges: new `--acc-ink`/`--ok-ink` tokens, aliased to `--acc`/`--ok` in dark mode (already passing there) and darkened only in light mode (verified 4.94:1 and 4.81:1 against their own tinted backgrounds). `.gate .lbl` had the identical problem (`--acc` on `--acc-soft`, 3.58:1) and got the same `--acc-ink` fix for the same reason, even though the review's S1 finding didn't name that specific rule.

## Phase 3/4/5 — complete
- **WP-31..34** node editing: prompt editing with diff-vs-canonical and an effective-prompt preview that visually separates skill injections from playbook lessons; tools/skills pickers with risk shown at the moment of granting; schema editors refusing bad input with path-specific reasons; change history with diff and restore.
- **WP-41** Registry: projects (live tool-policy bars), keys (presence/source only — the screen contains zero input elements, asserted as a security property), the full 42-tool registry grouped into 13 namespace families, skills (flagging the 5 assigned to nothing), agents, usage.
- **WP-42** Command palette on a scored fuzzy matcher — every one of the 43 nodes verified reachable in ≤3 keystrokes + Enter — plus the graph overlay (`G`), which states the honest gap rather than faking a graph for clone/capture.
- **WP-44 (new scope)** Login gate, session identity, Log out, a persistent read-only/read-write indicator, and mid-session 401 recovery.
- **WP-51..54** Learning: flywheel with live counts, observations → curation, playbooks with rendered injection, Compare A/B (ten keyboard verdicts measured at **315ms** against a 20s budget), evaluate + regression watchboard, optimizer, datasets, plus the per-node Learning tab and run-output capture buttons.

## WP-R5 — final review
Ran the `spec/HANDOFF_1.md` §3.1 review skills:
- **`design:accessibility-review`** → `A11Y-REVIEW.md`. 24 findings with a real computed contrast table. All 5 Critical and 8 Serious fixed, plus the Moderate/Minor set. Worst defect was the toast container having no `role`/`aria-live` — every async outcome in the app was silent to assistive tech. Regression tests added for that and for palette focus.
- **`design:design-critique` + `design:ux-copy`** → `DESIGN-REVIEW.md`. §7 scored 7 Pass / 2 Partial / 1 Fail; the Fail (amber used for every primary button) is fixed and recorded above. Copy defects fixed: mock-only claims that would become false against the live endpoint, gate summaries that said "publish decision" for non-publish gates, and **test residue that had leaked into fixture-visible content**.
- **`web-artifacts-builder`** was evaluated for the HANDOFF_1 §3 stack pivot and deliberately not adopted — see "Stack decision" below.

**Final state: `npm run build` green (app + server). 46/46 Playwright specs passing across 12 spec files. 39 server unit tests passing.**

## Stack decision (HANDOFF_1 §3)
The updated handoff moves the stack to Tailwind + shadcn/ui. Assessed and **not adopted**, on Wolf's "if easier to deliver first, do not alter" instruction. Reasoning:
- The updated §3 states shadcn supplies component *behaviour*, never its look, and that a stock-shadcn screen is a review failure — so the pivot changes the substrate, not the product.
- Surface area: 48 component files, 527 `className` usages bound to the mockup's class vocabulary, 12 spec files asserting that DOM. A view-layer rebuild, not a swap.
- `web-artifacts-builder` targets a single bundled HTML artifact (Parcel → `bundle.html`), which is wrong for this app: cookie-based auth against the broker needs a real origin and an env-configured API base.
- **The value shadcn was cited for — focus management, keyboard nav, ARIA — was captured directly instead**, via the accessibility pass above.

**If Wolf wants the migration anyway**, the sane scope is the eight interactive primitives (Dialog, Tabs, Command, Select, Tooltip, Sonner, Progress, ScrollArea) under the existing CSS. HANDOFF_1 §3 already exempts the rail, run grid, timeline, flywheel stages, Compare split-screen, gate panel and policy bars as custom-built, so those would not move.

## Still open — needs Wolf
1. **MCP endpoint + credentials for a real deploy.** Everything runs on fixtures today. Set `CMS_AGENT_MCP_URL` / `CMS_AGENT_MCP_TOKEN` on the broker and the app talks to the live workspace — a config change, not a code change.
2. **`READ_ONLY=0`** — mutations are server-blocked until Wolf flips it. §10's end-to-end dry-run trace (start → pause → resume → gate decision → cancel/reset) cannot be executed until then.
3. **The legacy-retirement list** — `RETIREMENT.md`, nothing removed pending sign-off. It found two live capabilities with **no home in the new UI** (see that document).
4. **Multi-operator**: the broker hardcodes one operator identity; a second user would be indistinguishable from the first. Noted, not built.
