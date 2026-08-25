// Learning → Datasets (WP-53). The 6 frozen replay datasets, SFT/preference
// exports, and the fine-tune readiness meters — explicitly report-only, as
// the mockup and the WP brief both insist: this screen never launches a
// training job, it only tells you when you'd have enough evidence to.

import { useMutation } from '@tanstack/react-query';
import { useDatasets, useReadiness } from '../../api/hooks';
import * as verbs from '../../api/verbs';
import { Btn, Card, Meter } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';
import { ErrorNote, LoadingNote } from '../Workbench/tabs/Shared';
import { useApprovedDelta } from './overlay';

function DatasetRow({ d }: { d: { id: string; node: string; cases: number; when: string; note: string } }) {
  const sftM = useMutation({ mutationFn: verbs.datasetExportSft });
  const prefM = useMutation({ mutationFn: verbs.datasetExportPreferences });

  async function replay(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    toast(
      'Replay',
      'the counterfactual harness: any prompt edit can be trialed against these cases before touching a live run — no dedicated verb yet, wire a real proposal via Optimizer → run trial once one exists',
    );
  }
  async function exportSft(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await sftM.mutateAsync({ datasetId: d.id });
      toast('SFT export requested', `dataset_export_sft → ${d.id} (report-only — never launches a training job)`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Export failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }
  async function exportPref(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await prefM.mutateAsync({ datasetId: d.id });
      toast('Preference export requested', `dataset_export_preferences → ${d.id} (report-only)`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Export failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div className="toolrow">
      <span className="tn">{d.id}</span>
      <span className="td">
        {d.node} · {d.cases} cases · {d.when} — {d.note}
      </span>
      <span style={{ display: 'flex', gap: 5 }}>
        <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={(e) => replay(e.currentTarget)}>
          replay against
        </Btn>
        <Btn style={{ padding: '2px 9px', fontSize: 11 }} disabled={sftM.isPending} onClick={(e) => exportSft(e.currentTarget)}>
          export SFT
        </Btn>
        <Btn style={{ padding: '2px 9px', fontSize: 11 }} disabled={prefM.isPending} onClick={(e) => exportPref(e.currentTarget)}>
          export pairs
        </Btn>
      </span>
    </div>
  );
}

export function Datasets() {
  const datasetsQ = useDatasets();
  const readinessQ = useReadiness();
  const approvedDelta = useApprovedDelta();

  const approved = (readinessQ.data?.approvedExamples ?? 0) + approvedDelta;
  const threshold = readinessQ.data?.approvedThreshold ?? 500;
  const pairs = readinessQ.data?.preferencePairs ?? 0;
  const pairThreshold = readinessQ.data?.pairThreshold ?? 200;

  return (
    <>
      <Card label={`frozen replay datasets · ${(datasetsQ.data ?? []).length}`}>
        {datasetsQ.isLoading ? (
          <LoadingNote>Loading datasets…</LoadingNote>
        ) : datasetsQ.isError ? (
          <ErrorNote message={datasetsQ.error?.message} />
        ) : (
          (datasetsQ.data ?? []).map((d) => <DatasetRow d={d} key={d.id} />)
        )}
      </Card>

      <Card label="fine-tune flywheel · draft_writer">
        {readinessQ.isLoading ? (
          <LoadingNote>Loading readiness…</LoadingNote>
        ) : readinessQ.isError ? (
          <ErrorNote message={readinessQ.error?.message} />
        ) : (
          <>
            <div className="kv num">
              <span className="k">approved SFT examples</span>
              <span>
                {approved} / {threshold}
                {approvedDelta > 0 ? ` (+${approvedDelta} this session — Approve/Edit&approve on a node's This run tab)` : ''}
              </span>
            </div>
            <Meter pct={(approved / threshold) * 100} />
            <div className="kv num" style={{ marginTop: 8 }}>
              <span className="k">decisive preference pairs</span>
              <span>
                {pairs} / {pairThreshold}
              </span>
            </div>
            <Meter pct={(pairs / pairThreshold) * 100} />
            <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '10px 0 0' }}>
              {readinessQ.data?.recommendation} Approve / Edit&amp;approve (a node&rsquo;s This run tab) fills the
              first meter; Compare fills the second. When both fill: dataset_export_sft + dataset_export_preferences.
              Report-only — never launches a job.
            </p>
          </>
        )}
      </Card>

      <Card label="outcome join">
        <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: 0 }}>
          feedback_ingest_monetizer ties revenue and engagement back to the runs and nodes that produced each
          piece — the only feedback that arrives without costing you a click. Shown here and on run analysis once
          flowing.
        </p>
      </Card>
    </>
  );
}
