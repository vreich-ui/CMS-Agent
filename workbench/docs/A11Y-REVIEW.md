# WCAG 2.1 AA Accessibility Review — Conductor Workbench

**Scope:** WP-R5 gate item, `spec/HANDOFF_1.md` §3.1. Read-only audit — no application code changed.
**Reviewed:** `app/src/styles/tokens.css`, `app/src/styles/base.css`, every component under `app/src/components/`, every screen under `app/src/screens/`. Verified live against `npm run dev` (fixture mode, port 5173) with Playwright/Chromium for focus behavior, computed styles, and DOM state; verified against the app's own committed token values for contrast math (script-computed WCAG relative-luminance ratios, not eyeballed).
**Date:** 2026-08-24

---

## Verdict

**Not WCAG 2.1 AA today.** The gap is real but narrow and fixable — nothing here requires re-architecting the keyboard-speed model the tool is built around. Two classes of problem dominate: (1) **status-message and focus-management wiring** that's inconsistent across an otherwise well-built set of hand-rolled dialogs — three of five overlays (`ConfirmDialog`, `StartRunModal`, `GraphOverlay`) implement a correct focus trap and restore-on-close; the command palette and the registry-picker overlay don't, and neither the palette's result list nor the app's one toast system exposes anything to assistive tech at all; and (2) a **single mis-tuned color token** (`--faint`) that fails body-text contrast everywhere it's used as text, in both themes, because it was tuned to work as a subtle border/decoration color and then reused for load-bearing field labels. Neither problem touches the Compare screen's 1-2-0-x hotkey model, which is in fact the best-designed part of the app from an accessibility standpoint — every key has a visible label, every action is also a real focusable button, and typing-target guards are correct. Realistic remediation for the Critical+Serious items below is on the order of a day, not a redesign.

**Counts:** 5 Critical · 8 Serious · 7 Moderate · 4 Minor (24 findings)

---

## Findings

| ID | WCAG | Sev | File : Line | What the user experiences | Fix |
|----|------|-----|--------------|---------------------------|-----|
| **C1** | 4.1.3 Status Messages | Critical | `src/components/Toasts.tsx:42-54` | Every mutation result in the app — run started/paused/cancelled, verdict recorded, save failed, login/logout, connection-test result — surfaces only as a toast that auto-dismisses after 3.8s. The `#toasts` container has no `role` or `aria-live` (confirmed live: both `null`). A screen-reader user gets total silence for every async outcome in the app. | Add `role="status" aria-live="polite"` to the `#toasts` div in `Toasts.tsx:45`. For toasts pushed from a `.catch()` (failures), consider `role="alert"` on that specific toast instead — everything else can stay `polite`. |
| **C2** | 4.1.2 Name, Role, Value | Critical | `src/components/CommandPalette.tsx:296-299, 318-333` | Inside the palette, `Tab` is fully suppressed (only the input is ever a real Tab stop) and Arrow↑/↓ only mutate React state — confirmed live: after `ArrowDown`, `document.activeElement` is still the `<input>`. Result buttons have no `role="option"`/`aria-selected`. A screen-reader user has no way to discover that 12 ranked results exist, or which one is highlighted. | Implement the ARIA 1.2 combobox pattern without changing any interaction: input gets `role="combobox" aria-expanded aria-controls="palres" aria-activedescendant={id of row at index hi}`; the `.res` div gets `role="listbox" id="palres"`; each result button gets `role="option" id aria-selected={i===hi}`. Purely additive — the 3-keystroke/Enter speed goal is untouched. |
| **C3** | 2.4.7 Focus Visible | Critical | `src/styles/base.css:239` | `.palette input{...outline:none;}` — the single always-focused control in the command palette has **zero** visible focus indicator. Confirmed live: computed `outlineStyle: none`, `boxShadow: none`. | Delete `outline:none`, or replace with something visible, e.g. `box-shadow: inset 0 0 0 2px var(--acc);`. |
| **C4** | 4.1.2 / 2.4.3 | Critical | `src/App.tsx:99-113` | None of the five overlays (`CommandPalette`, `ConfirmDialog`, `StartRunModal`, `GraphOverlay`, `RegistryPicker`) makes the rest of the app `inert`/`aria-hidden` while open. Confirmed live: with `StartRunModal` open, `document.querySelector('.topbar').getAttribute('aria-hidden')` is `null` and `.inert` is `false`. A screen-reader user in browse mode can navigate into and "read" background nav/rail controls that are visually covered and non-functional. | Wrap `TopBar` + `ActiveScreen` in `App.tsx` in a single element toggling the native `inert` attribute — e.g. `<div inert={anyOverlayOpen}>` — driven by one derived boolean in `store.ts` (`paletteOpen \|\| startModalOpen \|\| graphOverlayOpen \|\| confirmPending`, plus RegistryPicker's own open state passed down). One attribute fixes all five overlays at once. |
| **C5** | 2.4.3 Focus Order | Critical | `src/screens/Workbench/tabs/Shared.tsx:463-533` (`RegistryPicker`, used from `ToolsTab.tsx:118` and `SkillsTab.tsx:128`) | This dialog declares `role="dialog" aria-modal="true"` but implements **no focus trap** — `Tab` is unhandled, so keyboard focus walks straight out of the "add tool/skill from registry" overlay into the Rail/Dock behind it — and no `triggerRef`, so focus is lost to `<body>` on close instead of returning to the "+ add from registry" button. This is the exact defect class the brief called out, and it's the one dialog in the app that doesn't follow the pattern its three siblings already use correctly. | Copy the Tab-cycling block from `StartRunModal.tsx:139-155` (or `GraphOverlay.tsx:251-269`) into `RegistryPicker`'s `onKeyDown`, and add a `triggerRef` captured on open / restored on close, matching `GraphOverlay.tsx:233-241`. |
| **S1** | 1.4.3 Contrast (Minimum) | Serious | `src/styles/tokens.css:3` (light `--faint:#989eab`), `:14`/`:23` (dark `--faint:#5b6373`); consumed by `.lbl` in `base.css:48` and `.phase .lbl` (`--acc-dim`) in `base.css:73` | `--faint` fails 4.5:1 as text on **every** surface it renders on, **in both themes** — see Contrast table. It powers `.lbl`, the class used for essentially every field label and section heading in the app: StartRunModal's "workflow"/"budget usd"/"brief" labels, Dock's card titles, Center's phase labels, Registry's `.k` key labels, etc. `.phase .lbl` additionally overrides to `--acc-dim`, which *also* fails (2.79:1 light / 3.30:1 dark on `--panel`). | Cheapest correct fix: `.lbl{color:var(--muted)}` in `base.css:48` (muted already clears 4.5:1 on every panel tier in both themes — see table) instead of retuning the shared `--faint`/`--acc-dim` tokens, which are also used decoratively elsewhere (borders, disabled-state dots) where the current values are fine. Also change `.phase .lbl{color:var(--acc-dim)}` at `base.css:73` to a token that passes, e.g. keep `--acc` (which passes, see table) or drop the override and inherit the fixed `--muted`. |
| **S2** | 1.4.3 Contrast (Minimum) | Serious | `src/styles/base.css:47` (`.risk.publish`), `:97` (`.pin.live`) | Both are `color-mix()` badges: text in the accent/ok hue, background a 12-15% tint of that same hue mixed into `--panel`. In **light mode only**, both fail 4.5:1 for their ~9.5-10.5px text — `.risk.publish` ("P" marker on publish-risk nodes, shown in the Rail and in `Center`'s `RiskBadge`) computes to 3.46:1; `.pin.live` (SchemasTab's "live" tag) computes to 4.07:1. Dark mode passes both (6.09:1, 5.62:1). | Raise the light-mode mix percentage for these two rules (e.g. 15%→22% for `.risk.publish`, 12%→18% for `.pin.live`) until the tint darkens enough to clear 4.5:1 against the unchanged `--acc`/`--ok` text color — verify with the same luminance formula after adjusting. |
| **S3** | 1.4.11 Non-text Contrast | Serious | `src/styles/tokens.css:6` (light `--cell-ok/--cell-gate/--cell-bad`), `:17` (dark); consumed `base.css:160-162`, `src/screens/Runs/GridTab.tsx:73-81` | Runs → Grid status cells vs. their own resting/queued background (`--panel3`) fail 3:1 in **both** themes: light `cell-ok` 1.55:1, `cell-gate` 1.51:1, `cell-bad` 2.19:1; dark 1.87:1, 2.76:1, 1.98:1. Each cell does carry a correct `aria-label`/`title` (good for screen readers), but a low-vision sighted user relying on the visual grid — the entire point of this view — cannot reliably tell "completed" from "queued" from "blocked" by hue alone at 26×17px. | Either raise the cell-fill/panel3 luminance gap until each state clears 3:1, or add a non-color marker per state (e.g. a 2px differently-styled border, or a tiny glyph baked into the cell) so the grid degrades gracefully for low color/contrast sensitivity. |
| **S4** | 4.1.2 Name, Role, Value | Serious | `src/screens/Runs/HistoryTab.tsx:20-38` | The runs History table's `<tr>` is made keyboard-operable (`tabIndex={0}`, Enter/Space → `onOpen()`) but carries no `role`/accessible name. A screen reader announces only "row" and the literal cell text — no indication that Enter/Space opens the run in the Workbench. | Add `role="button"` and `aria-label={\`Open run ${shortId(run.id)} in the workbench\`}` to the `<tr>` at line 38. |
| **S5** | 4.1.2 Name, Role, Value | Serious | `src/screens/Workbench/Rail.tsx:100-106` | The Build/Run mode switcher declares `role="tablist"` on the wrapper (`.modebar`) but its two `<button>` children have no `role="tab"`, `aria-selected`, or `aria-controls`, and no arrow-key switching exists — an incomplete/invalid ARIA widget (a `tablist` with no `tab` children). | Drop `role="tablist"` — it's not implementing that pattern — and use `aria-pressed={mode==='build'}` / `aria-pressed={mode==='run'}` on the two buttons instead, which accurately describes the click-only two-state toggle that's actually built. |
| **S6** | 4.1.2 / 4.1.3 | Serious | `src/components/TopBar.tsx:92-103`; `src/screens/Workbench/Center.tsx:111-117`; `src/screens/Learning/index.tsx:36-42`; `src/screens/Runs/index.tsx` subtabs; `src/screens/Registry/index.tsx:60-71` | Every tab-like button row in the app — primary nav, Center's 9-tab inspector, Learning's 7 subtabs, Runs' 3 subtabs, Registry's 6-section nav — is a plain `<button>` group with only a CSS `.on` class for the active item. No `aria-selected`/`aria-current`, no `aria-controls` linking a tab to the region it reveals, and switching never moves or announces focus — a screen-reader user gets no confirmation the page content changed. | This is one repeated pattern, so one fix covers it: a small shared `<TabBar>` primitive wrapping the existing `.tabs`/`.subtabs` CSS that adds `role="tablist"`/`role="tab"`/`aria-selected` (Center/Learning/Runs — real tab-panel swaps) and `aria-current="page"` for the nav-style switchers (TopBar, Registry's `.regnav`, which read more as navigation than tabs). |
| **S7** | 4.1.2 Name, Role, Value | Serious | `src/components/StartRunModal.tsx:246-268` | The `execution` (mock/openai) and `mode` (dry/live) `.seg` toggles expose the selected option only via a CSS `.on` class. **Dry vs. live is explicitly "the most consequential button in this application"** per the file's own header comment — a screen-reader user has no programmatic way to confirm which one is currently selected before hitting Start. | Add `aria-pressed={execMode==='mock'}` (and its sibling) to the four `.seg` buttons at lines 249-266 — four attributes, no structural change. |
| **S8** | 4.1.3 Status Messages | Serious | `src/components/StartRunModal.tsx:305, 336-373` | `ValidationLabel`/`ValidationNote` ("checking input…", "✗ input does not validate…", "blocked: …") update live as the operator types the brief (350ms debounce, `StartRunModal.tsx:117-131`) but sit in no `aria-live` region. A screen-reader user typing the brief gets no spoken notice that Start just became blocked, or why. | Wrap the `.foot` `ValidationLabel` and the `ValidationNote` paragraph (they always render together) in a single `aria-live="polite"` container. |
| **M1** | 1.4.1 Use of Color | Moderate | `src/screens/Workbench/Rail.tsx:135`; `src/screens/Workbench/Dock.tsx:97`; `src/components/TopBar.tsx:110`; `src/components/GraphOverlay.tsx:170-178` | The bare `<Dot status={...}/>` primitive (`src/components/primitives.tsx:7-9`) renders a `<span>` with **no text at all** — status is conveyed by CSS background-color alone. Used standalone (no adjacent status word) in the node rail, Dock's recent-runs list, TopBar's run chip, and GraphOverlay's node buttons. Contrast with `StatusChip` (`primitives.tsx:21-28`), which correctly pairs the same dot with the status word as visible text — that one is fine. | Give bare `<Dot>` a `title={status}` at minimum (one line in `primitives.tsx:8`); where layout allows (Dock, TopBar chip) prefer swapping in `StatusChip` instead. |
| **M2** | 1.3.1 / 2.4.1 | Moderate | `src/screens/Runs/index.tsx`, `src/screens/Library/index.tsx`, `src/screens/Learning/index.tsx`, `src/screens/Registry/index.tsx` — all return a bare `<div className="pagewrap">` | Only the Workbench screen has a `<main>` landmark (via `Center.tsx:103`). The other four top-level screens have none — screen-reader users cannot jump to page content with the standard landmark shortcut on 4 of 5 surfaces. | Change the outer `<div className="pagewrap">` to `<main className="pagewrap">` in each of the four files. |
| **M3** | 1.3.1 / 2.4.6 | Moderate | `src/screens/Registry/index.tsx:56` (`<h1>Registry</h1>`) vs. every section body (`KeysTab.tsx:129/141/150`, `SkillsTab.tsx:29`, `ProjectsTab.tsx:20`, `AgentsTab.tsx:26/38`, `ToolsTab.tsx:51`, `UsageTab.tsx:33` — all `<h3>`) | Heading level skips from `<h1>` straight to `<h3>` with no `<h2>` anywhere in Registry. | Give `Registry.tsx`'s section body region an `<h2>` matching the active nav label, or promote the section `<h3>`s to `<h2>`s (nothing below them currently nests an h3 meaningfully). |
| **M4** | 2.4.6 Headings and Labels | Moderate | `src/screens/Workbench/index.tsx` (no heading present) | The Workbench screen has no page-level heading — `Center.tsx:105`'s `<h2>{node.name}</h2>` is the only heading and it changes per selected node. Unlike Library ("Workflows"), Runs, Learning, Registry, there is no static "Workbench" heading anywhere. | Add a heading (visually-hidden is fine, e.g. `<h1 className="sr-only">Workbench</h1>`) at the top of `Workbench/index.tsx`. |
| **M5** | 4.1.2 Name, Role, Value | Moderate | `src/components/TopBar.tsx:117-122` (`.wfsel`), `:176-184` (`#accountbtn`) | Both dropdown triggers declare `aria-haspopup="true"` but never set `aria-expanded` — screen-reader users get no indication whether the menu is open. | Add `aria-expanded={menuOpen}` / `aria-expanded={accountOpen}` to the two trigger buttons. |
| **M6** | 3.3.1 / 4.1.3 | Moderate | `src/screens/Workbench/tabs/SchemasTab.tsx:200-215` | Schema-editor textareas show malformed-JSON/validation errors in a paragraph below the textarea, but the textarea has no `aria-invalid`/`aria-describedby` pointing at it, and the error isn't in a live region — a screen-reader user editing JSON gets no signal their edit just broke validation until they tab away and re-discover the error text. | Give the error paragraph (line 209-214) an `id`; set `aria-describedby` on the `<textarea>` (line 200) to that `id` whenever `parseError \|\| issues.length`; set `aria-invalid="true"` in the same condition. |
| **M7** | 3.3.1 Error Identification | Moderate | `src/components/LoginGate.tsx:192-197` (refocus), `:236-240` (error `<p>`) | On a failed login, focus returns to the (unchanged) password input, but the error text below it has no `aria-describedby`/`aria-live` wiring — refocusing the same element does not cause most screen readers to read newly-appeared sibling content. | Add `id="lg-error"` to the error `<p>` at line 236 and `aria-describedby="lg-error"` (conditionally) on the `<input>` at line 225, or wrap the error in `role="alert"`. |
| **M8** | 1.4.10 Reflow | Moderate | `src/styles/base.css:10` (`.topbar`) | Confirmed live: at a 720px-wide viewport (a rough proxy for ~200% browser zoom on a standard window), `.topbar` measures `scrollWidth: 1169` against `clientWidth: 720` and forces the entire page into horizontal scroll — even though the Workbench's own 3-column grid correctly collapses via its `@media(max-width:1020px)` rule (`.bench` itself measured `720/720`, no overflow). The topbar's flex row (wordmark + nav + workflow picker + theme/palette/account buttons) has no wrap and no responsive collapsing. | Add a narrow-width path for `.topbar` — `flex-wrap: wrap` plus letting `nav.main` scroll independently (`overflow-x:auto`) or collapse into the existing command-palette/menu pattern, so the *page* never gains a horizontal scrollbar even when the topbar's own content doesn't fully fit. |
| **N1** | 4.1.2 Name, Role, Value | Minor | `src/components/TopBar.tsx:112` | The run-chip unbind button (`<button className="x" onClick={unbindRun} title="unbind">✕</button>`) has only the glyph as its accessible name — ambiguous to screen readers (contrast with `GraphOverlay.tsx:290-292`'s "✕ close", which has real adjacent text and is fine). | Add `aria-label="Unbind run"`. |
| **N2** | 4.1.2 Name, Role, Value | Minor | `src/screens/Registry/index.tsx:62-69` | The active Registry section is conveyed only by the `.on` background class, no `aria-current`. | Add `aria-current={reg === n.id ? 'page' : undefined}`. |
| **N3** | 1.3.1 (landmark clarity) | Minor | `src/components/TopBar.tsx:92`, `src/screens/Registry/index.tsx:60` | Two unlabeled `<nav>` landmarks coexist when the Registry screen is active — both announce simply as "navigation" in a landmarks list. | `aria-label="Primary"` on TopBar's nav, `aria-label="Registry sections"` on Registry's. |
| **N4** | 2.5.5 Target Size (AAA — informational, not required for AA) | Minor | e.g. `.kbd` buttons (`base.css:23`, ~24×19px), grid cells (`base.css:160`, 26×17px), `.risk`/`.chip` badges | Several controls are under 24×24px. This is a Level AAA success criterion, not required for AA, and real-world risk is low for a keyboard-first desktop console typically used with a mouse on a full monitor — noted since target size was explicitly in scope, not because it blocks AA. | No fix required for AA compliance; consider only if the tool later targets touch/tablet use. |

---

## Contrast Table

All ratios computed via the WCAG relative-luminance formula against the literal hex values in `tokens.css`. **Bold** = fails the relevant threshold (4.5:1 normal text, 3:1 large text/UI boundaries).

### Text tokens vs. every surface they render on

| Foreground | Background | Light hex pair | Light ratio | Dark hex pair | Dark ratio | Needs |
|---|---|---|---|---|---|---|
| `--ink` | `--bg` | `#23262e`/`#f2efe8` | 13.17:1 ✅ | `#d7dce5`/`#101319` | 13.51:1 ✅ | 4.5:1 |
| `--ink` | `--panel` | `#23262e`/`#faf8f3` | 14.25:1 ✅ | `#d7dce5`/`#151a23` | 12.67:1 ✅ | 4.5:1 |
| `--ink` | `--panel2` | `#23262e`/`#edeae1` | 12.58:1 ✅ | `#d7dce5`/`#1b212d` | 11.72:1 ✅ | 4.5:1 |
| `--ink` | `--panel3` | `#23262e`/`#e2ded0` | 11.23:1 ✅ | `#d7dce5`/`#212939` | 10.59:1 ✅ | 4.5:1 |
| `--muted` | `--bg` | `#686e7d`/`#f2efe8` | 4.44:1 **⚠ (0.06 short)** | `#8a94a6`/`#101319` | 6.08:1 ✅ | 4.5:1 |
| `--muted` | `--panel` | `#686e7d`/`#faf8f3` | 4.81:1 ✅ | `#8a94a6`/`#151a23` | 5.70:1 ✅ | 4.5:1 |
| `--muted` | `--panel2` | `#686e7d`/`#edeae1` | 4.24:1 **❌** | `#8a94a6`/`#1b212d` | 5.27:1 ✅ | 4.5:1 |
| `--muted` | `--panel3` | `#686e7d`/`#e2ded0` | 3.79:1 **❌** | `#8a94a6`/`#212939` | 4.77:1 ✅ | 4.5:1 |
| `--faint` | `--bg` | `#989eab`/`#f2efe8` | 2.34:1 **❌** | `#5b6373`/`#101319` | 3.08:1 **❌** | 4.5:1 |
| `--faint` | `--panel` | `#989eab`/`#faf8f3` | 2.53:1 **❌** | `#5b6373`/`#151a23` | 2.89:1 **❌** | 4.5:1 |
| `--faint` | `--panel2` | `#989eab`/`#edeae1` | 2.23:1 **❌** | `#5b6373`/`#1b212d` | 2.67:1 **❌** | 4.5:1 |
| `--faint` | `--panel3` | `#989eab`/`#e2ded0` | 2.00:1 **❌** | `#5b6373`/`#212939` | 2.41:1 **❌** | 4.5:1 |
| `--acc` | `--bg` | `#a86b1c`/`#f2efe8` | 3.82:1 **❌** | `#e2a44a`/`#101319` | 8.54:1 ✅ | 4.5:1 |
| `--acc` | `--panel` | `#a86b1c`/`#faf8f3` | 4.14:1 **❌** | `#e2a44a`/`#151a23` | 8.01:1 ✅ | 4.5:1 |
| `--acc` | `--panel2` | `#a86b1c`/`#edeae1` | 3.65:1 **❌** | `#e2a44a`/`#1b212d` | 7.41:1 ✅ | 4.5:1 |
| `--acc` | `--panel3` | `#a86b1c`/`#e2ded0` | 3.26:1 **❌** | `#e2a44a`/`#212939` | 6.69:1 ✅ | 4.5:1 |
| `--acc` | `--acc-soft` | `#a86b1c`/`#f2e7cf` | 3.58:1 **❌** | `#e2a44a`/`#2b2415` | 7.06:1 ✅ | 4.5:1 |
| `--acc-dim` | `--panel` | `#b98f4d`/`#faf8f3` | 2.79:1 **❌** | `#8a6528`/`#151a23` | 3.30:1 **❌** | 4.5:1 |
| `--acc-dim` | `--bg` | `#b98f4d`/`#f2efe8` | 2.58:1 **❌** | `#8a6528`/`#101319` | 3.52:1 **❌** | 4.5:1 |
| `--ok` | `--bg` | `#2e7d4f`/`#f2efe8` | 4.39:1 **⚠ (0.11 short)** | `#57b380`/`#101319` | 7.23:1 ✅ | 4.5:1 |
| `--ok` | `--panel` | `#2e7d4f`/`#faf8f3` | 4.75:1 ✅ | `#57b380`/`#151a23` | 6.78:1 ✅ | 4.5:1 |
| `--bad` | `--bg` | `#b3403a`/`#f2efe8` | 4.93:1 ✅ | `#e0706a`/`#101319` | 5.93:1 ✅ | 4.5:1 |
| `--bad` | `--panel` | `#b3403a`/`#faf8f3` | 5.33:1 ✅ | `#e0706a`/`#151a23` | 5.56:1 ✅ | 4.5:1 |
| `--run` | `--bg` | `#2f6db3`/`#f2efe8` | 4.62:1 ✅ | `#6aa3e0`/`#101319` | 7.02:1 ✅ | 4.5:1 |
| `--run` | `--panel` | `#2f6db3`/`#faf8f3` | 5.00:1 ✅ | `#6aa3e0`/`#151a23` | 6.59:1 ✅ | 4.5:1 |
| `--paused` | `--bg` | `#7d5bb5`/`#f2efe8` | 4.53:1 ✅ | `#b48ede`/`#101319` | 6.96:1 ✅ | 4.5:1 |
| `--paused` | `--panel` | `#7d5bb5`/`#faf8f3` | 4.90:1 ✅ | `#b48ede`/`#151a23` | 6.53:1 ✅ | 4.5:1 |
| `--faint` | `--acc-soft` (empty-state / hint text) | `#989eab`/`#f2e7cf` | 2.19:1 **❌** | `#5b6373`/`#2b2415` | 2.55:1 **❌** | 4.5:1 |

### Color-mix badges (text color vs. its own tinted background, composited over `--panel`)

| Badge | Light ratio | Dark ratio | Real usage |
|---|---|---|---|
| `.risk.publish` (`--acc` on `--acc` 15%→panel) | **3.46:1 ❌** | 6.09:1 ✅ | Publish-risk "P" marker, Rail + Center `RiskBadge` |
| `.pin.live` (`--ok` on `--ok` 12%→panel) | **4.07:1 ❌** | 5.62:1 ✅ | SchemasTab "live" pin |
| `.risk.write` / `.chip` implied (`--run` on `--run` 12%→panel) | 4.26:1 ✅ | 5.47:1 ✅ | Write-risk marker |
| `.pin.pinned` (`--bad` on `--bad` 10%→panel) | 4.64:1 ✅ | 4.89:1 ✅ | SchemasTab "pinned" pin |

### Non-text / UI-boundary contrast (needs 3:1 — WCAG 1.4.11)

| Pair | Light ratio | Dark ratio |
|---|---|---|
| `--line` on `--bg`/`--panel` (card/table borders) | 1.26–1.37:1 (decorative hairline, not conveying state — informational only) | 1.28–1.36:1 |
| `--line2` on `--panel`/`--panel2` (input/button borders) | 1.58–1.79:1 (decorative; buttons also carry text) | 1.55–1.68:1 |
| `--cell-ok` vs `--panel3` (Grid) | **1.55:1 ❌** | **1.87:1 ❌** |
| `--cell-gate` vs `--panel3` (Grid) | **1.51:1 ❌** | **2.76:1 ❌** |
| `--cell-bad` vs `--panel3` (Grid) | **2.19:1 ❌** | **1.98:1 ❌** |

**Read on this:** `--faint` and `--acc-dim` are the systemic offenders (finding S1) — they fail as text in *every* combination, in *both* themes, because they were evidently tuned as decorative/border colors, not text colors, and then reused for `.lbl`. `--muted` and `--acc` are borderline-to-failing on the *lowest*-contrast panel tiers (`--panel2`/`--panel3`) specifically — worth a look but lower priority since most real usages sit on `--bg`/`--panel`, where they pass. The grid-cell palette (`--cell-*`) is the one true non-text-contrast failure (S3), consistent in both themes.

---

## What Is Already Right

- **`ConfirmDialog`** (`src/components/ConfirmDialog.tsx`) is the reference implementation in this codebase: correct two-element focus trap (Cancel⟷Confirm), danger actions deliberately do **not** default-focus Confirm (so a stray Enter can't fire a destructive action), focus is captured pre-open and restored to the exact trigger element post-close, `role="alertdialog"` + `aria-labelledby`, Escape and scrim-click both cancel. Nothing to change here.
- **`StartRunModal`** and **`GraphOverlay`** both implement a correct, general-purpose focus trap (first/last element cycling on Tab/Shift+Tab), pre-open focus capture, and post-close focus restore — the same quality bar as `ConfirmDialog`. `StartRunModal`'s form fields (`sm-wf`, `sm-proj`, `sm-budget`, `sm-reqid`, `sm-brief`) all use real `<label htmlFor>` pairing.
- **Runs → Grid** (`GridTab.tsx:73-81`): every status cell carries a full `aria-label` (`"{node} — {status} — run {id}"`) plus a `title` tooltip — the densest color-coded surface in the app is the *one* place status is never color-only for screen readers (contrast with M1/S3, which are about the *visual*, not the accessible-name, side of this same view).
- **`ProjectsTab`**'s connection-health and policy indicators (`ProjectsTab.tsx:25-27, 46-59`) consistently pair a ●/○ glyph and explicit text with color — never color alone.
- **Dock's publish-readiness checklist** (`Dock.tsx:389-393`) uses ✓/✗/? glyphs alongside color for each check's pass state.
- **Icon usage is clean everywhere**: `Icons.tsx`'s sprite and per-icon `<svg>` are correctly `aria-hidden="true"`, and every place an icon is used it's paired with adjacent visible text (`Ic id=...` was grepped app-wide — no icon-only unlabeled buttons exist).
- **Reduced motion is handled correctly** — the one CSS animation in the entire app (`.toast`'s entrance) is properly gated behind `@media (prefers-reduced-motion: reduce)` (`base.css:248`).
- **`nav.main`, `.wfsel`, `.kbd`, `.btn`** all get an explicit, on-brand `:focus-visible` outline (`base.css:17, 55`) rather than relying on inconsistent browser defaults.
- **The Compare screen's speed design is, itself, accessible-by-default** — every hotkey has a visible on-screen label ("A is better (1)", "candidate A · key 1"), all four verdict actions are also real clickable/focusable `<Btn>`s (not keyboard-only), Backspace-undo is discoverable and its consequence explained in the toast copy, and the global key listener correctly ignores `INPUT`/`TEXTAREA`/`SELECT` targets so the blind-mode checkbox and other controls on the same screen keep working normally. This is the part of the app the brief was most worried about, and it's the best-built part from an accessibility standpoint.
- **Body text (`--ink`)** clears 10.5–14.25:1 against every panel tier, in both themes — never a contrast concern anywhere it's used.
- **`LoginGate`** never stores, logs, or persists the password beyond the single submit call (`LoginGate.tsx:181-186`) — not itself an accessibility point, but it means the one thing M7 asks to add (an `aria-describedby`'d error) doesn't conflict with that security property.

---

## Keyboard Map (as implemented)

**Global (any screen, guarded against active `INPUT`/`TEXTAREA`/contentEditable targets):**
| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open Command Palette |
| `g` (bare) | Open Graph Overlay |

**Command Palette** (`CommandPalette.tsx`):
| Key | Action |
|---|---|
| type | Filter results (fuzzy-ranked) |
| `↓` / `↑` | Move highlight — **state only, real DOM focus never leaves the input** (C2) |
| `Enter` | Activate highlighted result |
| `Escape` | Close, focus returns to trigger |
| `Tab` | No-op (`preventDefault`) — the input is the only Tab stop in the dialog |

**Confirm Dialog** (`ConfirmDialog.tsx`):
| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycles Cancel ⟷ Confirm (2-element trap) |
| `Escape` | Cancel, focus returns to trigger |
| Default focus | Confirm, unless `danger:true` → Cancel |

**Start Run Modal** (`StartRunModal.tsx`):
| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Full trap across all enabled fields/buttons, DOM order |
| `Escape` | Close, focus returns to trigger |
| Default focus | `workflow` `<select>` |

**Graph Overlay** (`GraphOverlay.tsx`):
| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Full trap across node buttons + Close |
| `Escape` | Close, focus returns to trigger |
| Default focus | Close button |

**Registry Picker** (`Shared.tsx` — Tools/Skills "+ add from registry"):
| Key | Action |
|---|---|
| `Escape` | Close (no focus-restore — C5) |
| `Tab` | **Not trapped** — leaks into the page behind (C5) |
| Default focus | Filter input |

**Workbench Rail** (`Rail.tsx:83-93`):
| Key | Action |
|---|---|
| `↑` / `↓` | Move selection among visible node rows — real DOM focus moves (correct roving pattern) |
| `Enter`/`Space` on a row | Select that node (native button) |
| Build/Run buttons | Click only — no arrow-key switching despite `role="tablist"` (S5) |

**Learning → Compare** (`Compare.tsx:114-130`, global `window` listener while mounted, ignores `INPUT`/`TEXTAREA`/`SELECT` targets):
| Key | Action |
|---|---|
| `1` | Verdict: A preferred |
| `2` | Verdict: B preferred |
| `0` | Verdict: tie |
| `x` / `X` | Verdict: both bad |
| `Backspace` | Undo last verdict |
| (mouse/Tab) | All four verdicts and the blind-mode checkbox are also ordinary focusable/clickable controls |

**Runs → History table** (`HistoryTab.tsx:38`):
| Key | Action |
|---|---|
| `Tab` | Each `<tr>` is a stop (`tabIndex=0`) |
| `Enter`/`Space` | Opens that run in Workbench — but announces only as "row" (S4) |

**Everywhere else** (TopBar nav, Center's 9 tabs, Learning's 7 subtabs, Runs' 3 subtabs, Registry's 6 sections, `.wfsel`/account dropdown menus): plain Tab order, click/Enter/Space activates, no arrow-key roving-tabindex pattern, no `Escape`-to-close on the two TopBar dropdowns' individual items (though `Escape` at the document level does close them — `TopBar.tsx:49-54`).

---

## Prioritised Fix List

Ordered by (severity × cheapness) — cheapest, highest-leverage fixes first, since several one-line token/attribute changes fix multiple findings at once.

1. **C1 — Toasts `aria-live`.** One attribute (`role="status" aria-live="polite"` on `Toasts.tsx:45`) fixes the single biggest blind-spot in the app: every mutation outcome, everywhere.
2. **C3 — Palette input focus outline.** Delete one CSS declaration (`base.css:239`).
3. **S1 — `.lbl` color.** One CSS declaration (`base.css:48`: `color:var(--faint)` → `color:var(--muted)`) fixes the contrast failure on essentially every field label and section heading in the app, in both themes, at once. Also fix `.phase .lbl`'s `--acc-dim` override (`base.css:73`).
4. **M5 — `aria-expanded` on the two TopBar dropdown triggers.** Two attributes.
5. **S7 — `aria-pressed` on StartRunModal's `.seg` toggles.** Four attributes on the most consequential control in the app (dry vs. live).
6. **M1 — `title={status}` on bare `<Dot>`.** One line in `primitives.tsx:8`.
7. **N1/N2/N3 — `aria-label`/`aria-current` additions.** Each is a single attribute, in `TopBar.tsx:112`, `Registry/index.tsx:62-69`, and the two `<nav>` elements.
8. **S2 — Color-mix badge contrast.** Adjust two mix percentages (`.risk.publish`, `.pin.live` in `base.css:47,97`), light mode only, then re-verify with the same formula.
9. **M2 — `<main>` landmarks.** Four one-word tag changes (`div`→`main`) in Runs/Library/Learning/Registry `index.tsx`.
10. **C4 — `inert` on the background during overlays.** One wrapper element in `App.tsx` plus one derived boolean in `store.ts`; fixes all five overlays simultaneously.
11. **S8 / M6 / M7 — `aria-live`/`aria-describedby` on validation and error text.** Same shape of fix in three files (`StartRunModal.tsx`, `SchemasTab.tsx`, `LoginGate.tsx`) — do together.
12. **S4 — `role="button"` + `aria-label` on History table rows.** One element, `HistoryTab.tsx:38`.
13. **S5 — Replace `role="tablist"` with `aria-pressed` on the Rail's Build/Run switcher.** `Rail.tsx:100-106`.
14. **C5 — Focus trap + restore for `RegistryPicker`.** Port the existing, already-correct pattern from `StartRunModal`/`GraphOverlay` verbatim — this is copying working code, not writing new logic.
15. **C2 — Combobox ARIA for the Command Palette.** The most involved fix in this list (five attributes across two elements plus a small `id`-per-row helper), but still purely additive — it does not touch the ranking, the keystroke model, or the 3-keystroke/Enter done-criterion.
16. **S3 — Grid cell non-text contrast.** Requires either a palette pass or a per-cell marker; lowest urgency since the cells already carry correct accessible names.
17. **S6 — Shared `<TabBar>` ARIA primitive.** The largest-surface-area fix (touches 5 screens) but each individual screen's change is small once the primitive exists; do last since it's more refactor than patch.
18. **M3/M4 — Heading structure.** Cosmetic relative to the above; do whenever those files are next touched.
19. **M8 — Topbar reflow at narrow/zoomed widths.** Lowest priority given this is a desktop expert tool normally used at full width, but flagged since 1.4.10 was in scope and the fix (`flex-wrap` + independent nav scroll) is self-contained to one selector.
