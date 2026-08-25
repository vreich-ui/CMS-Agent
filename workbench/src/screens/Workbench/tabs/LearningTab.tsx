// Learning tab — the node's view into the flywheel: playbook injection state
// (with provenance back to the source observation), rubric status + score
// trend, observations mentioning this node, and fine-tune readiness. Mirrors
// spec/mockup.html's S.tab==='learn' branch. WP-54: every control here is
// now live — curate/create-rubric/run-regression all fire real, confirm-
// gated verbs; "view rendered injection" and the playbook lesson list read
// from Learning/overlay.ts (see its header comment — the mock backend's
// playbook_curate doesn't persist on its own, this is what does).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useObservations, useReadiness, useRubrics } from '../../../api/hooks';
import * as verbs from '../../../api/verbs';
import { Btn, Card, KV, Meter } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_MOCK } from '../../../api/client';
import { useStore } from '../../../store';
import { usePlaybook } from '../queries';
import { renderInjection } from '../../Learning/Playbooks';
import { useApprovedDelta, useCuratedLessons } from '../../Learning/overlay';
import { Disclosure, ErrorNote, LoadingNote } from './Shared';

const HELD_THRESHOLD = 0.85;

export function LearningTab({ nodeId }: { nodeId: string }) {
  const setLearn = useStore((s) => s.setLearn);
  const setScreen = useStore((s) => s.setScreen);
  const qc = useQueryClient();

  const playbookQ = usePlaybook(nodeId);
  const rubricsQ = useRubrics();
  const readinessQ = useReadiness(nodeId);
  const obsQ = useObservations(nodeId);
  const curated = useCuratedLessons(nodeId);
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

  const tokens = curated.reduce((sum, l) => sum + l.tokens, 0);
  const approved = (readinessQ.data?.approvedExamples ?? 0) + approvedDelta;

  return (
    <>
      <Card
        label={
          <>
            playbook · injected lessons <span className="pin live">live — part of the effective prompt</span>
          </>
        }
      >
        {curated.length > 0 ? (
          <>
            <p style={{ margin: '0 0 8px' }}>
              {curated.length} lesson{curated.length === 1 ? '' : 's'} curated for this node · {tokens} tokens
            </p>
            {curated.map((l) => (
              <div className="obsrow" key={l.id}>
                <span className="when">{l.when}</span>
                <span className="txt">
                  {l.text}
                  {l.fromObservationId && (
                    <span className="mono" style={{ color: 'var(--faint)', marginLeft: 8, fontSize: 10.5 }}>
                      from {l.fromObservationId.slice(-10)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </>
        ) : playbookQ.isLoading ? (
          <LoadingNote>Loading playbook…</LoadingNote>
        ) : playbookQ.isError ? (
          <ErrorNote message={playbookQ.error?.message} />
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 8px' }}>
            No curated playbook yet for this node.{' '}
            {obsQ.isLoading
              ? 'Checking observations…'
              : obs.length > 0
                ? `${obs.length} observation(s) mention it — curate below.`
                : 'Observations feed this: curate one from the Learning surface.'}
          </p>
        )}
        <div className="editnote">
          <Disclosure openLabel="view rendered injection" closeLabel="hide injection">
            <div className="promptbox" style={{ maxHeight: 200 }}>
              {renderInjection(nodeId)}
            </div>
          </Disclosure>
          <Btn onClick={() => goLearning('obs')}>open observations</Btn>
          <Btn onClick={() => goLearning('pb')}>open playbook</Btn>
        </div>
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
