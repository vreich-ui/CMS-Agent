// Default output tab — W4. A node's STANDING output: a value written into
// a run as though the node produced it, with no model turn and no cost. An
// operator uses this to push one blocked/expensive node through, or to
// start a whole run in a defaults output mode (see StartRunModal.tsx) —
// never to change what happens on one run alone (that's an operator
// OVERRIDE, drive/OverrideOutputModal.tsx's job, a different thing that
// must keep reading as a different thing here).
//
// Reuses OverrideOutputModal's JSON-editor approach and Shared.tsx's
// SchemaIssueList / parseJsonWithPosition / ErrorNote / LoadingNote /
// READONLY_REASON rather than reinventing any of them — this tab's Save
// flow deliberately mirrors OverrideOutputModal's handleSaveClick exactly:
// parse -> validate (node_validate_output, proactively, client-side) ->
// on a schema-invalid-but-parseable value, a second explicit,
// issue-naming confirmation in the SAME shape (same heading, same "you are
// the authority" wording, same Btn/variant) before Save ever passes
// `force: true` to workspace_update_node_default_output. The server would
// refuse the same value with a classified default_output_schema_invalid
// error if this proactive check were skipped — this tab never lets that
// refusal be the operator's first sight of the problem.
//
// Seed order: the node's current defaultOutput.value when one is set;
// otherwise node_get_latest_output's value, purely as a convenience
// prefill (typing over it and saving creates a genuinely NEW default, not
// an adoption — use "Adopt as default" from the rail/quick-look for that).
// A local per-node draft (Shared.tsx's getLocalDraft/setLocalDraft, same
// mechanism SchemasTab uses) survives a tab switch or a node reselect.

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../../api/verbs';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { errMsg, formatWhen, normalizeValidationIssues } from '../../../components/drive/overrideStatus';
import type { WorkflowNode } from '../../../types';
import {
  clearLocalDraft,
  ErrorNote,
  getLocalDraft,
  LoadingNote,
  parseJsonWithPosition,
  READONLY_REASON,
  recordChange,
  SchemaIssueList,
  setLocalDraft,
  type SchemaIssue,
} from './Shared';

const TEXT_FIELD = 'defaultOutputText';
const NOTE_FIELD = 'defaultOutputNote';

function schemaValidPin(node: WorkflowNode): { text: string; cls: string } | null {
  const d = node.defaultOutput;
  if (!d) return null;
  if (d.schemaValidAt === null) return { text: 'saved over a schema failure', cls: 'pinned' };
  if (typeof d.schemaValidAt === 'string') return { text: 'schema valid', cls: 'live' };
  return { text: 'never validated', cls: '' };
}

export function DefaultOutputTab({ node, nodeId }: { node: WorkflowNode; nodeId: string }) {
  const qc = useQueryClient();
  const editingNode = useRef(nodeId);

  // SEEDED FROM THE STORED DEFAULT, not just from a draft. Center.tsx renders this tab
  // conditionally, so the component unmounts on every tab switch and this initializer runs
  // again — and the node-switch effect below early-returns on mount (editingNode.current
  // starts at nodeId). Without the seed here, opening the tab on a node that HAS a default
  // showed its header ("schema valid, saved by human") above an empty editor, with Clear
  // enabled and nothing on screen saying what was about to be discarded.
  const [text, setText] = useState<string>(
    () => getLocalDraft<string>(nodeId, TEXT_FIELD) ?? (node.defaultOutput ? JSON.stringify(node.defaultOutput.value, null, 2) : ''),
  );
  const [note, setNote] = useState<string>(() => getLocalDraft<string>(nodeId, NOTE_FIELD) ?? (node.defaultOutput?.note ?? ''));
  const [parseError, setParseError] = useState<{ message: string; line?: number; column?: number } | null>(null);
  const [issues, setIssues] = useState<SchemaIssue[] | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateCallError, setValidateCallError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const hasDefault = Boolean(node.defaultOutput);

  // Seeds only when this node has no default yet, so typing over a fetched
  // "last output" convenience prefill never gets silently re-fetched out
  // from under the operator.
  const latestOutputQ = useQuery({
    queryKey: ['nodeLatestOutput', nodeId],
    queryFn: () => verbs.nodeGetLatestOutput({ nodeId }),
    enabled: Boolean(nodeId) && !hasDefault,
    staleTime: 15_000,
  });

  function resetEditorState() {
    setParseError(null);
    setIssues(null);
    setValidateCallError(null);
    setPendingConfirm(false);
  }

  // Node switch — mirrors SchemasTab's editingNode-ref pattern exactly: a
  // draft survives a tab switch (component stays mounted) but resets when
  // the SELECTED NODE changes.
  useEffect(() => {
    if (editingNode.current === nodeId) return;
    editingNode.current = nodeId;
    const draft = getLocalDraft<string>(nodeId, TEXT_FIELD);
    if (draft !== undefined) {
      setText(draft);
    } else if (node.defaultOutput) {
      setText(JSON.stringify(node.defaultOutput.value, null, 2));
    } else {
      setText('');
    }
    setNote(getLocalDraft<string>(nodeId, NOTE_FIELD) ?? (node.defaultOutput?.note ?? ''));
    resetEditorState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // Convenience prefill from node_get_latest_output, only for a node that
  // genuinely has no default and no draft yet — never overwrites a typed edit.
  useEffect(() => {
    if (hasDefault) return;
    if (text !== '') return;
    if (getLocalDraft(nodeId, TEXT_FIELD) !== undefined) return;
    const latest = latestOutputQ.data;
    if (latest !== null && latest !== undefined) {
      setText(JSON.stringify(latest.value, null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestOutputQ.data, hasDefault, nodeId]);

  // Parse-check whatever the editor opened with, exactly as OverrideOutputModal does on its
  // own first mount: a seeded or drafted value that no longer parses must say so before the
  // operator presses anything, not after.
  useEffect(() => {
    if (text.trim() === '') return;
    const parsed = parseJsonWithPosition(text);
    setParseError(parsed.ok ? null : { message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onTextChange(v: string) {
    setText(v);
    resetEditorState();
    if (v.trim() === '') clearLocalDraft(nodeId, TEXT_FIELD);
    else setLocalDraft(nodeId, TEXT_FIELD, v);
    const parsed = parseJsonWithPosition(v);
    setParseError(parsed.ok ? null : { message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
  }

  function onNoteChange(v: string) {
    setNote(v);
    setLocalDraft(nodeId, NOTE_FIELD, v);
  }

  async function handleValidate() {
    const parsed = parseJsonWithPosition(text);
    if (!parsed.ok) {
      setParseError({ message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
      return;
    }
    setValidating(true);
    setValidateCallError(null);
    setPendingConfirm(false);
    try {
      const result = await verbs.nodeValidateOutput({ nodeId, output: parsed.value });
      setIssues(result.valid ? [] : normalizeValidationIssues(result.issues));
    } catch (err) {
      setIssues(null);
      setValidateCallError(errMsg(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleSaveClick(triggerEl: HTMLElement | null) {
    const parsed = parseJsonWithPosition(text);
    if (!parsed.ok) {
      setParseError({ message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
      return;
    }

    let currentIssues = issues;
    if (currentIssues === null) {
      setValidating(true);
      setValidateCallError(null);
      try {
        const result = await verbs.nodeValidateOutput({ nodeId, output: parsed.value });
        currentIssues = result.valid ? [] : normalizeValidationIssues(result.issues);
        setIssues(currentIssues);
      } catch (err) {
        // The operator is still the authority even when the validator
        // itself can't be reached — surface the failure, but don't invent
        // schema issues that were never actually reported.
        currentIssues = [];
        setIssues([]);
        setValidateCallError(errMsg(err));
      } finally {
        setValidating(false);
      }
    }

    if (currentIssues.length > 0 && !pendingConfirm) {
      setPendingConfirm(true); // require the explicit second confirmation below
      return;
    }

    await doSave(triggerEl, parsed.value, currentIssues.length > 0);
  }

  async function doSave(triggerEl: HTMLElement | null, value: unknown, force: boolean) {
    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    const before = node.defaultOutput;
    try {
      await verbs.workspaceUpdateNodeDefaultOutput({ nodeId, value, note: note.trim() || undefined, force: force || undefined });
      clearLocalDraft(nodeId, TEXT_FIELD);
      clearLocalDraft(nodeId, NOTE_FIELD);
      setPendingConfirm(false);
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
      // W3/W4 — the rail reads its node rows (and `hasDefaultOutput`, which is what decides whether
      // it offers a push-through at all) from `workbench.bootstrap`. Without this, an operator could
      // save a default here and the rail would keep insisting the node has none.
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
      recordChange({ nodeId, kind: 'defaultOutput', label: 'default output saved', before, after: value });
      toast('Default output saved', `workspace_update_node_default_output → ${nodeId}${force ? ' (force)' : ''}`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Save failed', errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(triggerEl: HTMLElement | null) {
    setNextConfirmTrigger(triggerEl);
    setClearing(true);
    const before = node.defaultOutput;
    try {
      await verbs.workspaceUpdateNodeDefaultOutput({ nodeId, value: null });
      clearLocalDraft(nodeId, TEXT_FIELD);
      clearLocalDraft(nodeId, NOTE_FIELD);
      setText('');
      setNote('');
      resetEditorState();
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      qc.invalidateQueries({ queryKey: ['nodes'] });
      // W3/W4 — the rail reads its node rows (and `hasDefaultOutput`, which is what decides whether
      // it offers a push-through at all) from `workbench.bootstrap`. Without this, an operator could
      // save a default here and the rail would keep insisting the node has none.
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
      recordChange({ nodeId, kind: 'defaultOutput', label: 'default output cleared', before, after: null });
      toast('Default output cleared', `workspace_update_node_default_output → ${nodeId} (value: null)`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Clear failed', errMsg(err));
    } finally {
      setClearing(false);
    }
  }

  const pin = schemaValidPin(node);
  const saveDisabled = saving || validating || Boolean(parseError) || IS_READ_ONLY;

  return (
    <Card
      label={
        <>
          default output
          {pin && <span className={`pin ${pin.cls}`} style={{ marginLeft: 6 }}>{pin.text}</span>}
          {!hasDefault && <span className="pin" style={{ marginLeft: 6 }}>no default set</span>}
        </>
      }
    >
      <p className="note" style={{ margin: '0 0 10px' }}>
        A standing output for <span className="mono">{nodeId}</span>, reused across every run that pushes this node
        through or starts in a defaults output mode — not a one-run override. Anything defaulted can never be
        published live.
      </p>

      {node.defaultOutput && (
        <p className="note" style={{ margin: '0 0 10px' }}>
          saved {formatWhen(node.defaultOutput.updatedAt)} by <span className="mono">{node.defaultOutput.updatedBy}</span>
          {node.defaultOutput.note ? ` — “${node.defaultOutput.note}”` : ' — no note given'}
        </p>
      )}
      {!hasDefault && latestOutputQ.isLoading && <LoadingNote>checking the last recorded output to seed the editor…</LoadingNote>}
      {!hasDefault && latestOutputQ.isError && (
        <ErrorNote message={`could not fetch a last-output prefill for ${nodeId} — the editor starts empty instead.`} />
      )}
      {!hasDefault && latestOutputQ.isSuccess && latestOutputQ.data && (
        <p className="note" style={{ margin: '0 0 10px' }}>
          seeded from the node's last recorded output ({formatWhen(latestOutputQ.data.createdAt)}) — edit freely, this
          only becomes the default once you Save.
        </p>
      )}

      <label className="lbl" htmlFor="default-output-json" style={{ display: 'block', marginBottom: 6 }}>
        default output JSON
      </label>
      <textarea
        id="default-output-json"
        className="schemabox"
        style={{ width: '100%', minHeight: 220, resize: 'vertical', color: 'var(--ink)' }}
        spellCheck={false}
        disabled={IS_READ_ONLY}
        aria-invalid={Boolean(parseError)}
        aria-describedby={parseError ? 'default-output-json-error' : undefined}
        placeholder={'{\n  \n}'}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
      />
      {parseError && (
        <p id="default-output-json-error" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--bad)' }}>
          Malformed JSON{parseError.line ? ` at line ${parseError.line}, column ${parseError.column}` : ''}:{' '}
          {parseError.message}
        </p>
      )}
      {!parseError && issues !== null && issues.length === 0 && (
        <span className="valnote">✓ validates against {nodeId}'s declared output schema</span>
      )}
      {validateCallError && (
        <p className="note" style={{ color: 'var(--bad)' }}>
          node_validate_output failed: {validateCallError} — Save is still available; nothing was checked.
        </p>
      )}
      <SchemaIssueList issues={issues ?? []} />

      {pendingConfirm && issues && issues.length > 0 && (
        <div className="card drive-invalid-confirm" style={{ marginTop: 10 }}>
          <span className="lbl" style={{ color: 'var(--bad)' }}>
            second confirmation — schema invalid
          </span>
          <p style={{ margin: '0 0 8px', fontSize: 12.5 }}>
            This output does not validate against <span className="mono">{nodeId}</span>'s declared output schema (
            {issues.length} issue{issues.length === 1 ? '' : 's'} above). You can still save it — you are the
            authority here, and a schema can be wrong — but this stores it exactly as written, issues and all, and
            stamps the record schema-invalid.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => setPendingConfirm(false)}>Back to editing</Btn>
            <Btn
              variant="danger"
              disabled={saving}
              onClick={(e) => doSave(e.currentTarget, parseJsonWithPosition(text).value, true)}
            >
              Yes — save despite {issues.length} issue{issues.length === 1 ? '' : 's'}
            </Btn>
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="default-output-note">note (optional) — why this default exists</label>
        <textarea
          id="default-output-note"
          rows={2}
          disabled={IS_READ_ONLY}
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
        />
      </div>

      <div className="editnote" style={{ marginTop: 10 }}>
        <Btn disabled={validating || Boolean(parseError) || IS_READ_ONLY} onClick={handleValidate}>
          {validating ? 'Validating…' : 'Validate'}
        </Btn>
        <Btn
          variant="pri"
          disabled={saveDisabled}
          title={IS_READ_ONLY ? READONLY_REASON : parseError ? 'Fix the JSON before saving.' : undefined}
          onClick={(e) => handleSaveClick(e.currentTarget)}
        >
          {saving ? 'Saving…' : pendingConfirm ? 'Save anyway' : 'Save default'}
        </Btn>
        <Btn
          variant="danger"
          disabled={!hasDefault || clearing || IS_READ_ONLY}
          title={!hasDefault ? 'No default is set for this node.' : IS_READ_ONLY ? READONLY_REASON : undefined}
          onClick={(e) => handleClear(e.currentTarget)}
        >
          {clearing ? 'Clearing…' : 'Clear default'}
        </Btn>
      </div>
      {IS_READ_ONLY && <p className="note" style={{ color: 'var(--acc)' }}>{READONLY_REASON}</p>}
    </Card>
  );
}
