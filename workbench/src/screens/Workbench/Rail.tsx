// WP-11 — node rail + Build/Run mode bar. Markup/behaviour mirror
// spec/mockup.html's `<aside class="rail">` block and renderRail()/orderedNodes()
// /nodeRunStatus() (lines ~42-62, 582-591). Class vocabulary only — no new CSS.

import { useMemo, useRef, type KeyboardEvent } from 'react';
import { useNodes, useRun, useRuns, useWorkflows } from '../../api/hooks';
import { Dot } from '../../components/primitives';
import { useStore } from '../../store';
import type { Run, WorkflowNode } from '../../types';
import { nodeRunStatus, orderedNodes, type NodeRunStatus } from './helpers';

interface VisibleRow {
  nid: string;
  n: WorkflowNode | undefined;
  st: NodeRunStatus | null;
  dim: boolean;
}

export function Rail() {
  const wf = useStore((s) => s.wf);
  const mode = useStore((s) => s.mode);
  const runId = useStore((s) => s.runId);
  const node = useStore((s) => s.node);
  const showUneng = useStore((s) => s.showUneng);
  const setMode = useStore((s) => s.setMode);
  const setNode = useStore((s) => s.setNode);
  const setTab = useStore((s) => s.setTab);
  const setShowUneng = useStore((s) => s.setShowUneng);
  const bindRun = useStore((s) => s.bindRun);
  const openGraphOverlay = useStore((s) => s.openGraphOverlay);

  const workflowsQ = useWorkflows();
  const nodesQ = useNodes(wf);
  const wfRunsQ = useRuns({ workflowId: wf });
  const boundRunQ = useRun(runId);

  const workflow = workflowsQ.data?.find((w) => w.id === wf);
  const nodesById = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    for (const n of nodesQ.data ?? []) map.set(n.id, n);
    return map;
  }, [nodesQ.data]);

  const run: Run | null = mode === 'run' && runId ? (boundRunQ.data ?? null) : null;
  const order = useMemo(() => (workflow ? orderedNodes(workflow) : []), [workflow]);

  const rowsByPhase: Array<[string, VisibleRow[]]> = useMemo(() => {
    if (!workflow) return [];
    return workflow.phases.map(([label, ids]) => {
      const rows: VisibleRow[] = [];
      for (const nid of ids) {
        const st = run ? nodeRunStatus(run, nid, order) : null;
        const dim = Boolean(run) && st === 'queued';
        if (dim && !showUneng) continue;
        rows.push({ nid, n: nodesById.get(nid), st, dim });
      }
      return [label, rows] as [string, VisibleRow[]];
    });
  }, [workflow, run, order, showUneng, nodesById]);

  const visibleIds = useMemo(() => rowsByPhase.flatMap(([, rows]) => rows.map((r) => r.nid)), [rowsByPhase]);

  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function handleModeBuild() {
    setMode('build');
    setTab('prompt');
  }

  function handleModeRun() {
    if (runId) {
      setMode('run');
      setTab('thisrun');
      return;
    }
    const candidate = wfRunsQ.data?.[0];
    if (candidate) {
      bindRun(candidate.id, wf, candidate.cur ?? node);
    }
    // No run exists yet for this workflow — mirrors the mockup: stays in build.
  }

  function handleRailKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (visibleIds.length === 0) return;
    e.preventDefault();
    const idx = visibleIds.indexOf(node);
    const base = idx === -1 ? 0 : idx;
    const nextIdx = e.key === 'ArrowDown' ? (base + 1) % visibleIds.length : (base - 1 + visibleIds.length) % visibleIds.length;
    const nextId = visibleIds[nextIdx];
    setNode(nextId);
    requestAnimationFrame(() => rowRefs.current[nextId]?.focus());
  }

  const isLoading = workflowsQ.isLoading || nodesQ.isLoading;
  const isError = workflowsQ.isError || nodesQ.isError;

  return (
    <aside className="rail">
      {/* a11y S5 — this is a click-only two-state toggle, not a tab panel
          switch (no arrow-key roving, no linked tabpanel), so it doesn't
          fit the tablist/tab pattern role="tablist" implied. aria-pressed
          accurately describes what's actually built. */}
      <div className="modebar">
        <button type="button" id="mode-build" aria-pressed={mode === 'build'} className={mode === 'build' ? 'on' : ''} onClick={handleModeBuild}>
          Build
        </button>
        <button type="button" id="mode-run" aria-pressed={mode === 'run'} className={mode === 'run' ? 'on' : ''} onClick={handleModeRun}>
          Run
        </button>
      </div>

      {isError ? (
        <p style={{ color: 'var(--bad)', fontSize: 12.5, padding: '0 6px' }}>
          {workflowsQ.error?.message ?? nodesQ.error?.message ?? 'Failed to load the node rail.'}
        </p>
      ) : isLoading ? (
        <p style={{ color: 'var(--muted)', fontSize: 12.5, padding: '0 6px' }}>Loading nodes…</p>
      ) : (
        <div id="rail" onKeyDown={handleRailKeyDown}>
          {rowsByPhase.map(([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label}>
                <div className="phase">
                  <span className="lbl">{label}</span>
                </div>
                {rows.map(({ nid, n, st, dim }) => (
                  <button
                    key={nid}
                    type="button"
                    ref={(el) => {
                      rowRefs.current[nid] = el;
                    }}
                    className={['nrow', node === nid ? 'sel' : '', run?.cur === nid ? 'cur' : '', dim ? 'dim' : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setNode(nid)}
                  >
                    <Dot status={st ?? undefined} />
                    <span className="nm">{nid}</span>
                    {n && n.fan > 1 && (
                      <span className="fan" title={`${n.fan} upstream inputs`}>
                        ⇐{n.fan}
                      </span>
                    )}
                    {n && n.risk === 'publish' && (
                      <span className="risk publish" title="publish risk">
                        P
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
      )}

      <div className="railfoot">
        {run && (
          <label>
            <input
              type="checkbox"
              checked={showUneng}
              onChange={(e) => setShowUneng(e.target.checked)}
            />
            show unengaged nodes
          </label>
        )}
        <button type="button" className="ghost" onClick={openGraphOverlay}>
          ⌗ graph overlay
        </button>
      </div>
    </aside>
  );
}
