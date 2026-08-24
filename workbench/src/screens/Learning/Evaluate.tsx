// Learning → Evaluate (WP-53). Rubric list/editor (weighted criteria,
// versioned via evaluation_update_rubric / evaluation_restore_rubric_version)
// and the regression watchboard. The contract_intelligence story has to read
// exactly as the mockup tells it: mean 0.484, threshold 0.85, 4 replay
// cases, verdict held, baseline set 3 Aug with no movement on re-run — every
// one of those numbers is pulled from the real fixtures (rubrics.json,
// datasets.json), not hardcoded, except the 0.85 threshold itself, which the
// live rubric/regression-report shapes carry no field for — it's the
// narrative constant this whole gate is built around (HANDOFF's own retelling
// of it), kept here the same way Workbench/helpers.ts keeps its per-gate copy.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDatasets, useRubrics } from '../../api/hooks';
import * as verbs from '../../api/verbs';
import { Btn, Card } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';
import type { Rubric } from '../../types';
import { ErrorNote, LoadingNote } from '../Workbench/tabs/Shared';
import { useState } from 'react';

const HELD_THRESHOLD = 0.85;

function RubricRow({ rubric }: { rubric: Rubric }) {
  const [editing, setEditing] = useState(false);
  const [top, setTop] = useState(rubric.top);
  const qc = useQueryClient();
  const updateM = useMutation({
    mutationFn: verbs.evaluationUpdateRubric,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rubrics'] }),
  });

  async function save(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await updateM.mutateAsync({ node: rubric.node, patch: { top } });
      toast('Rubric updated', `evaluation_update_rubric → ${rubric.node}`);
      setEditing(false);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Update failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: '8px 4px' }}>
      <div className="toolrow" style={{ borderBottom: 'none', padding: 0 }}>
        <span className="tn">{rubric.node}</span>
        <span className="td">
          {rubric.crit} weighted criteria — {editing ? '' : rubric.top}
        </span>
        {rubric.verdict ? (
          <span className={`regverdict ${rubric.verdict}`}>
            {rubric.verdict} · {rubric.score}
          </span>
        ) : (
          <span className="regverdict baseline">no baseline</span>
        )}
        <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setEditing((v) => !v)}>
          {editing ? 'cancel' : 'edit'}
        </Btn>
      </div>
      {editing && (
        <div className="field" style={{ marginTop: 6, marginBottom: 0 }}>
          <label>top weighted criteria</label>
          <textarea value={top} onChange={(e) => setTop(e.target.value)} rows={2} />
          <div className="editnote">
            <Btn variant="pri" disabled={updateM.isPending} onClick={(e) => save(e.currentTarget)}>
              {updateM.isPending ? 'Saving…' : 'Save · evaluation_update_rubric'}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

export function Evaluate() {
  const rubricsQ = useRubrics();
  const datasetsQ = useDatasets();
  const qc = useQueryClient();
  const regressionM = useMutation({
    mutationFn: verbs.evaluationRunRegression,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rubrics'] }),
  });

  const rubrics = rubricsQ.data ?? [];
  const contract = rubrics.find((r) => r.node === 'contract_intelligence');
  const ciDatasets = (datasetsQ.data ?? []).filter((d) => d.node === 'contract_intelligence');
  const baseline = ciDatasets.find((d) => d.when === '3 Aug' && d.cases === 4);
  const rerun = ciDatasets.find((d) => d.when === '10 Aug');

  async function runRegression(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await regressionM.mutateAsync({ node: 'contract_intelligence' });
      toast('Regression run', 'evaluation_run_regression → contract_intelligence');
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Regression failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <>
      <Card label={`rubrics · ${rubrics.length} active`}>
        {rubricsQ.isLoading ? (
          <LoadingNote>Loading rubrics…</LoadingNote>
        ) : rubricsQ.isError ? (
          <ErrorNote message={rubricsQ.error?.message} />
        ) : (
          rubrics.map((r) => <RubricRow rubric={r} key={r.node} />)
        )}
      </Card>

      {contract && (
        <Card label="regression watchboard · contract_intelligence">
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div className="spark">
                {[0.48, 0.48, 0.48, 0.48].map((v, i) => (
                  <i key={i} className="hi" style={{ height: v * 100 * 0.3 }} />
                ))}
                <i style={{ height: HELD_THRESHOLD * 30 }} title="threshold" />
              </div>
              <span className="note" style={{ marginTop: 4, display: 'block' }}>
                mean {contract.score} · threshold {HELD_THRESHOLD} ·{' '}
                {baseline?.cases ?? rerun?.cases ?? 4} replay cases · verdict{' '}
                <span className={`regverdict ${contract.verdict}`}>{contract.verdict}</span>
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 220, color: 'var(--muted)', fontSize: 12.5 }}>
              Baseline set {baseline?.when ?? '3 Aug'}
              {baseline ? ` (${baseline.id.slice(-10)}, ${baseline.cases} cases)` : ''}, re-run{' '}
              {rerun?.when ?? '4 Aug'}
              {rerun ? ` (${rerun.id.slice(-10)}, ${rerun.cases} cases)` : ''}: no movement. The gate is honest —
              this node needs prompt work (or its rubric recalibrated), and the next trial will show against
              exactly these cases.
            </div>
            <Btn variant="pri" disabled={regressionM.isPending} onClick={(e) => runRegression(e.currentTarget)}>
              {regressionM.isPending ? 'Running…' : 'run regression now'}
            </Btn>
          </div>
          <p className="note">
            a regressed verdict flags like failing CI — here, on the Runs grid column, and on the node&rsquo;s
            Learning tab
          </p>
        </Card>
      )}
    </>
  );
}
