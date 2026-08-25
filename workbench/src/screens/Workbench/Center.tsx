// WP-12 — center inspector, read-only tabs. Markup/behaviour mirror
// spec/mockup.html's `<main class="center">`, renderCenter() and TABDEFS
// (~line 645). Class vocabulary only — no new CSS.

import { useEffect } from 'react';
import { useNode, useRun, useWorkflows } from '../../api/hooks';
import { Chip, RiskBadge, TabBar } from '../../components/primitives';
import { useStore } from '../../store';
import type { NodeTab } from '../../types';
import { nodeRunStatus, orderedNodes } from './helpers';
import { DepsTab } from './tabs/DepsTab';
import { HistoryTab } from './tabs/HistoryTab';
import { LearningTab } from './tabs/LearningTab';
import { ModelTab } from './tabs/ModelTab';
import { PromptTab } from './tabs/PromptTab';
import { SchemasTab } from './tabs/SchemasTab';
import { SkillsTab } from './tabs/SkillsTab';
import { ThisRunTab } from './tabs/ThisRunTab';
import { ToolsTab } from './tabs/ToolsTab';

const TABDEFS: Array<[NodeTab, string]> = [
  ['thisrun', 'This run'],
  ['prompt', 'Prompt'],
  ['tools', 'Tools'],
  ['skills', 'Skills'],
  ['schemas', 'Schemas'],
  ['model', 'Model & limits'],
  ['deps', 'Dependencies'],
  ['history', 'History'],
  ['learn', 'Learning'],
];

export function Center() {
  const wf = useStore((s) => s.wf);
  const mode = useStore((s) => s.mode);
  const runId = useStore((s) => s.runId);
  const nodeId = useStore((s) => s.node);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);

  const workflowsQ = useWorkflows();
  const nodeQ = useNode(nodeId);
  const boundRunQ = useRun(runId);

  const workflow = workflowsQ.data?.find((w) => w.id === wf);
  // Whether "This run" belongs in the tab list depends only on *a run being
  // bound* (mode + runId) — not on boundRunQ having resolved yet. Gating the
  // tab list on the query's data would flash "This run" out of existence on
  // every load (data starts `undefined`) and the correction effect below
  // would then permanently knock the tab over to Prompt before the run
  // finished loading. `run` (the loaded object) is still what tab bodies render.
  const runBound = mode === 'run' && Boolean(runId);
  const run = runBound ? (boundRunQ.data ?? null) : null;
  const tabs = TABDEFS.filter(([id]) => id !== 'thisrun' || runBound);

  // Mirrors the mockup's inline correction: if the active tab isn't valid
  // for the current run-binding state (e.g. the bound run was just
  // unbound while "This run" was open), fall back to a tab that is.
  useEffect(() => {
    if (!tabs.find(([id]) => id === tab)) {
      setTab(runBound ? 'thisrun' : 'prompt');
    }
  }, [runBound, tab, tabs, setTab]);

  if (workflowsQ.isError || nodeQ.isError) {
    return (
      <main className="center">
        <p style={{ color: 'var(--bad)' }}>
          {workflowsQ.error?.message ?? nodeQ.error?.message ?? 'Failed to load this node.'}
        </p>
      </main>
    );
  }

  if (workflowsQ.isLoading || nodeQ.isLoading || !workflow) {
    return (
      <main className="center">
        <p style={{ color: 'var(--muted)' }}>Loading node…</p>
      </main>
    );
  }

  const node = nodeQ.data;
  if (!node) {
    return (
      <main className="center">
        <div className="card">
          <span className="lbl">not found</span>
          <p style={{ margin: 0, color: 'var(--muted)' }}>
            <span className="mono">{nodeId}</span> could not be resolved (workspace_get_node returned nothing for
            it).
          </p>
        </div>
      </main>
    );
  }

  const order = orderedNodes(workflow);
  const status = run ? nodeRunStatus(run, nodeId, order) : null;
  const unknownMeta = node.kind === 'unknown';

  return (
    <main className="center">
      <div className="nhead">
        <h2>{node.name}</h2>
        <span className="id">{nodeId}</span>
        {unknownMeta ? <span className="mono">risk unknown</span> : <RiskBadge risk={node.risk} />}
        {run && run.cur === nodeId && <Chip status={run.status}>run stopped here</Chip>}
      </div>
      <p className="ndesc">{node.desc}</p>
      <TabBar
        idPrefix="node-tab"
        active={tab}
        onSelect={setTab}
        tabs={tabs.map(([id, label]) => ({ id, label }))}
      />

      {tab === 'thisrun' && runBound && (
        <>
          {boundRunQ.isLoading && (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--muted)' }}>Loading run…</p>
            </div>
          )}
          {boundRunQ.isError && (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--bad)' }}>
                {boundRunQ.error?.message ?? 'Failed to load the bound run.'}
              </p>
            </div>
          )}
          {!boundRunQ.isLoading && !boundRunQ.isError && run && status && (
            <ThisRunTab node={node} nodeId={nodeId} run={run} status={status} />
          )}
          {!boundRunQ.isLoading && !boundRunQ.isError && !run && (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                <span className="mono">{runId}</span> could not be resolved (workflow_get_run returned nothing for
                it).
              </p>
            </div>
          )}
        </>
      )}
      {tab === 'prompt' && <PromptTab node={node} nodeId={nodeId} wfName={workflow.name} />}
      {tab === 'tools' && <ToolsTab node={node} />}
      {tab === 'skills' && <SkillsTab node={node} nodeId={nodeId} />}
      {tab === 'schemas' && <SchemasTab nodeId={nodeId} />}
      {tab === 'model' && <ModelTab node={node} />}
      {tab === 'deps' && <DepsTab node={node} />}
      {tab === 'history' && <HistoryTab nodeId={nodeId} />}
      {tab === 'learn' && <LearningTab nodeId={nodeId} />}

      <p className="note">
        Prompt, tools, skills, schemas and model config apply live. Topology (dependencies, risk level) is pinned —
        changing it needs <span className="mono">npm run nodes:update</span> + redeploy.
      </p>
    </main>
  );
}
