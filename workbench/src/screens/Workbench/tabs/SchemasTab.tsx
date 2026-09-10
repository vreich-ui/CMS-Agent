// Schemas tab — WP-33. Input/output JSON Schema, now real editors: validated
// with workspace_validate_node before save, with blocking errors shown
// inline at the offending path — not a generic "invalid JSON." Two separate
// failure modes are handled distinctly, per the WP-33 done-criterion:
//   1. malformed JSON (a parse error, reported with line/column), and
//   2. schema-invalid-but-parseable (workspace_validate_node's own message
//      where it has one, plus a real local JSON-Schema-shape check — see
//      Shared.tsx's doc comment on why the local check exists).
//
// A successful mutation is never treated as proof by itself: the editor
// reads the committed schema back before it says "live". A failed or
// mismatched readback remains explicitly uncertain rather than becoming a
// session-only overlay that can be mistaken for the workspace.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import {
  workspacePrepareNodeEdit,
  workspaceSaveSchemaWithReadback,
  WorkspaceEditConflictError,
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
  LoadingNote,
  parseJsonWithPosition,
  READONLY_REASON,
  recordChange,
  SchemaIssueList,
  setLocalDraft,
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
      />
      <SchemaEditor
        nodeId={nodeId}
        kind="output"
        title={`output schema · produces ${nodeId}.v1`}
        query={outputQ}
      />
    </>
  );
}

function SchemaEditor({
  nodeId,
  kind,
  title,
  query,
}: {
  nodeId: string;
  kind: SchemaKind;
  title: string;
  query: { data?: JSONSchema; isLoading: boolean; isError: boolean; error: { message?: string } | null };
}) {
  const qc = useQueryClient();
  const field: 'inputSchema' | 'outputSchema' = kind === 'input' ? 'inputSchema' : 'outputSchema';
  const effective = query.data;
  const effectiveText = effective !== undefined ? JSON.stringify(effective, null, 2) : '';

  const editingNode = useRef(nodeId);
  const [text, setText] = useState<string>(() => getLocalDraft<string>(nodeId, `${kind}SchemaText`) ?? effectiveText);
  const [issues, setIssues] = useState<SchemaIssue[]>([]);
  const [parseError, setParseError] = useState<{ message: string; line?: number; column?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [validOk, setValidOk] = useState(false);
  const [readbackUncertain, setReadbackUncertain] = useState(false);

  useEffect(() => {
    if (editingNode.current === nodeId) return;
    editingNode.current = nodeId;
    setText(getLocalDraft<string>(nodeId, `${kind}SchemaText`) ?? effectiveText);
    setIssues([]);
    setParseError(null);
    setValidOk(false);
    setReadbackUncertain(false);
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
    setReadbackUncertain(false);
    if (v !== effectiveText) setLocalDraft(nodeId, `${kind}SchemaText`, v);
    else clearLocalDraft(nodeId, `${kind}SchemaText`);
  }

  function discard() {
    setText(effectiveText);
    setIssues([]);
    setParseError(null);
    setValidOk(false);
    setReadbackUncertain(false);
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

    if (shapeIssues.length > 0) {
      setIssues(shapeIssues);
      return;
    }

    setNextConfirmTrigger(triggerEl);
    setSaving(true);
    try {
      const before = effective;
      const schema = parsed.value as JSONSchema;
      // The preparation call carries a real full node and the workspace's
      // supported concurrency tokens. The save boundary validates that
      // complete candidate, mutates, then reads the committed field back.
      const prepared = await workspacePrepareNodeEdit(nodeId);
      const result = await workspaceSaveSchemaWithReadback({ nodeId, kind, schema, prepared });
      if (result.state !== 'confirmed') {
        setReadbackUncertain(true);
        setIssues([{ path: '$ · committed readback', message: result.message }]);
        await qc.invalidateQueries({ queryKey: [`${kind}Schema`, nodeId] });
        return;
      }
      clearLocalDraft(nodeId, `${kind}SchemaText`);
      recordChange({ nodeId, kind: field, label: `${kind} schema edited`, before, after: schema });
      await qc.invalidateQueries({ queryKey: [`${kind}Schema`, nodeId] });
      setValidOk(true);
      setReadbackUncertain(false);
      toast('Schema saved and verified', `workspace_update_node_${kind}_schema → committed readback recorded in History`);
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      if (err instanceof WorkspaceEditConflictError) {
        setReadbackUncertain(true);
        setIssues([{ path: '$ · save conflict', message: `${err.message} Reloaded state is required before retrying.` }]);
        await qc.invalidateQueries({ queryKey: [`${kind}Schema`, nodeId] });
        return;
      }
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setIssues([{ path: '$ · workspace save', message }]);
      toast('Save failed', message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      label={
        <>
          {title} <span className={`pin ${readbackUncertain ? '' : 'live'}`}>{readbackUncertain ? 'readback uncertain' : 'live'}</span>
          {readbackUncertain && <span className="pin pinned" style={{ marginLeft: 6 }}>committed state uncertain</span>}
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
