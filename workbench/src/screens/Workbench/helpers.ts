// Ported from spec/mockup.html's orderedNodes()/nodeRunStatus() (lines ~582-591).
// Kept as pure functions, independent of React/store, so Rail/Center/Dock and
// the smoke test can all compute the same rail order and per-node run status
// the mockup does.

import type { QueryClient } from '@tanstack/react-query';
import type { Run, Workflow } from '../../types';

/** Every node id in a workflow, phase-grouped then flattened — the rail's display order. */
export function orderedNodes(wf: Workflow): string[] {
  return wf.phases.flatMap(([, ids]) => ids);
}

export type NodeRunStatus = 'completed' | 'failed' | 'cancelled' | 'running' | 'blocked' | 'queued';

/**
 * A node's status *within a specific bound run*, derived from the node's
 * position relative to the run's current node — mirrors the mockup exactly:
 * nodes before `run.cur` read as completed, the node at `run.cur` inherits
 * the run's own status, everything after is queued (not yet engaged).
 */
export function nodeRunStatus(run: Run, nodeId: string, order: string[]): NodeRunStatus {
  const i = order.indexOf(nodeId);
  if (run.status === 'completed') return 'completed';
  const ci = order.indexOf(run.cur ?? '');
  if (i !== -1 && ci !== -1 && i < ci) return 'completed';
  if (i === ci) {
    if (run.status === 'failed') return 'failed';
    if (run.status === 'cancelled') return 'cancelled';
    if (run.status === 'running') return 'running';
    return 'blocked';
  }
  return 'queued';
}

/** Deterministic per-node bar heights for the dock timeline when real durationMs isn't available — same formula the mockup uses (`8 + (i*37)%30`), so a "no data" workflow still reads as a timeline rather than a flat line. */
export function fallbackBarHeight(index: number, status: NodeRunStatus): number {
  if (status === 'queued') return 4;
  return 8 + ((index * 37) % 30);
}

/** Smallest and largest bar a measured duration can produce, in px. */
const BAR_MIN = 6;
const BAR_MAX = 38;

export interface TimelineBar {
  nodeId: string;
  /** px height for the bar */
  height: number;
  /** measured duration, or null when the node has not run */
  durationMs: number | null;
  /** what the bar means, for the tooltip */
  title: string;
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * P2-05 — the dock timeline, built from measured durations.
 *
 * Heights are scaled against the slowest node in THIS run, on a square-root
 * curve: a run where one node takes 60× another still has to show both, and
 * a linear scale renders every fast node as a 1px stub. A node with no
 * measured duration (queued, or still running) gets the minimum bar and
 * says so in its tooltip — it is never given a fabricated height.
 */
export function timelineBars(
  nodeTimings: Array<{ nodeId: string; durationMs?: number | null; status?: string }>,
  order: string[],
): TimelineBar[] {
  const byId = new Map(nodeTimings.map((n) => [n.nodeId, n]));
  const ids = order.length > 0 ? order : nodeTimings.map((n) => n.nodeId);
  const durations = ids
    .map((id) => byId.get(id)?.durationMs)
    .filter((d): d is number => typeof d === 'number' && d > 0);
  const max = durations.length > 0 ? Math.max(...durations) : 0;

  return ids.map((nodeId) => {
    const t = byId.get(nodeId);
    const d = typeof t?.durationMs === 'number' ? t.durationMs : null;
    if (d === null) {
      return {
        nodeId,
        height: BAR_MIN,
        durationMs: null,
        title: `${nodeId} — not timed yet (${t?.status ?? 'queued'})`,
      };
    }
    const ratio = max > 0 ? Math.sqrt(d / max) : 0;
    return {
      nodeId,
      height: Math.round(BAR_MIN + ratio * (BAR_MAX - BAR_MIN)),
      durationMs: d,
      title: `${nodeId} — ${humanMs(d)}`,
    };
  });
}

/**
 * Gate copy per gate node — the mockup only wrote theme_bind's; WP-23
 * (Phase 2 gate panel) fills in the other two real cases from the node
 * descriptions in api/fixtures/nodes.json rather than generic text
 * (HANDOFF's WP-23 brief). See ThisRunTab.tsx / Dock.tsx for how this reads
 * on-screen; Dock.tsx additionally composes node-specific *approve* copy
 * for the confirm dialog (what approving here actually does), which lives
 * there rather than here since it needs the run id too.
 */
export const GATE_COPY: Record<string, string> = {
  theme_bind:
    'Exact-replace theme apply awaits confirmation — proposal must cover every declared color key (theme_not_total refused otherwise). Approving performs a real site-theme write.',
  publication_controller:
    'Readiness evidence assembled. This node only ever prepares an auditable go/no-go recommendation — it never publishes. Publishing (if it happens) is publish_executor’s job, next in the pipeline, and it additionally requires the durable operator publish decision recorded here to read "approved".',
  publish_executor:
    'Both preconditions for a live publish are checked here: publication_controller’s decision must read "go", and the durable operator publish decision must read "approved". Approving records that decision and resumes the run — if the controller’s decision is "go", publish_executor then executes the real publish sequence for this project.',
  capture_emit_live:
    'Executes the plan as never-released drafts — any verb that would truly publish or release is refused by this node regardless of approval. Approving resumes the run so the draft emission can happen; nothing goes live from this gate.',
};
/** Used by the This-run tab's gate card (renderCenter) for a gate node with no entry above. */
export const DEFAULT_GATE_COPY_CENTER =
  'Readiness evidence assembled. Awaiting the operator publish decision — see the run dock.';
/** Used by the dock's own gate panel (renderDock) — it IS the run dock, so it doesn't refer back to itself. */
export const DEFAULT_GATE_COPY_DOCK = 'Readiness evidence assembled. Publish requires the operator decision.';

/** True for the two nodes where an *approval* can result in a real, live publish side effect (not a draft, not a recommendation). Drives the extra-unmistakable treatment HANDOFF asks for on the gate panel and its confirm dialog. */
export function isRealPublishGate(nodeId: string | null | undefined): boolean {
  return nodeId === 'publish_executor';
}

/**
 * WP-21's stated criterion: "optimistic status updates with rollback on
 * error." Flips the cached ['run', runId] query to `patch` immediately,
 * runs `mutate` (expected to be a confirmAction-gated call), and on any
 * rejection — including the operator declining the confirm dialog — puts
 * the cache back exactly as it was before rethrowing, so the caller's own
 * catch decides how to surface the error (or, for a cancelled confirm,
 * stays silent).
 */
export async function optimisticRunControl<T>(
  qc: QueryClient,
  runId: string,
  patch: Partial<Run>,
  mutate: () => Promise<T>,
): Promise<T> {
  const key = ['run', runId];
  const prev = qc.getQueryData<Run | null>(key);
  if (prev) qc.setQueryData(key, { ...prev, ...patch });
  try {
    const result = await mutate();
    qc.invalidateQueries({ queryKey: ['run', runId] });
    qc.invalidateQueries({ queryKey: ['runs'] });
    return result;
  } catch (err) {
    if (prev) qc.setQueryData(key, prev);
    throw err;
  }
}

/**
 * Node-specific confirm-dialog copy for the gate panel's Approve button —
 * composed here (not verbs.ts) because it needs the run id, which the
 * shared `workflow_set_operator_publish_decision` verb's fixed effect text
 * doesn't carry per call site. HANDOFF's non-negotiable: "An approval that
 * triggers a real publish must be unmistakable about that fact" — so
 * publish_executor's copy says so in plain terms; the other gates say
 * plainly why approving here does NOT put anything live.
 */
export function gateApproveEffect(run: Run): string {
  const node = run.cur;
  const id = run.id;
  if (node === 'publish_executor') {
    return `Records the operator publish decision as "approved" for ${id} and resumes the run. If publication_controller's own decision reads "go", publish_executor then executes the real publish sequence for ${run.proj} — this is expected to make content live. This cannot be undone.`;
  }
  if (node === 'capture_emit_live') {
    return `Records the operator publish decision as "approved" for ${id} and resumes the run so capture_emit_live can execute. This node always writes never-released drafts and refuses any verb that would truly publish or release — nothing goes live from this approval.`;
  }
  if (node === 'publication_controller') {
    return `Records the operator publish decision as "approved" for ${id} and resumes the run. publication_controller itself never publishes; it hands the recorded decision to publish_executor next, which is where a live action would actually happen.`;
  }
  if (node === 'theme_bind') {
    return `Confirms the exact-replace theme apply for ${id} and resumes the run. theme_bind writes the full declared palette in one operation and refuses to proceed on partial coverage (theme_not_total) — this is a real site-theme write.`;
  }
  return `Records the operator publish decision as "approved" for ${id} and resumes the run at ${node ?? 'the current node'}.`;
}

/** Decline copy for the gate panel — always the safe choice, but still names the concrete effect (HANDOFF §7.3). */
export function gateDeclineEffect(run: Run): string {
  return `Declines the gate for ${run.id} at ${run.cur ?? 'the current node'}. The run is marked cancelled; no publish, release, or write action is taken. Node outputs already completed upstream are kept.`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

/* ============================== U5 additions ================================
 * Navigation & visualization — the graph overlay's layering, per-node run
 * status read straight off a run's real node records (rather than inferred
 * from position relative to run.cur, which nodeRunStatus() above does for
 * the rail's simpler "before/at/after the stopped node" picture), and a
 * couple of small triage-signal derivations the rail's health chips need.
 * Every function below is new — nothing above this line was touched.
 */

export interface GraphLayerResult {
  /** nodeId -> layer index (0 = a root, no unresolved dependency). */
  layerOf: Record<string, number>;
  /** Node ids grouped by layer, each group in the input's original order. */
  layers: string[][];
  maxLayer: number;
  /** True when the edge set contained a cycle — see the function doc below. */
  hadCycle: boolean;
}

/**
 * U5 — layered-DAG layout for the graph overlay: a node sits one layer
 * below its deepest dependency (longest-path-from-roots), computed with a
 * Kahn's-algorithm topological sweep so every node's layer is only ever
 * finalized after all of its known dependencies have been. Edges naming an
 * id outside `nodeIds`, or a self-edge, are dropped rather than trusted —
 * the graph this draws is only ever as good as the ids it was actually
 * given.
 *
 * Cycles are handled defensively, not detected-and-thrown: if the sweep
 * finishes without reaching every node, the remainder can only be a cycle
 * (everything reachable via a genuine DAG path from a root always gets
 * processed). Every unresolved node is placed one layer past whatever was
 * reached, in input order, so the diagram still terminates and renders
 * instead of looping forever chasing a resolved layer that will never
 * come — `hadCycle: true` is the signal callers use to say so rather than
 * silently presenting a cyclic graph as a clean DAG.
 */
export function layerGraph(nodeIds: string[], edges: Array<{ from: string; to: string }>): GraphLayerResult {
  const known = new Set(nodeIds);
  const adj = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const id of nodeIds) {
    adj.set(id, []);
    remaining.set(id, 0);
  }
  for (const e of edges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);
  }

  const layerOf = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((remaining.get(id) ?? 0) === 0) {
      layerOf.set(id, 0);
      queue.push(id);
    }
  }

  let head = 0;
  let processed = 0;
  while (head < queue.length) {
    const u = queue[head++];
    processed++;
    const l = layerOf.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      layerOf.set(v, Math.max(layerOf.get(v) ?? 0, l + 1));
      const r = (remaining.get(v) ?? 0) - 1;
      remaining.set(v, r);
      if (r === 0) queue.push(v);
    }
  }

  const hadCycle = processed < nodeIds.length;
  if (hadCycle) {
    let nextLayer = 1 + Math.max(0, ...[...layerOf.values()]);
    for (const id of nodeIds) {
      if (!layerOf.has(id)) layerOf.set(id, nextLayer);
    }
  }

  const maxLayer = Math.max(0, ...[...layerOf.values()]);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of nodeIds) layers[layerOf.get(id) ?? 0].push(id);

  return { layerOf: Object.fromEntries(layerOf), layers, maxLayer, hadCycle };
}

/**
 * U5 — a node's ACTUAL status within a bound run, read straight off
 * `run.nodes[]` rather than inferred from position relative to `run.cur`
 * the way `nodeRunStatus()` above does. The graph overlay and the trace
 * waterfall both need the real per-node status (a node upstream of `cur`
 * that was actually skipped must not be painted "completed"), so this is
 * additive rather than a change to the existing inference. A node with no
 * entry in `run.nodes[]` at all has honestly not been reached yet —
 * 'queued', not a guess.
 */
export function nodeStatusFromRun(run: Run | null | undefined, nodeId: string): NodeRunStatus {
  const entry = run?.nodes.find((n) => n.nodeId === nodeId);
  if (!entry) return 'queued';
  switch (entry.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'skipped':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'paused':
    case 'blocked':
      return 'blocked';
    default:
      return 'queued';
  }
}

/** U5 — the phase label a node belongs to per the (presentation-only) workflow
 * catalog, or null when the catalog's phase lists don't claim it (see
 * workflowCatalog.ts's own honesty note about stale node lists — a node not
 * found here still exists, it's just ungrouped). */
export function phaseLabelForNode(wf: Workflow, nodeId: string): string | null {
  for (const [label, ids] of wf.phases) {
    if (ids.includes(nodeId)) return label;
  }
  return null;
}

/**
 * U5 — rail health chip: how many of the `limit` most recent runs for this
 * workflow show this node as 'failed'. Reuses whatever run list the caller
 * already fetched (the rail's own `useRuns({workflowId})`) — no extra call.
 * `runs` need not be sorted; recency is taken from the run id's own
 * embedded timestamp (`run_<epochMs>_<rand>`, the one reliable chronological
 * key — see Runs/helpers.ts's runTimestamp for the same convention).
 */
export function nodeErrorFrequency(runs: Run[], nodeId: string, limit = 8): number {
  const ts = (r: Run) => Number(/^run_(\d+)_/.exec(r.id)?.[1] ?? 0);
  const recent = [...runs].sort((a, b) => ts(b) - ts(a)).slice(0, limit);
  let count = 0;
  for (const r of recent) {
    if (r.nodes.some((n) => n.nodeId === nodeId && n.status === 'failed')) count++;
  }
  return count;
}
