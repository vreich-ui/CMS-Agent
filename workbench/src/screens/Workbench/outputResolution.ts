// Defect A — one output-source resolution, used everywhere "this run's
// output for this node" is shown. Before this, ThisRunTab read
// `stage_get_output` (the legacy stage-store) as the ONLY source of "this
// node's output" and separately scanned `node_list_outputs` for nothing but
// an operator-override marker — so a node with a real current-run artifact
// from `node_list_outputs` and no legacy stage record (the common,
// production-verified case — live evidence: run_1789034392364_o7bhnj's
// capture_map: a canonical artifact ~176,860 chars, no stage record) showed
// "No stage output recorded for this node in this run." That message is
// simply false for that node.
//
// Precedence (never re-derive this elsewhere — import resolveNodeOutput):
//   1. current-run operator override      — Run.nodes[].outputProvenance.source
//                                            === 'operator_override' (authoritative;
//                                            see the `provenance` param below), with
//                                            node_list_outputs' legacy
//                                            type === 'operator_override' entry kept
//                                            only as a fallback for a run recorded
//                                            before outputProvenance existed
//   2. current-run canonical node artifact — node_list_outputs, any other type
//   3. legacy stage-store record           — stage_list_outputs (id shape decides run-attribution)
//   4. an honest, per-node-state empty message
//
// Adversarial-review fix (post-W4) — the live server does NOT type an
// override's node_list_outputs entry 'operator_override'; it types it by
// `node.produces[0]`, same as anything else the node ever produced (see
// overrideStatus.ts's header comment on suppliedOutputMarker for the full
// story). So on live data, tier 1 and tier 2 can hold the exact same entry
// shape — the only thing that tells them apart is the run record's own
// `outputProvenance`. Callers pass it in as `provenance`; this module still
// falls back to the legacy typed-entry scan when a caller has none (an
// older run, or a unit test written before outputProvenance existed —
// tests/outputResolution.spec.ts's existing cases all omit it and keep
// passing unmodified).
//
// Both node_list_outputs and stage_list_outputs are read defensively here:
// node_list_outputs entries are matched EXACTLY on both runId and nodeId
// (never assumed scoped just because the caller's query args said so — a
// looser backend or a stale cache entry must not leak another run's or
// node's output in as if it were this one's); stage_list_outputs entries
// are attributed to this run only when their id carries this run's own id
// (the workflow mirror's `${runId}:${nodeId}` or the single-node path's
// `${runId}:${executionId}:${nodeId}`); a record OWNED by a different run
// is never shown here at all, and a genuinely unattributable id (a bare
// pre-convention `stage_*`) is shown but labelled unscoped, never claimed
// as this run's own record.
//
// Pure and framework-free, so it's unit-testable the same way
// tests/adapters.spec.ts unit-tests api/adapters.ts: plain Node assertions
// through the Playwright test runner, no `page`, no browser — see
// tests/outputResolution.spec.ts.

import type { NodeOutputEntry } from '../../components/drive/overrideStatus';
import type { StageOutputEntry } from '../../api/verbs';
import type { NodeRunStatus } from './helpers';

export type OutputSource = 'override' | 'canonical' | 'legacy' | 'empty';

export interface ResolvedNodeOutput {
  source: OutputSource;
  /** The output value itself — present for every source except 'empty'. */
  value?: unknown;
  createdAt?: string;
  /** source === 'canonical' only — the backend's own artifact `type`
   *  (e.g. "capture_map.v1"), carried through verbatim, never invented. */
  artifactType?: string;
  /** source === 'legacy' only — whether the record's id proves it belongs
   *  to this exact run, or is unattributable (a pre-canonical-artifact,
   *  random-id record that merely answers "the last stage record for this
   *  node stage", not "this run's"). */
  legacyScope?: 'run' | 'unscoped';
  /** source === 'override' only — the operator's own note, when given. */
  overrideNote?: string;
  /** source === 'empty' only — an honest, node-state-specific reason;
   *  never the generic "No stage output recorded" that started this. */
  emptyMessage?: string;
}

/**
 * Newest-first pick with a deterministic tie-break: on equal (or both
 * missing/unparseable) `createdAt`, the LATER entry in the input array
 * wins — scanning front-to-back and replacing on `>=` rather than `>`
 * achieves exactly that without a second pass or a stable-sort dependency.
 */
function newestOf<T extends { createdAt?: string }>(entries: T[]): T | undefined {
  let best: T | undefined;
  let bestTs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const parsed = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    if (best === undefined || ts >= bestTs) {
      best = entry;
      bestTs = ts;
    }
  }
  return best;
}

/** Empty-state honesty (Defect B's empty-state rules, folded in here so
 * every caller gets the same wording): a node that hasn't completed never
 * gets told "no output was recorded" as though it should have one — it
 * gets told, specifically, that it hasn't run yet, is paused, or is
 * blocked. Only a genuinely terminal node (completed or failed) with
 * nothing in any tier gets the precise missing-record message. */
export function emptyOutputMessage(status: NodeRunStatus): string {
  switch (status) {
    case 'queued':
      return 'This node has not run yet in this run, so it has no output to show.';
    case 'running':
      return 'This node is still running — it has not completed, so there is no output yet.';
    case 'paused':
      return 'This run is paused before this node finished. No output has been recorded yet — resume the run to let it complete.';
    case 'blocked':
      return 'This node is blocked on a gate and has not completed, so it has no output yet.';
    case 'cancelled':
      return 'This node was cancelled before it completed, so no output was recorded.';
    case 'failed':
      return 'This node failed and recorded no output — no canonical artifact and no legacy stage record exist for it in this run.';
    case 'completed':
    default:
      return 'This node completed but recorded no output — no canonical artifact and no legacy stage record exist for it in this run.';
  }
}

export function resolveNodeOutput(params: {
  status: NodeRunStatus;
  runId: string;
  nodeId: string;
  /** Raw node_list_outputs entries (already unwrapped — see
   *  overrideStatus.ts's extractOutputList). */
  nodeOutputs: NodeOutputEntry[];
  /** Raw stage_list_outputs entries for this node's stage (== nodeId). */
  stageOutputs: StageOutputEntry[];
  /** Adversarial-review fix (post-W4) — this node's outputProvenance off
   *  the RUN record (Run.nodes[].outputProvenance), the authoritative
   *  "was this supplied, and by what" source. Only its 'operator_override'
   *  value is read here — 'default_output' provenance still resolves
   *  through the ordinary canonical tier below; see ThisRunTab.tsx's own
   *  comment on why that stays orthogonal to this precedence. Optional —
   *  omit it to fall back to the legacy typed-entry scan. */
  provenance?: { source: 'default_output' | 'operator_override'; updatedAt: string; note?: string };
}): ResolvedNodeOutput {
  const { status, runId, nodeId, nodeOutputs, stageOutputs, provenance } = params;

  const scoped = nodeOutputs.filter((e) => e.runId === runId && e.nodeId === nodeId);
  const legacyOverrides = scoped.filter((e) => e.type === 'operator_override');
  const canonical = scoped.filter((e) => e.type !== undefined && e.type !== 'operator_override');

  // Tier 1 — always wins, regardless of node status: an override can be
  // set on a node before it has even run (drive mode). Run-record
  // provenance decides FIRST (the real server's own entry for an override
  // is typed no differently than a produced artifact — see this module's
  // header); the legacy type==='operator_override' scan only matters when
  // the run carries no provenance for this node at all.
  if (provenance?.source === 'operator_override') {
    const suppliedEntry = newestOf(scoped) ?? newestOf(legacyOverrides);
    return {
      source: 'override',
      value: suppliedEntry?.value,
      createdAt: provenance.updatedAt,
      overrideNote: provenance.note,
    };
  }
  const bestOverride = newestOf(legacyOverrides);
  if (bestOverride) {
    return {
      source: 'override',
      value: bestOverride.value,
      createdAt: bestOverride.createdAt,
      overrideNote: typeof bestOverride.note === 'string' ? bestOverride.note : undefined,
    };
  }

  // REVIEW FIX (R1) — a node that has not reached an output-producing state in
  // THIS run shows no value from tiers 2/3, only the honest empty message. This is
  // what keeps a superseded record from being presented as current: retryNode and
  // resetRun delete `run.stageOutputs[nodeId]` and drop the node's artifacts, but
  // NOTHING deletes the workspace stage-store mirror, so a re-queued node still has
  // a `${runId}:${nodeId}` record holding the PREVIOUS attempt's value. Rendering
  // that under "for this run" would be a confident lie about a node that is about to
  // run again. An operator override (tier 1, above) is deliberately exempt — it is
  // set on purpose, often before the node runs at all.
  const producedInThisRun = status !== 'queued' && status !== 'running' && status !== 'paused';
  if (!producedInThisRun) return { source: 'empty', emptyMessage: emptyOutputMessage(status) };

  // Tier 2 — the canonical run artifact node_list_outputs actually carries
  // for a completed/failed node.
  const bestCanonical = newestOf(canonical);
  if (bestCanonical) {
    return {
      source: 'canonical',
      value: bestCanonical.value,
      createdAt: bestCanonical.createdAt,
      artifactType: typeof bestCanonical.type === 'string' ? bestCanonical.type : undefined,
    };
  }

  // Tier 3 — legacy stage-store fallback. Id shape alone decides
  // run-attribution; stage_list_outputs itself already scoped the list to
  // this node's stage (== nodeId), never to a run.
  // REVIEW FIX (R2) — the executor's workflow mirror writes `${runId}:${nodeId}`,
  // but the SINGLE-NODE path (nodeRuntime.ts) has always written
  // `${runId}:${executionId}:${nodeId}`. Both are this run's own record; matching only
  // the two-part shape demoted a node_execute run's own output to "unscoped" and told
  // the operator its id "doesn't confirm it belongs to this exact run" when it does.
  const belongsToThisRun = (id: string) => id === `${runId}:${nodeId}` || (id.startsWith(`${runId}:`) && id.endsWith(`:${nodeId}`));
  // A `run_*`-prefixed id names its OWNING run (the same head the engine's own
  // refuseCrossRunStageAccess parses). A record owned by a DIFFERENT run is not a
  // legacy record with unknown provenance — it is another run's value, and it must
  // never be rendered inside "This run". Only genuinely unattributable ids (bare
  // `stage_*`, pre-convention) survive as the compatibility fallback.
  const ownedByAnotherRun = (id: string) => {
    const separator = id.indexOf(':');
    if (separator < 0) return false;
    const head = id.slice(0, separator);
    return /^run_/.test(head) && head !== runId;
  };
  const runAttributed = stageOutputs.filter((e) => belongsToThisRun(e.id));
  const bestRunAttributed = newestOf(runAttributed);
  if (bestRunAttributed) {
    return {
      source: 'legacy',
      value: bestRunAttributed.value,
      createdAt: bestRunAttributed.createdAt,
      legacyScope: 'run',
    };
  }
  const bestUnscoped = newestOf(stageOutputs.filter((e) => !ownedByAnotherRun(e.id)));
  if (bestUnscoped) {
    return {
      source: 'legacy',
      value: bestUnscoped.value,
      createdAt: bestUnscoped.createdAt,
      legacyScope: 'unscoped',
    };
  }

  // Tier 4 — nothing anywhere. State-specific honesty, never the old
  // blanket "No stage output recorded for this node in this run."
  return { source: 'empty', emptyMessage: emptyOutputMessage(status) };
}

// ============================================================================
// Bounded large-value presentation — a ~177 KB serialized artifact (the
// live capture_map evidence) must stay inspectable without freezing the
// page. This never truncates data silently: `full` always carries the
// complete serialization, `prefix` is a capped slice for the initial
// render, and `truncated`/`fullLength` are what a caller uses to say, in
// words, "showing N of M characters" with an explicit way to see the rest.
// ============================================================================

export interface BoundedText {
  full: string;
  prefix: string;
  truncated: boolean;
  fullLength: number;
}

export const DEFAULT_OUTPUT_PREVIEW_CHARS = 8000;

export function boundedOutputText(value: unknown, limit = DEFAULT_OUTPUT_PREVIEW_CHARS): BoundedText {
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    full = String(value);
  }
  const truncated = full.length > limit;
  return { full, prefix: truncated ? full.slice(0, limit) : full, truncated, fullLength: full.length };
}
