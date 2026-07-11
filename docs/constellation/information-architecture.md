# Constellation redesign — information architecture

Companion to `product-model.md`. Documents the current UI as audited, the
target architecture, and the cross-cutting UI specifications (node summary
schema, relationship taxonomy, modal sections, theme tokens, responsive
layout, keyboard behavior, accessibility).

## Current component tree (as audited)

```
main.tsx (React 19 StrictMode, imports @xyflow/react CSS + styles.css)
└─ App.tsx (≈200 lines; owns endpoint/token/status/activeTab; builds McpConfig memo)
   ├─ access screens: checking | verifying | login | unauthorized (accessState.ts)
   ├─ header .hero
   │  ├─ session-card (deployed mode only)
   │  └─ ConnectionPanel ── useConnection(endpoint, token)  ⚠ builds a SECOND McpConfig
   ├─ status banner (single global Status message)
   ├─ workspace-tabs (Overview | Builder | Nodes | Support)
   ├─ [overview] OverviewPanel ── useOverview(config)        (mount-only load)
   ├─ [builder]  WorkspaceGraph (React Flow) ⚠ fabricated edges/positions
   │             WorkflowControls             ⚠ mount-only list-runs effect
   │             RunStatusPanel · NodeExecutionList
   ├─ [nodes]    SkillsPanel · Inspector(+SchemaViewer) · RJSF schema preview
   │             NodeConsole(config)           ⚠ effect keyed on [selectedNodeId] only
   │             ArtifactPanel
   └─ [support]  workspace exchange <pre> · RepositoryDiagnostics (inline in App)
                 article_body SchemaViewer · Validator (RJSF) · UsagePanel
```

## Current state ownership

| State | Owner | Notes |
|---|---|---|
| `endpoint`, `token`, `activeTab`, global `status` | `App` local state | token mirrored to `localStorage` (`cms-agent.mcpToken`) |
| `McpConfig` (canonical) | `App` `useMemo` | `usingSecureProxy = endpoint === "/api/workspace-mcp"` decides token vs identity `authToken` |
| `McpConfig` (duplicate) | `useConnection` inside `ConnectionPanel` | `{endpoint, token}` only — diverges from canonical config; root of the credential bug (`data-model-gaps.md`) |
| nodes, selection, prompt draft, `workspaceVersion`, skills, article JSON/formData, export, health | `useWorkspace` | `workspaceVersion` cached client-side for `expectedWorkspaceVersion` |
| runs, currentRun, loading | `useWorkflowRun` | optimistic list updates per action |
| usage summary/records/budget | `useModelUsage` | auto-refreshes only while a run is selected |
| identity session (`accessToken`) | `useIdentitySession` | token captured once at login; never renewed |
| overview data | `useOverview` | mount-only load; per-section degradation |
| Inspector drafts (7 JSON-in-textarea strings) | `Inspector` local | re-seeded on node change; parse errors throw at save |
| WorkflowControls form (projectId, input, mode, untilNode) | local | |
| NodeConsole console state (7 blobs) | local | |

Everything above is read from MCP; the only client-authored state is drafts,
selection, and connection settings — this discipline must survive the
redesign. The redesign consolidates connection state into a single
**connection store** (endpoint, mode, credential, liveness) consumed by every
caller, replacing the duplicated config construction.

## Target information architecture

```
<AppShell>
 ├─ Header: product mark · ProjectSelector · nav (Overview/Constellation/Runs/Changes/Settings)
 │          · ConnectionStatus chip (opens Settings ▸ Connection)
 ├─ route: /overview            OverviewPage (exists)
 ├─ route: /constellation       ConstellationPage
 │    ├─ ModeSwitch (Design | Operate | History)   [URL param]
 │    ├─ Canvas (React Flow, minimal nodes, dependsOn edges, MCP positions)
 │    ├─ SideRail (selection summary / attention / timeline, mode-dependent)
 │    └─ NodeModal (native <dialog>, accordion sections)
 ├─ route: /runs                RunsPage (ledger → run detail)
 ├─ route: /changes             ChangesPage (event ledger → diff → restore)
 └─ route: /settings            SettingsPage (connection · storage · projects · exchange)
```

Routing may remain state-based (as tabs are today) or adopt a tiny router;
either way every page and Constellation mode must be URL-addressable so links
in attention items and change entries can deep-link.

## Node summary schema (minimal graph node)

The canvas node renders **only** this projection; everything else lives in the
rail/modal. Defined as a UI type derived from `WorkspaceNode`:

```ts
type NodeSummary = {
  id: string;
  name: string;
  kind?: string;              // intake | strategy | review | … (icon)
  status: "draft" | "active" | "deprecated";   // dot + text label
  riskLevel: "read" | "write" | "publish" | "admin"; // badge; publish/admin always visible
  attention?: "action" | "warning";  // derived: validation issue, blocked run node, conflict
  execution?: ExecutionStatus;       // Operate mode overlay only
  counts: { skills: number; tools: number; dependsOn: number };
  updatedAt?: string;                // relative time in tooltip, not on card
};
```

Rules: no prompt text on the card (the current card leaks a 96-char prompt
preview); fixed card dimensions so layout can never overlap; risk `publish`
and `admin` render with the danger token family and are never hidden by
truncation.

## Relationship taxonomy

| Relationship | Storage today | Rendered as | Editable? |
|---|---|---|---|
| `depends_on` (execution order) | `node.dependsOn: string[]`; edges derived on read by `workspace.get_graph` | solid directed edge | Yes — Design mode, via `workspace.update_graph {dependencies}`; server validates cycles/dangling refs |
| `produces` / `consumes` (artifact contract) | `node.produces[]`, `node.requiredInputs[]` (names like `article_body.v1`) | dashed edge or port badges, derived; toggleable layer | Not as edges; edited in modal ▸ Relationships. Note: consistency with `depends_on` is **not enforced** by the server (gap) |
| `skill_assignment` | `node.assignedSkills[]` (ids into the skill registry) | not a canvas edge; count on card + modal ▸ Skills; optional "highlight nodes using skill X" filter | Yes — `skill.assign` / `skill.unassign` |
| `tool_allowance` | `node.allowedTools[]` + resolver (`skill.resolve_for_node` → effective/denied/conflicts) | modal ▸ Tools; conflicts surface as node attention | Yes — `workspace.update_node_tools` |
| `project_handoff` (workspace → external project MCP) | project registry (`project.*`), publishing policy disabled | boundary badge on `publish_payload` / `publication_controller`; links to Settings ▸ Projects | No (env-var driven; read-only in UI) |

There is **no edge entity** in the data model — all edges are projections of
node fields. The taxonomy above is therefore a rendering contract, not a
schema change; gaps that would justify a real edge model are listed in
`data-model-gaps.md`.

## Agent configuration modal (accordion sections)

Large `<dialog>`, one node at a time, section state preserved while open.
Every save is a section-scoped MCP mutation carrying
`expectedWorkspaceVersion`, `actor`, and a human-readable `summary`;
`workspace_version_conflict` produces an inline "reload and reapply" flow.

1. **Identity & status** — id (read-only), name, kind, description, status,
   riskLevel. → `workspace.update_node`.
2. **Prompt** — draft editor + effective prompt preview
   (`node.get_effective_prompt`, includes skill-composed instructions).
   → `workspace.update_node_prompt`.
3. **Skills** — assigned skills, registry browser, resolve policy
   (`skill.resolve_for_node`) with conflict list. → `skill.assign`/`unassign`.
4. **Tools** — allowed tools, effective vs denied from the resolver, risk
   notes. → `workspace.update_node_tools`.
5. **Schemas** — input/output JSON Schema editors with structured validation
   feedback and RJSF preview (replaces raw textareas).
   → `workspace.update_node_input_schema` / `_output_schema`.
6. **Relationships** — dependsOn editor with live `workspace.validate_graph`
   preview; produces/requiredInputs editors. → `workspace.update_graph` /
   `update_node`.
7. **Model & execution** — modelConfig, executionConfig, budget hints.
   → `workspace.update_node_model_config`.
8. **History** — per-node change list and restore (requires the new history
   tools; hidden until they exist).
9. **Danger zone** — clone, deprecate, delete (canonical-node guard surfaced
   explicitly). → `workspace.clone_node` / `update_node` / `delete_node`.

## Theme-token architecture

Three layers; only the semantic layer is public to components:

1. **Primitives** (private): raw values. Today these are the literals already
   in `:root`; a future dark theme redefines them under
   `:root[data-theme="dark"]`.
2. **Semantic tokens** (public, shipped with the Overview): `--color-bg`,
   `--color-text`, `--color-text-muted`, `--color-surface`,
   `--color-surface-muted`, `--color-border`, `--color-border-muted`,
   `--color-accent{,-strong,-surface,-text}`, and the status families
   `--color-{success,warning,danger,info}-{surface,text}`.
3. **Component tokens** (only where a component needs indirection):
   e.g. `--node-card-bg: var(--color-surface)`.

Rules: no raw color literals in new CSS; execution-status classes map to the
status families (queued→muted, running→warning, completed→success,
blocked→warning, failed→danger, cancelled→info); React Flow is themed by
overriding its documented CSS variables with semantic tokens; **no arbitrary
z-index** — layering comes from DOM order, React Flow's internal layers, and
the native `<dialog>` top layer; **no absolute-positioned overlay panels** —
rails and canvases are grid areas. Legacy raw-color rules in `styles.css`
migrate to tokens page-by-page during the shell migration, then the file is
split per page.

Known overlap causes to eliminate (audit findings): the current graph
synthesizes node positions on a fixed 280×180 grid while card height is
content-dependent (prompt preview), so tall cards overlap the next row; fixed
canvas heights (`31rem`) fight `fitView` on large graphs. Fixed-size minimal
nodes + MCP positions remove both. `styles.css` itself contains no `z-index`
or `position: absolute` — keep it that way.

## Responsive layout

- Breakpoints: ≥ 981 px (full: canvas + side rail), 721–980 px (rail collapses
  to a drawer toggled from the toolbar; nav stays horizontal), ≤ 720 px
  (single column; canvas gets a list-view alternative; modal becomes a
  full-screen sheet; nav collapses to a select).
- The canvas never causes page-level horizontal scroll; wide tables (Runs,
  Changes) scroll inside their own `overflow-x: auto` container.
- Stat tiles and cards use `auto-fit/minmax` grids as the Overview does.

## Keyboard behavior

- Global: `?` shortcut help; `/` focuses search/command; `1–5` switch pages;
  `[` / `]` cycle Constellation modes.
- Canvas: nodes are focusable (React Flow `nodesFocusable`), roving tabindex;
  arrow keys move focus spatially; `Enter` opens the modal; `Delete` proposes
  edge/node removal in Design mode (with confirm); `Esc` clears selection.
- Modal: native `<dialog>` gives focus trap + `Esc`; accordion headers are
  buttons with `aria-expanded`; `Ctrl/Cmd+Enter` saves the active section.
- Every action reachable by pointer has a keyboard path; drag-only
  interactions (edge creation, node move) have list-based equivalents in the
  modal (Relationships section) — this is the accessibility fallback, not an
  afterthought.

## Accessibility expectations

- WCAG 2.1 AA contrast, enforced at the token layer (checked once per token
  pair, not per component).
- Status is never color-only: pills keep text labels; canvas overlays pair
  color with icon shape.
- Structure: pages are landmarks (`nav`, `main`, labelled `section`s — the
  current code already does this well); the tab/nav uses `aria-pressed` or
  `aria-current`; the status banner keeps `role="status"`; long-running
  operations announce via a polite live region.
- The canvas has a screen-reader-equivalent list view (nodes with their
  relationships as text) — History and Design must be fully understandable
  without the visual graph.
- `prefers-reduced-motion` disables canvas animations and timeline scrubbing
  transitions.
- Focus outlines use the accent token and are never suppressed.
