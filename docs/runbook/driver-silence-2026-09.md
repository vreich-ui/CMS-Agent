# Driver silence, 2026-09 — the two mechanisms, and what was changed

**Status:** cause found and fixed in code; live acceptance (D5) pending deploy.
**Branch:** `fix/driver-silence`. **Baseline:** deployed main `3ec3395`; work cut from `d478216`.
**Evidence run:** `run_1789303857536_obd2fd` (genesis-lab-2, 2026-09-13) — 52 minutes of wall clock for ~9 minutes of model time.

---

## 1. The finding, in one line

**No driver died.** Every "the driver process died mid-node" node in that run was dispatched by a driver that ran the node to completion, got a valid result, and then **threw it away** because its completion save lost a compare-and-swap — leaving its own claim stamped with nobody behind it.

The diagnostic sentence the system printed each time — *"dispatched … and never reported back — the driver process died mid-node. Nothing is in flight."* — was wrong on both counts. The driver reported back; a claim **was** in flight.

---

## 2. The exact code path that abandoned the dispatch

Pre-fix, in `src/agent/workspace/executor.ts`:

| Step | Code | What happens |
|---|---|---|
| 1 | `executeRunnableNode` → `stampDispatch(state, …)` then `run = await store.saveRun(run)` | The claim is persisted. Run is now at rev **R**. |
| 2 | `await runner.run(…)` | The node runs. 18–25 s, succeeds, result in hand. |
| 3 | *(any other writer saves this run)* | Store moves to rev **R+1**. |
| 4 | `const saved = await store.saveRun(prepared.run)` (base rev R) | `BlobExecutionRepository.saveRun` → **`RunConcurrencyError`**. |
| 5 | `catch (error) { if (isConcurrencyConflict(error)) continue; }` in `advanceRun` | The advance restarts from a fresh read. |
| 6 | `const inFlight = run.nodes.find(n => n.status === "running" && n.dispatch)` … `if (Date.now() <= deadline) return run;` | The fresh read finds **this driver's own claim**, still inside its window, and returns the run untouched. |

**Result:** the node's output is discarded, the model spend is lost, and the claim sits unreclaimable for `timeoutMs + STALL_MARGIN_MS` — 180 s for a 90 s model node, 390 s for a 300 s one — until a later driver reclaims it (`stale_dispatch_reclaimed`) and pays for the node a second time.

Step 6's guard is correct for *somebody else's* live claim. It cannot tell that apart from *its own*, and nothing in the conflict path told it which it was looking at.

### Proof from the live record — the model finished every time

This is not an inference from the code. `usage_list_records` for the evidence run shows one
`status:"actual"` model-usage record **per dispatch**, and `OpenAINodeRunner` writes that record
only on its terminal success path ("recorded exactly once, never double-counted, since it is written
only here on the terminal success path"). So every one of these dispatches got a complete, validated
model result back:

| Node | Driver | Dispatched | **Model result recorded** | Cost | What happened next |
|---|---|---|---|---|---|
| `draft_writer` | `continuation_tick` | 13:14:35 | **13:15:23.193** (48 s in) | $0.1717 | discarded; claim aged out; re-dispatched 13:22:47 |
| `draft_writer` | `continuation_tick` | 13:22:47 | **13:23:10.780** (24 s in) | $0.0848 | discarded; claim aged out at 13:22:47 + 300 s + 90 s = 13:29:17; re-dispatched 13:29:27 |
| `draft_writer` | `continuation_tick` | 13:29:27 | 13:29:52.325 (25 s in) | $0.0931 | **persisted** — `durationMs: 24814` |
| `reader_insight` | `http_run_all` | ~12:52:17 | **12:54:16.889** | $0.0371 | discarded; reclaimed 12:57:55 |
| `reader_insight` | `http_run_all` | 12:57:55 | 12:58:13.781 | $0.0360 | **persisted** — `durationMs: 18339` |

The node execution record for `draft_writer` reports `costUsd: 0.349605` — precisely
0.171705 + 0.084795 + 0.093105, the sum of all three attempts. One node, paid for three times.

Two details settle it:

1. **The gap between "answer in hand" and "reclaimed" is minutes, not milliseconds.** `draft_writer`'s
   second dispatch had a validated result at 13:23:10 and the run did not move until 13:29:27. For a
   process death to explain that, the process would have to have been killed inside the few
   milliseconds between `recordModelUsage` returning and `saveRun` being called — twice for one node,
   five times in one run. A lost compare-and-swap explains it exactly once, every time.
2. **The re-dispatch times land on the claim arithmetic, not on anything about the driver.**
   13:22:47 + `timeoutMs` 300 s + `STALL_MARGIN_MS` 90 s = 13:29:17, and the next tick fired at
   13:29:27. The run was waiting out its own claim window, which is what an abandoned claim does.

A supporting trace is visible in the node warnings themselves. `draft_writer` carries
`voice_prefetch_fallback` **three times** (once per dispatch — prefetch runs before the claim save,
so those warnings were persisted by the claim save) but `budget_reserve_source` only **once**. That
second warning is appended from `result.warnings` on the runner's success path, i.e. into the record
that the completion save was supposed to write. It survives from exactly one dispatch: the one whose
save landed.

### Reproduction

`tests/agent/workspace/dispatchAbandonOnCasConflict.test.ts` drives the real executor against the real CAS store and interposes **exactly one** foreign write while a node is in flight. Pre-fix, the node is left `status:"running"` holding a claim with the driver already returned; post-fix it completes.

---

## 3. Who the other writer was — and why the two patterns look different

Since W0 T0.2 (2026-09-04), the end of **every** continuation tick stamped `driverHealth.lastSeenByTickAt` on **every** continuable run — including runs it had just refused with `skip_dispatch_in_flight`. `lastSeenByTickAt` changes on every tick, so `applyRunDriverHealth` always reported `changed: true`, so that stamp was always a **full record write** against a run another driver was mid-node on.

The tick's soft budget is 240 s and Cloud Scheduler fires it every 120 s, so **two ticks overlap permanently**. A tick that is driving is back-to-back inside dispatches for its whole window, and two foreign stamps land somewhere inside it.

That single fact produces both patterns in the evidence table:

**Pattern 1 — `http_run_all` (reader_insight 12:51:45, objection_mapping 13:07:14).** The operator's `run_all` call held the claim; a concurrently-firing tick stamped health on the run; the call's completion save conflicted and the node was discarded. The call then returned normally — at its 45 s budget, or "seconds later" — with a claim stamped, `continued: true`, and a `driverNote` asserting nothing was in flight.

**Pattern 2 — `continuation_tick` (draft_writer 13:14:35 and 13:22:47, contract_intelligence 13:31:21, artifact_plan).** Same mechanism, with the *overlapping* tick as the foreign writer. This is why nodes that "died" completed in 18–25 s on a later attempt: they were never slow and their driver was never killed. It is also why `draft_writer` died twice — the interference recurs every two minutes.

A secondary contributor, real but not the cause: **`http_run_all` dispatches nodes it cannot stay for.** The loop's deadline check runs *between* advances, never during one, so `reader_insight` was dispatched with ~32 s of a 45 s budget left against a 90 s claim window. D9's claim ceiling exempted model nodes on the theory that a model timeout is a bound the driver always regains control from — true of the **node**, silent about the **driver**.

### What it was *not*

- Not the Cloud Run task timeout. `--task-timeout 600 s`, tick budget 240 s, and the W0 T1.2 deadline guard (`fitsAFreshTask`) already refuse a dispatch that cannot finish inside the task. A 300 s claim started at the 240 s budget edge still lands at ~540 s.
- Not a Netlify/Cloud Run request lifecycle kill. `OpenAINodeRunner` races every model call against the node's own `timeoutMs` and aborts the request on timeout, so a model dispatch always ends and the driver always regains control — **unless its result is discarded**, which is what was happening.
- Not tick overlap by itself. Overlap is safe: the dispatch claim plus the repository CAS are what make concurrent drivers safe. Overlap was only the *delivery mechanism* for the foreign write.

> **Not verified from the live planes.** This session had no GCP credentials (`run.googleapis.com` returned `ACCESS_TOKEN_TYPE_UNSUPPORTED`), so the Cloud Run job config and Cloud Logging were **not** read directly. The job-shape facts above come from `scripts/deploy-continuation-tick.sh`, `docs/platform/continuation-tick.live-shape.md` and `npm run test:drift` (which asserts code against the deploy scripts and passes). No Sep-4 "fast and reliable" research plan exists under `docs/`.

---

## 4. The fixes

### D1 — a driver never discards the node it just ran
`src/agent/workspace/nodeAdvanceSave.ts`. On a conflicting completion save, re-read the stored record, lay this advance's node states and run-level progress onto it, and re-save against the fresh revision. Used by `advanceRun`'s serial save and by `dispatchConcurrentBatch`'s reconciliation save.

**The one safety condition:** the merge happens only while the stored record still shows **our** claim (same `dispatchedAt`) on every node the advance touched. If another driver has reclaimed or re-dispatched the node, discarding is the correct behaviour and is what still happens — asserted by the second test in the repro file.

### D1b — the tick stops writing to runs somebody is mid-node on
`runContinuation.ts`. The driver-health stamp is skipped for any run whose **stored** record shows a live in-flight claim (re-checked against the store, not against the pre-loop verdict). The tick ledger is a different key space and conflicts with nothing, so refusals are still fully recorded.

Both halves are needed. D1b removes the systematic trigger; D1 makes any *other* foreign write — an operator's `set_node_budget_override`, a publish decision, a writer nobody has thought of — survivable.

### D2 — a driver never starts a node it cannot stay for
`dispatch_exceeds_remaining_driver_budget` in `src/agent/mcp/workspace/tools.ts`, applied to `run_all`, `run_node`, `run_until` and `run_next_node`. The next dispatch is priced on **this tenant's measured p95 for that node** (`nodeTimingAggregates`), falling back to the node's own timeout when there is no history, and refused when it does not fit the driver's **remaining** wall clock plus `DISPATCH_DEADLINE_MARGIN_MS`.

- Deterministic stages are never priced on p95 — their window is a stall floor, not a bound — so D9's kind-based refusal still owns them.
- Mock runs make no model call and are not priced at all.
- A refusal is a normal outcome: persisted run, named `driverRefusal`, `driverNote`, `continued: true`.
- `driverNote` and `assessRunStall`'s advice now read "is a claim stamped" off the record and name the claim. **Neither can say "nothing is in flight" while a claim exists.**

### D3 — heartbeat-based reclaim
`src/agent/workspace/dispatchHeartbeat.ts`. The dispatching driver beats every `DISPATCH_HEARTBEAT_INTERVAL_MS` (15 s); a claim silent for two intervals is reclaimable regardless of its own window. Reclaim latency drops from 180–390 s to ~30–45 s.

**The heartbeat is not on the run record.** A 15-second CAS write to the record a driver is mid-node on would manufacture the D1 conflict every fifteen seconds. It lives in the driver-health store (`dispatchHeartbeat/<runId>.json`, last-write-wins), keyed to the exact claim by `dispatchedAt` so a leftover heartbeat can never be read as evidence about a later dispatch. A dispatch that **is** heartbeating is untouched — the double-dispatch guard is the same guard — and a missing or unreadable heartbeat decides nothing, leaving the timeout rule exactly as it was. Nodes reclaimed this way carry `dispatch_heartbeat_silent` alongside `stale_dispatch_reclaimed`.

Start and stop are each in exactly one place: `stampDispatch` (the only place a claim is written) and `advanceRun`'s `finally` (the only place a dispatch ends).

### D4 — tick lifecycle
**No job configuration change is required, and none is proposed.** The tick's deaths were the same CAS-abandon as `http_run_all`'s, fixed in code above. `npm run test:drift` reports `cron */2 * * * *, task-timeout 600s, budget 240000ms match the deploy scripts`.

There is one behavioural improvement the tick gets for free: when Cloud Run *does* hard-kill a task with a node in flight (SIGTERM at scale-down, followed by the platform's kill ~10 s later — `runContinuationTickMain`'s abort lets the loop stop cleanly but cannot make an in-flight node finish), the heartbeat stops with the process and the next tick reclaims in ~30–45 s instead of 390 s.

---

## 5. Residual risks

| Risk | Why it is accepted |
|---|---|
| A live tenant with **no** timing history refuses every `run_all` dispatch (fallback = node timeout > 45 s) and progresses only on the tick, ~1 node per 2 min. | Honest: nothing is known about the node's duration, and dispatching costs 180–390 s of orphaned claim when it is wrong. `dr-lurie` has months of history. The tick builds history from the first run. |
| Two heartbeat writes per node per 15 s across four tenants. | Small JSON documents in a non-indexed key space, all writes unawaited and best-effort. |
| `advanceRun` now reads the heartbeat once per advance that finds a live claim. | One small blob read, only on the path that was about to return without dispatching anyway. |
| The merge in `nodeAdvanceSave` takes `stored` as the base for bookkeeping fields and the advance for node/run progress. | A concurrent *driver* cannot exist (its claim would have to match ours). Only non-dispatching writers reach this path. |

---

## 6. Verification in this session

- `npm run typecheck` — clean.
- `npm test` — **379 files, 3748 tests, all passing** (baseline before this work: 377 / 3742).
- `npm run test:drift` — clean after `npm run drift:update` (`surfaceHash c1747f6664f9…`) and regenerating `docs/reference/MCP_TOOLS.md`.
- New tests: `dispatchAbandonOnCasConflict.test.ts` (D1, 2), `dispatchHeartbeatReclaim.test.ts` (D3, 4), `driverRemainingBudgetRefusal.test.ts` (D2, 2).
- Verified against the live record: `workflow.get_run` and `usage_list_records` for
  `run_1789303857536_obd2fd` (the table in §2), read through the CMS-Agent MCP surface.
- **Not** verified: Cloud Run job config and Cloud Logging. See the note in §3.
