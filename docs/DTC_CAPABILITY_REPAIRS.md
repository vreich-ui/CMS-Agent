# CMS-Agent DTC capability repairs — 9 September 2026

The CMS-Agent audit found that assigned skills appeared in the effective-prompt preview but were
absent from both provider requests. It also found that a warning first emitted by an editorial node
could erase the hard factual-review source during deduplication. This change repairs those runtime
paths, preserving the existing tool authority, project hard-source overrides and own-property waiver.
Duplicate blockers count once, retain their contributing source IDs, and are classified under an
integrity source when any contributor requires it. The decision notes retain the source trail for
hard blockers; advisory and waiver records retain it structurally.

## Workspace corrections applied through MCP

These are store edits to `publishing_conductor`, not a canonical re-seed. Six atomic
`workspace_update_node` operations used `expectedWorkspaceVersion` and `baseRevisionId` after
read-only candidate validation. Workspace versions 1056–1061 were read back successfully.

| Node | Version | Correction |
|---|---:|---|
| `article_body` | 1056 | Name `artifact_materializer` as the source of generated, verified media. |
| `topic_opportunity` | 1057 | Describe routing recommendations as advisory; do not claim the graph was changed. |
| `research` | 1058 | Require evidence status, sources, findings, blockers and advisories. |
| `draft_writer` | 1059 | Require actual draft sections, claim notes, one next step and explicit ready/blocked status. |
| `trust_factual` | 1060 | Require claim reviews and a verdict; revise/blocked requires top-level blockers. |
| `review_aggregator` | 1061 | Require actionable revisions, conflicts, build instructions and preserved factual blockers. |

Only prompts, the four corresponding output schemas (including their deprecated `schema` mirror),
and automatic update timestamps changed. Models, tools, skill assignments, dependencies, metadata,
approvals and deterministic flags were unchanged. Existing `magnetic_marketing` assignments and
operator-specific instructions were preserved. No workflow, tenant content write, publish or release
was executed to make these changes.

`scripts/dtcPublishingNodeCorrections.ts` exports a pure transformation over a freshly read node.
It is idempotent, preserves existing fields, and refuses competing schema definitions. For another
workspace, inspect the current node and its policies, generate the proposed patch, validate the full
candidate via MCP, apply the patch with the current workspace version/revision, and verify read-back.
Do not pass these patches to a blanket canonical re-seed. The helper does not perform remote writes.

## Evidence and limits

Tests capture the actual outgoing OpenAI and Anthropic instruction fields using provider doubles.
They cover next-dispatch skill edits, inactive/missing/conflicting skills, instruction deduplication,
unchanged tool grants, factual-source ordering, project promotion, prefix echoes and existing waivers.
Handoff tests reject summary-only outputs and accept explicit refusals. Live MCP validation independently
rejected summary-only draft/factual-review fixtures and accepted a structured blocked factual review.

Schemas enforce shape and basic status consistency; they cannot prove citations were read, source IDs
resolve, prose is persuasive, every factual claim was found, or recommended edits were applied. Those
remain evaluation and workflow design work. Stored artifacts from earlier runs were not rewritten.
The six MCP fixes are live; the runner/controller fixes require code deployment and a separately
authorized, publication-withheld end-to-end check before claiming live model behavior is verified.

## Remaining design work

1. Make EV-floor skip decisions consume an engine-produced, provenance-checked result. Adding a
   prompt or the missing live `monetize.ev_floor` grant alone cannot authenticate a model-authored
   verdict. Keep the live cluster-aware monetization contract intact when implementing this.
2. Establish where material factual revisions are applied and rechecked against the final body;
   the aggregator cannot certify its own proposed changes as complete.
3. Add DTC evaluations for offer clarity, evidence coverage, objections, voice and the primary action,
   using the existing `magnetic_marketing` skill. Schema validity is only the entry condition.
4. Audit the wider tool/skill metadata contracts separately. This repair activates skill instruction
   text; it does not make every declared memory policy, artifact requirement or completion criterion
   an enforced execution rule.
