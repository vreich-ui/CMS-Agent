// CMS-Agent track A — the ONE view+edit surface for a node's real, persisted
// playbook, shared by the Learning → Playbooks screen (Playbooks.tsx) and
// the node's own Learning tab (Workbench/tabs/LearningTab.tsx). Replaces the
// session-local demonstration overlay both screens used to read from
// (./overlay.ts's old CuratedLesson store) with the actual `playbook_get` /
// `playbook_apply_delta` round trip — see api/adapters.ts's toPlaybookView
// for the normalization and the CMS-Agent-track-A report for what was wrong
// before.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePlaybook } from '../Workbench/queries';
import { useProjects } from '../../api/hooks';
import * as verbs from '../../api/verbs';
import type { PlaybookItemKind, PlaybookItemView } from '../../api/adapters';
import { Btn, Meter } from '../../components/primitives';
import { Disclosure, EmptyNote, ErrorNote, LoadingNote } from '../Workbench/tabs/Shared';
import { toast } from '../../components/Toasts';
import { setNextConfirmTrigger } from '../../components/ConfirmDialog';
import { ActionCancelledError } from '../../api/confirmAction';
import { markNodeCuratedThisSession } from './overlay';
import { scopeLabel, scopeProjectId, useLearnScope } from './scope';

const KINDS: PlaybookItemKind[] = ['strategy', 'pitfall', 'constraint'];

function netHelpfulness(item: PlaybookItemView): number {
  return item.helpfulCount - item.harmfulCount;
}

export function PlaybookPanel({ nodeId }: { nodeId: string }) {
  const scope = useLearnScope();
  const projectId = scopeProjectId(scope);
  const projectsQ = useProjects();
  const qc = useQueryClient();

  const playbookQ = usePlaybook(nodeId, projectId, { enabled: scope.kind !== 'unselected' });
  const [newText, setNewText] = useState('');
  const [newKind, setNewKind] = useState<PlaybookItemKind>('strategy');
  const [showRetired, setShowRetired] = useState(false);

  const applyDeltaM = useMutation({
    mutationFn: verbs.playbookApplyDelta,
    // Read nodeId/projectId off the mutation's OWN variables, never the outer
    // render closure — this component (PlaybookPanel inside LearningTab, or
    // Playbooks.tsx) can stay mounted across a node/scope switch while a
    // mutation is still in flight (TanStack Query v5 re-points a pending
    // mutation's callbacks at each new render's options), so a closure-captured
    // `nodeId` here would credit the Flywheel counter and invalidate the cache
    // for whatever node/scope happens to be selected when the response lands,
    // not the one the operator actually retired/added a lesson on.
    onSuccess: (_, variables) => {
      markNodeCuratedThisSession(variables.nodeId);
      qc.invalidateQueries({ queryKey: ['playbook', variables.nodeId, variables.projectId ?? 'fleet'] });
    },
  });

  if (scope.kind === 'unselected') {
    return <EmptyNote>Pick a playbook scope above to view or edit this node&rsquo;s lessons.</EmptyNote>;
  }
  if (playbookQ.isLoading) return <LoadingNote>Loading playbook…</LoadingNote>;
  if (playbookQ.isError) return <ErrorNote message={playbookQ.error?.message} />;
  const view = playbookQ.data;
  if (!view) return <ErrorNote message="No response from playbook_get." />;

  const scopeText = scopeLabel(scope, projectsQ.data ?? []);
  const active = view.items.filter((i) => i.status === 'active').sort((a, b) => netHelpfulness(b) - netHelpfulness(a));
  const retired = view.items.filter((i) => i.status === 'retired');

  async function retire(item: PlaybookItemView, triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      const result = await applyDeltaM.mutateAsync({ nodeId, delta: { retire: [item.id] }, projectId });
      toast('Lesson retired', `playbook_apply_delta → ${nodeId} (${scopeText}) — ${result.items.filter((i) => i.status === 'active').length} active lesson(s) now`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Retire failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function restore(item: PlaybookItemView, triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    try {
      // Re-adding the identical text is the backend's own supported path back to
      // `active` — applyPlaybookDelta dedupes an `add` against existing item text
      // and flips a retired match back on, rather than a separate un-retire tool
      // (there isn't one — see verbs.playbookApplyDelta's doc comment). But that
      // flip isn't protected from the SAME call's budget eviction (only brand-new
      // adds are — real backend behavior, see improvement/playbook.ts's
      // applyPlaybookDelta), so restoring into an already-full playbook can land
      // the item right back in `retired` if it still sorts lowest by net
      // helpfulness. Check the item's actual returned status before claiming
      // success — never toast "restored" for something the response shows is
      // still retired.
      const result = await applyDeltaM.mutateAsync({ nodeId, delta: { add: [{ text: item.text, kind: item.kind }] }, projectId });
      const after = result.items.find((i) => i.id === item.id);
      if (after?.status === 'active') {
        toast('Lesson restored', `playbook_apply_delta → ${nodeId} (${scopeText})`);
      } else {
        toast(
          'Restored, then re-evicted',
          `${nodeId} (${scopeText}) is at its ${result.budgetMaxItems}-item budget, and this lesson still sorted lowest by net helpfulness — it went back to retired in the same call. Retire a less useful lesson first, then restore this one.`,
        );
      }
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Restore failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function addLesson(triggerEl: HTMLElement | null) {
    const text = newText.trim();
    if (!text) return;
    setNextConfirmTrigger(triggerEl);
    try {
      await applyDeltaM.mutateAsync({ nodeId, delta: { add: [{ text, kind: newKind }] }, projectId });
      toast('Lesson added', `playbook_apply_delta → ${nodeId} (${scopeText})`);
      setNewText('');
      setNewKind('strategy');
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      // Preserve the draft on failure — nothing here clears newText/newKind.
      toast('Add lesson failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      {!view.exists ? (
        <EmptyNote>No playbook record exists yet for {nodeId} at {scopeText}. Add a lesson below to create one.</EmptyNote>
      ) : active.length === 0 ? (
        <EmptyNote>
          A playbook record exists for {nodeId} at {scopeText} (v{view.version}) but every lesson in it is retired —
          nothing from this record is injected right now.
        </EmptyNote>
      ) : (
        <>
          <p style={{ margin: '0 0 8px' }}>
            {active.length} active lesson{active.length === 1 ? '' : 's'} at {scopeText} · {view.activeChars} /{' '}
            {view.budgetMaxChars} chars · {active.length} / {view.budgetMaxItems} items
          </p>
          <Meter pct={(view.activeChars / view.budgetMaxChars) * 100} />
          {active.map((item) => (
            <div className="obsrow" key={item.id}>
              <span className="when">{item.kind}</span>
              <span className="txt">
                {item.text}
                <span className="mono" style={{ color: 'var(--faint)', marginLeft: 8, fontSize: 10.5 }}>
                  +{item.helpfulCount}/-{item.harmfulCount} · {item.provenanceSource}
                </span>
              </span>
              <span className="acts">
                <Btn style={{ padding: '3px 10px', fontSize: 11 }} disabled={applyDeltaM.isPending} onClick={(e) => retire(item, e.currentTarget)}>
                  remove
                </Btn>
              </span>
            </div>
          ))}
        </>
      )}

      {retired.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Btn style={{ padding: '2px 9px', fontSize: 11 }} onClick={() => setShowRetired((v) => !v)}>
            {showRetired ? 'hide' : 'show'} {retired.length} retired
          </Btn>
          {showRetired &&
            retired.map((item) => (
              <div className="obsrow" key={item.id} style={{ opacity: 0.6 }}>
                <span className="when">{item.kind}</span>
                <span className="txt" style={{ textDecoration: 'line-through' }}>
                  {item.text}
                </span>
                <span className="acts">
                  <Btn
                    style={{ padding: '3px 10px', fontSize: 11 }}
                    disabled={applyDeltaM.isPending}
                    title="No un-retire tool exists; this re-adds the identical text, which the backend's own dedup logic flips back to active."
                    onClick={(e) => restore(item, e.currentTarget)}
                  >
                    restore
                  </Btn>
                </span>
              </div>
            ))}
        </div>
      )}

      <div className="editnote" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
          <textarea
            placeholder="New lesson text…"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={2}
          />
        </div>
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as PlaybookItemKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Btn variant="pri" disabled={applyDeltaM.isPending || !newText.trim()} onClick={(e) => addLesson(e.currentTarget)}>
          {applyDeltaM.isPending ? 'Saving…' : 'Add → playbook_apply_delta'}
        </Btn>
      </div>

      <div className="editnote">
        <Disclosure openLabel="view composed prompt material" closeLabel="hide composed prompt material">
          <p className="note" style={{ marginTop: 0 }}>
            what a dispatch to {nodeId} would receive right now under {scopeText} — the live composition
            (site scope first, then fleet, deduplicated, one budget). This is a current preview, not a record
            of what any past run actually received; nothing in this backend persists that per run (see the
            CMS-Agent-track-A report).
            {view.composedUnreadableScopeKeys.length > 0 && (
              <>
                {' '}
                <strong>Warning:</strong> {view.composedUnreadableScopeKeys.join(', ')} failed to read — this
                preview may be missing lessons from that scope.
              </>
            )}
          </p>
          <div className="promptbox" style={{ maxHeight: 220 }}>
            {view.composedText || '(nothing would be injected — no active lessons at any scope in the chain)'}
          </div>
          <p className="note">contributing scopes, most specific first: {view.composedScopeKeys.join(', ') || '(none)'}</p>
        </Disclosure>
      </div>
    </div>
  );
}
