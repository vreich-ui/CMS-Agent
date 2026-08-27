// Learning → Flywheel (WP-51). The loop as live-count stage cards — observe
// → curate → evaluate → compare → trial → promote → tune. Every count comes
// from a real store (fixtures or this session's overlay, never invented);
// every empty stage says what feeds it and links there, since per this
// surface's whole reason for existing, the zeros ARE the story.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useObservations, useReadiness, useRubrics } from '../../api/hooks';
import * as verbs from '../../api/verbs';
import { Btn, Card } from '../../components/primitives';
import { Skeleton } from '../../components/Skeleton';
import { useStore } from '../../store';
import type { LearnTab } from '../../types';
import { useApprovedDelta, useCuratedNodeIds } from './overlay';
import { ActivityRow } from './Activity';
import { openActivity, readLastVisit, useActivityBaseline } from './activityNav';

function FlyStage({
  label,
  value,
  hint,
  onClick,
  zero,
  arrow = true,
}: {
  label: string;
  value: string;
  hint: string;
  onClick: () => void;
  zero: boolean;
  arrow?: boolean;
}) {
  return (
    <button className="fstage" onClick={onClick}>
      <span className="lbl">{label}</span>
      <span className={`big num ${zero ? 'zero' : ''}`}>{value}</span>
      <span className="hint">{hint}</span>
      {arrow && <span className="arrow">→</span>}
    </button>
  );
}

export function Flywheel() {
  const setLearn = useStore((s) => s.setLearn);
  const pairsDone = useStore((s) => s.pairsDone);
  const obsQ = useObservations();
  const rubricsQ = useRubrics();
  const readinessQ = useReadiness();
  const curatedIds = useCuratedNodeIds();
  const approvedDelta = useApprovedDelta();
  const regressionQ = useQuery({
    queryKey: ['regressionReports', 'all'],
    queryFn: () => verbs.evaluationListRegressionReports(),
  });

  const go = (t: LearnTab) => () => setLearn(t);

  const observeCount = obsQ.data?.length ?? 0;
  const curateCount = curatedIds.length;
  const evalCount = rubricsQ.data?.length ?? 0;
  const trialCount = regressionQ.data?.length ?? 0;
  const contract = rubricsQ.data?.find((r) => r.node === 'contract_intelligence');
  const approved = (readinessQ.data?.approvedExamples ?? 0) + approvedDelta;
  const approvedThreshold = readinessQ.data?.approvedThreshold ?? 500;
  const pairThreshold = readinessQ.data?.pairThreshold ?? 200;

  // U4 — "recent activity" column: the flywheel used to be seven counts
  // with no narrative underneath. Same read the Activity subtab's own
  // "new" marking and tab badge use (activityBaseline), so a broken
  // changes_list call shows up here too instead of quietly rendering an
  // empty flywheel that looks intentional.
  const activityQ = useActivityBaseline();
  const lastVisit = readLastVisit();
  const recentEvents = useMemo(
    () =>
      [...(activityQ.data?.events ?? [])]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 5),
    [activityQ.data],
  );

  return (
    <>
      <div className="fly">
        <FlyStage
          label="Observe"
          value={String(observeCount)}
          hint="lessons recorded — by runs and by you"
          onClick={go('obs')}
          zero={observeCount === 0}
        />
        <FlyStage
          label="Curate"
          value={String(curateCount)}
          hint="playbooks — observations distilled into injected lessons"
          onClick={go('pb')}
          zero={curateCount === 0}
        />
        <FlyStage
          label="Evaluate"
          value={String(evalCount)}
          hint="rubrics · weighted criteria per node"
          onClick={go('eval')}
          zero={evalCount === 0}
        />
        <FlyStage
          label="Compare"
          value={String(pairsDone)}
          hint="your pairwise verdicts — A/B on outputs"
          onClick={go('cmp')}
          zero={pairsDone === 0}
        />
        <FlyStage
          label="Trial"
          value={String(trialCount)}
          hint={contract ? `regression reports · gate held at ${contract.score} / 0.85` : 'regression reports'}
          onClick={go('eval')}
          zero={trialCount === 0}
        />
        <FlyStage
          label="Promote"
          value="0"
          hint="optimizer promotions → node change history"
          onClick={go('opt')}
          zero
        />
        <FlyStage
          label="Tune"
          value={`${approved} / ${approvedThreshold}`}
          hint={`SFT examples · ${readinessQ.data?.preferencePairs ?? 0} / ${pairThreshold} preference pairs`}
          onClick={go('ds')}
          zero={approved === 0}
          arrow={false}
        />
      </div>

      <Card label="recent activity — what the system changed on its own, and what you changed">
        {activityQ.isLoading && <Skeleton lines={3} />}
        {activityQ.isError && (
          <>
            <p className="attn-error-msg">
              The activity feed could not load — that is not the same thing as nothing having changed.
            </p>
            <p className="mono attn-error-detail">
              {activityQ.error instanceof Error ? activityQ.error.message : 'changes_list failed.'}
            </p>
            <Btn onClick={() => activityQ.refetch()}>Retry</Btn>
          </>
        )}
        {!activityQ.isLoading && !activityQ.isError && recentEvents.length === 0 && (
          <p className="note" style={{ marginTop: 0 }}>
            Nothing recorded yet — every prompt edit, playbook delta, promotion, and model-ladder step will show up
            here as it happens.
          </p>
        )}
        {recentEvents.length > 0 && (
          <div className="actlist">
            {recentEvents.map((e) => (
              <ActivityRow key={e.eventId} event={e} isNew={Date.parse(e.createdAt) > lastVisit} compact />
            ))}
          </div>
        )}
        <Btn onClick={openActivity} style={{ marginTop: 10 }}>
          Open full activity feed →
        </Btn>
      </Card>

      <Card label="how learning changes the workflow — three paths, all inspectable">
        <div className="kv" style={{ gridTemplateColumns: '210px 1fr' }}>
          <span className="k">playbook → effective prompt</span>
          <span>
            Curated lessons are rendered into the node&rsquo;s prompt at run time. See the injection in any
            node&rsquo;s <b>Learning</b> tab; diff stored vs effective in <b>Prompt</b>.
          </span>
          <span className="k">promotion → node definition</span>
          <span>
            A promoted variant lands in the store — it appears in the node&rsquo;s <b>History</b> as a diffable,
            restorable change, attributed to the trial that earned it.
          </span>
          <span className="k">model ladder → cost/quality</span>
          <span>
            With model-attributed eval results, the ladder recommends the cheapest model that holds quality —
            shown in <b>Model &amp; limits</b>, applied with one click.
          </span>
        </div>
      </Card>

      <Card label="the finding">
        <p style={{ margin: 0, color: 'var(--muted)' }}>
          The backend flywheel is complete; every human stage started empty — {observeCount} observations but{' '}
          {curateCount} curated, 0 feedback records at go-live, 0/{pairThreshold} preference pairs. The capture
          surfaces on this screen exist to change that: your judgment is the fuel.
        </p>
      </Card>

      <p className="note">
        learning_list_observations · playbook_get/curate · evaluation_* · optimizer_* · dataset_* · feedback_record
        · feedback_ingest_monetizer
      </p>
    </>
  );
}
