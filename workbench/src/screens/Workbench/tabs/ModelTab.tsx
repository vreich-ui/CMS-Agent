// Model & limits tab — WP-33. A real editable form (budget, max turns, tool-
// call limit, timeout, max output tokens, retry count) saved via
// workspace_update_node_model_config. Every numeric field is checked
// client-side before the round-trip — a budget of 0 or a negative timeout is
// refused with a stated reason, never silently sent to the backend.
//
// Renders as a plain read display until "Edit" is clicked (or a draft from
// an earlier, un-saved edit already exists for this node) — keeps the
// at-a-glance KV view legible for the common case of just checking the
// numbers, same as the WP-12 read-only view, while the edit form underneath
// is the same live data plus real bounds-checked inputs.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { workspaceUpdateNodeModelConfig } from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card, KV } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import type { ModelConfig, WorkflowNode } from '../../../types';
import { clearLocalDraft, getLocalDraft, READONLY_REASON, recordChange, setLocalDraft } from './Shared';

const DEFAULT_MODEL: ModelConfig = { maxTurns: 4, toolCallLimit: 2, timeout: '300s', budgetUsd: 0.5, maxOutputTokens: 8000, retryCount: 1 };

interface DraftForm {
  budgetUsd: string;
  maxTurns: string;
  toolCallLimit: string;
  timeoutSeconds: string;
  maxOutputTokens: string;
  retryCount: string;
}

function parseTimeoutSeconds(timeout: string): string {
  const m = /^(\d+(?:\.\d+)?)/.exec(timeout.trim());
  return m ? m[1] : timeout;
}

function formToDraft(m: ModelConfig): DraftForm {
  return {
    budgetUsd: String(m.budgetUsd),
    maxTurns: String(m.maxTurns),
    toolCallLimit: String(m.toolCallLimit),
    timeoutSeconds: parseTimeoutSeconds(m.timeout),
    maxOutputTokens: String(m.maxOutputTokens),
    retryCount: String(m.retryCount),
  };
}

/**
 * Server wire units for every field the form edits — see verbs.ts's
 * workspaceUpdateNodeModelConfig doc comment. Every field is a 1:1 pass-
 * through except `timeout`, which the server stores in milliseconds while
 * the form edits seconds (`timeoutSeconds`).
 */
type RawPatchFields = {
  budgetUsd: number;
  maxTurns: number;
  toolCallLimit: number;
  timeout: number;
  maxOutputTokens: number;
  retryCount: number;
};

function formToRaw(form: DraftForm): RawPatchFields {
  return {
    budgetUsd: Number(form.budgetUsd),
    maxTurns: Number(form.maxTurns),
    toolCallLimit: Number(form.toolCallLimit),
    timeout: Math.round(Number(form.timeoutSeconds) * 1000),
    maxOutputTokens: Number(form.maxOutputTokens),
    retryCount: Number(form.retryCount),
  };
}

/** Only the keys whose raw (server-unit) value actually changed — the patch
 * this tool sends is merged onto the node's existing modelConfig server-side
 * (deepMergeRecords in tools.ts), so an unmentioned key is left exactly as
 * it was; there's no need to (and no reason to risk) resending every field. */
function diffRawPatch(before: RawPatchFields, after: RawPatchFields): Partial<RawPatchFields> {
  const patch: Partial<RawPatchFields> = {};
  (Object.keys(after) as (keyof RawPatchFields)[]).forEach((key) => {
    if (after[key] !== before[key]) patch[key] = after[key];
  });
  return patch;
}

interface FieldSpec {
  key: keyof DraftForm;
  label: string;
  min: number;
  integer: boolean;
  allowZero: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: 'budgetUsd', label: 'budget usd', min: 0, integer: false, allowZero: false },
  { key: 'maxTurns', label: 'max turns', min: 1, integer: true, allowZero: false },
  { key: 'toolCallLimit', label: 'tool call limit', min: 0, integer: true, allowZero: true },
  { key: 'timeoutSeconds', label: 'timeout (seconds)', min: 0, integer: false, allowZero: false },
  { key: 'maxOutputTokens', label: 'max output tokens', min: 1, integer: true, allowZero: false },
  { key: 'retryCount', label: 'retry count', min: 0, integer: true, allowZero: true },
];

function validateField(spec: FieldSpec, raw: string): string | null {
  const n = Number(raw);
  if (raw.trim() === '' || Number.isNaN(n)) return `${spec.label} must be a number.`;
  if (spec.integer && !Number.isInteger(n)) return `${spec.label} must be a whole number.`;
  if (n < spec.min || (!spec.allowZero && n <= 0)) {
    return spec.allowZero ? `${spec.label} must be ${spec.min} or greater.` : `${spec.label} must be greater than 0.`;
  }
  return null;
}

export function ModelTab({ node }: { node: WorkflowNode }) {
  const nodeId = node.id;
  const qc = useQueryClient();
  const serverModel = node.model ?? DEFAULT_MODEL;
  const serverForm = formToDraft(serverModel);

  const editingNode = useRef(nodeId);
  const [editing, setEditing] = useState(() => getLocalDraft<DraftForm>(nodeId, 'model') !== undefined);
  const [form, setForm] = useState<DraftForm>(() => getLocalDraft<DraftForm>(nodeId, 'model') ?? serverForm);
  const [errors, setErrors] = useState<Partial<Record<keyof DraftForm, string>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingNode.current === nodeId) return;
    editingNode.current = nodeId;
    const draft = getLocalDraft<DraftForm>(nodeId, 'model');
    setForm(draft ?? formToDraft(serverModel));
    setEditing(draft !== undefined);
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const dirty = FIELDS.some((f) => form[f.key] !== serverForm[f.key]);

  function onChange(key: keyof DraftForm, value: string) {
    const next = { ...form, [key]: value };
    setForm(next);
    setErrors((e) => ({ ...e, [key]: undefined }));
    const isDirty = FIELDS.some((f) => next[f.key] !== serverForm[f.key]);
    if (isDirty) setLocalDraft(nodeId, 'model', next);
    else clearLocalDraft(nodeId, 'model');
  }

  function discard() {
    setForm(serverForm);
    setErrors({});
    clearLocalDraft(nodeId, 'model');
    setEditing(false);
  }

  async function handleSave(triggerEl: HTMLElement | null) {
    if (saving) return;
    const nextErrors: Partial<Record<keyof DraftForm, string>> = {};
    for (const spec of FIELDS) {
      const msg = validateField(spec, form[spec.key]);
      if (msg) nextErrors[spec.key] = msg;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const nextModel: ModelConfig = {
      budgetUsd: Number(form.budgetUsd),
      maxTurns: Number(form.maxTurns),
      toolCallLimit: Number(form.toolCallLimit),
      timeout: `${Number(form.timeoutSeconds)}s`,
      maxOutputTokens: Number(form.maxOutputTokens),
      retryCount: Number(form.retryCount),
    };

    const patch = diffRawPatch(formToRaw(serverForm), formToRaw(form));

    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    try {
      await workspaceUpdateNodeModelConfig({ nodeId, patch });
      recordChange({ nodeId, kind: 'model', label: 'model & limits edited', before: serverModel, after: nextModel });
      clearLocalDraft(nodeId, 'model');
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['node', nodeId] });
      toast('Model & limits saved', 'workspace_update_node_model_config → recorded in History');
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      // The server's own validation_error detail (issues, at path — see
      // client.ts's describeErrorEnvelope) is the whole point of surfacing
      // this: keep it verbatim rather than collapsing to a generic message.
      toast('Save failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card
        label={
          <>
            model &amp; limits <span className="pin live">live</span>
            {dirty && <span className="pin" style={{ marginLeft: 6, background: 'var(--acc-soft)', color: 'var(--acc)' }}>unsaved draft</span>}
          </>
        }
      >
        {editing ? (
          <>
            <KV>
              {FIELDS.map((spec) => (
                <FieldRow key={spec.key} spec={spec} value={form[spec.key]} error={errors[spec.key]} onChange={(v) => onChange(spec.key, v)} />
              ))}
            </KV>
            <div className="editnote">
              <Btn
                variant="pri"
                disabled={saving || IS_READ_ONLY}
                title={IS_READ_ONLY ? READONLY_REASON : undefined}
                onClick={(e) => handleSave(e.currentTarget)}
              >
                {saving ? 'Saving…' : 'Save'}
              </Btn>
              <Btn onClick={discard}>{dirty ? 'Discard draft' : 'Cancel'}</Btn>
            </div>
          </>
        ) : (
          <>
            <KV>
              <span className="k">budget usd</span>
              <span className="num">{serverModel.budgetUsd}</span>
              <span className="k">max turns</span>
              <span className="num">{serverModel.maxTurns}</span>
              <span className="k">tool call limit</span>
              <span className="num">{serverModel.toolCallLimit}</span>
              <span className="k">timeout</span>
              <span className="num">{serverModel.timeout}</span>
              <span className="k">max output tokens</span>
              <span className="num">{serverModel.maxOutputTokens}</span>
              <span className="k">retry count</span>
              <span className="num">{serverModel.retryCount}</span>
            </KV>
            <div className="editnote">
              <Btn
                variant="pri"
                disabled={IS_READ_ONLY}
                title={IS_READ_ONLY ? READONLY_REASON : undefined}
                onClick={() => setEditing(true)}
              >
                Edit
              </Btn>
            </div>
          </>
        )}
      </Card>
      <Card label="model ladder">
        <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: 0 }}>
          No model-attributed eval results yet — run evaluations with subject-model attribution and the ladder will
          recommend the cheapest model that holds quality (threshold 0.7, min 3 samples). Recommendation applies
          with one click, reversible in History.
        </p>
      </Card>
    </>
  );
}

function FieldRow({
  spec,
  value,
  error,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  const id = `model-${spec.key}`;
  return (
    <>
      <label className="k" htmlFor={id}>
        {spec.label}
      </label>
      <span>
        <input
          id={id}
          className="mono num"
          style={{
            width: 110,
            background: 'var(--bg)',
            color: 'var(--ink)',
            border: `1px solid ${error ? 'var(--bad)' : 'var(--line2)'}`,
            borderRadius: 7,
            padding: '4px 8px',
            font: 'inherit',
            fontSize: 12.5,
          }}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {error && (
          <span id={`${id}-err`} style={{ color: 'var(--bad)', fontSize: 11.5, marginLeft: 8 }}>
            {error}
          </span>
        )}
      </span>
    </>
  );
}
