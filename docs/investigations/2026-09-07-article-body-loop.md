# `article_body_validation_loop_exhausted` — root cause

Run `run_1788769566432_5qnafb`, project `dr-lurie`, 2026-09-07. Written before the W1 fix, from the
saved run record plus the source at the commit this document lands on. Line numbers are current as of
that commit; where an earlier note cited a different number, the drift is noted rather than silently
corrected.

## The observed failure

`article_body` completed with `warnings: [stale_dispatch_reclaimed, article_body_validation_loop_exhausted]`
and `blockers: []`, after 70.4s and $1.51 (39% of the run). Its recorded verdict:

```json
{ "revalidations": 1, "revisionTurns": 1, "mechanicalFixes": [], "outcome": "invalid", "boundedExhaustion": true }
```

The engine loop ran, spent its one permitted model revision turn, and the body came back still
carrying the same three violations. `publish_payload` then reused that recorded verdict rather than
re-earning it and raised its own `client_validation_failed` blocker
(`src/agent/workspace/publishPayload.ts:267`), which is the designed behaviour: the gate worked. What
failed was the repair path.

The client validator's three violations, verbatim from the run record:

```
nodes.24.private.strategy: Invalid option: expected one of "hook"|"agitation"|"context"|"explanation"|"proof"|"example"|"comparison"|"myth"|"step"|"recommendation"|"resolution"|"summary"
nodes.28.public.items.0: Invalid input: expected string, received array
nodes.28.public.items.1: Invalid input: expected string, received array
```

## Verdicts on the four hypotheses

| # | Hypothesis | Verdict |
|---|---|---|
| H1 | The model never saw the intact 12-value `strategy` enum, because `contract_intelligence` overflowed the 48,000-char dependency bound and got halved. | **False.** |
| H2 | The revision copied itself: the issues were buried under a ~30K-char `previousOutput` and an instruction to re-emit the same envelope. | **Undetermined — and undeterminable from the record.** |
| H3 | The issues reach the revision as one raw client-validator object with three problems joined into one `message`, not as separate strings. | **True. Primary defect.** |
| H4 | The workspace `outputSchema.body` is untyped, so structured output can enforce nothing and the client validator is the only judge. | **True. Structural.** |

### H1 — false

`contract_intelligence`'s stageOutput for this run serializes to **28,830 characters** against the
48,000-char per-dependency bound (`src/agent/execution/runners/OpenAINodeRunner.ts:60`), measured by
running the real `boundDependencyOutput` over the real captured payload. It is returned as the same
object reference, untouched, with no truncation ledger. All 12 `strategy` values reached the model
verbatim, on the first dispatch and on the revision alike — `boundDependencyOutput` is a pure function
of size and the dependency did not change between them.

The path in the delivered payload is
`bodySchema.properties.nodes.items.properties.private.properties.strategy.enum` — camelCase
`bodySchema`, as `contract_intelligence` actually emits it, not the `body_schema` that earlier prose
used.

Information starvation was not the cause. The model had the right answer in front of it twice and
emitted `"reassurance"` both times — a value that is not in `strategy`'s enum but is adjacent to the
node's own valid `private.intent: "reassure"`. That is a conflation of two neighbouring closed
vocabularies, not a gap in either.

### H3 — true, and the defect W1 fixes

The client validator returns **one** issue object naming all three problems:

```json
[{ "id": "schema_zod", "label": "Per-type schema", "status": "missing",
   "message": "<problem 1>; <problem 2>; <problem 3>" }]
```

That array is passed to the revision without any transformation. `articleBodyValidation.ts:342` hands
`validation.issues` straight to `deps.revise`, and the executor embeds it, unflattened, as
`validationFeedback.issues` (`src/agent/workspace/executor.ts:2966-2977`). So the model is asked to
fix three distinct violations — one enum misuse and two array-shape errors, in two different nodes —
from a single dense string whose `status` field reads `"missing"`, which describes none of them.

Beside it in the same object sits `previousOutput`: the model's entire prior envelope, ~29-30K
characters. That is the one part of the revision input nothing bounds. The runner strips only
`dependencies` and `imageRefs` from `input` before prompting
(`OpenAINodeRunner.ts:422`, `:427`); `boundDependencyOutput` applies to `dependencyOutputs` only, so
`validationFeedback` — issues, instruction and the full previous envelope — travels into the prompt
whole. The accompanying instruction is "Emit the SAME output envelope again with only the changes
those issues require."

The result, per the usage records: the revision carried 26% more input tokens than the first dispatch
and produced a body in which neither flagged defect was resolved — while its own `summary` claimed
"Re-emitted after validation feedback with the rejected comparison items converted from arrays to
strings", and never mentioned the strategy defect at all. A compound correction, densely worded, acted
on incompletely and inaccurately even where it was acted on.

### H2 — undetermined, and that is itself a defect

The run record keeps exactly **one** `article_body` body: one artifact entry, and
`run.nodes[article_body].output` is the same object as `run.stageOutputs.article_body`. The
pre-revision body is not recorded anywhere. So it cannot be established whether the revision changed
the body at all, in any respect, or returned a copy.

That gap is what makes the summary/body contradiction unresolvable: a confident summary claiming a fix
sits over a body where no fix is present, and nothing in the record says whether the revision edited
something else, edited nothing, or edited and lost it. W1.3 closes this by fingerprinting the body on
either side of the revision turn and recording `engineLoop.revisionChangedBody`, reusing the same
`stableHash` that already produces `bodyFingerprint` (`articleBodyValidation.ts:376`).

### H4 — true, structural, out of scope for W1

`article_body`'s workspace outputSchema declares `body` as
`{"type": "object", "minProperties": 1, "additionalProperties": true}`
(`src/agent/workspace/nodes.ts:2928-2932`) — no properties, no enums, no item typing. The runner passes
that schema to the model as its structured-output type, so structured output cannot enforce the
client's `strategy` enum or its `items: string[]` shape. The client's own validator, called after the
model returns, is the only judge — by which time the loop's single revision turn is already spent.

Fixing this means editing node literals in `nodes.ts`, which requires a re-seed of the store-sourced
live workspace. Out of scope here; recorded so the next wave that touches `nodes.ts` knows the cost of
leaving it.

## Call order, as the run took it

1. `executor.ts:2948` — `ownsValidationLoop(article_body)` true, live mode, body present → the loop runs.
2. `articleBodyValidation.ts:329` — validate #1 → invalid, one issue object naming three problems.
3. `articleBodyValidation.ts:332` — `applyMechanicalFixes` → no match on this run's code (the two
   classes that would now match were added by W3, commit `66d4dbb`, after this run). `fixes: []`.
4. `articleBodyValidation.ts:341-342` — `deps.revise` present, `revisionTurns 0 < 1` → revision
   dispatched at `executor.ts:2966` with `input = {...state.input, validationFeedback: {source,
   attempt, issues, previousOutput, instruction}}`.
5. `OpenAINodeRunner.ts:427` — prompt assembled; `validationFeedback` survives into it whole, deps are
   re-sent bounded at 48,000 chars each.
6. `articleBodyValidation.ts:348-358` — the revision returned a usable body → `revalidations` 1 →
   validate #2 → still invalid, same three problems.
7. Loop re-enters, finds nothing mechanical, and breaks at `:341` on `revisionTurns >= 1`.
   `:365` `boundedExhaustion` true → `:366` pushes `article_body_validation_loop_exhausted`.
8. `executor.ts:2999` `promoteValidationUnavailableToBlocker` — a no-op here; it promotes only
   `article_body_validation_unavailable*`. `article_body`'s `blockers` stays `[]`.
9. `publishPayload.ts:267` — the recorded verdict is reused and becomes `client_validation_failed`.

## What W1 changes, and why that is the right seam

The revision turn is the only self-repair the loop has, and it was being handed the correction in the
least usable form available: three problems in one string, next to 30K characters of the model's own
prior output, under an instruction to reproduce that output. W1 changes the shape of that hand-off and
nothing else:

- **Flat issues.** `validationFeedback.issues` becomes one plain string per real problem, split on the
  client's own `"; "` joiner. The untransformed original is kept under `validationFeedback.rawIssues`,
  so the flattening can never be a lossy rewrite of what the client said.
- **A compact target instead of the whole envelope.** `previousOutput` leaves `input` entirely,
  replaced by `revisionTarget: {nodeIds, paths, currentValues}` derived from the paths the issues
  themselves name — `nodes.24.private.strategy` resolves to node id `n_p14`, that path, and its current
  value `"reassurance"`.
- **A recorded answer to H2.** `engineLoop.revisionChangedBody` says whether the revision turn changed
  the body at all. Read with `revisionTurns`: `{revisionTurns: 1, revisionChangedBody: false}` is a
  revision that ran and did nothing — exactly the case this run could not prove or disprove.

W1 deliberately does not change which dependencies the revision is sent (a W4 proposal), does not touch
`nodes.ts` (H4), and does not weaken `article_body_validation_loop_exhausted`. An honest failure stays
honest; what changes is how much of a chance the repair turn is given before it fails.

### Consequence to watch

Removing `previousOutput` also removes the model's only copy of its prior envelope: the revision is a
fresh dispatch with no conversational memory, so it now rebuilds the envelope from its dependencies
plus `revisionTarget` rather than editing a copy in front of it. That is the intended trade — the prior
envelope demonstrably did not buy a correct edit on this run, and it cost ~26% of the revision's input
tokens — but it means a revision can now diverge from the first body in places the issues never named.
`revisionChangedBody` makes the blunt fact visible; a field-level diff of what changed does not exist
yet and is the natural follow-up if divergence shows up in a live run.
