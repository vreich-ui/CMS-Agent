// History tab — WP-34, reworked for U2. The full change feed for this
// node: every locally recorded edit from the Prompt/Tools/Skills/Schemas/
// Model tabs (Shared.tsx's change log) merged with whatever changes_list
// actually returns (real fixture events now — five authored cases, see
// api/fixtures/changes.json), each row diffable and restorable
// (changes_restore). Optimizer promotions render their trial attribution +
// score delta wherever an entry actually carries one.
//
// U2 — the JSON-wall-with-strikethrough diff view is gone. Every
// API-backed row (a real change event, with real parent→resulting
// revision ids) opens the diff & merge studio in 'revisions' mode instead
// — the readable, type-aware, editable surface. Locally-recorded rows (an
// unsaved-to-server session edit from another tab, with no revision id of
// its own to look up) get the SAME diff engine, rendered inline right here
// — never the studio's full three-pane chrome (there is nothing to
// restore-to or open by URL for a change that was never actually
// persisted), but never a raw JSON dump either.
//
// Restore applies the entry's prior value straight into the field's own
// editor/query cache and jumps the operator there, so "the operator sees
// the restored value immediately" is literal, not just a toast.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { changesListEvents, changesRestore, type ChangeRecord, type JSONSchema } from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Card } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { useStore } from '../../../store';
import type { NodeTab, WorkflowNode } from '../../../types';
import { useChangesList } from '../queries';
import { ProseDiffView } from '../../../components/diff/ProseDiffView';
import { FieldRow } from '../../../components/diff/FieldsDiffView';
import { classifyValueDiff } from '../../../components/diff/structuredDiff';
import { computeProseDiff } from '../../../components/diff/textDiff';
import {
  clearLocalDraft,
  ErrorNote,
  LoadingNote,
  READONLY_REASON,
  recordChange,
  setLocalDraft,
  setSchemaOverlay,
  useLocalHistory,
  type ChangeKind,
  type HistoryEntry,
} from './Shared';

const KIND_TAB: Record<ChangeKind, NodeTab> = {
  prompt: 'prompt',
  tools: 'tools',
  skills: 'skills',
  inputSchema: 'schemas',
  outputSchema: 'schemas',
  model: 'model',
};

function inferKind(field: string): ChangeKind | null {
  const f = field.toLowerCase();
  if (f.includes('prompt')) return 'prompt';
  if (f.includes('input') && f.includes('schema')) return 'inputSchema';
  if (f.includes('output') && f.includes('schema')) return 'outputSchema';
  if (f.includes('tool')) return 'tools';
  if (f.includes('skill')) return 'skills';
  if (f.includes('model')) return 'model';
  return null;
}

function fromApiRecord(r: ChangeRecord): HistoryEntry {
  return {
    id: r.id,
    nodeId: r.nodeId,
    kind: inferKind(r.field) ?? 'prompt',
    label: r.field,
    before: r.before,
    after: r.after,
    when: r.when,
    whenIso: r.when,
    author: r.author ?? 'unknown',
    source: 'api',
  };
}

/** Renders one entry's before/after with the same engine the diff studio
 * uses: prose (word-level) for a prompt, a single structured field row for
 * everything else. */
function InlineEntryDiff({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === 'prompt') {
    const before = typeof entry.before === 'string' ? entry.before : '';
    const after = typeof entry.after === 'string' ? entry.after : '';
    return (
      <ProseDiffView
        lines={computeProseDiff(before, after)}
        layout="inline"
        leftLabel="before"
        rightLabel="after"
      />
    );
  }
  return <FieldRow row={classifyValueDiff(entry.label, entry.before, entry.after)} />;
}

export function HistoryTab({ nodeId }: { nodeId: string }) {
  const changesQ = useChangesList(nodeId);
  // Full events (not the flattened ChangeRecord shape) so a "diff" click on
  // an API-backed row can open the studio on the real parent→resulting
  // revision pair — the exact surface Wolf asked for on History rows.
  const eventsQ = useQuery({
    queryKey: ['changeEvents', nodeId],
    queryFn: () => changesListEvents({ nodeId }),
    enabled: Boolean(nodeId),
  });
  const parentByResulting = new Map<string, string | undefined>();
  for (const e of eventsQ.data?.events ?? []) {
    if (e.resultingRevisionId) parentByResulting.set(e.resultingRevisionId, e.parentRevisionId);
  }

  const localEntries = useLocalHistory(nodeId);
  const apiEntries = (changesQ.data ?? []).map(fromApiRecord);
  const entries = [...localEntries, ...apiEntries].sort((a, b) => (a.whenIso < b.whenIso ? 1 : -1));

  const qc = useQueryClient();
  const setTab = useStore((s) => s.setTab);
  const openModal = useStore((s) => s.openModal);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  function openStudio(entry: HistoryEntry) {
    const parent = parentByResulting.get(entry.id);
    if (!parent) {
      toast(
        'No comparable revision',
        'This entry has no recorded parent revision to compare against (changes_list didn\'t carry one for it).',
      );
      return;
    }
    openModal('diff', { mode: 'revisions', node: nodeId, revA: parent, revB: entry.id });
  }

  async function handleRestore(entry: HistoryEntry, triggerEl: HTMLElement | null) {
    if (restoring) return;
    setNextConfirmTrigger(triggerEl);
    setRestoring(entry.id);
    try {
      await changesRestore({ nodeId, revisionId: entry.id });

      if (entry.source === 'local') {
        applyRestoredValue(entry, qc, nodeId);
        recordChange({
          nodeId,
          kind: entry.kind,
          label: `restored to before "${entry.label}" (${entry.when})`,
          before: entry.after,
          after: entry.before,
        });
        setTab(KIND_TAB[entry.kind]);
        toast('Restored', `changes_restore → ${entry.kind} — open in its tab, showing the restored value`);
      } else {
        toast('Restored', 'changes_restore recorded — reopen the relevant tab to see it (no local field mapping for this entry).');
      }
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Restore failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Card label="change history · this node">
      {changesQ.isLoading && <LoadingNote>Loading change history…</LoadingNote>}
      {changesQ.isError && <ErrorNote message={changesQ.error?.message} />}
      {!changesQ.isLoading && !changesQ.isError && entries.length === 0 && (
        <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>
          No recorded changes for this node yet. Prompt, tool, skill, schema and model-config edits appear here as
          they&rsquo;re saved — optimizer promotions land here too, attributed to the trial that earned them, with
          the score delta.
        </p>
      )}
      {!changesQ.isLoading &&
        !changesQ.isError &&
        entries.map((entry) => {
          const open = openDiff === entry.id;
          const isApi = entry.source === 'api';
          return (
            <div key={entry.id}>
              <div className="histrow">
                <span className="when">{entry.when}</span>
                <span className="what">
                  {entry.label}
                  <span className="chip" style={{ marginLeft: 8 }}>
                    {entry.author}
                  </span>
                  {entry.trial && (
                    <span className="mono" style={{ color: 'var(--acc)', marginLeft: 8 }}>
                      trial {entry.trial.id} · Δ{entry.trial.scoreDelta >= 0 ? '+' : ''}
                      {entry.trial.scoreDelta.toFixed(2)}
                    </span>
                  )}
                </span>
                {isApi ? (
                  <button className="act" onClick={() => openStudio(entry)}>
                    diff & merge studio
                  </button>
                ) : (
                  <button className="act" onClick={() => setOpenDiff(open ? null : entry.id)}>
                    {open ? 'hide diff' : 'diff'}
                  </button>
                )}
                <button
                  className="act"
                  disabled={Boolean(restoring) || IS_READ_ONLY}
                  title={IS_READ_ONLY ? READONLY_REASON : undefined}
                  onClick={(e) => handleRestore(entry, e.currentTarget)}
                >
                  {restoring === entry.id ? 'restoring…' : 'restore'}
                </button>
              </div>
              {!isApi && open && (
                <div style={{ padding: '0 4px 10px' }}>
                  <InlineEntryDiff entry={entry} />
                </div>
              )}
            </div>
          );
        })}
      <p className="note">optimizer promotions land here too — attributed to the trial that earned them, with the score delta</p>
    </Card>
  );
}

function applyRestoredValue(entry: HistoryEntry, qc: ReturnType<typeof useQueryClient>, nodeId: string): void {
  switch (entry.kind) {
    case 'prompt':
      setLocalDraft(nodeId, 'prompt', entry.before as string);
      break;
    case 'tools':
      qc.setQueryData<WorkflowNode | null | undefined>(['node', nodeId], (old) =>
        old ? { ...old, tools: entry.before as string[] } : old,
      );
      break;
    case 'skills':
      qc.setQueryData<WorkflowNode | null | undefined>(['node', nodeId], (old) =>
        old ? { ...old, skills: entry.before as string[] } : old,
      );
      break;
    case 'inputSchema':
      setSchemaOverlay(nodeId, 'input', entry.before as JSONSchema);
      clearLocalDraft(nodeId, 'inputSchemaText');
      break;
    case 'outputSchema':
      setSchemaOverlay(nodeId, 'output', entry.before as JSONSchema);
      clearLocalDraft(nodeId, 'outputSchemaText');
      break;
    case 'model':
      qc.setQueryData<WorkflowNode | null | undefined>(['node', nodeId], (old) =>
        old ? { ...old, model: entry.before as WorkflowNode['model'] } : old,
      );
      clearLocalDraft(nodeId, 'model');
      break;
  }
}
