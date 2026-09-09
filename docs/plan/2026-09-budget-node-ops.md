# 2026-09-09 — budget ceilings that cannot cover a retry (W2.2)

Two node ceilings are raised here. A third node the original brief named is **deliberately left
alone**, because the number that condemned it was wrong.

## What changed since the brief was written

The brief called for raising `article_body`, `reader_simulation` and `narrative_movement` on the
strength of p95 costs of **$1.49 / $0.28 / $0.24** read from `workflow_get_run_cost`'s
`nodeTimingAggregates`. W0.2 established that this figure, at the time those were read, summed
**actual + estimated** spend, double-counted orchestrator retries, and pooled four tenants under one
`workflowId`. It was not a measurement.

Re-derived from `usage.list_records` (`status: "actual"`, one record per dispatch), the same three
nodes look like this:

| node | n | p50 | p95 | worst | ceiling | headroom vs worst |
|---|---|---|---|---|---|---|
| `narrative_movement` | 40 | $0.041 | $0.090 | $0.121 | $0.15 | **1.24x** |
| `reader_simulation` | 30 | $0.087 | $0.160 | $0.169 | $0.20 | **1.18x** |
| `article_body` | 30 | $0.257 | $0.403 | $0.438 | $1.125 | 2.57x |

None of the three is over budget. The brief's premise — "budget < p95" — does not survive an honest
ledger.

## The real defect, and why two ceilings still move

The node ceiling is enforced **per dispatch**, and `guardState` is shared across the runner's own
in-dispatch retries. So a node must be able to afford **two attempts**, not one.

Live evidence, `run_1788769566432_5qnafb`, `narrative_movement` (ceiling $0.15): one attempt ran long
and hit the node's 3500-token output cap, costing **$0.121**. The in-dispatch retry was then priced at
that cap again and refused — `$0.121 + $0.121` against `$0.15`. The node's measured p95 is $0.090.

W2.1 (code) removes the systematic half of that: the guard now reserves the node's **measured p95
output tokens** instead of the cap most nodes never approach. Only the output term is measured — the
input term stays the live, growing request size, because that is the runaway detector the guard was
built around. It cannot fix the rest — after an attempt that genuinely spent $0.121, no reserve arithmetic makes a second attempt
fit under $0.15. That needs a ceiling that covers two attempts at the node's **worst observed**
dispatch.

`article_body` already does (2 x $0.438 = $0.875, under its $1.125), so it does not move. Raising it
to the brief's $1.90 would buy nothing and would widen a ceiling on the single most expensive node in
the graph — the wrong direction to move without a reason.

## Ops

Both patches are **merges** — `workspace.update_node_model_config` recursively merges the keys given
and preserves every key omitted, so `model`, `timeout`, `maxTurns` and `maxOutputTokens` are
untouched. Re-running an op is a no-op. Verify against `workspace_get_node` first and apply only
where the store disagrees.

> **Applying these:** `npm run nodes:apply` parses only `workspace_update_node_{input_schema,
> output_schema,prompt,metadata}` and `workspace_create_node` — it has **no model-config op**, so it
> cannot apply this doc. Run the two calls below directly against the live workspace, or extend
> `scripts/applyNodeOps.ts` with a `model_config` kind first (the merge semantics above make that a
> contained change). This is stated rather than worked around: silently hand-editing node literals
> would put the store and canonical out of sync, which is the drift `store:check` exists to catch.

### 1. `workspace_update_node_model_config` — node `narrative_movement`

$0.30 is 2 x the worst dispatch this node has ever recorded ($0.121), rounded up. At $0.15 it covers
1.24 attempts; at $0.30 it covers two of its worst and roughly seven of its median.

```json
{ "id": "narrative_movement", "patch": { "modelConfig": { "budgetUsd": 0.3 } } }
```

### 2. `workspace_update_node_model_config` — node `reader_simulation`

$0.40 is 2 x the worst dispatch recorded ($0.169), rounded up. At $0.20 it covers 1.18 attempts.

```json
{ "id": "reader_simulation", "patch": { "modelConfig": { "budgetUsd": 0.4 } } }
```

### Not applied: `article_body`

Left at $1.125. Recorded for the next reader so the omission is a decision rather than an oversight:
its worst dispatch is $0.438 and two of those fit inside the existing ceiling with $0.25 to spare.

## After applying

`store:check` will report the two nodes as differing from canonical (`nodes.ts` still carries 0.15 /
0.20). That is expected and is the same state every other operator budget decision leaves behind;
fold the values into `nodes.ts` on the next canonical pass if they prove out.
