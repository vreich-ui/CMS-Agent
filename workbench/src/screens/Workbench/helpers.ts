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
