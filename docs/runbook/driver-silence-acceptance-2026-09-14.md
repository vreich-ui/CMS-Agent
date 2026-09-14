# D5 acceptance — driver silence, `fix/driver-silence`

**Status: PREPARED, NOT RUN.** The acceptance run must be driven by the **deployed** continuation
tick, and the fix is not deployed: `fix/driver-silence` is delivered as a patch and this session
could reach neither Cloud Run nor Cloud Build. Running it against the current build would only
reproduce the defect at ~$0.40–$8 of model spend, so it was not run.

Run this once `fix/driver-silence` is merged and the MCP service **and** the `continuation-tick`
job image are both on the new build.

---

## Before — `run_1789303857536_obd2fd` (genesis-lab-2, 2026-09-13)

Read from the live record (`workflow.get_run`, `usage_list_records`), not reconstructed.

| Measure | Value |
|---|---|
| Wall clock (startedAt → updatedAt) | **53.6 min** |
| Sum of the persisted node durations | **7.6 min** (457.5 s) |
| Ratio | **7.0×** |
| `stale_dispatch_reclaimed` warnings | **5** (reader_insight, objection_mapping, draft_writer ×2, contract_intelligence, artifact_plan) |
| Abandoned dispatches that had already produced a paid model result | **5** |
| Duplicate model spend on `draft_writer` alone | $0.2565 of $0.3496 |

Four nodes (`human_texture`, `trust_factual`, `emotional_resonance`, `reader_simulation`) ran as one
concurrent batch, so the serial-equivalent floor is a little above the 7.6 min sum. The run ended
`cancelled` at `artifact_materializer` on an unrelated tenant-config blockage
(`artifact_site_scope_missing` — genesis-lab-2 declares no `objectDialect.siteObjectId`); that is not
a driver defect and is out of scope here. **It is a reason to run acceptance on `dr-lurie`, which is
configured, rather than on genesis-lab-2.**

---

## The run

Driven **only by the tick** after the start, as the task requires.

```
workflow.start_dry_run {
  projectId:     "dr-lurie",
  executionMode: "openai",
  requestId:     "req_publish_driver_silence_20260914_01",
  budgetUsd:     8,
  input: { topic: "<any lifestyle topic in drlurie's niche>" }
}
```

Then **stop touching it.** Do not call `workflow.run_all` / `run_node` / `run_until` — a second
driver would invalidate the measurement. Poll with `workflow.get_run { detail: "compact" }` every few
minutes; its `stall` block now names the claim when one is stamped.

If the run needs a nudge to leave `queued`, one `workflow.run_next_node` is acceptable — record that
you did it.

## Pass criteria

1. `run.status === "completed"`.
2. **Zero** `stale_dispatch_reclaimed` across every node's `warnings`.
3. **Zero** `dispatch_heartbeat_silent` (a heartbeat reclaim is a real driver death — better than the
   old 390 s wait, but not a clean run).
4. Wall clock ≤ **2×** the sum of `nodes[].durationMs`.
5. `usage_list_records { runId }` shows **one** `status:"actual"` record per model node. More than one
   for any node means a dispatch was still discarded — that is the defect, and the run fails even if
   it completed.

## Record here after the run

| Measure | Value |
|---|---|
| runId | |
| Wall clock (startedAt → completedAt) | |
| Sum of node durations | |
| Ratio (target ≤ 2.0) | |
| `stale_dispatch_reclaimed` count (target 0) | |
| `dispatch_heartbeat_silent` count (target 0) | |
| Nodes with >1 actual usage record (target 0) | |
| Total `costUsdEstimate` | |
| Final status | |

## If it fails

- **Reclaims with `dispatch_heartbeat_silent`** → a driver genuinely died. Correlate with Cloud Run
  job executions for `continuation-tick`; this is the D4 job-lifecycle case, and the reclaim latency
  (~30–45 s) is now the evidence you have.
- **Reclaims without `dispatch_heartbeat_silent`** → a claim aged out with its heartbeat alive:
  either the driver-health store is unreachable from the driver (heartbeats never written — check for
  a `dispatchHeartbeat/<runId>.json` blob during the run) or a node genuinely exceeded its window.
- **>1 usage record for a node, no reclaim warning** → something else is discarding advances. Start at
  `nodeAdvanceSave.ts`'s `"taken"` branch; a wrong `"taken"` verdict discards exactly as before.
- **Ratio > 2 with no reclaims and one usage record per node** → the run is slow, not stalled. Look at
  tick cadence and `deferred_deadline` refusals in the tick ledger, not at this wave.
