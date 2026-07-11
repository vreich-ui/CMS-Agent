# Constellation redesign — product model

Status: audit/specification only. Nothing in this document is implemented yet
except the Overview tab. See `migration-plan.md` for sequencing.

## Purpose

CMS-Agent is a **supervisory operating environment for autonomous agent
systems** — not a traditional CMS dashboard and not merely a workflow
builder. Agents perform most configuration changes, optimizations, and
operational decisions through MCP; humans intervene less frequently, but when
they do they must re-orient fast: understand the system quickly, inspect
changes, redirect behavior, edit configuration, and restore earlier states
with confidence. The UI is a lens over MCP state, never a second source of
truth.

Conceptually it combines: an organizational map for autonomous agents, a
workflow and relationship editor, an operations console, a versioned
configuration system, an audit and restoration interface, and an analytics
environment. It is not a collection of admin pages.

The product helps people answer: which agents exist; how they work together;
who influences whom; what each agent is responsible for; which agents consume
the most resources; which relationships carry the most activity; what
changed; who or what made the change; whether behavior improved or regressed;
and where human attention is needed right now.

Primary UX principle: **human attention is the scarce resource.** Show
information when it is relevant; hide detail until requested; emphasize
exceptions, risks, changes, and decisions; compress healthy or routine
information. The user should feel oriented, not surrounded by telemetry.

### Conceptual entities

Projects · Missions · Workflows · Roles/teams · Agents · Relationships ·
Runs · Changes · Memory · Policies · Analytics · Approvals.

Today's backend models projects, workflow nodes (agents), runs, changes
(events/versions), skills, tools, usage, and learning observations. Missions,
roles/teams, policies, approvals-as-entities, and evaluation data have no
backend representation yet — see `data-model-gaps.md` § Product-entity gaps.
The UI must not fake entities the backend cannot attribute or persist.

## Product surfaces

```
Project selector ─┬─ Overview        (shipped: attention-first summary)
                  ├─ Constellation   (Design | Operate | History modes)
                  ├─ Runs            (execution ledger + run detail)
                  ├─ Changes         (immutable change ledger + restore)
                  └─ Settings        (connection, storage, project registry)
```

The current Builder / Nodes / Support tabs are transitional and map onto these
surfaces (see `migration-plan.md` § Migration path).

## Project selector

Follows the spirit of GitHub's repository selector: always available,
upper-left, easy to access, low in visual emphasis, searchable when the list
grows, and context-preserving when switching. Project selection never
dominates the page.

Behavior specification:

- Source of truth: `project.list` (safe summaries only — env var *names* and
  `endpointConfigured` / `tokenConfigured` booleans, never secret values).
- Placement: persistent in the app header, upper-left, before the page
  navigation; rendered quietly (a labeled control, not a hero element).
- Searchable: type-ahead filtering once more than a handful of projects
  exist; fully keyboard-operable either way.
- Context preservation: switching projects keeps the current page and mode,
  re-scoping data rather than resetting navigation.
- Selection scope: `projectId` becomes ambient context for Runs
  (`workflow.list_runs {projectId}`), usage (`usage.get_summary {projectId}`),
  and run creation. It does **not** scope the constellation graph today: the
  workspace document is global (single Publishing Conductor). This is a known
  data-model gap (`data-model-gaps.md` § Project scoping) and the selector must
  not pretend otherwise — in v1 the Constellation page shows a "shared
  workspace" badge when a project is selected.
- Default: the only registered project (`dr-lurie`) plus the implicit dry-run
  projects seen in run history (e.g. `project-a`). If exactly one project
  exists, preselect it; otherwise restore the last selection from
  `localStorage` (selection is a UI preference, not workspace state).
- Unconfigured connections (endpoint/token env vars absent) render with a
  warning glyph; selecting such a project is allowed (dry-runs don't need the
  external MCP), but connection-dependent actions are disabled with a reason.
- Keyboard: the selector is a native `select` or an ARIA combobox; fully
  operable without a pointer.

## Constellation modes

One canvas, three modes. Mode is a UI state (URL-addressable), never stored in
workspace state. Switching modes never mutates anything.

### Design mode

Intent: edit the graph and node configuration safely. Shows the stable
structure of the agent system: agents, roles, relationships, dependencies,
configuration.

- Renders true structure: nodes at MCP-provided `position {x,y}`, edges derived
  from `dependsOn` via `workspace.get_graph`. (The current `WorkspaceGraph`
  fabricates a linear chain and synthesizes positions — see
  `data-model-gaps.md` § Graph rendering honesty. Design mode replaces it.)
- **Positions are stable so users develop spatial memory.** Design mode owns
  layout; Operate and History reuse the same positions and never reflow the
  map. Layout changes happen only through explicit user drags (or an explicit
  re-layout action), persisted through MCP.
- Node interactions: select → summary rail; open → node-editing modal
  (accordion sections, see below); drag → position update through
  `workspace.update_graph {positions}` on drop, guarded by
  `expectedWorkspaceVersion`.
- Edge interactions: create/delete `depends_on` edges through
  `workspace.update_graph {dependencies}`; the server re-validates (cycles,
  dangling references, canonical-structure rules) and the UI surfaces
  `workspace.validate_graph` issues inline before commit.
- Destructive actions (delete node) respect the canonical-node guard
  (`allowCanonicalNodeRemoval` + `adminApproved`) and require typed
  confirmation.
- Every mutation sends `actor` and `summary`; conflicts
  (`workspace_version_conflict`) trigger a reload-and-reapply prompt, never a
  silent retry.

### Operate mode

Intent: watch and steer execution without reconfiguring anything.

- Same canvas, read-only structure; nodes overlay live execution state
  (`queued/running/completed/blocked/failed/cancelled`) for the selected run.
- Operational visual encodings, layered onto the stable map without
  destabilizing it: node size may represent token usage or another selected
  metric; node color represents health; connector thickness represents
  interaction frequency; relationship kinds render by style or filter;
  attention states surface clearly; activity indicators stay subtle. Each
  encoding is restrained, explained on hover/selection, and never the only
  carrier of meaning (labels and text back every color/size signal).
  Encodings ship only where backing data exists — per-node usage and
  durations exist today; per-edge interaction counts do not
  (`data-model-gaps.md` § Product-entity gaps).
- The attention rail lists approvals required (`approvalsRequired`), failures,
  and the current node. Approving is out of scope until the backend has an
  explicit PUBLISH approval gate; the UI shows "approval required — no
  publication was performed" exactly as the executor reports it.
- Run controls (start, run-one, run-until, run-all, pause, resume, cancel,
  retry, reset) move here from the Builder tab. Pause and approval-block are
  visually distinct even though both map to `status: "blocked"` today (gap
  documented in `data-model-gaps.md` § Run semantics).
- Node click opens the run-scoped node inspector (input, output, warnings,
  errors, duration, usage) — not the configuration modal.

### History mode

Intent: understand how the constellation got to its current shape, and restore.

- Same canvas; a timeline scrubber selects a `workspaceVersion`; nodes render
  from that version's snapshot with changed nodes highlighted (`events[]`
  before/after hashes identify the touched version ranges).
- Selecting a node shows its config at that version and a per-node change list.
- Restore: per-node restore writes the historical node state back through a
  normal guarded mutation, producing a new event (history is append-only;
  restore never rewrites it).
- Blocked on backend work: history read tools and restore tools do not exist
  yet (`data-model-gaps.md` § Change/revision system). History mode is the
  last Constellation mode to ship.

## Minimal graph nodes

Nodes on the canvas show only what earns its pixels; everything else is in the
rail or modal. See `information-architecture.md` § Node summary schema for the
exact shape.

## Node-editing modal

A large modal (native `<dialog>`) with accordion sections; specified in
`information-architecture.md` § Agent configuration modal. It replaces the
Inspector's raw-JSON textareas, the SkillsPanel assignment flow, and the
NodeConsole for per-node inspection.

## Change/revision system

Principles:

- **Immutable**: the store already appends a full node snapshot
  (`versions[]`) and an event (`events[]` with `beforeHash`/`afterHash`,
  optional `actor`/`summary`) on every mutation; nothing may ever rewrite or
  delete these in place. Compaction, if ever needed, is an explicit,
  attributed operation.
- **Attributable**: every change carries a server-stamped actor
  `{ kind: "human" | "agent" | "system", id }`. Today `actor` is an optional,
  caller-asserted free string and three mutation paths bypass it entirely —
  this must be fixed server-side before the Changes page ships
  (`data-model-gaps.md` § Attribution).
- **Reversible**: restore is a forward operation — applying a historical state
  produces a new version and a new event that references what it restored.
  Nothing is ever "undone" by deletion.

The **Changes page** is the ledger view: filter by node, actor kind, time
range, and event type; inspect diffs between versions; restore from a diff.
**History mode** is the same data projected onto the canvas.

## Analytics requirements

Analytics support decisions rather than displaying every available metric.
Questions the product must answer (Operate, Runs, and Overview surfaces):

1. What does a run cost (tokens, estimated USD) and how is it trending?
2. Which nodes are bottlenecks (duration, failure rate, retry count), and
   which create downstream failures?
3. How often are runs blocked on approval, and how long do blocks last?
4. Who/what is changing the constellation, and how often (change velocity by
   actor kind)? Which configuration changes improved outcomes, and which were
   reverted?
5. Is spend approaching budget (existing `usage.get_budget_status`)?
6. Which relationships are overloaded; where are retries, latency increases,
   and schema mismatches concentrating; which agents require human
   intervention now?

**Attention items must cite their evidence.** A health or attention indicator
explains why it exists — e.g. "Research Agent needs attention because cost
increased, two tool calls failed, and downstream quality fell after a recent
prompt change" — and deep-links to the underlying runs/changes/usage.
Unexplained composite scores are prohibited; prefer evidence-based attention
items over generic scorecards.

Available today: per-run and per-node token/cost estimates
(`usage.get_summary` with `byModel`/`byNode`/`byProject` buckets), per-node
`durationMs`, budget status. Missing: time-bucketed aggregation, actor-kind
change counts, approval latency (needs event timestamps exposed), pagination
for any list that feeds a chart. All costs render with the existing
"estimates only; not billing-grade" framing — pricing is a placeholder
catalog and unknown models silently fall back to `gpt-5.5` pricing.

## Explicit non-goals (this redesign)

- No publish execution and no approval-granting UI until the backend PUBLISH
  gate exists.
- No editing of external project MCP configuration beyond what
  `project.*` tools expose (env-var driven; secrets never reach the browser).
- No offline mode; the UI is a thin MCP client.
- No React Flow Pro features or paid template code (MIT React Flow only).
