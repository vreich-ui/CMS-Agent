// Schemas tab — WP-33. Input/output JSON Schema, now real editors: validated
// with workspace_validate_node before save, with blocking errors shown
// inline at the offending path — not a generic "invalid JSON." Two separate
// failure modes are handled distinctly, per the WP-33 done-criterion:
//   1. malformed JSON (a parse error, reported with line/column), and
//   2. schema-invalid-but-parseable (workspace_validate_node's own message
//      where it has one, plus a real local JSON-Schema-shape check — see
//      Shared.tsx's doc comment on why the local check exists: the mock
//      handler always reports {valid:true} regardless of input).
//
// workspace_update_node_input_schema/output_schema don't persist against
// mockStore either (client.ts, not ours to edit) — so a successful save
// writes into the local schema overlay (Shared.tsx), which is what's read
// back afterwards instead of the ever-identical stub.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import {
  workspaceUpdateNodeInputSchema,
  workspaceUpdateNodeOutputSchema,
  workspaceValidateNode,
  type JSONSchema,
} from '../../../api/verbs';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { useInputSchema, useOutputSchema } from '../queries';
import {
  clearLocalDraft,
  ErrorNote,
  getLocalDraft,
  getSchemaOverlay,
  LoadingNote,
  parseJsonWithPosition,
  READONLY_REASON,
  recordChange,
  SchemaIssueList,
  setLocalDraft,
  setSchemaOverlay,
  validateSchemaShape,
  type SchemaIssue,
  type SchemaKind,
} from './Shared';

export function SchemasTab({ nodeId }: { nodeId: string }) {
  const inputQ = useInputSchema(nodeId);
  const outputQ = useOutputSchema(nodeId);

  return (
    <>
      <SchemaEditor
        nodeId={nodeId}
        kind="input"
        title="input schema"
        query={inputQ}
        updateVerb={workspaceUpdateNodeInputSchema}
      />
      <SchemaEditor
        nodeId={nodeId}
        kind="output"
        title={`output schema · produces ${nodeId}.v1`}
        query={outputQ}
        updateVerb={workspaceUpdateNodeOutputSchema}
      />
    </>
  );
}

function SchemaEditor({
  nodeId,
  kind,
  title,
  query,
  updateVerb,
}: {
  nodeId: string;
  kind: SchemaKind;
  title: string;
  query: { data?: JSONSchema; isLoading: boolean; isError: boolean; error: { message?: string } | null };
  updateVerb: (args: { nodeId: string; schema: JSONSchema }) => Promise<{ nodeId: string; schema: JSONSchema; applied: boolean }>;
}) {
  const qc = useQueryClient();
  const field: 'inputSchema' | 'outputSchema' = kind === 'input' ? 'inputSchema' : 'outputSchema';
  const overlay = getSchemaOverlay(nodeId, kind);
  const effective = overlay ?? query.data;
  const effectiveText = effective !== undefined ? JSON.stringify(effective, null, 2) : '';

  const editingNode = useRef(nodeId);
  const [text, setText] = useState<string>(() => getLocalDraft<string>(nodeId, `${kind}SchemaText`) ?? effectiveText);
  const [issues, setIssues] = useState<SchemaIssue[]>([]);
  const [parseError, setParseError] = useState<{ message: string; line?: number; column?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [validOk, setValidOk] = useState(false);

  useEffect(() => {
    if (editingNode.current === nodeId) return;
    editingNode.current = nodeId;
    setText(getLocalDraft<string>(nodeId, `${kind}SchemaText`) ?? effectiveText);
    setIssues([]);
    setParseError(null);
    setValidOk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // Once loaded for the first time (draft empty, nothing typed yet), seed
  // from the server/overlay value rather than sitting on an empty box.
  useEffect(() => {
    if (text === '' && effectiveText !== '' && getLocalDraft(nodeId, `${kind}SchemaText`) === undefined) {
      setText(effectiveText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveText]);

  const dirty = text !== effectiveText;

  function onChange(v: string) {
    setText(v);
    setIssues([]);
    setParseError(null);
    setValidOk(false);
    if (v !== effectiveText) setLocalDraft(nodeId, `${kind}SchemaText`, v);
    else clearLocalDraft(nodeId, `${kind}SchemaText`);
  }

  function discard() {
    setText(effectiveText);
    setIssues([]);
    setParseError(null);
    setValidOk(false);
    clearLocalDraft(nodeId, `${kind}SchemaText`);
  }

  async function handleValidateAndSave(triggerEl: HTMLElement | null) {
    if (saving) return;
    setIssues([]);
    setParseError(null);
    setValidOk(false);

    const parsed = parseJsonWithPosition(text);
    if (!parsed.ok) {
      setParseError({ message: parsed.message ?? 'Invalid JSON.', line: parsed.line, column: parsed.column });
      return;
    }

    const shapeIssues = validateSchemaShape(parsed.value);

    let backendIssues: SchemaIssue[] = [];
    try {
      const result = await workspaceValidateNode({ nodeId, patch: { [field]: parsed.value } });
      if (!result.valid) {
        backendIssues = result.errors.map((message) => ({ path: '$ · workspace_validate_node', message }));
      }
    } catch (err) {
      backendIssues = [{ path: '$ · workspace_validate_node', message: err instanceof Error ? err.message : 'Validation call failed.' }];
    }

    const allIssues = [...backendIssues, ...shapeIssues];
    if (allIssues.length > 0) {
      setIssues(allIssues);
      return;
    }

    setValidOk(true);
    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    try {
      const before = effective;
      const schema = parsed.value as JSONSchema;
      await updateVerb({ nodeId, schema });
      setSchemaOverlay(nodeId, kind, schema);
      clearLocalDraft(nodeId, `${kind}SchemaText`);
      recordChange({ nodeId, kind: field, label: `${kind} schema edited`, before, after: schema });
      await qc.invalidateQueries({ queryKey: [`${kind}Schema`, nodeId] });
      toast('Schema saved', `workspace_update_node_${kind}_schema → recorded in History`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Save failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      label={
        <>
          {title} <span className="pin live">live</span>
          {overlay && <span className="mono" style={{ color: 'var(--faint)', marginLeft: 8 }}>edited this session</span>}
          {dirty && <span className="pin" style={{ marginLeft: 6, background: 'var(--acc-soft)', color: 'var(--acc)' }}>unsaved draft</span>}
        </>
      }
    >
      {query.isLoading ? (
        <LoadingNote>Loading {kind} schema…</LoadingNote>
      ) : query.isError ? (
        <ErrorNote message={query.error?.message} />
      ) : (
        <textarea
          className="schemabox"
          style={{ width: '100%', minHeight: 160, resize: 'vertical' }}
          spellCheck={false}
          aria-label={`${kind} schema JSON`}
          aria-invalid={Boolean(parseError)}
          aria-describedby={parseError ? `${kind}-schema-error` : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {parseError && (
        // a11y M6 — id'd + aria-describedby'd from the textarea above so a
        // screen-reader user editing JSON gets pointed at this the moment
        // it appears, instead of only discovering it by tabbing away.
        <p id={`${kind}-schema-error`} style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--bad)' }}>
          Malformed JSON
          {parseError.line ? ` at line ${parseError.line}, column ${parseError.column}` : ''}: {parseError.message}
        </p>
      )}
      <SchemaIssueList issues={issues} />
      {validOk && issues.length === 0 && !parseError && (
        <span className="valnote">✓ validates against workspace_validate_node + the local schema-shape check</span>
      )}
      <div className="editnote">
        <Btn
          variant="pri"
          disabled={saving || IS_READ_ONLY || query.isLoading}
          title={IS_READ_ONLY ? READONLY_REASON : undefined}
          onClick={(e) => handleValidateAndSave(e.currentTarget)}
        >
          {saving ? 'Saving…' : 'Validate & save'}
        </Btn>
        {dirty && <Btn onClick={discard}>Discard draft</Btn>}
      </div>
    </Card>
  );
}
