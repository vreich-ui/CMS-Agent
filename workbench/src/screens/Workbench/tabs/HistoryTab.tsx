// History tab — WP-34. The full change feed for this node: every locally
// recorded edit from the Prompt/Tools/Skills/Schemas/Model tabs (Shared.tsx's
// change log — changes_list always returns [] in fixture mode, see its doc
// comment) merged with whatever changes_list actually returns, each row
// diffable (changes_compare backstopped by a local line diff) and
// restorable (changes_restore). Optimizer promotions render their trial
// attribution + score delta wherever an entry actually carries one — never
// fabricated, since none exist in this fixture set today.
//
// Restore applies the entry's prior value straight into the field's own
// editor/query cache and jumps the operator there, so "the operator sees
// the restored value immediately" is literal, not just a toast.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { changesRestore, type ChangeRecord, type JSONSchema } from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Card } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { useStore } from '../../../store';
import type { NodeTab, WorkflowNode } from '../../../types';
import { useChangesList } from '../queries';
import {
  clearLocalDraft,
  DiffLines,
  diffLines,
  ErrorNote,
  LoadingNote,
  READONLY_REASON,
  recordChange,
  setLocalDraft,
  setSchemaOverlay,
  stringifyForDiff,
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

export function HistoryTab({ nodeId }: { nodeId: string }) {
  const changesQ = useChangesList(nodeId);
  const localEntries = useLocalHistory(nodeId);
  const apiEntries = (changesQ.data ?? []).map(fromApiRecord);
  const entries = [...localEntries, ...apiEntries].sort((a, b) => (a.whenIso < b.whenIso ? 1 : -1));

  const qc = useQueryClient();
  const setTab = useStore((s) => s.setTab);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

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
          return (
            <div key={entry.id}>
              <div className="histrow">
                <span className="when">{entry.when}</span>
                <span className="what">
                  {entry.label}
                  {entry.trial && (
                    <span className="mono" style={{ color: 'var(--acc)', marginLeft: 8 }}>
                      trial {entry.trial.id} · Δ{entry.trial.scoreDelta >= 0 ? '+' : ''}
                      {entry.trial.scoreDelta.toFixed(2)}
                    </span>
                  )}
                </span>
                <button className="act" onClick={() => setOpenDiff(open ? null : entry.id)}>
                  diff
                </button>
                <button
                  className="act"
                  disabled={Boolean(restoring) || IS_READ_ONLY}
                  title={IS_READ_ONLY ? READONLY_REASON : undefined}
                  onClick={(e) => handleRestore(entry, e.currentTarget)}
                >
                  {restoring === entry.id ? 'restoring…' : 'restore'}
                </button>
              </div>
              {open && (
                <div style={{ padding: '0 4px 10px' }}>
                  <DiffLines ops={diffLines(stringifyForDiff(entry.before), stringifyForDiff(entry.after))} />
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
