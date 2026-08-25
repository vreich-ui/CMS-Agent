// Learning → Playbooks. Per-node curated lessons, token budget, the
// rendered injection ("what the node actually receives", verbatim), and
// delta history — playbook_apply_delta removals are reversible (a soft
// delete held in overlay.ts, with a restore button). Real curated content
// lives in overlay.ts (see its header comment for why: the mock backend's
// playbook_curate doesn't persist).

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNodes, useObservations } from '../../api/hooks';
import * as verbs from '../../api/verbs';
import { Btn, Card } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';
import { useStore } from '../../store';
import type { LearnTab } from '../../types';
import { getCuratedLessons, removeLesson, restoreLesson, useCuratedLessons, useCuratedNodeIds, useRemovedLessons } from './overlay';

const BUDGET_CAP = 2000;

function renderInjection(nodeId: string): string {
  const lessons = getCuratedLessons(nodeId);
  if (lessons.length === 0) return '(no curated lessons — nothing is injected for this node yet)';
  return [
    `## Playbook — ${nodeId}`,
    '',
    ...lessons.map((l, i) => `${i + 1}. ${l.text}${l.fromObservationId ? `  [from ${l.fromObservationId.slice(-10)}]` : ''}`),
  ].join('\n');
}

function NodePlaybook({ nodeId }: { nodeId: string }) {
  const lessons = useCuratedLessons(nodeId);
  const removed = useRemovedLessons(nodeId);
  const [showInjection, setShowInjection] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const applyDeltaM = useMutation({ mutationFn: verbs.playbookApplyDelta });
  const tokens = lessons.reduce((sum, l) => sum + l.tokens, 0);

  async function remove(lessonId: string, triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await applyDeltaM.mutateAsync({ nodeId, delta: { op: 'remove', lessonId } });
      removeLesson(nodeId, lessonId);
      toast('Lesson removed', `playbook_apply_delta → ${nodeId} — reversible, see delta history below`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Remove failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  function restore(lessonId: string) {
    restoreLesson(nodeId, lessonId);
    toast('Lesson restored', `${nodeId} — back in the injected playbook`);
  }

  return (
    <div className="toolrow" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <span className="tn">{nodeId}</span>
      <span className="td">
        {lessons.length} lesson{lessons.length === 1 ? '' : 's'} · {tokens} / {BUDGET_CAP} token budget
      </span>
      <span style={{ display: 'flex', gap: 5 }}>
        <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setShowInjection((v) => !v)}>
          {showInjection ? 'hide injection' : 'view injection'}
        </Btn>
        {(removed.length > 0 || lessons.length > 0) && (
          <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'hide history' : 'delta history'}
          </Btn>
        )}
      </span>
      {showInjection && (
        <div className="promptbox" style={{ width: '100%', maxHeight: 220 }}>
          {renderInjection(nodeId)}
        </div>
      )}
      {showHistory && (
        <div style={{ width: '100%' }}>
          {lessons.map((l) => (
            <div className="obsrow" key={l.id}>
              <span className="when">{l.when}</span>
              <span className="txt">{l.text}</span>
              <span className="acts">
                <Btn style={{ padding: '3px 10px', fontSize: 11 }} onClick={(e) => remove(l.id, e.currentTarget)}>
                  remove
                </Btn>
              </span>
            </div>
          ))}
          {removed.map((l) => (
            <div className="obsrow" key={l.id} style={{ opacity: 0.6 }}>
              <span className="when">{l.when}</span>
              <span className="txt" style={{ textDecoration: 'line-through' }}>
                {l.text}
              </span>
              <span className="acts">
                <Btn style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => restore(l.id)}>
                  restore
                </Btn>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Playbooks() {
  const curatedIds = useCuratedNodeIds();
  const obsQ = useObservations();
  const nodesQ = useNodes();
  const setLearn = useStore((s) => s.setLearn);
  const setLrnAndSelect: (t: LearnTab) => void = setLearn;

  // Candidate nodes: appear in the observation feed but have no curated
  // playbook yet. Mirrors the mockup's contract_intelligence/draft_writer
  // rows — every node mentioned by at least one observation, sorted by how
  // many observations point at it (the biggest curation opportunity first).
  const candidates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of obsQ.data ?? []) {
      if (o.node && !curatedIds.includes(o.node)) counts.set(o.node, (counts.get(o.node) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [obsQ.data, curatedIds]);

  // contract_intelligence is the one node whose candidate lessons are
  // mostly the four node-less policy observations (two grammars, media
  // flip, taxonomy, publish≠release) — surfaced explicitly, matching the
  // mockup's called-out example, since `o.node === null` observations never
  // show up in the per-node count above.
  const generalCount = (obsQ.data ?? []).filter((o) => !o.node).length;

  return (
    <Card label="playbooks · curated, budgeted lessons per node">
      {curatedIds.length === 0 && candidates.length === 0 && generalCount === 0 ? (
        <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>
          No playbooks curated yet, and no observations to curate from either — this is the true start of the
          flywheel. Once a run (or you) records an observation, it becomes a candidate lesson here.
        </p>
      ) : (
        <>
          {curatedIds.map((id) => (
            <NodePlaybook nodeId={id} key={id} />
          ))}
          {curatedIds.length === 0 && (
            <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: '0 0 8px' }}>
              No playbook curated yet for any node — 0 of {(nodesQ.data ?? []).length} nodes have one. Every row
              below is an observation-backed candidate.
            </p>
          )}
          {candidates.map(([nodeId, count]) => (
            <div className="toolrow" key={nodeId}>
              <span className="tn">{nodeId}</span>
              <span className="td">
                no playbook yet · {count} observation{count === 1 ? '' : 's'} mention{count === 1 ? 's' : ''} it
              </span>
              <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setLrnAndSelect('obs')}>
                curate from feed
              </Btn>
            </div>
          ))}
          {generalCount > 0 && !curatedIds.includes('contract_intelligence') && (
            <div className="toolrow">
              <span className="tn">contract_intelligence</span>
              <span className="td">
                no playbook yet — {generalCount} policy observation{generalCount === 1 ? '' : 's'} with no node
                attached are candidates (two grammars, media flip, taxonomy, publish≠release)
              </span>
              <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setLrnAndSelect('obs')}>
                curate from feed
              </Btn>
            </div>
          )}
        </>
      )}
      <p className="note">
        a lesson is part of the node&rsquo;s effective prompt — provenance links each lesson back to the
        observation it came from; removals are reversible (playbook_apply_delta)
      </p>
    </Card>
  );
}

export { renderInjection };
