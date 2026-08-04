# CMS-Agent — session handoff

**This file lives in the repo on purpose.** Earlier handoffs lived in Claude Project knowledge, which
neither a Cowork session nor Claude Code can read — one cost a session-start to a screenshot. Anything
the next session must know goes here.

**Rule: a gate check is a command with an expected result. Prose is not a gate check.** If you cannot
write the call and what it should return, it is context, not a gate — put it under "State".

_Last updated 2026-08-04 by Session C (paid cost/quality baseline run)._

---

## Gates — run these before spending anything

All are free. Run in order. Any FAIL stops the session.

### G1 — Is the merged code actually serving?

```
MCP_URL=… MCP_API_TOKEN=… npm run verify:deploy
```

PASS: served tool surface hashes equal to `docs/mcp-tool-manifest.json`, endpoint/token configured for
every project. As of PR #96 the manifest is **135 tools**; a live count of 137 means the pre-#96
revision is still serving.

FAIL: a stale revision is serving. **Main deploys itself**: every push to main runs the
`cms-agent-mcp-deploy` trigger (`cloudbuild.deploy.yaml` — build → push → deploy → verify), so read
that build's log first; its verify step fails unless the serving image is the build's own, and
concurrent builds resolve by commit ancestry (the newest commit's build redeploys itself if an older
build raced past it — first hit 2026-07-31). Manual fallback remains `scripts/deploy-mcp.sh`. Never
`--set-env-vars`: it replaces the whole environment and has silently deleted the six
client-connection variables twice while health stayed green.

### G2 — Does every publish-capable project have its object dialect?

```
repository_get_health()
```

PASS: `data.health.project` exists and carries **no** `details.objectDialectFindings`.

FAIL (key present): a project whose hooks export `executePublish` is missing required `objectDialect`
fields; it is named in the finding. Fix in `src/agent/projects/<id>/definition.ts` and deploy —
**`project.update` has no `objectDialect` field, so no live MCP path can ever set it.**

> Do **not** check this by reading `project_get(<id>).knowledge` for a `site` block. `project.get`
> returns connection metadata plus the project's static hook-knowledge module; `objectDialect` is in
> neither. `dr-lurie`'s `knowledge.site` is a hand-written doc block missing `objectIdSource` and
> `defaultObjectType`, which is proof the two are different things. A 2026-07-30 handoff made exactly
> this mistake and would have produced a false STOP on a healthy workspace.

### G3 — Graph valid

```
workspace_validate_graph()
```

PASS: `{ valid: true, issues: [] }`.

### G4 — Attention clean

```
constellation_get_attention()
```

PASS: zero `blocker`-severity items. `action` items that are publish-gate approvals are the locks
working as designed and are expected.

### G5 — Publish posture known (GO-LIVE 2026-07-31 inverted this gate)

```
project_list()
```

Since the 2026-07-31 go-live (PR #104, operator decision), `publishingPolicy.publishEnabled: true` on
every project is the DESIGNED state, and `workflow_publish_run`'s `approved`/`live` default true. PASS
is now: you KNOW the posture and every test/measurement run passes `approved:false` or `live:false`
**explicitly** (or sets the `<CLIENT>_PUBLISH_ENABLED=false` kill-switch). Never rely on a default.
See the project doc `claude/cms-agent-GO-LIVE-2026-07-31.md` for what still blocks (correctness
gates, kept deliberately).

### G6 — Do the live workspace and the seeded code agree?

```
npm run nodes:check
```

PASS: clean, no rewrite proposed.

FAIL: live and `nodes.ts` have drifted. Re-seed with `npm run nodes:update` (needs live access) and
commit. **Never hand-copy live prompts over the seed** — that overwrites drift you cannot see, which
is the R-1 failure mode in a different hat.

### Before merging any code

```
npm test && npm run test:ui && npm run test:drift && npm run test:glossary && npm run test:objects
```

---

## Standing habits, earned the hard way

1. **After any workspace-data fix, check whether the code-defined defaults carry the same defect.**
   Taught three times: snoocle, the 14 ungrantable `stage.save_output` grants, and the whole node set.
   A data write looks complete and the next fresh workspace undoes it.
2. **A blocker recorded once and then cited by later documents acquires the appearance of having been
   verified.** Taught three times: R-3 and the S4 Schemas tab, F-1's "stale fixture" diagnosis, and
   the G2 gate above. Re-derive a claimed dependency from the code before building on it.
3. **Main is live; the build log is the receipt.** Every merge to main deploys via the
   `cms-agent-mcp-deploy` trigger, whose verify step proves the serving revision. A green merge with
   a red build means the fix did NOT ship — read the build log, not the merge, to know what is
   serving.
4. **Every dollar figure in these docs is an estimate, not a bill.** Every entry in
   `modelPricingCatalog` is `placeholder: true, "not billing-grade."`

---

## State — 2026-08-04 — Session C: paid cost/quality baseline run (PARTIAL — real cost $2.028635)

**Total real spend this session: $2.028635** (58% of the $3.5 ceiling set for this run). Real money,
authorized directly by Wolf ("do Session C"). Run `run_1785842430906_tqjk1o`, `requestId`
`req_1785842430906_nser80`, same frozen T-2 brief as `run_1785405350649_9u5mjz` for direct
comparability. Publish gates were never approached — `contract_intelligence` was the last node with
a `publishPolicy` opinion and nothing downstream of it that could publish ever ran.

**Run status: `failed`, at `article_body`, after two failed retries.** 16 of 21 nodes completed with
real output; `article_body`, `artifact_plan`, `publish_payload`, `publication_controller`, and
`publish_executor` never produced real content. This is a partial baseline, reported honestly as
partial — not patched into looking complete.

### Per-node cost table (real, `openai` mode)

| node | status | inputTokens | outputTokens | costUsdEstimate |
|---|---|---|---|---|
| input_triage | completed | 746 | 466 | 0.017710 |
| topic_opportunity | completed (1 retry) | 5,103 | 856 | 0.051195 |
| reader_insight | completed | 992 | 532 | 0.020920 |
| research | completed | 37,817 | 3,428 | 0.291925 |
| objection_mapping | completed | 3,013 | 1,817 | 0.069575 |
| narrative_movement | completed | 2,373 | 1,772 | 0.065025 |
| angle_strategy | completed | 2,295 | 665 | 0.031425 |
| brief_architect | completed | 8,194 | 3,428 | 0.143810 |
| draft_writer | completed | 4,214 | 3,733 | 0.133060 |
| human_texture | completed | 4,266 | 822 | 0.045990 |
| trust_factual | completed | 6,830 | 1,049 | 0.065620 |
| emotional_resonance | completed | 4,668 | 727 | 0.045150 |
| reader_simulation | completed | 4,265 | 595 | 0.039175 |
| review_aggregator | completed | 3,050 | 1,030 | 0.046150 |
| **contract_intelligence** | completed | **0** | **0** | **0.000000** |
| article_body | **failed x2** | 84,198 | 13,429 | 0.823860 |
| artifact_plan | queued (never ran) | — | — | — |
| publish_payload | queued (never ran) | — | — | — |
| publication_controller | queued (never ran) | — | — | — |
| learning_recorder | completed | 22,851 | 793 | 0.138045 |
| publish_executor | queued (never ran) | — | — | — |

**`contract_intelligence` real cost is $0.00 on a real, live, paid run** — Session D's deterministic
mapper fired correctly outside any test harness. Node output content matches the mapper's designed
shape exactly (13 constraints, all blocking, `enforcedLive: true`; taxonomy `unknownTermsBlock: true`;
`publishPolicy.gated: true`; 4 unmapped-contract notes surfaced, not dropped; `blockers: []`; no
`mediaPolicy` duplicate). This is the strongest evidence to date that Session D's fix works, not just
in its own unit tests.

### Two real, repeatable budget-ceiling findings — reported, not silently patched

- **`topic_opportunity`'s $0.10 node ceiling is too tight for current real cost.** First attempt hit
  `budget_exceeded` at $0.017 spent + $0.086 prospective turn. `workflow.retry_node` (the system's own
  suggested remedy) succeeded on the fresh attempt. One retry, low stakes, but the ceiling is
  measurably below what a real turn costs.
- **`article_body`'s $0.75 node ceiling is confirmed too tight, not a fluke.** First attempt: $0.418
  spent before failing. Retry: $0.824 total across both attempts, also failed. Two failed retries at
  the same node is a repeatable result, not noise. **Did not raise the ceiling or retry a third time.**
  Per this phase's own standing rule — a cost figure changed without a held/improved rubric score
  behind it is an unmeasured downgrade — quietly loosening a live budget ceiling to make the number
  disappear is exactly the kind of unreviewed change this measurement work exists to catch. This is
  now Wolf's call: raise `article_body`'s `budgetUsd`, or accept it fails on this brief as designed.

### Rubric scores (both draft rubrics, real `openai`-mode judge, real outputs)

Rubrics remain `status: "draft"` — **not activated by Wolf.** Scored anyway per his direct
authorization to run Session C, using explicit `rubricId` references (the same pattern used
throughout this phase to bypass the "must be active" lookup). Treat these as first real data points,
not a validated pass/fail gate — draft weights are still Wolf's to finalize.

- **`contract_intelligence`** (`rubric_1785773022345_jzc74l`): **normalizedScore 0.90, pass: true.**
  Strongest criteria: severity/enforcedLive mapping (10/10), unknown-field surfacing (5/5),
  no-cross-project-conventions (5/5). Weakest: contract_fidelity (7/10) — the judge flagged several
  contract rule notes in the output as visibly truncated with ellipses, meaning some literal clauses
  may not be carried whole; worth a look independent of the rubric-weight question.
- **`research`** (`rubric_1785773086490_hmrj61`): **normalizedScore 0.857, pass: true.** Strongest:
  claim-risk flagging (5/5) — the brief honestly reported that the "platform" client record could not
  be resolved and hedged every claim accordingly rather than fabricating platform-specific detail.
  Weakest: recency/currency (3/5) — cited sources (Google SRE book, Martin Fowler on feature toggles)
  carry no visible publication date or fetch timestamp in the output.
- `article_body`, `publish_payload` rubrics: not scored — no real output exists for either node this
  run.

### Exit criteria status

Per-node cost table: done (above, repo + project doc). Rubric scores attached: done, for the 2 of 4
nodes with real output. **The number to beat, for the next comparable run:** total real cost
$2.028635 for 16/21 nodes with `article_body` unresolved; if `article_body`'s ceiling is raised and it
completes, expect total real cost to land somewhere above $2.35 (16-node total + a single successful
`article_body` attempt, historically ~$0.4-0.5 based on this run's first attempt) — an estimate, not a
promise. Actual total cost reported first, as instructed: **$2.028635.**

## State — 2026-08-04 — Session E: usage accounting, R-9, tracing policy

Scoped conservatively given the accounting code's history (three prior real incidents: the
artifact_plan 138% budget overshoot, R-20's mock-cost bug, the pre-#95 contract re-send) — additive
changes only, nothing touching the budget guard's own real-time gating math.

- **R-9 — `requestId` join key.** `WorkflowExecutionRecord.requestId`, minted once per run
  (`buildInitialRun`, distinct from `publish_payload`'s human-authored `req_<flow>_<topic>_<...>`
  publish-attempt id — this is a different, system-generated concept), preserved across a `resetRun`
  rebuild (same request, not a new one), and threaded onto every `recordModelUsage` call site (the
  workflow executor's dry-run path, `nodeRuntime.ts`'s independent-node path, both `OpenAINodeRunner`
  and `AnthropicNodeRunner`). A mock-mode conductor run's every usage record now carries the same
  `requestId` as the run itself — regression-tested.
- **`pricingAsOf` / `pricingCatalogVersion`** stamped on every usage record from two new exported
  constants (`MODEL_PRICING_CATALOG_ASOF`, `MODEL_PRICING_CATALOG_VERSION` in `modelUsage.ts`) — bump
  the version constant whenever a catalog RATE changes (not for a comment-only edit), so two records
  with different versions are a visible signal their costs are not directly comparable.
- **`cachedInputTokens` now actually captured** in `OpenAINodeRunner` — the reduce over
  `rawResponses` never read `input_tokens_details.cached_tokens` before; it silently stayed 0/undefined
  on every real run regardless of actual cache hits. Fixed and regression-tested.
- **Retry under-counting fixed.** A node that failed schema validation, retried, then succeeded
  previously recorded ONLY the successful attempt's tokens — the failed attempt's real, already-spent
  tokens vanished from the usage ledger entirely (recorded nowhere: not on that attempt, since it
  wasn't final; not folded into the eventual success record, which read only the last attempt's own
  `rawResponses`). Now a per-dispatch `cumulativeUsage` accumulator sums every attempt this dispatch
  obtained a real SDK result for, and the terminal record (success or exhausted-retries failure) is
  written from that sum, exactly once. Regression-tested for both directions: no double-counting
  (exactly one record) and no under-counting (the full sum, not just the last attempt). Deliberately
  did NOT touch `guardState.accrued` or the budget guard's own real-time turn-by-turn gating — that
  remains exactly as it was; `cumulativeUsage` is a new, independent, always-populated source (not
  gated on `budgetGuardEngaged`) that `recordAccruedUsage` now prefers over `guardState.accrued` when
  both exist, and falls back to `guardState.accrued` only for the case `cumulativeUsage` cannot cover —
  a throw before any full SDK response completed.
- **Attempt/turn/tool-call counts** attached to every recorded usage record's `metadata`
  (`attempt`, `attemptsTotal`, `turnCount`, `toolCallCount`).
- **Tracing: env-controlled, default OFF.** `AGENT_TRACING_ENABLED` must be the exact string `"true"`
  — anything else (including `"1"`) fails closed, tracing stays off. Replaces the hardcoded
  `tracingDisabled: true` literal. When enabled, `traceMetadata` carries exactly five fields —
  `runId`, `nodeId`, `projectId`, `executionMode`, `attempt` — built from named scalars, never from
  `input`, `dependencyOutputs`, or anything sourced from the node's own prompt or response; regression
  test asserts the exact key set and that arbitrary node-input content never reaches trace metadata.
  `workflowName` is also set (the SDK's own top-level option) when enabled.
- **Not done, scoped out deliberately:** `AnthropicNodeRunner` does not share the OpenAI runner's
  retry-accumulation fix (it has no comparable multi-attempt loop reading `rawResponses` the same way,
  and touching it wasn't necessary for R-9/pricing/tracing, which it already receives via the shared
  `requestId` threading and `recordModelUsage` schema). The "Agents SDK's accumulated run usage" the
  runbook mentions preferring — `cumulativeUsage` is the closest available equivalent given the
  installed SDK version's `run()` returns a batch result rather than exposing a running total; there is
  no separate SDK-native accumulator to prefer over it.

**Gates:** root suite 993/993 (+9 from this session), GUI 89/89, typecheck clean, UI production build
green, drift/manifest/alias parity ok, glossary + objects ok.

**Cost:** $0.00 model-run.

## State — 2026-08-04 — Session D: contract_intelligence made deterministic

**Session B2 (the scheduled rubric-content rewrite) stalled with no output for 1h15m+ and was abandoned.**
Its intended work — closing the research veto gap, re-anchoring field-ownership criteria to Wolf's
profession/publication seam, closing the media-free loophole, reweighting `no_side_effects`, authoring
the fifth `artifact_plan` rubric — was instead done directly in-session (manual `evaluation_update_rubric`
calls, not a fresh scheduled session) once B2's silence passed the point of plausible "still working."
All five rubrics remain `status: "draft"`. See project doc `claude/cms-agent-decisions-2026-08-03-rubric-gate.md`
for the seam ruling and `claude/cms-agent-session-B2-manual-result-2026-08-04.md` for what changed on
each rubric.

**Session D — the actual finding matters more than the fix.** Before writing any code, `node_get` on
`contract_intelligence` showed the "biggest lever" premise was already stale: PR #93/#95's deterministic
contract prefetch (conductor fetches + reduces the contract in code before the node runs) had already
dropped this node from the historical $3.79/run to **$0.134/run observed** (node-limits audit, v258) —
well under the phase's own $1 target. What was left was a model call whose entire declared job is field
mapping the already-reduced contract into the node's output shape.

- **New: `src/agent/workspace/deterministicContractIntelligence.ts`.** A pure function,
  `buildDeterministicContractIntelligence`, that performs that field mapping in code — no model call.
  Deliberately does NOT replicate two things earlier LLM outputs did: it never emits a separate
  `mediaPolicy` duplicate of `mediaConvention.policy` (the rubric review flagged exactly this
  duplication as a fidelity risk — "a derived duplicate that contradicts its source"), and it never
  invents an `idConventions.object`/`.nodes` client-specific grouping the raw reduced contract doesn't
  contain (inventing a partitioning scheme is exactly what `no_invented_client_rules` exists to catch).
- **Wired into `executor.ts`, opt-in per node** (`metadata.contractIntelligenceDeterministic`, set on
  `contract_intelligence` in both the canonical seed and — pending — the live store overlay). When the
  prefetch succeeds AND the mapped output validates against the node's own `outputSchema`, the node
  completes from the mapping directly: no model dispatch, no usage record at all (R-20's own logic: a
  $0 event stays $0). **Safety net:** any prefetch failure or schema-invalid mapping falls straight
  through to the unchanged model path — a mapping bug degrades to "spend the $0.134," never to a failed
  run or a malformed artifact reaching a downstream node.
- **Regression:** `tests/agent/workspace/deterministicContractIntelligence.test.ts` (9 tests) — schema
  validity and content fidelity of the mapper in isolation, an end-to-end proof driven through the real
  DAG in `openai` mode with **no OpenAI network stub configured at all** (succeeding is the proof no
  model call happened) plus a zero-usage-record assertion, and a fallback proof (prefetch failure still
  completes via the normal model path unchanged).
- **Live metadata flag now set** (`workspace.update_node_metadata`, workspaceVersion 263 — the store
  half of the fix, without which the code change alone does nothing live, the same gap #93/#95 hit
  once before). Graph re-validated `valid`; health green.
- **Honest limit found, not fixed: dataset-replay cannot verify this node's cost, at all, by
  construction.** `dataset.build`'s `storedInput()` extracts only `initialInput`/`input` and
  `dependencies` from a persisted node state — it never captures `clientProjectId` or
  `prefetchedContract`, both of which the conductor injects directly into `state.input` at dispatch
  time (`executor.ts`), outside anything `storedInput` reads. So a frozen replay case for
  `contract_intelligence` never carries a prefetched contract, and `evaluation.run_regression` /
  `dataset.build` replay it through `nodeRuntime.ts`'s independent-node path, which has no prefetch
  logic at all (grep confirms zero references) — replay would exercise neither the pre-existing #93/#95
  prefetch NOR this session's deterministic bypass, and would return a cost number measuring nothing
  real. This is exactly what the repo's own prior "Unmeasured" note already said about this node
  ("a single-node node.execute will not measure it: the prefetch is applied in the workflow
  executor... a single-node run bypasses it and returns a meaningless number") — confirmed here to
  extend to dataset replay as well, not just ad hoc `node.execute` calls.
  **The only real measurement is a live conductor run** (`workflow.run_until(contract_intelligence)`
  or a full run), which costs real money on the upstream nodes regardless of this node's own $0 —
  that is Session C's territory (human-gated, one real ≤$3 run), not something to spend unilaterally.
  **Session C's per-node cost table should show ~$0 for `contract_intelligence`** if this fix is
  working; that is the actual verification, deferred to Session C by design, not an oversight here.
  **Confirmed 2026-08-04, Session C: real per-node cost is $0.00 on a live paid run — see the Session
  C section above.**
- Regression coverage that WAS possible and is in place: the executor-level test proves, with a
  fabricated-but-real prefetch response and no OpenAI network stub configured at all, that the node
  completes with zero model calls and zero usage records when the deterministic path fires, and falls
  back safely to the normal model path when it does not.

## State — 2026-08-03 (Session B follow-up) — Wolf's gate rulings, applied in code

Wolf answered the seven rubric-gate decisions (project doc
`claude/cms-agent-decisions-2026-08-03-rubric-gate.md` — **read decision 4, it is architectural**).
The evaluation layer now has the mechanisms those answers require:

- **`JudgeEvidence` — the judge can finally check the output against something.** `scoreOutput` takes
  optional `{ contract, dependencyOutputs, toolCalls }`, and `runRegression` populates it from the
  frozen case. Criteria that are really diffs (fidelity, exact mapping, provenance, no-invented-rules)
  were scoring internal fluency, which is precisely the property a cheaper model preserves while
  degrading — 72% of the `contract_intelligence` rubric weight, on the node holding 52% of spend. When
  evidence is absent the judge is now told so explicitly and instructed not to assume such a
  comparison passes; `EvalResult.evidenceUsed` records what it actually had, so a score taken without
  the contract is never silently compared to one taken with it.
- **`criticalMin` — ONE hard-fail mechanism, enforced by the harness.** A weighted mean over 7+
  criteria cannot express "this one is non-negotiable": any single zero is survivable by construction
  (`contract_intelligence`'s rubric *said* a provenance zero was fatal while the arithmetic scored it
  0.88 and passed). A criterion may now declare a floor; scoring at or below it fails the rubric
  whatever the mean says. `EvalResult.veto` records which one tripped, kept separate from
  `normalizedScore` so "failed the mean" and "tripped a non-negotiable" stay distinguishable. An
  unscored floor criterion counts as tripped — never as passed by omission. `validateRubric` rejects a
  floor at or above `scaleMax` (it would veto a perfect score).
- **Regression baselines are scoped by `executionMode`.** `runRegression` takes the newest prior report
  *in the same mode*. `getLatestRegressionReport` is now marked DEPRECATED for baseline selection —
  it ignores mode, and it is what would have graded Session D's real run against Session B's mock
  plumbing-proof report (meanScore 0.484, a pseudo-random function of an output hash).
- **`dataset.build` records each case's `sourceExecutionMode` and accepts an `executionMode` filter.**
  A mock run's "champion output" is a schema-derived placeholder — 463 bytes against 14–18KB for the
  live cases in the same dataset. Default behaviour is unchanged (mock cases still included, since
  they are what makes a plumbing test possible), but nothing can now mistake a placeholder for a
  champion. **Session D: freeze with `executionMode:"openai"`.**

Manifest regenerated: 135 tools, surfaceHash `9f2209d31976…` (dataset.build gained a parameter).

**Still open, and still Wolf's:** the four rubrics remain `draft`. Weights are his call — he asked for
the mechanism to work first and said he will edit the scoring once it does.

## State — 2026-08-03 (Session B, evaluation layer) — the rubrics themselves

The evaluation substrate is no longer empty. **Four DRAFT rubrics** (`contract_intelligence`
`rubric_1785773022345_jzc74l`, `research` `rubric_1785773086490_hmrj61`, `article_body`
`rubric_1785773157410_dajinj`, `publish_payload` `rubric_1785773218400_ajar9a`), **four frozen replay
datasets** (`ds_1785772079588_9a01hb`, `ds_1785772111182_5baov9`, `ds_1785772112692_am32rx`,
`ds_1785772114313_c5gnyl`), and **one mock regression report** (`reg_1785773255851_5ivneg`).

**Nothing is active.** Weights are Wolf's call — the review doc is the project doc
`claude/cms-agent-rubrics-for-review-2026-08-03.md` (seven decisions). **Session C ran 2026-08-04 on
Wolf's direct authorization despite this** — see the Session C section above, which flags the
draft-rubric caveat explicitly rather than treating scores as validated.

> **Watch out — `evalRubricInputSchema` defaults `status` to `active`.** Creating a rubric without an
> explicit `status: "draft"` silently activates it. Session B passed it explicitly and verified all
> four came back `draft`.

### Four traps the evaluation layer sets, found by using it

1. **A MOCK regression report becomes the baseline for the next REAL one.**
   `getLatestRegressionReport(nodeId)` picks the most recent prior report *regardless of
   `executionMode`*, so `reg_1785773255851_5ivneg` (mock, meanScore 0.484) is now what a future
   `openai`-mode regression on `contract_intelligence` will be graded against — producing a confident
   and meaningless `improved`. **Session D must discard it or set a real baseline first.** Proposed
   fix: scope baseline selection by `executionMode`.
2. **`dataset_build` freezes MOCK outputs as champion outputs.** It does not filter by execution mode.
   contract_intelligence 1 of 4 cases is from mock run `run_1785247255518_sdkyvv` (championOutput 463
   bytes against 14–18KB for the live ones); research and article_body 2 of 6 each; publish_payload
   2 of 5. Replaying a real output against a placeholder champion is noise — filter before Session D's
   replay, or add a mode filter to `dataset_build`.
3. **Mock evaluation cannot distinguish cases at all.** All four contract_intelligence cases scored
   identically (0.484) because the mock runner emits one deterministic schema-derived placeholder —
   all four shared `subjectHash e8b1ed18`. Mock proves plumbing; it is never quality evidence.
4. **72% of `contract_intelligence`'s rubric weight is unjudgeable from output alone** — those criteria
   are diffs against the contract the node was given, and the judge never sees it. Until the run's
   `prefetchedContract` is wired into judge context, that rubric scores internal fluency, which is what
   a cheaper model preserves while degrading — on the node that is 52% of spend.

**R-20 confirmed live:** the mock regression recorded $0.062055 of `status:"estimated"` usage with
`actualCostUsdEstimate: 0`. Pre-R-20 that would have accrued against `budgetUsd` (T-2 F-5, at twice
the magnitude). First live exercise of Session A's fix; it held.

## State — 2026-08-03 (Session A, 2026-08 improvement phase)

Improvement-phase runbook: project doc `claude/cms-agent-session-runbook.md` (sessions A–G); phase
plan `claude/cms-agent-improvement-phase-plan-2026-08.md`. Session A (this session) shipped the
hygiene & measurement-integrity PR:

- **`workflow.list_runs` pagination + filters.** Cursor pagination (default 20 rows, max 100,
  `page.nextCursor`), `status` filter, `from`/`to` startedAt range. `listRunsPage` in `executor.ts`;
  repositories keep their full-list contract. PR #105's compaction contract preserved and
  regression-locked (`tests/agent/workspace/listRunsPagination.test.ts`). The GUI still reads `runs`
  and now sees the newest 20 — wire `page.nextCursor` into the run picker when it needs history.
- **R-20 fixed.** Estimated (mock/dry-run) usage records no longer accrue against any `budgetUsd`
  ceiling. `ModelUsageSummary` now carries `actualCostUsdEstimate` + `estimatedCostUsdEstimate`
  separately; every budget gate (conductor gate, `getBudgetStatus`, runner prior-spend, run-cost
  ledger) meters `actualCostUsdEstimate` only. Usage filters accept `status`. Regression:
  `tests/agent/observability/mockUsageBudgetSeparation.test.ts`; `budgetGate.test.ts` rewritten to
  the new posture (injects `status:"actual"` records to drive the gate).
- **R-21 fixed.** `validateWorkspaceGraph` now flags a conductor-sequence node whose `dependsOn`
  entry is not in the canonical conductor sequence, or whose `requiredInputs` entry no sequence node
  has as id or produces (T-2 F-7 shape). Authored non-conductor nodes exempt. Live store graph
  re-validated clean against the new checks before merge (no false STOP). Regression in
  `workspaceNodes.test.ts`.
- Manifest regenerated (`npm run drift:update`): still 135 tools, new surfaceHash `701c1f84e934…`
  (list_runs/usage filter/validate_graph description schema changes).
- **Open item for Wolf (human):** a real browser click-through of the run-details on-demand
  hydration path (#105). `ui/tests/useWorkflowRun.test.tsx` covers it in vitest and passes; a human
  click-through has not been done.

## State — 2026-07-31

Workspace **v259**, backend `gcs`, graph valid, skill store **v21**. Registry: `dr-lurie`,
`monetizer` (disabled), `pdf-tool` (Ring 0 service), `platform` (client 0). All publish locks closed.

**Node-system overhaul (2026-07-31): PR #100 (behavioural) + the mechanical follow-up PR.** All 21
nodes carry all five limits live (maxTurns / toolCallLimit / timeout / budgetUsd / maxOutputTokens —
sizing and the three cost diagnoses in `docs/plan/findings/node-limits-audit.md`). The budget guard
now gates each model request *before* it is sent, holding node and run ceilings separately; runs
carry a dispatch-claim heartbeat so a dead driver is detected and reclaimed instead of hanging
silently; tool results are bounded (32k chars) and `toolCallLimit` is enforced with per-call audit
records persisted on node state. The shared prompt/skill layer is client-neutral — Dr. Lurie's voice
and domain caution live in `src/agent/projects/drLurie/`, awaiting `vox_drlurie_default` (P-2). The
R-23 rename is done in the code plane (`client_object.v1`, `canonicalArticleBody` deleted).

**The engine works end to end in live mode against client 0.** `run_1785405350649_9u5mjz` produced a
schema-valid 12-block `content_item` — strict root fields, opaque `n_*` ids, no undeclared keys,
taxonomy correctly omitted because `tax_platform` has zero active terms. T6.3 passes on the live path;
the publish gate held.

**`article_body.v1`, settled.** It was born in the platform repo on 2026-06-21 as the structured
replacement for markdown articles, when an article *was* one document. On 2026-07-19 the decision was
that `article_body.v1` nodes pass **verbatim** into `content_item`, whose node schema is a superset —
so `content_item` **wraps** it and never replaced it. On the platform side it is not an object; it is
the node grammar `content_item` imports (`private`, `commercial`, `rendering`, `chat`). **Leave the
platform side alone.** CMS-Agent hand-copied that schema into `store.ts` on 2026-07-01, and that copy
is what grew into five competing shapes. PR #96 deleted the copy and every consumer. What remains of
R-23 is the **rename**: the surviving envelope is not an "article body", it is one client object plus
its provenance, and `client_object.v1` describes it.

### Blocking T-3

1. **W-4 fixed in PR #99 (2026-07-30), unverified live.** The conductor now delivers
   `clientProjectId` (from `run.projectId`) in EVERY node's input (`executor.ts`); an unresolvable
   client fails the node with the named `client_project_unresolved` (same contract as
   `prefetch_object_type_unresolved`); the five branded editorial prompts and the
   `dr_lurie_dtc_science_editorial` skill (now "Editorial craft") are client-neutral craft in both
   planes (live v229→v238, skill store v13→v14, then `nodes:update` re-seed); and
   `contract_intelligence.metadata.projectId` is gone (verified unread — the prefetch uses
   `run.projectId`). No client was substituted; the Dr. Lurie voice text sits in skill version
   history awaiting `vox_drlurie_default` (P-2). **The executor half needs a deploy to take effect.**
2. **W-5 fixed in PR #99 (2026-07-30), unverified live.** `article_body` now depends on
   `narrative_movement` + `angle_strategy` (requiredInputs in lockstep), so the per-block reasoning
   arrives in its input instead of being discarded, and its prompt mandates populating
   contract-declared private annotation fields on every emitted node, enum values strictly from the
   contract's own enums (confirmed first-hand: `private.strategy` 12 values, `private.intent` 5,
   `additionalProperties: false`). **The dependency change is topology — it reaches conductor runs
   only through #99's `nodes.ts` re-seed plus a deploy.** Verification is a fresh platform run
   checking every block carries `private.strategy`/`private.intent` and no foreign-client CTA.

### Unmeasured

**#95's contract-prefetch effect on `contract_intelligence`** (was $3.79 pre-fix, target ~$0.10).
Measure with a fresh run plus `run_until(contract_intelligence)` — roughly $0.95 of known upstream
editorial cost plus the node itself. **A single-node `node.execute` will not measure it**: the
prefetch is applied in the workflow executor (`executeRunnableNode` gates on
`metadata.contractPrefetch`), so a single-node run bypasses it and returns a meaningless number.
**Confirmed 2026-08-04, Session C: real conductor-run cost is $0.00 for `contract_intelligence`.**

### Owed

- ~~**Deploy.**~~ Automated: pushes to main deploy via the `cms-agent-mcp-deploy` trigger
  (`cloudbuild.deploy.yaml`). The first day exposed the pipeline's race: #100 (95e2821) and #101
  (970c414) merged minutes apart, their builds ran concurrently, and the OLDER commit's deploy
  landed last — the newer build's verify failed loudly, exactly as designed. The release step now
  resolves concurrent deploys by commit ancestry (newest commit wins; older builds yield). #96/#99/
  #100/#101 all reach the serving revision with the first green main build after this commit.
- ~~**Live write.**~~ Done 2026-07-31, workspace **v260**: `article_body`'s live `produces` and
  both schema mirrors now say `client_object.v1` (the pre-#101 validator had refused the rename —
  chicken-and-egg — so the write waited for #101's validator to serve; `workspace_validate_graph`
  confirmed the plane was flagging the old name right up until the write, and is clean after it).
  The store overlay and the seeds agree again; R-23 is closed in both planes.
- ~~**`npm run nodes:update`.**~~ Re-done 2026-07-31: re-seeded from live v259 (limits + purge +
  rename patch) via the generator.
- ~~**R-23 rename half.**~~ Done in the code plane (mechanical PR); live-plane write owed above.
- ~~**Real pricing in `modelPricingCatalog`.**~~ Done 2026-07-31: OpenAI/Anthropic published list
  rates as of that date, entries still honestly flagged `placeholder` (hand-maintained, not
  billing-grade).

### Known defects, unfixed

- **Two sources for one schema.** `getWorkspaceNode()` reads the compiled canonical node list, and
  seven call sites take `article_body.outputSchema` from it — the conductor run bundle, both
  `publishReadiness` hooks, `project.validate_handoff`, `publisher` twice, and the publish-payload
  tool. The executor instead validates against `resolveConductorNodes()`, which overlays the live
  store (`outputSchema: stored.outputSchema ?? canonical.outputSchema`, default source `store`).
  Re-verified byte-identical 2026-07-31 (against v259) — but the invariant is still not guaranteed
  by construction, and `nodes:check` needs live access so CI cannot enforce it. Note the rename
  makes this bite until the post-deploy live write lands: seeds say `client_object.v1`, the store
  overlay still says `article_body.v1`. `getRunContext` is already `async` and already receives a
  repository.

Fixed 2026-07-31 (mechanical PR, deploy-gated like everything else): `get_run_cost` now answers
`retry_node` for a failed-node run; `tool.get_execution` requires `toolExecutionId` in its
advertised schema and `tool.list_executions` lists by run from persisted per-node records; the
Dr. Lurie image-placement validator reads the real contract shape (envelope `.body`,
`nodes[].public.media` — publisher.ts had it right); `AnthropicNodeRunner.validateConfiguration`
refuses tool-using nodes by name and `modelPricingCatalog` has Anthropic entries.

---

Deep background: `docs/plan/CHANGE-PLAN.md` (governing plan and every wave log),
`docs/plan/findings/`, `docs/plan/TEST-PROTOCOL.md`, `docs/platform/DIRECTION.md`.