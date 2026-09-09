// Node timing ledger (T6, Wave 3 — SHIPS DARK). Every node completion the executor and the
// node.execute runtime already reach is recorded here as {nodeId, durationMs, costUsd, outcome} and
// folded into a per-nodeId aggregate (EMA, p50, p95, count). Nothing in this file is read by any
// decision path yet — workflow.get_run_cost's plan block (mcp/workspace/tools.ts) is the ONE
// read-only consumer this wave adds. No scheduling, budgeting or stall-detection behaviour changes as
// a result of this file existing.
//
// Evidence (run_1786557897658_elj34j, verified live 2026-08-12): 12.8 min wall, ~7.3 min model work, a
// serial review quartet taking ~113s, and a mid-loop budget estimator that false-stopped a node. Every
// one of those is a decision currently made from a static guess (a fixed per-node budget reservation,
// a serial review ordering nobody has re-measured) because no per-node history exists to decide it
// from measured reality instead. This file creates that history. It creates nothing else: no consumer
// here changes what any node does, when it runs, or when a run halts.
//
// FOLLOW-UPS — explicitly NOT this task, and explicitly gated on two runs of accumulated data before
// anyone wires them live (a single run's aggregate is one sample per node, indistinguishable from
// noise; two runs is the first point an EMA and a p95 mean anything at all):
//   1. Driver packing — using durationMs aggregates to pack independent nodes into a single
//      conductor-job wall-clock budget instead of dispatching one at a time.
//   2. Estimator calibration — replacing the mid-loop budget estimator's static per-node guess (the
//      false-stop this evidence names) with the measured p50/EMA for that nodeId.
//   3. Per-node stall thresholds at p95 * 2 — replacing runStallHeartbeat's one-size timeout with a
//      per-nodeId threshold derived from this ledger's own p95.
// None of the three may be switched on until this ledger holds two runs' worth of samples for the
// nodes they'd gate; switching early would let a cold, near-empty aggregate make exactly the kind of
// static-guess decision this task exists to replace.
//
// ---------------------------------------------------------------------------------------------
// 2026-09-09 — "SHIPS DARK" IS NO LONGER TRUE. READ THIS BEFORE TRUSTING THE HEADER ABOVE.
//
// Follow-up 2 landed on 2026-09-08: runCostHistory.ts derives `estimatedRunCost` from these records,
// costPrefetch.ts hands it to monetization_strategy, and skipPredicates' EV floor can BLOCK a run on
// the result. This file has a live production consumer that stops work. The header's "no decision
// path reads this" was accurate when written and is now the most dangerous sentence in it.
//
// Follow-up 3 (per-node stall thresholds at p95 x 2) remains explicitly NOT built, and W1 establishes
// why it should not be: for every node on publishing_conductor, p95 x 2 is BELOW the deadline the
// claim already grants (timeoutMs + STALL_MARGIN_MS), so a p95-derived threshold is a no-op under its
// own floor rule. The one apparent exception, artifact_plan at 235s against 210s, was an era-mixed
// p95 — exactly the cold/dirty sample the paragraph above warns against, and exactly what routeEra
// now prevents. The stall incident's real cause was a claim stamped for phase 1 of a 3-phase node;
// see executor.ts's reclaimForPhase.
// ---------------------------------------------------------------------------------------------

import type { ExecutionStatus } from "./executionTypes.js";
import { repositoryManager } from "../runtime/repositories.js";
import { summarizeModelUsage } from "../observability/modelUsage.js";
import type { NodeTimingRepository } from "../repository/interfaces/NodeTimingRepository.js";

// A node itself is never "queued", "running" or "paused" once execution has REACHED a recordable
// outcome — those three are mid-flight run statuses, not node completion outcomes. Reusing
// ExecutionStatus (rather than inventing a parallel vocabulary) means this file's outcome and
// NodeExecutionState.status can never drift apart about what a terminal node state is called.
export type NodeTimingOutcome = Exclude<ExecutionStatus, "queued" | "running" | "paused">;

// W0.1 (2026-09-09) — THE ATTRIBUTION FIELDS, and why a warm ledger still was not an honest one.
//
// By 2026-09-09 this ledger held 26-41 samples per node on publishing_conductor — warm enough that
// something (runCostHistory.ts's EV floor) had already started reading it in production. It was still
// not evidence, for five separate reasons, each of which is one field below:
//   - projectId: FOUR tenants (dr-lurie, zilberman, platform, fernwell) share every workflowId, and
//     the only filter readers had was workflowId. One p95 was being computed across four different
//     sites' content, and the EV floor derived from it was charging zilberman dr-lurie's prices.
//   - routeEra: several nodes had their route flipped from a model dispatch to a deterministic one
//     (contract_intelligence, artifact_plan, publication_controller). Samples from before and after
//     that flip describe two different programs under one nodeId; artifact_plan's era-mixed p95 (118s
//     against a deterministic route that now takes ~0.2s) was the single figure that made a
//     "p95 x 2" stall threshold look like it would do something.
//   - executionMode: mock runs record estimated cost. The budget guard reads ACTUAL cost only
//     (R-20), so ledger cost and guard cost were two different numbers wearing one name.
//   - attempt: an orchestrator retry recorded ONE sample whose duration was the last attempt's and
//     whose cost was every attempt's, summed — the one combination that is wrong in both halves.
//   - phase: article_body's duration was stamped before its validate/revision phases ran, clipping up
//     to ~345s of real work off the very node whose claim window the stall incident turned on.
//
// EVERY ONE OF THEM IS OPTIONAL, deliberately. Records written before this wave carry none of them and
// must keep aggregating — a migration that made the existing 26-41 samples per node unreadable would
// buy honesty at the price of having no history at all. What the aggregators do instead is stated at
// aggregateNodeTimingsByNode: unattributed records are used when nothing better exists and stand aside
// the moment attributed samples for the same node arrive.
export type NodeTimingRecord = {
  timingId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  durationMs: number;
  // MEASURED, ACTUAL cost for THIS sample (status:"actual" usage only, and for THIS attempt alone —
  // see recordNodeTimingCompletion for the delta arithmetic that keeps a retried node from billing
  // its first attempt twice). Mock/estimated spend is carried separately below so it is visible
  // without being countable.
  costUsd: number;
  // The estimated half of the same usage window, kept beside costUsd rather than folded into it. A
  // mock run's whole spend lands here and its costUsd is 0, which is the honest pair: a mock run
  // moved no money.
  estimatedCostUsd?: number;
  outcome: NodeTimingOutcome;
  recordedAt: string;
  // The tenant this sample belongs to. Absent on pre-W0.1 records and on runs that carry no project.
  projectId?: string;
  // "openai" | "anthropic" | "mock" — the run's declared execution mode. Aggregates exclude "mock" by
  // default; an absent value is never treated as mock.
  executionMode?: string;
  // WHICH PROGRAM produced this sample: a deterministic route's declaration (e.g.
  // "publishExecutorDeterministic:execute", "captureStageDeterministic:crawl") or MODEL_ROUTE_ERA for
  // a model dispatch. Absent on pre-W0.1 records — see UNATTRIBUTED_ROUTE_ERA.
  routeEra?: string;
  // 1-based attempt number. Present from the first attempt onward once a node has been retried; a
  // node that succeeded first time may legitimately carry 1 or nothing at all.
  attempt?: number;
  // Set on a SUB-NODE sample (article_body's "model" / "validate" / "revision" segments). Phase
  // samples are a duration breakdown, never a node completion: they carry costUsd 0 and are excluded
  // from every node-level aggregate unless a caller asks for them.
  phase?: string;
  // W2.1 — the token halves behind costUsd, for the same attempt window. Recorded because the budget
  // guard needs the OUTPUT half specifically: its input term must stay the live, growing request size
  // (that is the runaway detector), and only its output term may be replaced by measurement.
  inputTokens?: number;
  outputTokens?: number;
  // How the sample ended, when that is not visible from `outcome` alone. "reclaim" marks a dispatch
  // the executor took back as stale — the incident class that used to be invisible because a reclaim
  // deletes durationMs from the node state before anything records it.
  terminatedBy?: "reclaim";
};

export type NodeTimingFilters = {
  runId?: string;
  workflowId?: string;
  nodeId?: string;
  projectId?: string;
  from?: string;
  to?: string;
};

// The routeEra written for a node dispatched to a model runner, as opposed to one that terminated in
// a deterministic route. A literal rather than `undefined` so "we know this was a model dispatch" and
// "we do not know what this was" stay distinguishable — the whole point of the field.
export const MODEL_ROUTE_ERA = "model";

// The bucket a pre-W0.1 record falls into: it was written before routes were attributed, so its era
// is genuinely unknown and must not be asserted to be either one.
export const UNATTRIBUTED_ROUTE_ERA = "unattributed";

// node.execute's single-node path. Segregated from MODEL_ROUTE_ERA because an independent execution
// is a different program even on the same node: it runs against supplied dependency outputs rather
// than a live run's, and a node whose CONDUCTOR route is deterministic still reaches a model runner
// here. (Those records already sit under workflowId "independent_node", so this is belt-and-braces
// rather than the only thing keeping them apart.)
export const NODE_EXECUTE_ROUTE_ERA = "node_execute";

export type RecordNodeTimingInput = Omit<NodeTimingRecord, "timingId" | "recordedAt"> & Partial<Pick<NodeTimingRecord, "timingId" | "recordedAt">>;

const makeTimingId = () => `timing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Pure: stamps timingId/recordedAt only when the caller omits them, so a repository round-trip (or a
// test) can supply both deterministically. Mirrors recordModelUsage's own stamping contract
// (modelUsage.ts) — same shape of "optional in, always-present out".
export function buildNodeTimingRecord(input: RecordNodeTimingInput): NodeTimingRecord {
  return {
    ...input,
    timingId: input.timingId ?? makeTimingId(),
    recordedAt: input.recordedAt ?? new Date().toISOString()
  };
}

export const NODE_TIMING_EMA_ALPHA = 0.3;

// Standard exponential moving average: EMA_0 = first sample (no smoothing possible with nothing to
// smooth against); EMA_n = alpha*sample_n + (1-alpha)*EMA_{n-1}. Pure and order-sensitive — callers
// must fold samples in chronological (recordedAt-ascending) order, the same convention
// modelUsage.ts's summarizeModelUsage relies on for its own per-node buckets.
export function foldEma(previous: number | undefined, sample: number, alpha: number = NODE_TIMING_EMA_ALPHA): number {
  return previous === undefined ? sample : alpha * sample + (1 - alpha) * previous;
}

// Percentile definition: NEAREST-RANK (no interpolation). rank = ceil(p/100 * n), 1-based, clamped to
// [1, n]; the result is sortedAscending[rank - 1]. Chosen over a linear-interpolation method because
// it needs no interpolation, is cheap to recompute on every read, and — the reason it is stated here
// instead of assumed — its behaviour on the tiny sample counts an early node history actually has is
// well-defined without a special case:
//   n=1: rank = ceil(p/100) = 1 for every p in (0,100], so p50 AND p95 both return the single sample.
//   n=2, ascending [a, b]: p50 -> rank=ceil(0.5*2)=1 -> a (the smaller); p95 -> rank=ceil(0.95*2)=2 ->
//     b (the larger). A linear-interpolation definition would instead blend a and b at p50 — the case
//     this comment exists to rule out. See the n=1/n=2 tests in nodeTimings.test.ts.
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.min(sortedAscending.length, Math.max(1, Math.ceil((p / 100) * sortedAscending.length)));
  return sortedAscending[rank - 1];
}

export type NodeTimingAggregate = {
  nodeId: string;
  count: number;
  emaDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  // 2026-09-08 — THE COST HALF, added because it was missing and something needed it.
  // The ledger has always RECORDED costUsd (recordNodeTimingCompletion reads it back from the usage
  // ledger); only the aggregate was duration-only, so "what does this node usually cost" had no
  // answer and monetization_strategy's estimatedRunCost was left to a model turn — the $800-against-
  // $3.86 defect. Same three statistics, same definitions, same folding order as the duration half.
  emaCostUsd: number;
  p50CostUsd: number;
  p95CostUsd: number;
  totalCostUsd: number;
  // W0.1 — WHICH SAMPLES THESE STATISTICS ARE ABOUT. `routeEra` names the program the figures
  // describe; `eraExcludedCount` is how many samples for this nodeId were set aside because they
  // belong to a different era (or to no attributed era at all). A caller that sees count:2 with
  // eraExcludedCount:34 is looking at a thin-but-honest aggregate, not a broken one — which is
  // exactly the state a node has just after its route flips.
  routeEra: string;
  eraExcludedCount: number;
};

export type NodeTimingAggregateOptions = {
  // Mock runs record estimated spend against a ceiling that only counts actual spend. Excluded by
  // default; a record with NO executionMode is never assumed to be mock.
  includeMock?: boolean;
  // Phase samples are a within-node duration breakdown, not node completions. Excluded by default so
  // a node is never counted more times than it ran.
  includePhases?: boolean;
  // Restrict to one tenant. Records carrying no projectId are pre-W0.1 and are excluded when this is
  // set — a sample that cannot be attributed to this tenant is not evidence about it.
  projectId?: string;
};

const routeEraOf = (record: NodeTimingRecord): string => record.routeEra ?? UNATTRIBUTED_ROUTE_ERA;

// The one filter every aggregator applies before counting anything. Stated once so the node view and
// the era view can never disagree about which samples are countable.
export function selectAggregableTimings(records: readonly NodeTimingRecord[], options: NodeTimingAggregateOptions = {}): NodeTimingRecord[] {
  return records.filter((record) => {
    if (!options.includePhases && record.phase !== undefined) return false;
    if (!options.includeMock && record.executionMode === "mock") return false;
    if (options.projectId !== undefined && record.projectId !== options.projectId) return false;
    return true;
  });
}

const summarize = (nodeId: string, routeEra: string, chronological: readonly NodeTimingRecord[], eraExcludedCount: number): NodeTimingAggregate => {
  let ema: number | undefined;
  for (const record of chronological) ema = foldEma(ema, record.durationMs);
  const sortedDurations = chronological.map((record) => record.durationMs).sort((a, b) => a - b);
  let emaCost: number | undefined;
  for (const record of chronological) emaCost = foldEma(emaCost, record.costUsd);
  const sortedCosts = chronological.map((record) => record.costUsd).sort((a, b) => a - b);
  const roundUsd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return {
    nodeId,
    routeEra,
    eraExcludedCount,
    count: chronological.length,
    emaDurationMs: Math.round(ema ?? 0),
    p50DurationMs: percentile(sortedDurations, 50),
    p95DurationMs: percentile(sortedDurations, 95),
    emaCostUsd: roundUsd(emaCost ?? 0),
    p50CostUsd: roundUsd(percentile(sortedCosts, 50)),
    p95CostUsd: roundUsd(percentile(sortedCosts, 95)),
    totalCostUsd: roundUsd(chronological.reduce((sum, record) => sum + record.costUsd, 0))
  };
};

const chronologically = (records: readonly NodeTimingRecord[]): NodeTimingRecord[] => [...records].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

// W0.1 — THE ERA VIEW. One aggregate per (nodeId, routeEra) pair, keyed `${nodeId}::${routeEra}`.
// This is the shape the ledger actually has: `artifact_plan` under the old model route and
// `artifact_plan` under the W8 deterministic route are two programs, and the only reason they ever
// shared a p95 is that nothing recorded which was which. Nothing here picks a winner between eras —
// that judgement belongs to aggregateNodeTimingsByNode, which states its rule out loud.
export function aggregateNodeTimingsByEra(records: readonly NodeTimingRecord[], options: NodeTimingAggregateOptions = {}): Record<string, NodeTimingAggregate> {
  const usable = selectAggregableTimings(records, options);
  const byKey = new Map<string, NodeTimingRecord[]>();
  for (const record of usable) {
    const key = `${record.nodeId}::${routeEraOf(record)}`;
    const list = byKey.get(key);
    if (list) list.push(record); else byKey.set(key, [record]);
  }
  const result: Record<string, NodeTimingAggregate> = {};
  for (const [key, group] of byKey) {
    const [nodeId] = key.split("::");
    result[key] = summarize(nodeId, routeEraOf(group[0]), chronologically(group), 0);
  }
  return result;
}

// Pure aggregator — the ONLY place EMA/p50/p95 arithmetic happens, so it is testable against known
// samples independent of any repository or MCP wiring. Records are grouped by nodeId, sorted by
// recordedAt (EMA is order-sensitive; percentile is not, so it gets its own separate value-sort),
// then folded. Takes every record passed in — callers window/filter (e.g. by workflowId, by runId)
// before calling this, exactly as summarizeModelUsage's callers filter before summarizing.
// W0.1 — THE NODE VIEW, and the one judgement it makes.
//
// Both existing consumers (workflow.get_run_cost's plan.nodeTimingAggregates and createWorkspaceTools'
// runStallTiming) key by nodeId and cannot key by anything else without changing meaning, so this
// keeps returning one aggregate per nodeId. What changed is WHICH samples reach it.
//
// THE RULE, stated so it can be argued with: a node's aggregate describes its CURRENT era only —
// the routeEra of its most recent attributed sample. Samples from any other era are excluded and
// counted in eraExcludedCount. A node with only unattributed (pre-W0.1) samples keeps using them,
// because a thin honest history beats none; the moment one attributed sample for that node lands, the
// unattributed ones stand aside.
//
// THE COST OF THIS RULE, named rather than hidden: on the day a node's route flips, its aggregate
// drops from ~30 samples to 1 and its p95 is briefly noisy. That is the correct direction. The
// alternative — the behaviour being replaced — is `artifact_plan` reporting a confident 118s p95 for a
// route that now returns in 0.2s, which is not a noisier number but a wrong one, and it was wrong in
// the direction that made a stall threshold look justified. Every consumer of this function already
// reads `count`; a thin aggregate announces itself, an era-mixed one does not.
export function aggregateNodeTimingsByNode(records: readonly NodeTimingRecord[], options: NodeTimingAggregateOptions = {}): Record<string, NodeTimingAggregate> {
  const usable = selectAggregableTimings(records, options);
  const byNode = new Map<string, NodeTimingRecord[]>();
  for (const record of usable) {
    const list = byNode.get(record.nodeId);
    if (list) list.push(record); else byNode.set(record.nodeId, [record]);
  }
  const result: Record<string, NodeTimingAggregate> = {};
  for (const [nodeId, nodeRecords] of byNode) {
    const chronological = chronologically(nodeRecords);
    // Most recent ATTRIBUTED era; falls back to the unattributed bucket only when the node has no
    // attributed sample at all.
    const lastAttributed = [...chronological].reverse().find((record) => record.routeEra !== undefined);
    const era = lastAttributed ? routeEraOf(lastAttributed) : UNATTRIBUTED_ROUTE_ERA;
    const inEra = chronological.filter((record) => routeEraOf(record) === era);
    result[nodeId] = summarize(nodeId, era, inEra, chronological.length - inEra.length);
  }
  return result;
}

export type RecordNodeTimingCompletionInput = {
  runId: string;
  workflowId: string;
  nodeId: string;
  durationMs: number;
  outcome: NodeTimingOutcome;
  projectId?: string;
  executionMode?: string;
  routeEra?: string;
  attempt?: number;
  phase?: string;
  terminatedBy?: "reclaim";
  // When THIS attempt began. Usage recorded from this instant onward is this attempt's spend and
  // nothing earlier is — see the cost note on recordNodeTimingCompletion for why the alternative
  // (reading back what previous samples already carry) was rejected.
  attemptStartedAt?: string;
};

// Impure convenience wrapper — the ONE place a node completion becomes a persisted NodeTimingRecord.
// costUsd is read back from the usage ledger this SAME (runId, nodeId) pair already wrote — or
// didn't: a deterministic completion has no usage record and costUsd naturally comes back 0, no
// special case needed (same as R-20's $0-event convention). Best-effort is the CALLER's job: both
// call sites (executor.ts's executeRunnableNode dispatch and nodeRuntime.ts's executeNode) wrap this
// in .catch(() => undefined) — a timing-repository failure must never fail the run or node execution
// it is merely observing.
// W0.2 — WHICH COST, and W0.3 — WHOSE ATTEMPT. Both defects lived in this one line.
//
// COST (W0.2). The old line recorded `totalCostUsdEstimate`, which sums actual AND estimated spend.
// The budget guard that gates a run reads `actualCostUsdEstimate` only (R-20: a mock run's
// deterministic estimates are money nobody spent). So the ledger's cost and the guard's cost were two
// different figures under one name, and the EV floor built on the ledger was charging real runs for
// mock ones. `costUsd` is now the ACTUAL half; the estimated half is kept beside it as
// `estimatedCostUsd` so a mock sample is still fully visible, just not countable.
//
// ATTEMPT (W0.3). summarizeModelUsage sums every usage record for this (runId, nodeId) — which, after
// an orchestrator retry, is every attempt. Recording that figure once per attempt would bill attempt 1
// twice. `attemptStartedAt` windows the usage read to the attempt being recorded, so N samples for a
// retried node sum to exactly the run's actual spend on it rather than N x the total.
//
// WHY A TIME WINDOW AND NOT A LEDGER DELTA. The obvious alternative — read back what previous samples
// for this (runId, nodeId) already carry, and subtract — was written first and then removed, because
// it is a performance trap: the blob timing repository indexes by workflowId only, so a
// {runId, nodeId} list() scans the "node_timings/" prefix and downloads EVERY timing blob in the
// store. That is an O(whole ledger) read on every node completion, in the hot path, growing forever.
// The usage repository is runId-indexed and already supports a `from` filter, so windowing there
// costs one cheap scoped read and is exact rather than reconstructed.
//
// PHASE SAMPLES carry no cost at all. They are a duration breakdown of ONE attempt, and a breakdown
// that also consumed the budget would double-count within an attempt the way retries used to
// double-count across them.
//
// FAIL-OPEN, as everywhere in this area: a usage read that throws is not this function's business to
// handle — every call site wraps it in .catch(() => undefined) — and a costUsd that cannot be
// established is 0, never a guess.
export async function recordNodeTimingCompletion(input: RecordNodeTimingCompletionInput, store: NodeTimingRepository = repositoryManager.getNodeTimingRepository()): Promise<NodeTimingRecord> {
  const { attemptStartedAt, ...record } = input;
  if (record.phase !== undefined) return store.record(buildNodeTimingRecord({ ...record, costUsd: 0 }));
  const usage = await summarizeModelUsage({ runId: record.runId, nodeId: record.nodeId, ...(attemptStartedAt ? { from: attemptStartedAt } : {}) });
  return store.record(buildNodeTimingRecord({
    ...record,
    costUsd: usage.actualCostUsdEstimate,
    ...(usage.estimatedCostUsdEstimate > 0 ? { estimatedCostUsd: usage.estimatedCostUsdEstimate } : {}),
    ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {})
  }));
}

// W2.1 (2026-09-09) — THE MEASURED OUTPUT SIZE, and the one term of the reserve it may replace.
//
// THE DEFECT. The budget guard prices an upcoming model turn as
// estimateModelCost(requestTokens, maxOutputTokens). `maxOutputTokens` is a CAP the node is permitted
// to reach, not what it emits: narrative_movement is capped at 3500 and typically emits ~1100, so
// every turn reserved roughly three times the node's real output cost.
//
// LIVE EVIDENCE (run_1788769566432_5qnafb, narrative_movement, node ceiling $0.15). One in-dispatch
// attempt ran long and actually hit the 3500 cap — $0.121 accrued. The runner retried inside the same
// dispatch, so the guard priced the next turn at the cap again ($0.121) and refused. Measured across
// 40 dispatches this node's p95 is $0.090; the ceiling was never the problem.
//
// ONLY THE OUTPUT TERM. The reserve's INPUT term is estimateRequestTokens(request) — the live, growing
// conversation about to be sent. That term IS the runaway detector: it is what would have caught
// artifact_plan's 386,138-token dispatch, and it must keep rising turn over turn. An earlier cut of
// this change capped the WHOLE prospective cost at the node's measured p95, which silently discarded
// that live signal — a node with a cheap history could then balloon its context and be priced at its
// history rather than at what it was about to spend, reproducing the exact overshoot the guard exists
// to stop. So measurement replaces the OUTPUT tokens only, and never the input.
//
// STILL ONE-DIRECTIONAL. The replacement is Math.min(maxOutputTokens, measured p95 output), so the
// reserve can only shrink and the guard can only fire later, never earlier. A cold ledger, a node
// with no recorded output tokens, or a failed lookup leaves the cap in place and the guard behaves
// exactly as it did.
//
// WHY THE TIMING LEDGER RATHER THAN THE USAGE LEDGER. The obvious source is usage records filtered by
// {workflowId, nodeId}, but BlobUsageRepository indexes by runId alone, so that query scans and
// downloads every usage blob in the store — on the dispatch path, per node. The timing ledger is
// workflowId-indexed and, since W0.1, carries projectId, routeEra and ACTUAL-only figures. This is
// what W0 was for.
//
// PER DISPATCH, NOT PER TURN. A NodeTimingRecord covers one whole dispatch, so for a multi-turn node
// its output total exceeds one turn's and Math.min simply keeps the cap. It bites exactly where it
// should: single-turn nodes, which is every node that has false-stopped.
export const MIN_MEASURED_RESERVE_SAMPLES = 2;

export type MeasuredDispatchCost = {
  // The node's measured OUTPUT size, which is the only term the budget guard may replace. Cost is
  // carried alongside for diagnostics (the run-visible reserve-source warning) and is NOT used to
  // price a turn — see the header above for why capping total cost was wrong.
  p95OutputTokens: number;
  p50OutputTokens: number;
  p95CostUsd: number;
  sampleCount: number;
};

// ONE READ PER (workflow, tenant), NOT ONE PER NODE — and the reason is the same trap W0.3 hit.
//
// BlobNodeTimingRepository.list() keys by workflowId and then DOWNLOADS every blob under that prefix
// before filtering. A per-node lookup on the dispatch path would therefore re-download the whole
// workflow's timing history 25 times per run, growing forever as the ledger does. So the lookup is
// per (workflowId, projectId): one list, aggregated across every node at once, memoized briefly.
//
// The TTL is short and the staleness it permits is harmless: this figure bounds a cost estimate, it
// does not authorize spend, and a reserve computed from history that is five minutes old is not
// meaningfully different from one computed now. The cache is keyed by projectId as well as workflowId
// so a long-lived process serving four tenants can never hand one tenant another's costs.
const MEASURED_COST_TTL_MS = 5 * 60_000;
const MEASURED_COST_CACHE_LIMIT = 64;
type MeasuredCostEntry = { expiresAt: number; byNode: Map<string, MeasuredDispatchCost> };
const measuredCostCache = new Map<string, MeasuredCostEntry>();

export const resetMeasuredDispatchCostCache = (): void => { measuredCostCache.clear(); };

const buildMeasuredCosts = (records: readonly NodeTimingRecord[], minSamples: number): Map<string, MeasuredDispatchCost> => {
  const byNode = new Map<string, { outputTokens: number[]; costs: number[] }>();
  // Same population rule every other aggregate uses (no mock runs, no phase breakdowns), plus: a
  // sample with no recorded outputTokens is pre-W2.1 and cannot answer the question being asked.
  for (const record of selectAggregableTimings(records)) {
    if (!Number.isFinite(record.outputTokens) || (record.outputTokens ?? 0) <= 0) continue;
    const entry = byNode.get(record.nodeId) ?? { outputTokens: [], costs: [] };
    entry.outputTokens.push(record.outputTokens as number);
    entry.costs.push(record.costUsd);
    byNode.set(record.nodeId, entry);
  }
  const result = new Map<string, MeasuredDispatchCost>();
  for (const [nodeId, entry] of byNode) {
    if (entry.outputTokens.length < minSamples) continue;
    const outputs = [...entry.outputTokens].sort((a, b) => a - b);
    const costs = [...entry.costs].sort((a, b) => a - b);
    result.set(nodeId, {
      p95OutputTokens: percentile(outputs, 95),
      p50OutputTokens: percentile(outputs, 50),
      p95CostUsd: percentile(costs, 95),
      sampleCount: outputs.length
    });
  }
  return result;
};

export async function measuredDispatchCost(
  input: { workflowId: string; nodeId: string; projectId?: string; minSamples?: number },
  store: NodeTimingRepository = repositoryManager.getNodeTimingRepository()
): Promise<MeasuredDispatchCost | undefined> {
  const minSamples = input.minSamples ?? MIN_MEASURED_RESERVE_SAMPLES;
  // The cache is keyed by (workflow, tenant) and CANNOT be keyed by which store was asked, so it is
  // used only for the process-wide default repository — the dispatch path, the only caller that needs
  // it. A caller supplying its own store (a test, a one-off audit) always reads that store directly,
  // which removes the "answered from another store's history" footgun rather than documenting it.
  const cacheable = store === repositoryManager.getNodeTimingRepository();
  const key = `${input.workflowId}::${input.projectId ?? ""}::${minSamples}`;
  const now = Date.now();
  if (cacheable) {
    const cached = measuredCostCache.get(key);
    if (cached && cached.expiresAt > now) return cached.byNode.get(input.nodeId);
  }
  const records = await store.list({ workflowId: input.workflowId, ...(input.projectId ? { projectId: input.projectId } : {}) });
  const byNode = buildMeasuredCosts(records, minSamples);
  if (cacheable) {
    if (measuredCostCache.size >= MEASURED_COST_CACHE_LIMIT) measuredCostCache.clear();
    measuredCostCache.set(key, { expiresAt: now + MEASURED_COST_TTL_MS, byNode });
  }
  return byNode.get(input.nodeId);
}
