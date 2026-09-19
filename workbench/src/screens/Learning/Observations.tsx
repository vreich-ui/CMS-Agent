// Learning → Observations. The feed the flywheel's "Observe" stage counts,
// filterable by node and by run, with a ten-second curate flow: click
// "curate →" on a row, a lesson draft pre-fills from the observation text,
// the operator edits it and picks a scope + kind, submit fires the real
// `playbook_apply_delta` verb (confirm-gated, like every other deliberate
// one-off mutation in this app) against the node's ACTUAL persisted
// playbook. `learning_archive_observation` is the other one-click action per
// row; `playbook_migrate_observations` handles the (global, all-nodes)
// legacy backlog in one pass.
//
// CMS-Agent track A (2026-09-18) — this used to call `playbook_curate`
// (the automatic Reflector→Curator pass over evaluation evidence, schema
// `{nodeId, mode, projectId?}`) with `{nodeId, observationId, lesson}`,
// which a live backend's `.strict()` schema rejects outright — see the
// track-A report. `playbook.apply_delta`'s `delta.add` is the verb that
// actually accepts arbitrary lesson text, so that's what this curate flow
// calls now. It also used to call `playbook_migrate_observations` with a
// `{nodeId}` the real (global, no-nodeId) schema also rejects — fixed below
// to a single all-nodes action.

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNodes, useObservations, useProjects } from '../../api/hooks';
import { usePlaybook } from '../Workbench/queries';
import * as verbs from '../../api/verbs';
import type { PlaybookItemKind } from '../../api/adapters';
import { Btn, Card } from '../../components/primitives';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';
import type { Observation } from '../../types';
import { ErrorNote, LoadingNote } from '../Workbench/tabs/Shared';
import { markNodeCuratedThisSession } from './overlay';
import { scopeLabel, scopeProjectId, useLearnScope } from './scope';
import { ScopePicker } from './ScopePicker';

const KINDS: PlaybookItemKind[] = ['strategy', 'pitfall', 'constraint'];
// Fallback ONLY for "no node/scope picked yet, so there's no real record to read
// a budget off of" — mirrors adapters.ts's DEFAULT_DISPLAY_BUDGET. Once a node
// and scope are picked, the real budgetMaxChars from that node's own playbook_get
// (via usePlaybook below) always wins.
const DEFAULT_BUDGET_MAX_CHARS = 2000;

function CurateForm({ obs, onClose }: { obs: Observation; onClose: () => void }) {
  const nodesQ = useNodes();
  const projectsQ = useProjects();
  const scope = useLearnScope();
  const [nodeId, setNodeId] = useState(obs.node ?? '');
  const [lesson, setLesson] = useState(obs.txt);
  const [kind, setKind] = useState<PlaybookItemKind>('strategy');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const projectId = scopeProjectId(scope);
  // The backend budgets by CHARACTER COUNT, never tokens (item 5 of the
  // track-A brief — a budget shown as a "token" figure is exactly the
  // mislabeling this must not do). Read the real per-node, per-scope budget
  // once both are picked; before that there's no record to read one from.
  const playbookQ = usePlaybook(nodeId || undefined, projectId, {
    enabled: Boolean(nodeId) && scope.kind !== 'unselected',
  });
  const budgetMaxChars = playbookQ.data?.budgetMaxChars ?? DEFAULT_BUDGET_MAX_CHARS;
  const charCount = lesson.trim().length;
  const nodes = useMemo(() => [...(nodesQ.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [nodesQ.data]);
  const scopeText = scopeLabel(scope, projectsQ.data ?? []);

  async function submit(triggerEl: HTMLElement | null) {
    if (!nodeId) {
      toast('Pick a node first', 'A curated lesson has to land on a specific node’s playbook.');
      return;
    }
    if (scope.kind === 'unselected') {
      toast('Pick a playbook scope first', 'Use the scope picker above the feed — Fleet or a tenant.');
      return;
    }
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      await verbs.playbookApplyDelta({ nodeId, delta: { add: [{ text: lesson, kind }] }, projectId });
      markNodeCuratedThisSession(nodeId);
      qc.invalidateQueries({ queryKey: ['playbook', nodeId, projectId ?? 'fleet'] });
      toast('Curated', `playbook_apply_delta → ${nodeId} (${scopeText}) — ${charCount} chars`);
      onClose();
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      // Draft (lesson/nodeId/kind) is deliberately left in place on failure.
      toast('Curate failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ background: 'var(--panel2)', marginTop: 6 }}>
      <span className="lbl">curate into playbook · {scopeText}</span>
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
      <div className="field">
        <label>kind</label>
        <select value={kind} onChange={(e) => setKind(e.target.value as PlaybookItemKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="editnote">
        <span className="mono num" style={{ color: 'var(--muted)' }}>
          {charCount} / {budgetMaxChars} chars
          {playbookQ.data ? ` (this node's real budget at ${scopeText})` : ' (default display budget — pick a node to read its real one)'}
        </span>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="pri" disabled={busy || !lesson.trim()} onClick={(e) => submit(e.currentTarget)}>
          {busy ? 'Curating…' : 'Curate → playbook_apply_delta'}
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
  const taggedCount = all.filter((o) => o.node).length;

  async function migrateAll(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      const res = await migrateM.mutateAsync(undefined);
      toast(
        'Migration requested',
        `playbook_migrate_observations → all nodes — ${res.migratedObservations} observation(s) into ${res.migratedNodes} node playbook(s), ${res.skippedWithoutNodeId} skipped (no node)`,
      );
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Migrate failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <Card label={`observation feed · ${all.length} active · newest first`}>
      <div className="editnote" style={{ marginBottom: 4 }}>
        <ScopePicker compact />
      </div>
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
            {taggedCount > 0 && (
              <Btn onClick={(e) => migrateAll(e.currentTarget)} disabled={migrateM.isPending}>
                migrate all node-tagged observations ({taggedCount})
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
            curation is a judgment call — this feed makes it a ten-second one. playbook_migrate_observations
            migrates every node-tagged observation across the whole fleet in one pass (there is no per-node form of
            this verb — it always sweeps all nodes).
          </p>
        </>
      )}
    </Card>
  );
}
