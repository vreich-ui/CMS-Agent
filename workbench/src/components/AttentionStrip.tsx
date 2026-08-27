// U1 — the attention strip. `constellation_get_attention` is the
// workspace's own list of what needs a human: failed runs, pending
// approvals, output-validation failures, pricing caveats, relationship
// issues, and configuration defects (see api/verbs.ts's HONESTY NOTE right
// above `constellationGetAttention`). This is the whole point of the home
// screen per the operator's own goal — "my mind quickly navigates to the
// correct node" — so every item keeps its evidence string visible without
// a click, and resolves to one click that binds the exact run/node and
// switches straight to the workbench. No intermediate screen.
//
// `constellation_get_attention` was failing 100% of the time through the
// Cloud Run proxy as of the 2026-08-26 contract capture (contracts/
// README.md, Finding #4) — fixed server-side but not yet deployed, so a
// live failure here is a real possibility, not a hypothetical. The four
// states below are deliberately distinct DOM shapes (not just different
// text in the same shell) so a failed verb can never render — or be
// mistaken for — an all-clear: loading, error+retry, a real empty state,
// and the item list.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRuns, useWorkflows } from '../api/hooks';
import { constellationGetAttention, type AttentionItem } from '../api/verbs';
import { useStore } from '../store';
import { Btn } from './primitives';
import type { Workflow } from '../types';

// ---------------------------------------------------------------------
// Test-only failure injection. Fixture mode's mock handler for this verb
// always succeeds (mockStore.getAttention() never throws), so — exactly
// like LoginGate.tsx's `__test_setUnauthenticated` (see tests/auth.spec.ts)
// — the only way to exercise the real broker's documented failure mode in
// Playwright is a test-only hook. This one lives on `window` rather than a
// module-level variable so `page.addInitScript` can pre-arm it before the
// app's very first render, making "the verb was already broken on load" a
// deterministic scenario rather than a race against the mock's own fetch.
// ---------------------------------------------------------------------
declare global {
  interface Window {
    __ATTN_FORCE_FAILURE__?: string | null;
  }
}

export function __test_setAttentionFailure(message: string | null): void {
  if (typeof window !== 'undefined') window.__ATTN_FORCE_FAILURE__ = message;
}
export function __test_resetAttentionFailure(): void {
  __test_setAttentionFailure(null);
}

async function fetchAttention(): Promise<AttentionItem[]> {
  const forced = typeof window !== 'undefined' ? window.__ATTN_FORCE_FAILURE__ : null;
  if (forced) throw new Error(forced);
  return constellationGetAttention();
}

// ---------------------------------------------------------------------
// Severity: ranked, and always paired with a word (never color alone).
// The mock's two known values are 'blocker'/'attention'; the live verb's
// full vocabulary ("pricing caveats", "configuration defects", …) isn't
// captured yet (contracts/README.md never got a successful payload), so
// unrecognized severities rank mid-pack rather than silently sorting last.
// ---------------------------------------------------------------------
const SEVERITY_RANK: Record<string, number> = {
  blocker: 0, critical: 0, error: 0, severe: 0, high: 0,
  attention: 1, warning: 1, warn: 1, medium: 1,
  caveat: 2, notice: 2, info: 2, low: 2,
};

function severityRank(severity?: string): number {
  if (!severity) return 1;
  return SEVERITY_RANK[severity.toLowerCase()] ?? 1;
}

function severityMeta(severity?: string): { glyph: string; word: string; chipClass: string } {
  const rank = severityRank(severity);
  const word = severity ?? (rank === 0 ? 'blocker' : rank === 2 ? 'caveat' : 'attention');
  if (rank === 0) return { glyph: '⛔', word, chipClass: 'failed' };
  if (rank === 2) return { glyph: '◦', word, chipClass: '' };
  return { glyph: '▲', word, chipClass: 'blocked' };
}

const KIND_LABELS: Record<string, string> = {
  failed_run: 'Failed run',
  pending_approval: 'Pending approval',
  output_validation_failure: 'Output validation failure',
  pricing_caveat: 'Pricing caveat',
  relationship_issue: 'Relationship issue',
  configuration_defect: 'Configuration defect',
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function evidenceText(item: AttentionItem): string | null {
  if (Array.isArray(item.evidence)) {
    const joined = item.evidence.filter(Boolean).join(' · ');
    return joined || null;
  }
  if (typeof item.evidence === 'string' && item.evidence) return item.evidence;
  if (typeof item.reason === 'string' && item.reason) return item.reason;
  return null;
}

/** nodeId -> workflowId, from every workflow's phases — the same shape
 *  verbs.ts's own (private) nodeIdsForWorkflow builds, needed here because
 *  AttentionItem carries no workflowId of its own (see contracts/README.md
 *  — only kind/severity/nodeId/runId/projectId/title/reason/evidence are
 *  documented on the live payload). */
function buildNodeWorkflowMap(workflows: Workflow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const wf of workflows) {
    for (const [, ids] of wf.phases) {
      for (const id of ids) if (!map.has(id)) map.set(id, wf.id);
    }
  }
  return map;
}

interface JumpTarget {
  wf: string;
  node: string;
  runId?: string;
}

// U7 — reuses the shared shimmer treatment (styles/base.css's `.skel-line`,
// also behind `<Skeleton>`) rather than the flat `var(--line2)` bars this
// used to draw, so every loading placeholder in the app shimmers the same
// way. The row SHAPE stays bespoke (three bars mimicking an attn-item's
// kind/evidence/jump lines, not `<Skeleton>`'s generic paragraph) because
// this is a list of rows, not prose.
function AttentionSkeletonRow() {
  return (
    <div className="attn-item" aria-hidden="true" style={{ opacity: 0.6 }}>
      <span className="skel-line" style={{ width: 76, display: 'inline-block' }} />
      <span className="skel-line" style={{ width: '58%', marginTop: 7 }} />
      <span className="skel-line" style={{ width: '38%', height: 9, marginTop: 7 }} />
    </div>
  );
}

export function AttentionStrip() {
  const attnQ = useQuery({ queryKey: ['attention-strip'], queryFn: fetchAttention, staleTime: 0 });
  const runsQ = useRuns({});
  const workflowsQ = useWorkflows();

  const bindRun = useStore((s) => s.bindRun);
  const setWf = useStore((s) => s.setWf);
  const setNode = useStore((s) => s.setNode);
  const unbindRun = useStore((s) => s.unbindRun);
  const setScreen = useStore((s) => s.setScreen);

  const nodeWorkflowMap = useMemo(() => buildNodeWorkflowMap(workflowsQ.data ?? []), [workflowsQ.data]);

  // Stable sort, most severe first — ties keep the verb's own order.
  const sorted = useMemo(() => {
    const items = attnQ.data ?? [];
    return items
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => severityRank(a.item.severity) - severityRank(b.item.severity) || a.idx - b.idx)
      .map(({ item }) => item);
  }, [attnQ.data]);

  function resolveTarget(item: AttentionItem): JumpTarget | null {
    const run = item.runId ? (runsQ.data ?? []).find((r) => r.id === item.runId) : undefined;
    const wf = run?.wf ?? (item.nodeId ? nodeWorkflowMap.get(item.nodeId) : undefined);
    const node = item.nodeId ?? run?.cur ?? undefined;
    if (!wf || !node) return null;
    return { wf, node, runId: run?.id ?? item.runId };
  }

  /** One click, no intermediate screen — bindRun itself sets wf/runId/node/
   *  mode/tab AND screen:'bench' in one store update when a run is known;
   *  a node-only target (a configuration defect with no run) still lands
   *  on that node in the workbench, just unbound. */
  function jump(target: JumpTarget) {
    if (target.runId) {
      bindRun(target.runId, target.wf, target.node);
    } else {
      setWf(target.wf);
      setNode(target.node);
      unbindRun();
      setScreen('bench');
    }
  }

  if (attnQ.isLoading) {
    return (
      <section className="card attn-strip attn-strip--loading" aria-busy="true" aria-label="Attention">
        <span className="lbl">attention</span>
        <AttentionSkeletonRow />
        <AttentionSkeletonRow />
      </section>
    );
  }

  if (attnQ.isError) {
    return (
      <section className="card attn-strip attn-strip--error" role="alert" aria-label="Attention">
        <span className="lbl">attention</span>
        <p className="attn-error-msg">
          The attention check could not run — that is not the same thing as nothing needing attention.
        </p>
        <p className="mono attn-error-detail">
          {attnQ.error instanceof Error ? attnQ.error.message : 'constellation_get_attention failed.'}
        </p>
        <Btn onClick={() => attnQ.refetch()}>Retry</Btn>
      </section>
    );
  }

  if (sorted.length === 0) {
    return (
      <section className="card attn-strip attn-strip--empty" aria-label="Attention">
        <span className="lbl">attention</span>
        <p className="note attn-allclear">✓ nothing is waiting on you</p>
      </section>
    );
  }

  return (
    <section className="card attn-strip attn-strip--items" aria-label="Attention">
      <span className="lbl">attention · {sorted.length}</span>
      <div className="attn-list">
        {sorted.map((item, i) => {
          const meta = severityMeta(item.severity);
          const evidence = evidenceText(item);
          const target = resolveTarget(item);
          return (
            <div className="attn-item" key={`${item.kind}-${item.runId ?? item.nodeId ?? i}`}>
              <div className="attn-item-head">
                <span className={`chip attn-sev${meta.chipClass ? ' ' + meta.chipClass : ''}`}>
                  {meta.glyph} {meta.word}
                </span>
                <span className="attn-kind lbl">{kindLabel(item.kind)}</span>
              </div>
              <div className="attn-title">{item.title ?? kindLabel(item.kind)}</div>
              <div className="attn-evidence mono">{evidence ?? '(no evidence string supplied)'}</div>
              {target && (
                <Btn className="attn-jump" onClick={() => jump(target)}>
                  {target.runId ? `Jump to ${target.node} · run …${target.runId.slice(-6)}` : `Jump to ${target.node}`}
                </Btn>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
