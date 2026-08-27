// U3 — the override output modal. The heart of "insert manually the output
// variant I prefer": the operator produces the output he wants for one
// node, and the rest of the run consumes it as though the node produced it
// itself — except the app never actually claims that (see the override
// banner in ThisRunTab.tsx and the rail's own marker, which this reuses the
// exact vocabulary of via overrideStatus.ts).
//
// Opens as `?modal=override&m.node=…&m.run=…` (deep-linkable), from ⌘K's
// "override output on <node>" action, from the drive-mode step panel, and
// from This-run's own override banner. `params.run` falls back to the
// currently-bound run when the deep link/palette action didn't carry one.
//
// Flow (spec order):
//   1. Seed — current output, a prior variant (node_list_outputs), or an
//      empty object. Pasting a variant in wholesale is a first-class path:
//      picking one from the list drops it into the editor verbatim.
//   2. Edit — a real JSON textarea; parse errors shown live, with
//      line/column pulled from JSON.parse's own message (Shared.tsx's
//      parseJsonWithPosition — never invented).
//   3. Validate — node_validate_output against the node's declared output
//      schema; issues shown per-path (Shared.tsx's SchemaIssueList, same
//      vocabulary SchemasTab already uses). Unparseable JSON blocks Save
//      outright. Schema-invalid-but-parseable output MAY be saved — the
//      operator is the authority and a schema can be wrong — but only
//      after a second, explicit, issue-naming confirmation distinct from
//      (and not a softened substitute for) the blunt confirmAction gate
//      stage_save_output already carries (api/verbs.ts's stageSaveOutput
//      effect string — read there before touching this file's copy).
//   4. Save — stage_save_output, marked as an operator override.
//   5. What this does, stated before the save, in the same terms the
//      confirmAction gate itself uses — never softened.
//
// Escape never loses a typed override: the draft is held keyed by this
// exact modal instance (overlay/drafts.ts), independent of the seed
// source, and cleared only on a successful save.

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../api/verbs';
import { ActionCancelledError } from '../../api/confirmAction';
import { IS_READ_ONLY } from '../../api/client';
import { setNextConfirmTrigger } from '../ConfirmDialog';
import { Btn } from '../primitives';
import { toast } from '../Toasts';
import { useStore } from '../../store';
import { overlayKey } from '../../overlay/types';
import { clearDraft, readDraft, saveDraft } from '../../overlay/drafts';
import { Modal } from '../overlay/Modal';
import {
  ErrorNote,
  LoadingNote,
  parseJsonWithPosition,
  READONLY_REASON,
  SchemaIssueList,
  type SchemaIssue,
} from '../../screens/Workbench/tabs/Shared';
import {
  errMsg,
  extractOutputList,
  findOverride,
  formatWhen,
  normalizeValidationIssues,
  type NodeOutputEntry,
} from './overrideStatus';

export function OverrideOutputModal({ params, onClose }: { params: Record<string, string>; onClose: () => void }) {
  const qc = useQueryClient();
  const nodeId = params.node ?? '';
  const boundRunId = useStore((s) => s.runId);
  const runId = params.run || boundRunId || '';

  const draftKey = overlayKey({ kind: 'override', params });

  const [text, setText] = useState<string>(() => readDraft<string>(draftKey) ?? '');
  const [note, setNote] = useState<string>(() => readDraft<string>(`${draftKey}::note`) ?? '');
  const [seeded, setSeeded] = useState(() => readDraft<string>(draftKey) !== undefined);
  const [parseError, setParseError] = useState<{ message: string; line?: number; column?: number } | null>(null);
  const [issues, setIssues] = useState<SchemaIssue[] | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateCallError, setValidateCallError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  const schemaQ = useQuery({
    queryKey: ['outputSchema', nodeId],
    queryFn: () => verbs.nodeGetOutputSchema({ nodeId }),
    enabled: Boolean(nodeId),
  });
  // Same query key Rail.tsx's override marker uses — one cache entry, one
  // definition of "carries an override", refreshed for both surfaces the
  // instant either invalidates it.
  const outputsQ = useQuery({
    queryKey: ['nodeOutputs', nodeId, runId],
    queryFn: () => verbs.nodeListOutputs({ nodeId, runId: runId || undefined }),
    enabled: Boolean(nodeId) && Boolean(runId),
  });

  const priorList = useMemo(() => extractOutputList(outputsQ.data), [outputsQ.data]);
  const existingOverride = useMemo(() => findOverride(priorList), [priorList]);
  // "Current output" — the most recent entry regardless of kind (an
  // override, if one exists, is unshifted to the front by node_list_outputs
  // — see mockStore.ts's listNodeOutputs — so this is genuinely "what this
  // node's output reads as right now", not just the last stage_output).
  const currentEntry: NodeOutputEntry | undefined = priorList[0];

  function seedFrom(value: unknown) {
    setText(JSON.stringify(value ?? {}, null, 2));
    setSeeded(true);
    setIssues(null);
    setPendingConfirm(false);
    setParseError(null);
  }

  function onTextChange(v: string) {
    setText(v);
    setSeeded(true);
    setIssues(null);
    setPendingConfirm(false);
    setValidateCallError(null);
    saveDraft(draftKey, v);
    const parsed = parseJsonWithPosition(v);
    setParseError(parsed.ok ? null : { message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
  }

  function onNoteChange(v: string) {
    setNote(v);
    saveDraft(`${draftKey}::note`, v);
  }

  // Live parse-check on first mount too, in case a draft was restored.
  useEffect(() => {
    if (!text) return;
    const parsed = parseJsonWithPosition(text);
    setParseError(parsed.ok ? null : { message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveClick(triggerEl: HTMLElement | null) {
    const parsed = parseJsonWithPosition(text);
    if (!parsed.ok) {
      setParseError({ message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
      return; // never let a save proceed while the JSON is unparseable
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

    await doSave(triggerEl, parsed.value);
  }

  async function doSave(triggerEl: HTMLElement | null, value: unknown) {
    if (!runId) return;
    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    try {
      // The effect text the operator sees next comes straight out of
      // verbs.ts's stageSaveOutput → confirmAction gate — this modal states
      // the same thing above (see the notice card below) and never softens it.
      await verbs.stageSaveOutput({ runId, nodeId, value, note: note.trim() || undefined });
      clearDraft(draftKey);
      clearDraft(`${draftKey}::note`);
      qc.invalidateQueries({ queryKey: ['nodeOutputs', nodeId, runId] });
      qc.invalidateQueries({ queryKey: ['stageOutput', runId, nodeId] });
      qc.invalidateQueries({ queryKey: ['run', runId] });
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast('Output overridden', `stage_save_output → ${nodeId} in …${runId.slice(-10)}`);
      onClose();
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Override failed', errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  if (!nodeId) {
    return (
      <Modal open onClose={onClose} title="Override output" size="work">
        <p className="note">Open this from ⌘K ("override output on &lt;node&gt;"), a run's step view, or the rail — this instance has no node to target.</p>
      </Modal>
    );
  }

  if (!runId) {
    return (
      <Modal open onClose={onClose} title={`Override output · ${nodeId}`} size="work">
        <p className="note">
          An output override is scoped to a run — bind or start a run first, then reopen this from that run's step
          view (drive mode) or ⌘K.
        </p>
      </Modal>
    );
  }

  const saveDisabled = saving || validating || Boolean(parseError) || IS_READ_ONLY;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Override output · ${nodeId}`}
      size="work"
      sub={
        <>
          run <span className="mono">{runId}</span>
          {existingOverride && (
            <span style={{ marginLeft: 10, color: 'var(--run)' }}>
              ⎘ already carries an operator override, saved {formatWhen(existingOverride.createdAt)}
            </span>
          )}
        </>
      }
      footNote={IS_READ_ONLY ? <span style={{ color: 'var(--acc)' }}>{READONLY_REASON}</span> : undefined}
      actions={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="pri"
            disabled={saveDisabled}
            title={IS_READ_ONLY ? READONLY_REASON : parseError ? 'Fix the JSON before saving.' : undefined}
            onClick={(e) => handleSaveClick(e.currentTarget)}
          >
            {saving ? 'Saving…' : validating ? 'Validating…' : pendingConfirm ? 'Save anyway' : 'Save override'}
          </Btn>
        </>
      }
    >
      <div className="card" style={{ background: 'var(--acc-soft)', borderColor: 'var(--acc-dim)' }}>
        <span className="lbl" style={{ color: 'var(--acc-ink)' }}>
          what this does
        </span>
        <p style={{ margin: 0, fontSize: 12.5 }}>
          Replaces <span className="mono">{nodeId}</span>'s output in run <span className="mono">{runId}</span> with
          the variant you supply below. Every downstream node in this run will read <b>your</b> value as this node's
          result, and the run record will record it as an operator override.
        </p>
      </div>

      <div className="card" style={{ background: 'var(--panel2)' }}>
        <span className="lbl">seed the editor</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn
            disabled={!currentEntry}
            title={currentEntry ? undefined : 'No output recorded for this node in this run yet.'}
            onClick={() => currentEntry && seedFrom(currentEntry.value)}
          >
            current output
          </Btn>
          <Btn onClick={() => seedFrom({})}>empty object</Btn>
          {priorList.length > 0 && (
            <span className="note" style={{ margin: 0 }}>
              or pick a prior variant below to paste it in wholesale
            </span>
          )}
        </div>
        {outputsQ.isLoading ? (
          <LoadingNote>loading recorded outputs…</LoadingNote>
        ) : outputsQ.isError ? (
          <ErrorNote message={outputsQ.error?.message} />
        ) : priorList.length === 0 ? (
          <p className="note" style={{ margin: '8px 0 0' }}>No prior output recorded for this node in this run yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, maxHeight: 140, overflowY: 'auto' }}>
            {priorList.map((entry, i) => (
              <button
                key={entry.id ?? i}
                type="button"
                className="toolrow"
                style={{ borderRadius: 6, cursor: 'pointer' }}
                onClick={() => seedFrom(entry.value)}
              >
                <span className="tn mono">{entry.type === 'operator_override' ? '⎘ operator override' : 'stage output'}</span>
                <span className="td">{formatWhen(entry.createdAt)}</span>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>use →</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="dssplit">
        <div>
          <label className="lbl" htmlFor="override-json" style={{ display: 'block', marginBottom: 6 }}>
            output JSON
          </label>
          <textarea
            id="override-json"
            className="schemabox"
            style={{ width: '100%', minHeight: 260, resize: 'vertical', color: 'var(--ink)' }}
            spellCheck={false}
            aria-invalid={Boolean(parseError)}
            aria-describedby={parseError ? 'override-json-error' : undefined}
            placeholder={seeded ? undefined : '{\n  \n}'}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
          />
          {parseError && (
            <p id="override-json-error" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--bad)' }}>
              Malformed JSON{parseError.line ? ` at line ${parseError.line}, column ${parseError.column}` : ''}:{' '}
              {parseError.message}
            </p>
          )}
          {!parseError && issues !== null && issues.length === 0 && (
            <span className="valnote">✓ validates against {nodeId}'s declared output schema</span>
          )}
          {validateCallError && (
            <p className="note" style={{ color: 'var(--bad)' }}>node_validate_output failed: {validateCallError} — save is still available; nothing was checked.</p>
          )}
          <SchemaIssueList issues={issues ?? []} />

          {pendingConfirm && issues && issues.length > 0 && (
            <div className="card drive-invalid-confirm" style={{ marginTop: 10 }}>
              <span className="lbl" style={{ color: 'var(--bad)' }}>
                second confirmation — schema invalid
              </span>
              <p style={{ margin: '0 0 8px', fontSize: 12.5 }}>
                This output does not validate against <span className="mono">{nodeId}</span>'s declared output
                schema ({issues.length} issue{issues.length === 1 ? '' : 's'} above). You can still save it — you are
                the authority here, and a schema can be wrong — but this saves it exactly as written, issues and all.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn onClick={() => setPendingConfirm(false)}>Back to editing</Btn>
                <Btn
                  variant="danger"
                  disabled={saving}
                  onClick={(e) => doSave(e.currentTarget, parseJsonWithPosition(text).value)}
                >
                  Yes — save despite {issues.length} issue{issues.length === 1 ? '' : 's'}
                </Btn>
              </div>
            </div>
          )}

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="override-note">note (optional) — why you're overriding this output</label>
            <textarea id="override-note" rows={2} value={note} onChange={(e) => onNoteChange(e.target.value)} />
          </div>
        </div>

        <div>
          <span className="lbl" style={{ display: 'block', marginBottom: 6 }}>
            declared output schema · reference
          </span>
          {schemaQ.isLoading ? (
            <LoadingNote>loading schema…</LoadingNote>
          ) : schemaQ.isError ? (
            <ErrorNote message={schemaQ.error?.message} />
          ) : (
            <div className="schemabox" style={{ maxHeight: 320 }}>{JSON.stringify(schemaQ.data ?? {}, null, 2)}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
