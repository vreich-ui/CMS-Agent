// Learning tab — the node's view into the flywheel: playbook state (real,
// persisted, scope-aware — CMS-Agent track A), rubric status + score trend,
// observations mentioning this node, and fine-tune readiness. Mirrors
// spec/mockup.html's S.tab==='learn' branch.
//
// CMS-Agent track A (2026-09-18): this card used to read from
// Learning/overlay.ts's session-local CuratedLesson demonstration store and
// render a hand-reconstructed "injection" string that was never what any
// backend call actually returned — see the track-A report for the full
// rationale. It now shares Learning/PlaybookPanel.tsx with the Learning →
// Playbooks screen, so both surfaces read the exact same playbook_get /
// playbook_apply_delta round trip through one normalization path
// (api/adapters.ts's toPlaybookView). The playbook scope (fleet vs. a
// specific tenant) is shared, cross-screen UI state from Learning/scope.ts —
// picking it here also affects the Learning screen, and vice versa.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useObservations, useReadiness, useRubrics } from '../../../api/hooks';
import * as verbs from '../../../api/verbs';
import { Btn, Card, KV, Meter } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_MOCK } from '../../../api/client';
import { useStore } from '../../../store';
import { PlaybookPanel } from '../../Learning/PlaybookPanel';
import { ScopePicker } from '../../Learning/ScopePicker';
import { useApprovedDelta } from '../../Learning/overlay';
import { ErrorNote, LoadingNote } from './Shared';

const HELD_THRESHOLD = 0.85;

export function LearningTab({ nodeId }: { nodeId: string }) {
  const setLearn = useStore((s) => s.setLearn);
  const setScreen = useStore((s) => s.setScreen);
  const qc = useQueryClient();

  const rubricsQ = useRubrics();
  const readinessQ = useReadiness(nodeId);
  const obsQ = useObservations(nodeId);
  const approvedDelta = useApprovedDelta();

  const rubric = rubricsQ.data?.find((r) => r.node === nodeId);
  const obs = obsQ.data ?? [];

  const regressionM = useMutation({
    mutationFn: verbs.evaluationRunRegression,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rubrics'] }),
  });
  const createRubricM = useMutation({
    mutationFn: verbs.evaluationCreateRubric,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rubrics'] }),
  });

  function goLearning(tab: 'obs' | 'eval' | 'pb') {
    setLearn(tab);
    setScreen('learning');
  }

  async function runRegression(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await regressionM.mutateAsync({ node: nodeId });
      toast('Regression run', `evaluation_run_regression → ${nodeId}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Regression failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function createRubric(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await createRubricM.mutateAsync({ node: nodeId, crit: 0, top: 'not yet defined — edit from Learning → Evaluate' });
      // Truth-telling — IS_MOCK-gated: the "may not appear in the list"
      // caveat describes a fixture-store limitation, not something true of
      // a live backend.
      const caveat = IS_MOCK
        ? ' (fixtures only persist updates to the 5 existing rubric nodes — this call fires for real but may not appear in the list here)'
        : '';
      toast('Rubric requested', `evaluation_create_rubric → ${nodeId}${caveat}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Create rubric failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  const approved = (readinessQ.data?.approvedExamples ?? 0) + approvedDelta;

  return (
    <>
      <Card
        label={
          <>
            playbook <span className="pin live">live — real backend record for the selected scope</span>
          </>
        }
      >
        <div className="editnote" style={{ marginBottom: 8 }}>
          <ScopePicker compact />
          <Btn onClick={() => goLearning('pb')}>open playbook screen</Btn>
          <Btn onClick={() => goLearning('obs')}>open observations</Btn>
        </div>
        <PlaybookPanel nodeId={nodeId} />
      </Card>

      <Card label="evaluation">
        {rubricsQ.isLoading ? (
          <LoadingNote>Loading rubrics…</LoadingNote>
        ) : rubricsQ.isError ? (
          <ErrorNote message={rubricsQ.error?.message} />
        ) : rubric ? (
          <>
            <KV>
              <span className="k">rubric</span>
              <span>
                {rubric.crit} weighted criteria · {rubric.top}
              </span>
              <span className="k">last regression</span>
              <span>
                {rubric.verdict ? (
                  <>
                    <span className={`regverdict ${rubric.verdict}`}>{rubric.verdict}</span> mean{' '}
                    <span className="num">{rubric.score}</span> / threshold{' '}
                    <span className="num">{HELD_THRESHOLD}</span>
                  </>
                ) : (
                  'no regression baseline yet'
                )}
              </span>
              {rubric.score !== null && (
                <>
                  <span className="k">score trend</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="spark">
                      {[rubric.score, rubric.score, rubric.score, rubric.score].map((v, i) => (
                        <i key={i} className="hi" style={{ height: v * 100 * 0.3 }} />
                      ))}
                    </span>
                    <span style={{ color: 'var(--faint)', fontSize: 11 }}>flat — no movement across baseline + re-run</span>
                  </span>
                </>
              )}
            </KV>
            <div className="editnote">
              <Btn onClick={() => goLearning('eval')}>open rubric</Btn>
              <Btn variant="pri" disabled={regressionM.isPending} onClick={(e) => runRegression(e.currentTarget)}>
                {regressionM.isPending ? 'Running…' : 'run regression'}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 8px' }}>No rubric for this node yet.</p>
            <div className="editnote">
              <Btn disabled={createRubricM.isPending} onClick={(e) => createRubric(e.currentTarget)}>
                {createRubricM.isPending ? 'Creating…' : 'create rubric'}
              </Btn>
            </div>
          </>
        )}
      </Card>

      <Card label="fine-tune readiness">
        {readinessQ.isLoading ? (
          <LoadingNote>Loading readiness…</LoadingNote>
        ) : readinessQ.isError ? (
          <ErrorNote message={readinessQ.error?.message} />
        ) : readinessQ.data ? (
          <>
            <KV>
              <span className="k">approved examples</span>
              <span className="num">
                {approved} / {readinessQ.data.approvedThreshold}
              </span>
            </KV>
            <Meter pct={(approved / readinessQ.data.approvedThreshold) * 100} />
            <KV>
              <span className="k">preference pairs</span>
              <span className="num">
                {readinessQ.data.preferencePairs} / {readinessQ.data.pairThreshold}
              </span>
            </KV>
            <Meter pct={(readinessQ.data.preferencePairs / readinessQ.data.pairThreshold) * 100} />
            <p className="note">{readinessQ.data.recommendation}</p>
          </>
        ) : null}
      </Card>

      {obs.length > 0 && (
        <Card label="observations mentioning this node">
          {obs.map((o) => (
            <div className="obsrow" key={o.id}>
              <span className="when">{o.when}</span>
              <span className="txt">{o.txt}</span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
