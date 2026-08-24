// Pure helpers shared by the three Runs tabs. Mirrors two functions from the
// mockup's script block (spec/mockup.html): orderedNodes() (~line 583) and
// nodeRunStatus() (~line 584-591). No React here — kept testable in
// isolation and importable by every tab component in this folder.

import type { Run, Workflow } from '../../types';

/** Flattens a workflow's phase groups into one ordered node-id list. */
export function orderedNodes(wf: Workflow): string[] {
  return wf.phases.flatMap(([, ids]) => ids);
}

/**
 * Per-node status of one run, for the Grid tab's cells. A node before the
 * run's stopped node (`cur`) reads as completed; the stopped node itself
 * carries the run's own status (paused reads as "blocked" here too — both
 * mean "stopped, needs a decision or a nudge", and the mockup's CSS only
 * ever styled the four statuses returned below); everything after reads as
 * queued. A run that finished normally is completed end to end.
 */
export function nodeRunStatus(order: string[], run: Run, nodeId: string): string {
  if (run.status === 'completed') return 'completed';
  const curIdx = run.cur ? order.indexOf(run.cur) : -1;
  const idx = order.indexOf(nodeId);
  if (curIdx !== -1 && idx !== -1 && idx < curIdx) return 'completed';
  if (idx === curIdx) {
    if (run.status === 'failed') return 'failed';
    if (run.status === 'cancelled') return 'cancelled';
    if (run.status === 'running') return 'running';
    return 'blocked';
  }
  return 'queued';
}

/**
 * Run ids encode their creation time (`run_<epochMs>_<rand>`) — the only
 * reliable chronological key. `workflow_list_runs` happens to already
 * return newest-first, but nothing in the contract guarantees that, so the
 * Grid tab sorts explicitly rather than trusting fetch order.
 */
export function runTimestamp(run: Run): number {
  const m = /^run_(\d+)_/.exec(run.id);
  return m ? Number(m[1]) : 0;
}

/** Mono, truncated id — the mockup's `…${id.slice(-10)}` convention. */
export function shortId(id: string): string {
  return `…${id.slice(-10)}`;
}

/**
 * design-review fix — every blocked-run summary used to say "awaiting the
 * operator publish decision" no matter which node it stopped at, even
 * non-publish gates like theme_bind and even non-gate nodes like
 * clone_report (risk: read) or capture_crawl (risk: write), which aren't
 * operator-approval gates at all. The confirm dialogs already get this
 * right per node (see Workbench/helpers.ts's GATE_COPY/gateApproveEffect);
 * this is the same per-node specificity for the Runs screen's own summary
 * lines. Kept as its own small map (rather than importing Workbench/
 * helpers.ts across the screen boundary) — the 4 ids are the same ones
 * that carry risk:"publish" in the node registry.
 */
const GATE_AWAITING_LABEL: Record<string, string> = {
  theme_bind: 'awaiting your theme-apply confirmation',
  publication_controller: 'awaiting your publish decision',
  publish_executor: 'awaiting your publish decision',
  capture_emit_live: 'awaiting your draft-emission confirmation',
};

/** The blocked-run summary clause for a stopped-at node — precise for the
 * four real operator-decision gates, honest ("not an approval gate") for
 * every other node a run can stop at. */
export function blockedSummary(nodeId: string | null | undefined): string {
  if (!nodeId) return 'blocked — see the workbench for what it needs';
  return GATE_AWAITING_LABEL[nodeId] ?? 'blocked here — not an operator gate; see the workbench for why';
}

/**
 * The node a run stopped at, for binding into the workbench. Completed runs
 * carry `cur: null`; fall back to the workflow's last node so "open in
 * workbench" always lands on something real, exactly like the mockup's
 * `bindRun()` (`S.node = r.cur || orderedNodes(r.wf).slice(-1)[0]`).
 */
export function stoppedNode(run: Run, wf: Workflow | undefined): string {
  if (run.cur) return run.cur;
  if (!wf) return '';
  const order = orderedNodes(wf);
  return order[order.length - 1] ?? '';
}
