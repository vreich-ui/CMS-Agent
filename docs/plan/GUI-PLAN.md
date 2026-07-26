# CMS-Agent — Agent Management GUI Plan

**Date:** 2026-07-26
**Repo:** github.com/vreich-ui/CMS-Agent (HEAD `8ab11be`)
**Live UI:** cms-agent.netlify.app/constellation
**Canonical control plane (your decision):** Cloud Run + GCS (`CMS_Agent_GCloud`)

---

## 1. Verdict on build vs. plug-in

**Build. No off-the-shelf tool fits, and the reason is structural, not aesthetic.**

Langflow, Flowise, Dify, n8n and LibreChat's agent builder all own their own node model. Each defines what a node *is* — its config shape, its execution semantics, its persistence. To adopt one you would either (a) rewrite the CMS-Agent backend to their model, discarding the parts that carry your actual business rules, or (b) run their canvas as a shell that cannot express your model, which is the situation you already have.

What their node model cannot express, concretely:

| CMS-Agent concept | Evidence in your workspace | Off-the-shelf equivalent |
|---|---|---|
| `riskLevel` ladder (`read`/`write`/`publish`) gating tool access at execution time | `contract_intelligence` is denied `project.call_tool` with `risk_level_exceeds_authorization` | none |
| Skill → node compatibility resolution with typed conflicts | `article_body` returns a `blocker`-severity schema conflict | none |
| Per-project tool policy + publish gate | `dr-lurie` `publishEnabled:false`, 18 tool policies, one `needs_approval` | none |
| Content contract versioning (`article_body.v1`) with conditional JSON Schema | `if media → require rendering.placement`; `dependentRequired ctaLink↔ctaText` | none |
| Immutable change ledger with before/after + revision chain | `changes.list` returns full node snapshots per event | partial (n8n versions, no semantic diff) |
| Publish readiness checklist as a first-class gate | 8-item GO/NO-GO with per-item detail | none |

Your backend is the asset. It exposes ~129 MCP tools including `node.get_effective_*`, `skill.resolve_for_node`, `workflow.publish_readiness`, `changes.*` — every screen the new GUI needs already has a server-side answer. **The gap is purely client-side.** That is the cheapest possible position to be in, and adopting a foreign node model would throw it away.

One caveat worth stating plainly: you have **zero CI** (no `.github/` directory at all) against 94 existing test files. Build velocity will be dominated by regressions unless that's fixed first. See §5.

---

## 2. What the GUI does and doesn't do today

**Design canvas** (`?mode=design`, the default) — React Flow canvas, node cards, dependency add/remove, layer toggles, graph validation. The right rail shows `Id / Kind / Status / Risk / Skills (count) / Tools (count) / Updated`. The "Open details" button is **disabled**, labelled *"arrives in S4"*.

**So: the canvas can tell you a node has 4 tools. It cannot tell you which four, or let you change them.**

**Legacy Nodes tab** (`?legacy=nodes`) — this is where editing actually lives today. It does work: prompt textarea + Save, dependencies textarea + Save, allowed tools, skill assign/unassign, `Resolve policy`. But it is:
- raw JSON in `<textarea>` elements (`Inspector.tsx`, 61 lines) — no schema awareness, no validation before save, no diff
- disconnected from the canvas — you select a node in one place and edit it in another
- explicitly marked for retirement ("These workspaces retire as the canvas absorbs their features")

**Runs page** — a 15-line stub. **History mode** — disabled, "arrives in S6".

Net: an agent editing this workflow through the GUI has no supported path. It has to use the legacy tab or go straight to MCP. That matches what you described.

---

## 3. The plan — S4, S5, S6

Your repo already specifies this migration (`docs/constellation/migration-plan.md`). This plan makes it concrete and adds what the dry runs showed is missing.

### S4 — Node inspector (replaces `Inspector.tsx`)

A right-side drawer, opened from canvas selection. Not a modal — the graph must stay visible so an operator can see what a change affects. Six tabs:

**1. Overview** — identity, kind, status, risk, `dependsOn` / `requiredInputs` (and a warning when they disagree — `trust_factual` currently does), position, `updatedAt`, metadata editor for `approvalRequired` / `externalStageMapping` / `canonicalRules`.

**2. Prompt** — the highest-value screen. Two panes:
- *Own prompt*: monospace editor over `node.prompt`, with the seven-section template (`Objective / Inputs expected / Output required / Completion criteria / Blocker criteria / Tool policy / Memory policy`) as soft section markers, since every node already follows it.
- *Effective prompt*: read-only, from `node.get_effective_prompt` — shows the node prompt **plus injected skill instructions** concatenated below a `---` separator. Today nothing in the UI reveals that a skill silently appends to the prompt. Operators are editing half a prompt without knowing it.
- Save via `workspace.update_node_prompt` with `expectedWorkspaceVersion`, preceded by a diff confirmation.

**3. Tools** — replace the JSON textarea with a two-column resolver view:

```
  TOOL                    OWN   EFFECTIVE   WHY
  stage.get_output         ✓    allowed
  stage.save_output        ✓    denied      approval_required
  project.call_tool        ✓    denied      risk_level_exceeds_authorization
  web.fetch                ·    —           node_tool_not_allowed
```

Left column = `node.allowedTools` (editable checkboxes against `tool.list`). Right column = `node.get_effective_tools`, showing `allowed` plus `denialReasons`. **This one screen would have surfaced the `contract_intelligence` defect immediately** (see §4). The registry gives you `riskLevel`, `sideEffect`, `requiresApproval`, `timeoutMs`, `category` per tool — group by category, badge by risk.

**4. Skills** — assign/unassign from `skill.list`, and below it render `skill.resolve_for_node` output: `effectiveTools`, `requestedTools`, `deniedTools`, and the **`conflicts` array with severity badges**. A `blocker` conflict must render red and block save-to-active. Today `article_body` carries a blocker conflict and no surface in the product shows it.

**5. Schemas** — `inputSchema` / `outputSchema` / the deprecated `schema` alias. Use `@rjsf` (already a dependency) for a form view, with a raw JSON escape hatch. Flag when `schema !== outputSchema` (currently identical on all 21 nodes — worth a migration to drop the alias). Include a "validate a sample payload" box wired to `workspace.validate_node`.

**6. Model** — `workspace.update_node_model_config` exists as a tool but `workspace.get_nodes` returns **no model fields at all**. Either the config lives elsewhere or the tool writes to a field nothing reads. Resolve this before building the tab; it may be a backend gap rather than a UI one.

**Cross-cutting save semantics.** Every mutation sends `expectedWorkspaceVersion`, `actor`, `source:"ui"`, and a `reason` string. The reason field must be required in the UI — the change ledger is only as good as the reasons in it, and with agents doing the editing, "why" is the only thing a human reviewer can act on.

### S5 — Operate mode (replaces the `RunsPage` stub)

- Run list from `workflow.list_runs`, filterable by project and status. Your Netlify plane has 21 runs (7 failed, 1 blocked, 2 stuck in `running`) with no UI to inspect any of them.
- Run detail: node-by-node timeline with status, `durationMs`, input dependencies, output artifact, errors. The data is already in the run record — `workflow.get_run` returns per-node `input` / `output` / `durationMs`.
- Live canvas overlay: in Operate mode, colour the same React Flow graph by node run status. One graph, two modes — do not build a second canvas.
- Controls: `run_node`, `run_next_node`, `run_until`, `run_all`, `pause`, `resume`, `retry_node`, `cancel`, `reset` — all exist as tools. Gate `run_all` behind a confirm.
- Cost per run from `workflow.get_run_cost`, with the pricing caveat the API itself returns ("placeholder estimates, not billing-grade") shown inline, not buried.
- **Publish panel**: render `workflow.publish_readiness` as the 8-item checklist it returns, with per-item `detail`. This is the single most important screen for your Dr. Lurie goal and it maps 1:1 to an existing tool response.

### S6 — History mode

The change ledger is genuinely good — richer than most products manage. `changes.list` returns, per event: `eventId`, `type`, `operation`, `target`, `actor` (kind/id/label), `source`, `reason`, `parentRevisionId`, `resultingRevisionId`, `workspaceVersion`, `riskLevel`, and **full `before` and `after` node snapshots**, plus a `correlation.requestId`.

- Timeline filtered by node, actor kind, operation, source, date.
- Semantic diff per event — field-level, not raw JSON. Prompt diffs get a text diff; tool/skill arrays get added/removed chips.
- Restore via `changes.restore`, with a preview of what restoring would change against current state.
- **Group by `correlation.requestId`** — when an agent makes eight edits in one task, show them as one collapsible unit. This is the feature that makes agent oversight tractable, and you already emit the correlation id.

### New: an Attention surface that actually resolves

`constellation.get_attention` currently returns `items: []` on a workspace that has at least two real defects (§4). It evidently checks runs and approvals but does not run skill/tool resolution. Extend it server-side to include:
- nodes with `blocker`-severity skill conflicts
- nodes whose assigned skill requests a tool the node denies
- nodes where `dependsOn ≠ requiredInputs`
- projects where `connection.endpointConfigured` is false but nodes reference that project

Then the Overview page becomes a real dashboard instead of an empty state.

---

## 4. Defects found while auditing (all reproducible)

These came out of the dry runs. Two are on the Dr. Lurie publish critical path.

**D1 — Split-brain control planes.** *Severity: blocking.*
Netlify (`blobs`) is at `workspaceVersion 89`, 24 agents, 21 runs, and **has** `DR_LURIE_MCP_ENDPOINT`/`TOKEN` configured. Cloud Run (`gcs`) — the plane you've designated canonical — is at version 56, 21 agents, 3 runs, and `project.test_connection("dr-lurie")` fails: *"Project MCP endpoint is not configured (DR_LURIE_MCP_ENDPOINT)."* The two planes also disagree on `dr-lurie.allowedTools`: GCloud grants `save_artifact`, `create_artifact_from_url`, `create_artifact_upload_intent`; Netlify does not.
**Consequence: the canonical plane cannot publish to Dr. Lurie at all today.** Fix before any live test — see the protocol doc, Tier 0.

**D2 — `contract_intelligence` is structurally unable to do its job.** *Severity: blocking.*
The node's entire purpose is calling the Dr. Lurie MCP for contracts. It lists `project.call_tool` in `allowedTools`. But its `riskLevel` is `read`, and `project.call_tool` is registered `write` — so `node.get_effective_tools` returns `allowed:false, denialReasons:["risk_level_exceeds_authorization","approval_required"]`. Every downstream node depends on contract intelligence it can never fetch.
Fix: raise the node to `riskLevel:"write"`, or reclassify a read-only project call path. This is a policy decision, not a mechanical one — flagging rather than fixing.

**D3 — `article_body` carries an unsurfaced blocker conflict.** *Severity: high.*
`skill.resolve_for_node("article_body")` returns:
> `{"severity":"blocker","source":"dr_lurie_contract_intelligence","message":"Skill output schema is incompatible with the node output schema."}`

plus a warning that `project.call_tool` is requested by the skill but not granted by the node. `effectiveTools` resolves to `[]`. Nothing in the GUI shows any of this.

**D4 — Attention endpoint misses D2 and D3.** *Severity: medium.* Covered in §3.

**D5 — Version conflicts surface as untyped errors.** *Severity: medium (high for your use case).*
Writing with a stale `expectedWorkspaceVersion` correctly rejects — but as `MCP error -32603: Tool execution failed`, not a structured envelope. A GUI cannot distinguish "you're out of date, here's the current version and the diff" from "the server broke". With multiple agents editing concurrently — your stated scenario — this is the difference between a usable merge prompt and a dead end. Return `{ok:false, code:"version_conflict", currentVersion, currentRevisionId}` instead.

**D6 — `trust_factual` metadata inconsistency.** *Severity: low.* `dependsOn: ["draft_writer","research"]` but `requiredInputs: ["draft_writer"]`. Every other node keeps them identical.

**D7 — `schema` is a dead duplicate of `outputSchema`.** *Severity: low.* Byte-identical on all 21 nodes. Deprecate and drop; don't build UI for it.

---

## 5. Sequencing

**Phase 0 — unblock (do first, small).**
1. Add GitHub Actions running `npm test && npm run test:ui && npm run build`. 94 tests with no CI is the main risk to everything below.
2. Wire `DR_LURIE_MCP_ENDPOINT` / `DR_LURIE_MCP_TOKEN` into Cloud Run (D1).
3. Reconcile the two planes: `workspace.export_workspace` from Netlify → `workspace.import_workspace` into GCloud, then diff to confirm. Decide what happens to Netlify afterwards — read-only mirror, or retire.
4. Return typed version-conflict envelopes (D5) — this changes the contract the whole S4 save path is built on, so it must land before S4.

**Phase 1 — S4 node inspector.** Tabs in value order: Prompt → Tools → Skills → Overview → Schemas → Model. Ship behind a flag; keep the legacy tab live until parity. Delete `Inspector.tsx` and the legacy panels only once S4 covers every field they touch.

**Phase 2 — S5 Operate.** Run list → run detail → canvas status overlay → controls → publish readiness panel.

**Phase 3 — S6 History.** Timeline → semantic diff → restore → requestId grouping.

**Phase 4 — Attention resolution + Dr. Lurie live publish enablement.** Only after the protocol's dry-run tiers pass twice.

**Architectural constraints to hold** (from your own `migration-plan.md`, worth restating because agents will be doing the work): semantic CSS tokens only, no arbitrary z-index, no overlapping absolute panels, MIT React Flow only, pure logic in framework-free modules tested by root vitest with thin components on top. That last one is why the existing test suite is usable at all — keep it.

---

## 6. Where LibreChat fits

Keep it, but scope it. The `Workspace Inspector` agent (LibreChat v0.8.7, claude-sonnet-4-5, pointed at `cms-agent-gcloud`) is a good **read/diagnose** surface — better than a GUI for "why is this node failing". In the transcript it correctly refused a rename, citing read-only mode, while its own instructions said "Edit nodes on behalf of the user" — that contradiction should be resolved deliberately, not by accident.

Recommendation: **two agents, not one.**
- `Workspace Inspector` — read-only tools only. Diagnosis, explanation, drift checks. Safe to use freely.
- `Workspace Editor` — adds `workspace.update_node_*`, with a system prompt requiring a `reason` on every write and forbidding `publish.*` and `workflow.publish_run` entirely.

The GUI is the surface for deliberate, reviewable change. LibreChat is the surface for investigation and bulk mechanical edits. Don't make either do both.
