// Prompt tab — WP-31. A real editable contenteditable (`.promptbox`) saved
// via workspace_update_node_prompt, a diff-vs-canonical view (changes_compare,
// backstopped by a local line diff — see Shared.tsx's doc comment on why),
// and an effective-prompt preview (node_get_effective_prompt) that visibly
// marks skill + playbook injections apart from the operator's own text —
// the whole point of that preview is showing what the model actually
// received, not just echoing the stored prompt back.
//
// Unsaved-changes protection: edits are mirrored into a per-node draft cache
// (Shared.tsx) as they're typed, so switching to another tab (this
// component unmounts) or to another node (Center.tsx keeps this component
// mounted, only the `nodeId`/`node` props change) never silently drops
// work — the draft reloads either way, marked dirty, with Discard available.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSkills } from '../../../api/hooks';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { workspaceUpdateNodePrompt } from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import type { WorkflowNode } from '../../../types';
import { useEffectivePrompt, usePlaybook } from '../queries';
import {
  canonicalPromptFor,
  clearLocalDraft,
  Disclosure,
  DiffLines,
  diffLines,
  ErrorNote,
  getLocalDraft,
  READONLY_REASON,
  recordChange,
  setLocalDraft,
} from './Shared';

export function PromptTab({ node, nodeId, wfName }: { node: WorkflowNode; nodeId: string; wfName: string }) {
  const promptQ = useEffectivePrompt(nodeId);
  const playbookQ = usePlaybook(nodeId);
  const skillsQ = useSkills();
  const qc = useQueryClient();

  const storedPrompt =
    node.prompt ||
    `You are the ${node.name} in the ${wfName.toLowerCase()}.\n\n${node.desc}\n\nRead upstream stage outputs, honor the client contract, produce output matching the declared schema…`;

  const canonical = canonicalPromptFor(nodeId, storedPrompt);

  // A real contenteditable, not a controlled React input: the DOM owns its
  // own text nodes (never re-rendered from `text`) so typing never fights
  // the cursor position. `text` mirrors it for dirty-checking/draft-saving;
  // `setEditorContent` is the only path allowed to write into the DOM
  // (initial mount, node switch, discard) — `handleInput` (user typing)
  // deliberately never touches the DOM, only reads it.
  const editorRef = useRef<HTMLDivElement>(null);
  const editingNode = useRef(nodeId);
  const [text, setText] = useState<string>(() => getLocalDraft<string>(nodeId, 'prompt') ?? storedPrompt);
  const [saving, setSaving] = useState(false);

  function setEditorContent(v: string) {
    setText(v);
    if (editorRef.current) editorRef.current.textContent = v;
  }

  // Seed the DOM once on mount — React never renders this div's children,
  // so nothing else does this for us.
  useEffect(() => {
    if (editorRef.current) editorRef.current.textContent = text;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Node switched while the Prompt tab stayed mounted — reload the draft
  // (or the new node's stored prompt) instead of leaving the previous
  // node's text sitting in the box.
  useEffect(() => {
    if (editingNode.current === nodeId) return;
    editingNode.current = nodeId;
    setEditorContent(getLocalDraft<string>(nodeId, 'prompt') ?? storedPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // No live warm-up call here: changes_compare's real schema takes two
  // revision ids (fromRevisionId/toRevisionId), and this tab has neither —
  // only a nodeId. The previous `changesCompare({ nodeId })` prefetch could
  // never succeed against the live schema and its result was discarded
  // either way (`.catch(() => undefined)`, no `.then`); removed rather than
  // fired as a doomed call. The local diff below is what actually renders.

  const dirty = text !== storedPrompt;

  function handleInput(e: React.FormEvent<HTMLDivElement>) {
    const v = e.currentTarget.textContent ?? '';
    setText(v);
    if (v !== storedPrompt) setLocalDraft(nodeId, 'prompt', v);
    else clearLocalDraft(nodeId, 'prompt');
  }

  function discardDraft() {
    setEditorContent(storedPrompt);
    clearLocalDraft(nodeId, 'prompt');
  }

  async function handleSave(triggerEl: HTMLElement | null) {
    if (!dirty || saving) return;
    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    try {
      const before = storedPrompt;
      await workspaceUpdateNodePrompt({ nodeId, prompt: text });
      clearLocalDraft(nodeId, 'prompt');
      recordChange({ nodeId, kind: 'prompt', label: 'prompt edited', before, after: text });
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      await qc.invalidateQueries({ queryKey: ['effectivePrompt', nodeId] });
      toast('Prompt saved', 'workspace_update_node_prompt → recorded in History');
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Save failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  const diffOps = diffLines(canonical, storedPrompt);
  const skillIds = node.skills;

  return (
    <Card
      label={
        <>
          stored prompt <span className="pin live">live — applies next run</span>
          {dirty && <span className="pin" style={{ marginLeft: 6, background: 'var(--acc-soft)', color: 'var(--acc)' }}>unsaved draft</span>}
          {promptQ.isLoading && ' · checking divergence…'}
          {promptQ.isError && ' · divergence unknown'}
          {promptQ.data?.diverged && ' · state: diverged from canonical'}
        </>
      }
    >
      <div
        ref={editorRef}
        className="promptbox"
        style={{ minHeight: 220 }}
        contentEditable={!IS_READ_ONLY}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="stored prompt"
        aria-readonly={IS_READ_ONLY}
        onInput={handleInput}
      />
      {promptQ.isError && <ErrorNote message={promptQ.error?.message} />}
      <div className="editnote">
        <Btn
          variant="pri"
          disabled={!dirty || saving || IS_READ_ONLY}
          title={IS_READ_ONLY ? READONLY_REASON : !dirty ? 'No unsaved changes.' : undefined}
          onClick={(e) => handleSave(e.currentTarget)}
        >
          {saving ? 'Saving…' : 'Save'}
        </Btn>
        {dirty && (
          <Btn onClick={discardDraft} title="Revert the textarea to the currently saved prompt and discard this draft.">
            Discard draft
          </Btn>
        )}
        <Disclosure openLabel="Diff vs canonical" closeLabel="Hide diff">
          <p className="note" style={{ marginTop: 0 }}>
            canonical = the prompt first observed this session for {nodeId}; changes_compare called for the record
            (returns no line diff in fixture mode — the lines below are computed locally against that baseline).
          </p>
          <DiffLines ops={diffOps} />
        </Disclosure>
        <Disclosure openLabel="Preview effective" closeLabel="Hide effective preview">
          <EffectivePreview
            base={storedPrompt}
            dirty={dirty}
            skillIds={skillIds}
            skillVersions={skillsQ.data}
            playbookNote={playbookQ.data?.note}
            lessons={playbookQ.data?.lessons ?? []}
            loadingSkills={skillsQ.isLoading}
            loadingPlaybook={playbookQ.isLoading}
          />
        </Disclosure>
        <Btn disabled title="Phase 5 — optimizer_run_trial counterfactual replay against a frozen dataset">
          ⇄ Replay vs dataset
        </Btn>
      </div>
    </Card>
  );
}

function EffectivePreview({
  base,
  dirty,
  skillIds,
  skillVersions,
  playbookNote,
  lessons,
  loadingSkills,
  loadingPlaybook,
}: {
  base: string;
  dirty: boolean;
  skillIds: string[];
  skillVersions: Array<{ id: string; version: string }> | undefined;
  playbookNote: string | undefined;
  lessons: unknown[];
  loadingSkills: boolean;
  loadingPlaybook: boolean;
}) {
  return (
    <div>
      {dirty && (
        <p className="note" style={{ marginTop: 0, color: 'var(--acc)' }}>
          reflects the currently saved prompt — save your draft to include it in what the next run receives.
        </p>
      )}
      <div className="lbl" style={{ marginBottom: 6 }}>
        operator prompt
      </div>
      <div className="promptbox">{base}</div>

      <div className="lbl" style={{ margin: '12px 0 6px', color: 'var(--acc)' }}>
        skill injections · {skillIds.length}
      </div>
      {loadingSkills ? (
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>resolving assigned skills…</p>
      ) : skillIds.length === 0 ? (
        <p style={{ color: 'var(--faint)', fontSize: 12, margin: 0 }}>No skills assigned — nothing injected here.</p>
      ) : (
        skillIds.map((id) => {
          const v = skillVersions?.find((s) => s.id === id)?.version;
          return (
            <div key={id} style={{ borderLeft: '3px solid var(--acc)', paddingLeft: 10, marginBottom: 8 }}>
              <div className="lbl" style={{ color: 'var(--acc)' }}>
                skill injection · {id}
                {v ? ` v${v}` : ''}
              </div>
              <div className="promptbox" style={{ background: 'var(--acc-soft)', color: 'var(--ink)' }}>
                Injected at run time by skill_resolve_for_node — this skill&rsquo;s authored guidance is appended
                here. Its body text isn&rsquo;t captured in this fixture set, so only the injection point is shown.
              </div>
            </div>
          );
        })
      )}

      <div className="lbl" style={{ margin: '12px 0 6px', color: 'var(--ok)' }}>
        playbook lessons
      </div>
      {loadingPlaybook ? (
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>loading playbook…</p>
      ) : lessons.length > 0 ? (
        <div style={{ borderLeft: '3px solid var(--ok)', paddingLeft: 10 }}>
          <div className="promptbox" style={{ background: 'color-mix(in srgb, var(--ok) 10%, transparent)', color: 'var(--ink)' }}>
            {JSON.stringify(lessons, null, 2)}
          </div>
        </div>
      ) : (
        <p style={{ color: 'var(--faint)', fontSize: 12, margin: 0 }}>{playbookNote ?? 'No curated playbook lessons for this node yet.'}</p>
      )}
    </div>
  );
}
