# Cross-repo wire contracts (T-14)

Every place `src/` parses a shape produced by a DIFFERENT repository, what it reads, and what the
drift looks like from inside CMS-Agent. T-14's general lesson was "a shape crossing a repo boundary
is a contract nobody wrote down"; this is the writing-down, and `npm run contract:check` (W4) is the
mechanism that keeps the top rows honest.

Ranked worst-first: **silently wrong** above **empty** above **throws**, then by blast radius.

There is no `throws` row. Every reader below is deliberately built to survive a malformed producer,
which is the right call for a nightly job and exactly what makes drift invisible.

| # | Consumer | Producer | Fields read | On drift | Coverage today |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/agent/improvement/strategyLearning.ts:142-144` (`strategyGroupsFromRows`) | kugel-data `/rollups?by=strategy` | `row.strategy`, `row.intent` — no camelCase or nested fallback, unlike every sibling reader | **no rows at all, today.** The producer has never built this grain: `kugel-data` answers **503 "grain not implemented"** for `by=strategy` on purpose (`UNIMPLEMENTED_ROLLUP_GRAINS`, S-04), and `RollupBy` is `"object" \| "producer"`. So this reader has never seen a row. When the view IS built, `if (!strategy && !intent) continue;` drops any row whose columns are spelled differently, the grain returns `[]`, and `ingestStrategyRollups` writes zero observations with no error — indistinguishable from a quiet week, and starving playbook promotion for all six `STRATEGY_PLAYBOOK_TARGET_NODES`. | `tests/agent/improvement/strategyLearning.test.ts` fixtures `strategyRow()`/`ordinaryRow()`/`thirdRow()` (l.45-89) use plain `strategy`/`intent`, **never cross-checked against kugel-data's real `by=strategy` shaping code** |
| 2 | `src/agent/improvement/trackingIngest.ts:115-118` (`producerField`), used at `:278-279` | kugel-data `/rollups?by=producer` (`netlify/functions/_shared/rollups.ts`) | `node_id`/`nodeId`, `run_id`/`runId`, plus a nested `producer.{…}` envelope | **silently wrong.** All spellings missing ⇒ `producerKeyOf` collapses to `"unknown:unknown"` and the record still saves. `optimizer.analyzeNode` for the real node then finds nothing and reads it as "no feedback", not as a broken pull. | `tests/agent/trackingIngest.test.ts:61`, `:193` — camelCase and nested envelope both asserted |
| 3 | `src/agent/improvement/trackingIngest.ts:150-161` (`metricsFromRow`), all three grains | kugel-data `/rollups` | each key of `TRACKING_METRIC_KEYS` / `STRATEGY_METRIC_KEYS`, snake_case or camelCase or nested under `metrics{}` | **empty, by design.** A renamed measure column is absent from the map rather than zero-filled ("never fabricate"). Degrades gracefully — and silently: nothing reports that a column stopped arriving. | `tests/agent/trackingIngest.test.ts:61` covers the happy shapes; no test proves the rename path |
| 4 | `src/agent/improvement/engagement.ts:140-148` (`medianRollupMetrics`) | kugel-data `/rollups?by=object` | `pageviews`, `sessions`, `completion_rate`, `cta_ctr`, `purchase_rate`, `p75_dwell_ms` | **empty.** `if (!values.length) continue;` ⇒ no median for that measure, so `engagement_below_site_median` quietly loses an input. | `tests/agent/improvement/engagementEvidence.test.ts:95-97,159-170`, snake_case fixtures only |
| 5 | `src/agent/improvement/strategyReview.ts:170-186`, `:259` | kugel-data `/rollups?by=object` (`shapeObjectRow`, named at `strategyReview.ts:190-194`) | `funnel_stage`/`stage`/`funnel`, `topic`/`primary_topic`/`topic_id`/`taxonomy_term` | **empty, and already surfaced.** The sink has never sent these columns; `dimensionLines` reports `available:false` rather than staying quiet. Lowest risk on this list *because* it is announced (S-04b). | `tests/agent/improvement/strategyReview.test.ts:50-66` — `sinkObjectRows()` (what the sink actually sends) kept beside `labelledObjectRows()` (named in the test as hypothetical). The one place in the repo that got the fixture-vs-reality gap right. |
| 6 | `src/agent/improvement/strategyReview.ts:738-742` (`threadIdOf`) | kugel-platform tenant `/mcp` → `marginalia_create` | `structuredContent.thread.{thread_id,threadId,id}`, `structuredContent.{thread_id,threadId}`, top-level `thread.*` | **empty, cosmetic.** A missing id is explicitly never a failure; only the optional notify payload loses its link. | none — no test asserts `threadIdOf` against a realistic `marginalia_create` envelope |

## Known gap in this inventory

pdf-tool artifact references and the kugel-platform object verbs (`object_get`/`object_list`/
`object_patch`, `tracking_config`, `editorial_strategy` bodies) are NOT reachable from the five files
T0.2 started at. `siteGenesis.ts:854,868` mentions `object_get` only inside human-readable checklist
strings — never parses it. The real consumption sits in `src/agent/workspace/artifactMaterialization.ts:477`
(`readArtifactReference`), `src/agent/workspace/publishExecution.ts:354` (`readArtifactReferences`) and
`src/agent/workspace/nodes.ts`. Those rows are unwritten, and therefore unpinned. Next inventory pass
starts there rather than at the improvement/ modules.

## The three pinned in W4

1. **`by=strategy` → `strategy` / `intent`** (row 1). Not a drift risk yet — a shape risk. The
   producer answers 503 for this grain and always has, so the two field names in
   `strategyLearning.ts` were never agreed with anyone; they are what a reader assumed a future view
   would be called. The fixture records `producerState: "unimplemented"` so that `contract:check`
   fails on the day that stops being true, which is the moment to agree the column names rather than
   to discover them from an empty result. It is also the only sink reader with no fallback, in a
   module whose sibling grain had exactly this bug (S-04b) and shipped with it.
2. **`by=producer` → `node_id` / `run_id`** (row 2). Widest downstream fan-out: every feedback
   outcome record, and everything keyed off it. Already well tested — pinning it converts "we hope
   kugel-data still sends `node_id`" into a CI failure the day it stops.
3. **`by=object` row shape** (rows 4 + 5). Two modules read the same shape through two different
   helpers with two different fixture sets; one vendored fixture asserted against both catches a
   drift that today degrades one while the other's tests stay green.

`tests/agent/improvement/strategyReview.test.ts:59-60` `sinkObjectRows()` is the pattern to
generalise — it already carries the producer's real column list in a comment.

## How to add a pin

1. Capture a real producer row (or the producer's shaping code excerpt) into
   `tests/contracts/<producer>/<shape>.json` with a header block:
   `{ "producer": "kugel-data", "path": "netlify/functions/_shared/rollups.ts", "sha": "<commit>", "capturedAt": "<ISO>" }`.
2. Point the consumer's test at the fixture instead of a hand-written literal.
3. `npm run contract:check` fetches `path` from the producer's `main` and fails on drift. It needs
   `GITHUB_TOKEN`; without one it prints an explicit **unverified** line and does not pass by default.
