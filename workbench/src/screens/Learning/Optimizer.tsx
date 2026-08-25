// Learning → Optimizer (WP-53). optimizer_analyze / optimizer_propose fire
// for real and their (honest, mock-mode-empty) result is shown rather than
// discarded; there are no live proposals or trials yet, so the mockup's
// dashed "what a live proposal looks like (example)" card stays, clearly
// labelled and non-interactive — its buttons would otherwise be promoting a
// fake proposal id, which is exactly the kind of pretending §7.9 rules out.

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import { IS_MOCK } from '../../api/client';
import { Btn, Card } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';

const NODES_WITH_RUBRICS = ['contract_intelligence', 'draft_writer', 'research', 'article_body', 'publish_payload', 'artifact_plan'];

export function Optimizer() {
  const [nodeId, setNodeId] = useState('draft_writer');
  const [lastProposal, setLastProposal] = useState<verbs.OptimizerProposal | null>(null);

  const statusQ = useQuery({
    queryKey: ['optimizerStatus', nodeId],
    queryFn: () => verbs.optimizerStatus({ nodeId }),
  });
  const analyzeM = useMutation({ mutationFn: verbs.optimizerAnalyze });
  const proposeM = useMutation({ mutationFn: verbs.optimizerPropose });

  const findingsCount = useMemo(() => statusQ.data?.proposals.length ?? 0, [statusQ.data]);

  async function analyze(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      const res = await analyzeM.mutateAsync({ nodeId });
      // Truth-telling fix — was unconditionally "(mock backend mines
      // nothing yet)", which would misreport a real live finding count.
      const caveat = IS_MOCK && res.findings.length === 0 ? ' — fixtures don’t mine real findings yet' : '';
      toast('Analyzed', `optimizer_analyze → ${nodeId} — ${res.findings.length} finding(s)${caveat}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Analyze failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function propose(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      const res = await proposeM.mutateAsync({ nodeId });
      setLastProposal(res);
      const caveat = IS_MOCK ? ' (fixtures return no prompt diff yet)' : '';
      toast('Proposal requested', `optimizer_propose → ${res.proposalId}${caveat}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Propose failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <>
      <Card label={<>optimizer · <span className="mono">{nodeId}</span></>}>
        <div className="field" style={{ maxWidth: 260 }}>
          <label>node</label>
          <select value={nodeId} onChange={(e) => { setNodeId(e.target.value); setLastProposal(null); }}>
            {NODES_WITH_RUBRICS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 10px' }}>
          {findingsCount > 0
            ? `${findingsCount} proposal(s) on record.`
            : 'No proposals or trials yet. Model ladder: "no model-attributed eval results yet — run evaluations with subject model attribution first" (threshold 0.7, min 3 samples).'}
        </p>
        {lastProposal && (
          <p className="note">
            last request: <span className="mono">{lastProposal.proposalId}</span> at{' '}
            {new Date(lastProposal.createdAt).toLocaleTimeString()}
            {IS_MOCK
              ? ' — fixtures don’t compute a real prompt diff or trial score for it; see the worked example below for what a live one carries.'
              : '.'}
          </p>
        )}
        <div className="editnote">
          <Btn variant="pri" disabled={analyzeM.isPending} onClick={(e) => analyze(e.currentTarget)}>
            {analyzeM.isPending ? 'Analyzing…' : 'analyze node'}
          </Btn>
          <Btn disabled={proposeM.isPending} onClick={(e) => propose(e.currentTarget)}>
            {proposeM.isPending ? 'Proposing…' : 'propose variant'}
          </Btn>
        </div>
      </Card>

      <Card label="what a live proposal looks like (example)" style={{ borderStyle: 'dashed' }}>
        <div className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
          <span className="k">proposal</span>
          <span>draft_writer / prompt v8-candidate — &ldquo;tighten schema adherence, name the output contract explicitly&rdquo;</span>
          <span className="k">diff</span>
          <span>
            <span className="diffline del">Produce draft.v1 matching the output schema…</span>
            <br />
            <span className="diffline add">
              Produce draft.v1. Before returning, verify every required field against the output schema; name any
              field you cannot fill rather than omitting it.
            </span>
          </span>
          <span className="k">trial</span>
          <span className="num">vs frozen replay ds_…am32rx · mean 0.71 → 0.79 (+0.08) · 6/6 cases scored</span>
          <span className="k">gates</span>
          <span>
            regression <span className="regverdict baseline">improved</span> · your Compare verdicts 4–1 for
            challenger
          </span>
        </div>
        <div className="editnote">
          <Btn variant="pri" disabled title="This is a worked example, not a real proposal — analyze/propose above to create one.">
            promote
          </Btn>
          <Btn disabled title="This is a worked example, not a real proposal — analyze/propose above to create one.">
            enable auto-promote
          </Btn>
          <Btn disabled title="This is a worked example, not a real proposal — analyze/propose above to create one.">
            run as shadow
          </Btn>
        </div>
      </Card>
    </>
  );
}
