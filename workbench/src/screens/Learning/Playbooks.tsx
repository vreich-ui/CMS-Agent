// Learning → Playbooks. Pick a scope (Fleet or a tenant) and a node, and see
// that node's REAL persisted playbook — active lessons, budget usage against
// the actual chars the backend renders, and the live composed prompt
// material (Learning/PlaybookPanel.tsx does the reading/editing; this screen
// is just the scope+node picker around it).
//
// CMS-Agent track A (2026-09-18) — this used to read a session-local
// demonstration overlay (./overlay.ts's old CuratedLesson store) that was
// never connected to playbook_get/playbook_apply_delta at all; see the
// track-A report for what was wrong and PlaybookPanel.tsx for the fix.
//
// There is no bulk "list every node's playbook" verb (playbook_get takes
// exactly one nodeId), so this screen cannot honestly show "which nodes
// already have a playbook" without 48 individual reads. The
// "observation-backed candidates" list below is exactly what it says: nodes
// an observation mentions, not a claim about playbook existence.

import { useMemo, useState } from 'react';
import { useNodes, useObservations } from '../../api/hooks';
import { Btn, Card } from '../../components/primitives';
import { useStore } from '../../store';
import type { LearnTab } from '../../types';
import { PlaybookPanel } from './PlaybookPanel';
import { ScopePicker } from './ScopePicker';

export function Playbooks() {
  const nodesQ = useNodes();
  const obsQ = useObservations();
  const setLearn = useStore((s) => s.setLearn);
  const setLrnAndSelect: (t: LearnTab) => void = setLearn;
  const [selectedNode, setSelectedNode] = useState('');

  const nodes = useMemo(() => [...(nodesQ.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [nodesQ.data]);

  const mentioned = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of obsQ.data ?? []) {
      if (o.node) counts.set(o.node, (counts.get(o.node) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [obsQ.data]);

  return (
    <>
      <Card label="playbooks · real persisted lessons per node, at a scope">
        <div className="editnote" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          <ScopePicker />
          <div className="field" style={{ marginBottom: 0 }}>
            <select value={selectedNode} onChange={(e) => setSelectedNode(e.target.value)} aria-label="Node">
              <option value="">choose a node…</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id} — {n.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {selectedNode ? (
          <PlaybookPanel nodeId={selectedNode} key={selectedNode} />
        ) : (
          <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>
            Choose a node above to view or edit its real playbook.
          </p>
        )}
        <p className="note">
          a lesson is part of the node&rsquo;s effective prompt — removals are one-way (retire); re-adding the
          identical text restores it (playbook_apply_delta)
        </p>
      </Card>
      {mentioned.length > 0 && (
        <Card label="observation-backed candidates">
          <p className="note" style={{ marginTop: 0 }}>
            nodes at least one observation mentions — not a claim about whether a playbook already exists there
            (there is no bulk playbook-listing verb to check that honestly; pick the node above to find out)
          </p>
          {mentioned.map(([nodeId, count]) => (
            <div className="toolrow" key={nodeId}>
              <span className="tn">{nodeId}</span>
              <span className="td">
                {count} observation{count === 1 ? '' : 's'} mention{count === 1 ? 's' : ''} it
              </span>
              <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setLrnAndSelect('obs')}>
                curate from feed
              </Btn>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
