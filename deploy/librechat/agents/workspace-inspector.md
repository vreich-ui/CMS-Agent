# Smoke agent — "Workspace Inspector"

The one agent that proves the end-to-end loop: chat → LibreChat Agent → native
MCP client → `cms-agent-gcloud` → real workspace data back into chat. **Read-only.**

Agents are created in the LibreChat UI (Agent Builder), so this is the
reproducible spec to enter there — not a file the app loads.

## Configuration to enter in Agent Builder

| Field | Value |
|-------|-------|
| **Name** | `Workspace Inspector` |
| **Provider / Model** | Anthropic — Claude (e.g. `claude-sonnet-5` for cheap inspection, or `claude-opus-4-8` for deeper reasoning) |
| **MCP server** | `cms-agent-gcloud` **only** |
| **Tools** | READ-ONLY subset only (see below) |

### Tools — the smallest subset that does the job (read-only)

From `cms-agent-gcloud`, add ONLY these:

- `workspace_get_nodes` — list the workspace nodes
- `workspace_get_node` — get one node
- `node_get_effective_prompt` — a node's effective (merged) prompt
- `skill_list` — reusable workspace skills
- `constellation_get_summary` — agent/relationship/run counts (read-only)
- *(optional read add:)* `constellation_get_structure` — pipeline shape/edges

**Do NOT add** any `*_update_*`, `*_create_*`, `*_delete_*`, `workflow_*`,
`node_execute`, `optimizer_promote`/`optimizer_auto_promote`, `publish_*`, or any
other write / publish / mutation tool. Never "all tools".

### Instructions (paste verbatim)

```
You inspect an agentic CMS workspace. Report what you find factually. You may
only read. Never call write, publish, or mutation tools.
```

## Test

Prompt the agent:

> List the workspace nodes and summarize the pipeline.

### PASS criteria

It calls `workspace_get_nodes` on `cms-agent-gcloud` and returns the **real
21-node pipeline**. Verified live at authoring time — the 21 nodes are:

| # | id | name | risk |
|---|----|------|------|
| 1 | `input_triage` | Publishing Input Triage | read |
| 2 | `topic_opportunity` | Topic Opportunity Agent | read |
| 3 | `reader_insight` | Reader Insight Agent | read |
| 4 | `research` | Research Agent | read |
| 5 | `objection_mapping` | Objection Mapping Agent | read |
| 6 | `narrative_movement` | Narrative Movement Agent | read |
| 7 | `angle_strategy` | Angle Strategist | read |
| 8 | `brief_architect` | Brief Architect | read |
| 9 | `draft_writer` | Full Draft Writer | read |
| 10 | `human_texture` | Human Texture Editor | read |
| 11 | `trust_factual` | Trust / Factual Editor | read |
| 12 | `emotional_resonance` | Emotional Resonance Evaluator | read |
| 13 | `reader_simulation` | Reader Simulation | read |
| 14 | `review_aggregator` | Review Aggregator | read |
| 15 | `article_body` | Article Body Builder | write |
| 16 | `publish_payload` | Publish Payload Builder | write |
| 17 | `publication_controller` | Publication Controller | publish |
| 18 | `learning_recorder` | Learning Recorder | write |
| 19 | `contract_intelligence` | Contract Intelligence Agent | read |
| 20 | `artifact_plan` | Artifact Planning Agent | write |
| 21 | `publish_executor` | Publish Executor | publish *(draft — activation-gated)* |

(Totals: 15 read · 4 write · 2 publish; 20 active + 1 draft.)

If the agent instead returns a generic/hallucinated pipeline, or errors, the MCP
wiring or the `CMS_AGENT_KEY` is wrong — fix that before building any further agents.
