// Learning → Observations. The feed the flywheel's "Observe" stage counts,
// filterable by node and by run, with a ten-second curate flow (WP-51):
// click "curate →" on a row, a lesson draft pre-fills from the observation
// text, the operator edits it, a token-budget estimate updates live, submit
// fires the real `playbook_curate` verb (confirm-gated, like every other
// deliberate one-off mutation in this app) and records the result in
// overlay.ts so the Playbooks tab and the node's Learning tab see it
// immediately. `learning_archive_observation` is the other one-click action
// per row; `playbook_migrate_observations` handles the backlog in bulk.

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNodes, useObservations } from '../../api/hooks';
import * as verbs from '../../api/verbs';
import { IS_MOCK } from '../../api/client';
import { Btn, Card } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';
import type { Observation } from '../../types';
import { ErrorNote, LoadingNote } from '../Workbench/tabs/Shared';
import { addCuratedLesson } from './overlay';

const BUDGET_CAP = 2000;

function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.trim().length / 4));
}

function CurateForm({ obs, onClose }: { obs: Observation; onClose: () => void }) {
  const nodesQ = useNodes();
  const [nodeId, setNodeId] = useState(obs.node ?? '');
  const [lesson, setLesson] = useState(obs.txt);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const tokens = estimateTokens(lesson);
  const nodes = useMemo(() => [...(nodesQ.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [nodesQ.data]);

  async function submit(triggerEl: HTMLElement | null) {
    if (!nodeId) {
      toast('Pick a node first', 'A curated lesson has to land on a specific node’s playbook.');
      return;
    }
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      await verbs.playbookCurate({ nodeId, observationId: obs.id, lesson });
      addCuratedLesson(nodeId, lesson, obs.id);
      qc.invalidateQueries({ queryKey: ['playbook', nodeId] });
      toast('Curated', `playbook_curate → ${nodeId} (${tokens} tokens)`);
      onClose();
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Curate failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ background: 'var(--panel2)', marginTop: 6 }}>
      <span className="lbl">curate into playbook</span>
      <div className="field">
        <label>node</label>
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
          <option value="">choose node…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} — {n.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>lesson draft (pre-filled from the observation — edit freely)</label>
        <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} rows={4} />
      </div>
      <div className="editnote">
        <span className="mono num" style={{ color: 'var(--muted)' }}>
          ~{tokens} / {BUDGET_CAP} token budget
        </span>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="pri" disabled={busy || !lesson.trim()} onClick={(e) => submit(e.currentTarget)}>
          {busy ? 'Curating…' : 'Curate → playbook_curate'}
        </Btn>
      </div>
    </div>
  );
}

function ObsRow({ obs }: { obs: Observation }) {
  const [curating, setCurating] = useState(false);
  const qc = useQueryClient();
  const archiveM = useMutation({
    mutationFn: verbs.learningArchiveObservation,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['observations'] }),
  });

  async function archive(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      await archiveM.mutateAsync({ id: obs.id });
      toast('Archived', `learning_archive_observation → ${obs.id.slice(-10)}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Archive failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <div className="obsrow">
        <span className="when">{obs.when}</span>
        <span className="txt">
          {obs.node ? <span className="tag">{obs.node}</span> : null}
          {obs.run ? <span className="tag">{obs.run.slice(-10)}</span> : <span className="tag">operator</span>}
          {obs.txt}
        </span>
        <span className="acts">
          <Btn onClick={() => setCurating((c) => !c)}>{curating ? 'cancel' : 'curate →'}</Btn>
          <Btn disabled={archiveM.isPending} onClick={(e) => archive(e.currentTarget)}>
            archive
          </Btn>
        </span>
      </div>
      {curating && <CurateForm obs={obs} onClose={() => setCurating(false)} />}
    </div>
  );
}

export function Observations() {
  const obsQ = useObservations();
  const [nodeFilter, setNodeFilter] = useState('');
  const [runFilter, setRunFilter] = useState('');
  const migrateM = useMutation({ mutationFn: verbs.playbookMigrateObservations });

  const all = obsQ.data ?? [];
  const nodeOptions = useMemo(
    () => [...new Set(all.map((o) => o.node).filter((n): n is string => Boolean(n)))].sort(),
    [all],
  );
  const runOptions = useMemo(
    () => [...new Set(all.map((o) => o.run).filter((r): r is string => Boolean(r)))].sort(),
    [all],
  );
  const filtered = all.filter(
    (o) => (!nodeFilter || o.node === nodeFilter) && (!runFilter || o.run === runFilter),
  );

  async function migrate(nodeId: string, triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      const res = await migrateM.mutateAsync({ nodeId });
      const migrated = res.migrated ?? 0;
      // Truth-telling fix — this used to unconditionally claim "mock backend
      // reports 0", which becomes a false statement the moment this points
      // at a live broker. Only mock mode can honestly assert *why* the
      // count is 0; a live 0 (or any nonzero count) just gets reported as-is.
      const caveat = IS_MOCK && migrated === 0 ? ' (fixtures don’t simulate a real migration; curate individually below)' : '';
      toast('Migration requested', `playbook_migrate_observations → ${nodeId} — ${migrated} migrated${caveat}.`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Migrate failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <Card label={`observation feed · ${all.length} active · newest first`}>
      {obsQ.isLoading ? (
        <LoadingNote>Loading observations…</LoadingNote>
      ) : obsQ.isError ? (
        <ErrorNote message={obsQ.error?.message} />
      ) : all.length === 0 ? (
        <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>
          No observations recorded yet. They arrive automatically from run failures/blocks (learning_recorder nodes)
          or manually from a node&rsquo;s <b>This run</b> tab (&ldquo;+ Record observation&rdquo;).
        </p>
      ) : (
        <>
          <div className="editnote" style={{ marginBottom: 4 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <select value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)}>
                <option value="">all nodes</option>
                {nodeOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <select value={runFilter} onChange={(e) => setRunFilter(e.target.value)}>
                <option value="">all runs</option>
                {runOptions.map((r) => (
                  <option key={r} value={r}>
                    {r.slice(-10)}
                  </option>
                ))}
              </select>
            </div>
            <span style={{ flex: 1 }} />
            {nodeFilter && (
              <Btn onClick={(e) => migrate(nodeFilter, e.currentTarget)} disabled={migrateM.isPending}>
                migrate backlog for {nodeFilter}
              </Btn>
            )}
          </div>
          {filtered.length === 0 ? (
            <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: '8px 0 0' }}>
              No observations match this filter.
            </p>
          ) : (
            filtered.map((o) => <ObsRow obs={o} key={o.id} />)
          )}
          <p className="note">
            curation is a judgment call — this feed makes it a ten-second one. playbook_migrate_observations batches
            the backlog{IS_MOCK ? ' (fixtures always report 0 migrated — curate individually below in the meantime)' : ''}.
          </p>
        </>
      )}
    </Card>
  );
}
