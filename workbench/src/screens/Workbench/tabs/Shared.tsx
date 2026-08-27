// Small pieces shared by every tab in Center.tsx — loading/error text (HANDOFF
// §7.10: every network-backed panel needs both, errors show the backend's own
// message), a lightweight inline disclosure for "view" buttons, and — new for
// WP-31..34 — the client-side bookkeeping that bridges the gap between the
// thin fixture-mode mock handlers (src/api/client.ts, not ours to edit) and
// this phase's done-criteria:
//
//   - `changes_list` always returns [] and `changes_compare` always returns
//     an empty diff in mock mode; `changes_restore` doesn't touch mockStore.
//   - `workspace_update_node_input_schema/output_schema` don't persist —
//     `node_get_input_schema/output_schema` always return the same stub.
//   - `workspace_validate_node` always returns {valid:true, errors:[]}
//     regardless of input.
//
// Rather than editing src/api/** (out of scope for this WP), every owned tab
// records its own edits into a local, in-memory change log + draft/overlay
// caches here — real backend responses simply replace this local layer once
// the mock handlers (or a live broker) start carrying the real thing. This
// is genuinely local bookkeeping, not fabricated data: nothing here invents
// a fact the operator didn't just create by editing and saving.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from '../../../components/primitives';
import { Skeleton } from '../../../components/Skeleton';
import { useStore } from '../../../store';
import type { JSONSchema } from '../../../api/verbs';

/** U7 — the shared skeleton (components/Skeleton.tsx) plus whatever this
 * call site's own text says is loading, so every tab's loading state reads
 * the same way at a glance instead of the "Loading…" text alone. */
export function LoadingNote({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Skeleton lines={2} />
      <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: 0 }}>{children}</p>
    </div>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  return (
    <p style={{ color: 'var(--bad)', fontSize: 12.5, margin: 0 }}>{message ?? 'Failed to load.'}</p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p style={{ color: 'var(--faint)', fontSize: 12.5, margin: 0 }}>{children}</p>;
}

/** An inline "view" / "hide" toggle button; renders `children` underneath when open. */
export function Disclosure({
  openLabel = 'view',
  closeLabel = 'hide',
  defaultOpen = false,
  children,
}: {
  openLabel?: string;
  closeLabel?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <Btn style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setOpen((o) => !o)}>
        {open ? closeLabel : openLabel}
      </Btn>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </>
  );
}

/** Shared copy for every disabled-while-read-only mutating control across the edit tabs.
 * U7 polish — operator copy, not developer copy: the old text named an
 * environment variable, which tells the person holding this console
 * nothing they can act on. This says what's true and who can change it. */
export const READONLY_REASON =
  'This workbench is connected read-only right now, so nothing here can be saved or run. Ask whoever administers this deployment to switch it to read-write.';

// ============================================================================
// Local change log — WP-34's History feed. Every owned tab calls recordChange()
// right after a mutating verb succeeds; HistoryTab reads it back merged with
// whatever changes_list actually returns (empty today, real once the mock/
// live backend carries history).
// ============================================================================

export type ChangeKind = 'prompt' | 'tools' | 'skills' | 'inputSchema' | 'outputSchema' | 'model';

export interface HistoryEntry {
  id: string;
  nodeId: string;
  kind: ChangeKind;
  label: string;
  before: unknown;
  after: unknown;
  when: string;
  whenIso: string;
  author: string;
  source: 'local' | 'api';
  /** Optimizer-promotion attribution, when the data actually carries it — never fabricated. */
  trial?: { id: string; scoreDelta: number };
}

let HISTORY: HistoryEntry[] = [];
const historyListeners = new Set<() => void>();
function emitHistory() {
  for (const l of historyListeners) l();
}
function subscribeHistory(listener: () => void) {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}
function historySnapshot() {
  return HISTORY;
}

function formatWhen(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

let historyIdCounter = 0;

export function recordChange(entry: {
  nodeId: string;
  kind: ChangeKind;
  label: string;
  before: unknown;
  after: unknown;
}): HistoryEntry {
  historyIdCounter += 1;
  const now = new Date();
  const full: HistoryEntry = {
    id: `local_${Date.now()}_${historyIdCounter}`,
    nodeId: entry.nodeId,
    kind: entry.kind,
    label: entry.label,
    before: entry.before,
    after: entry.after,
    when: formatWhen(now),
    whenIso: now.toISOString(),
    author: 'operator',
    source: 'local',
  };
  HISTORY = [full, ...HISTORY];
  emitHistory();
  return full;
}

/** Every locally-recorded change for one node, newest first. */
export function useLocalHistory(nodeId: string | null | undefined): HistoryEntry[] {
  const all = useSyncExternalStore(subscribeHistory, historySnapshot, historySnapshot);
  return useMemo(() => all.filter((h) => h.nodeId === nodeId), [all, nodeId]);
}

/** Look up one locally-recorded entry by id — used by HistoryTab's restore handler. */
export function getLocalHistoryEntry(id: string): HistoryEntry | undefined {
  return HISTORY.find((h) => h.id === id);
}

// ============================================================================
// Draft cache — per-field, per-node unsaved edits. Survives a tab switch
// (component unmount) and a node switch (component stays mounted, props
// change) because it lives outside React state entirely. This is WP-31's
// "switching node or tab with a dirty editor must not silently discard
// work" — the draft is what's not discarded.
// ============================================================================

const DRAFTS = new Map<string, unknown>();

function draftKey(nodeId: string, field: string): string {
  return `${nodeId}::${field}`;
}

export function getLocalDraft<T>(nodeId: string, field: string): T | undefined {
  return DRAFTS.get(draftKey(nodeId, field)) as T | undefined;
}

export function setLocalDraft<T>(nodeId: string, field: string, value: T): void {
  DRAFTS.set(draftKey(nodeId, field), value);
}

export function clearLocalDraft(nodeId: string, field: string): void {
  DRAFTS.delete(draftKey(nodeId, field));
}

// ============================================================================
// Schema overlay — WP-33. workspace_update_node_input_schema/output_schema
// don't persist in mock mode (client.ts returns {applied:true} without
// touching mockStore), so node_get_input_schema/output_schema would keep
// showing the pre-save stub forever. The overlay is what "Validate & save"
// actually changes, and what Schemas/History read back afterwards.
// ============================================================================

export type SchemaKind = 'input' | 'output';

const SCHEMA_OVERLAY = new Map<string, JSONSchema>();

function overlayKey(nodeId: string, kind: SchemaKind): string {
  return `${nodeId}::${kind}`;
}

export function getSchemaOverlay(nodeId: string, kind: SchemaKind): JSONSchema | undefined {
  return SCHEMA_OVERLAY.get(overlayKey(nodeId, kind));
}

export function setSchemaOverlay(nodeId: string, kind: SchemaKind, schema: JSONSchema): void {
  SCHEMA_OVERLAY.set(overlayKey(nodeId, kind), schema);
}

// ============================================================================
// Canonical-prompt snapshot — WP-31's "diff vs canonical." node_get_effective_
// prompt's `diverged` flag always reads false in fixture mode (the mock
// handler just echoes the live node's own prompt back at itself — there's no
// separately-stored seed text to diverge from). The first prompt value this
// session ever saw for a node IS that seed text, so it's cached here, once,
// and used as the diff baseline regardless of how many times the node is
// since edited — an honest stand-in for the canonical text a live backend
// would carry.
// ============================================================================

const CANONICAL_PROMPT = new Map<string, string>();

export function canonicalPromptFor(nodeId: string, currentValue: string): string {
  const existing = CANONICAL_PROMPT.get(nodeId);
  if (existing !== undefined) return existing;
  CANONICAL_PROMPT.set(nodeId, currentValue);
  return currentValue;
}

// ============================================================================
// Line diff — renders into the mockup's .diffline.add/.diffline.del. A plain
// LCS diff; changes_compare always returns an empty diff array in mock mode,
// so this is what actually produces line-level output there. Non-string
// values (tool/skill lists, schemas, model config) are stringified first via
// stringifyForDiff so History's diff view works for every field kind.
// ============================================================================

export interface DiffOp {
  type: 'add' | 'del' | 'ctx';
  text: string;
}

export function stringifyForDiff(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const DIFF_SIZE_GUARD = 4000; // n*m DP cells cap — see fallback below

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_SIZE_GUARD * DIFF_SIZE_GUARD) {
    const ops: DiffOp[] = [];
    if (before) ops.push({ type: 'del', text: before });
    if (after) ops.push({ type: 'add', text: after });
    return ops;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] });
    j++;
  }
  return ops;
}

/** Renders only the changed lines (mockup's diffline vocabulary never shows context). */
export function DiffLines({ ops }: { ops: DiffOp[] }) {
  const changed = ops.filter((o) => o.type !== 'ctx');
  if (changed.length === 0) {
    return <p style={{ color: 'var(--faint)', fontSize: 12, margin: '6px 0 0' }}>No differences.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
      {changed.map((o, i) => (
        <div key={i} className={`diffline ${o.type === 'add' ? 'add' : 'del'}`}>
          {o.type === 'add' ? '+ ' : '− '}
          {o.text || '(empty line)'}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// JSON parsing + JSON-Schema-shape validation — WP-33's "blocking errors
// shown inline at the offending path." workspace_validate_node always
// returns {valid:true, errors:[]} in mock mode no matter what's passed in, so
// this is what actually catches a malformed or schema-invalid-but-parseable
// document; the backend's own errors (when it has any, live) are shown
// verbatim alongside these, never replaced by them.
// ============================================================================

export interface JsonParseResult {
  ok: boolean;
  value?: unknown;
  message?: string;
  line?: number;
  column?: number;
}

// design-review fix — the native JS engine's own message already states
// "...in JSON at position N (line L column C)"; callers here (SchemasTab)
// separately render "Malformed JSON at line L, column C: <message>", which
// used to leave the position stated twice, in two different formats, in
// one sentence. Once line/column have been pulled out of the native
// message, this strips that same info back out of the display text.
function stripRedundantPosition(message: string): string {
  return message.replace(/\s*in JSON at position \d+(?:\s*\(line \d+ column \d+\))?\.?$/i, '');
}

export function parseJsonWithPosition(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON.';
    const posMatch = /position (\d+)/.exec(message);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const upto = text.slice(0, pos);
      const line = upto.split('\n').length;
      const column = pos - upto.lastIndexOf('\n');
      return { ok: false, message: stripRedundantPosition(message), line, column };
    }
    const lineColMatch = /line (\d+) column (\d+)/.exec(message);
    if (lineColMatch) {
      return {
        ok: false,
        message: stripRedundantPosition(message),
        line: Number(lineColMatch[1]),
        column: Number(lineColMatch[2]),
      };
    }
    return { ok: false, message };
  }
}

export interface SchemaIssue {
  path: string;
  message: string;
}

const VALID_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A real (if partial) JSON-Schema shape check — not full spec coverage, enough to refuse the common broken-schema mistakes with a path-specific reason. */
export function validateSchemaShape(value: unknown, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isPlainObject(value)) {
    issues.push({ path, message: 'must be a JSON object (e.g. { "type": "object", "properties": {…} }).' });
    return issues;
  }
  const obj = value;

  if ('type' in obj) {
    const t = obj.type;
    const types = Array.isArray(t) ? t : [t];
    for (const one of types) {
      if (typeof one !== 'string' || !VALID_SCHEMA_TYPES.has(one)) {
        issues.push({
          path: `${path}.type`,
          message: `"${String(one)}" is not a valid JSON Schema type — expected one of ${[...VALID_SCHEMA_TYPES].join(', ')}.`,
        });
      }
    }
  }

  if ('properties' in obj) {
    if (!isPlainObject(obj.properties)) {
      issues.push({ path: `${path}.properties`, message: 'must be an object mapping property names to sub-schemas.' });
    } else {
      for (const [key, sub] of Object.entries(obj.properties)) {
        if (!isPlainObject(sub)) {
          issues.push({ path: `${path}.properties.${key}`, message: 'must be a schema object.' });
        } else {
          issues.push(...validateSchemaShape(sub, `${path}.properties.${key}`));
        }
      }
    }
  }

  if ('required' in obj) {
    if (!Array.isArray(obj.required)) {
      issues.push({ path: `${path}.required`, message: 'must be an array of property-name strings.' });
    } else {
      const propKeys = isPlainObject(obj.properties) ? Object.keys(obj.properties) : null;
      obj.required.forEach((r: unknown, i: number) => {
        if (typeof r !== 'string') {
          issues.push({ path: `${path}.required[${i}]`, message: 'must be a string naming a declared property.' });
        } else if (propKeys && !propKeys.includes(r)) {
          issues.push({ path: `${path}.required[${i}]`, message: `"${r}" is not declared in ${path}.properties.` });
        }
      });
    }
  }

  if ('items' in obj && obj.items !== undefined) {
    const it = obj.items;
    if (Array.isArray(it)) {
      it.forEach((one, i) => {
        if (!isPlainObject(one)) {
          issues.push({ path: `${path}.items[${i}]`, message: 'must be a schema object.' });
        } else {
          issues.push(...validateSchemaShape(one, `${path}.items[${i}]`));
        }
      });
    } else if (!isPlainObject(it)) {
      issues.push({ path: `${path}.items`, message: 'must be a schema object or an array of schema objects.' });
    } else {
      issues.push(...validateSchemaShape(it, `${path}.items`));
    }
  }

  if ('additionalProperties' in obj) {
    const ap = obj.additionalProperties;
    if (typeof ap !== 'boolean' && !isPlainObject(ap)) {
      issues.push({ path: `${path}.additionalProperties`, message: 'must be a boolean or a schema object.' });
    }
  }

  if ('enum' in obj && !Array.isArray(obj.enum)) {
    issues.push({ path: `${path}.enum`, message: 'must be an array of allowed values.' });
  }

  return issues;
}

/** Renders a blocking-refusal list at each offending path — used by SchemasTab. */
export function SchemaIssueList({ issues }: { issues: SchemaIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      {issues.map((it, i) => (
        <p key={i} style={{ margin: 0, fontSize: 12, color: 'var(--bad)' }}>
          <span className="mono">{it.path}</span> — {it.message}
        </p>
      ))}
    </div>
  );
}

// ============================================================================
// Registry picker — the searchable "+ add from registry" overlay shared by
// Tools and Skills. Reuses .scrim/.modal/.field/.toolrow — no new CSS.
// ============================================================================

export function RegistryPicker<T>({
  open,
  title,
  hint,
  items,
  getId,
  renderMeta,
  onAdd,
  onClose,
  emptyText = 'No matches.',
}: {
  open: boolean;
  title: string;
  hint?: ReactNode;
  items: T[];
  getId: (item: T) => string;
  renderMeta: (item: T) => ReactNode;
  onAdd: (item: T, triggerEl: HTMLElement | null) => void;
  onClose: () => void;
  emptyText?: string;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const setRegistryPickerOpen = useStore((s) => s.setRegistryPickerOpen);

  // a11y C5 — this was the one hand-rolled dialog in the app missing the
  // focus trap-and-restore pattern its siblings (ConfirmDialog,
  // StartRunModal, GraphOverlay) already implement correctly: capture the
  // trigger on open, focus it back on close. Registered into the store so
  // App.tsx's `inert` toggle (a11y C4) covers this overlay too.
  //
  // Keyed on `open` rather than mount/unmount: this component used to be
  // conditionally rendered by its callers ({pickerOpen && <RegistryPicker
  // .../>}), so every open was a fresh mount — and React StrictMode
  // double-invokes an effect specifically on a component's *initial*
  // mount (simulated unmount→remount, dev-only). That double-invoke
  // clobbered triggerRef with the filter input itself instead of the real
  // trigger button (the 2nd pass's document.activeElement read raced the
  // 1st pass's still-in-flight rAF focus-restore). Its siblings avoid this
  // because they're always mounted and gate visibility with an `open`
  // prop/state instead — an effect re-run from a dependency change on an
  // already-mounted instance is never double-invoked by StrictMode, only a
  // true initial mount is. Callers now always render this component and
  // toggle `open`, matching that same architecture.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setRegistryPickerOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setRegistryPickerOpen(false);
      // Deferred a frame: the trigger button lives inside App.tsx's
      // `inert`-toggled wrapper (a11y C4), so focusing it one tick too
      // early would silently no-op. requestAnimationFrame runs after the
      // next paint, by which point `inert` has cleared. Same convention
      // CommandPalette already uses for its own (open-side) focus call.
      const trigger = triggerRef.current;
      requestAnimationFrame(() => trigger?.focus?.());
      triggerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const filtered = needle ? items.filter((it) => getId(it).toLowerCase().includes(needle)) : items;

  // a11y C4 — portaled to a DOM node that lives outside App.tsx's
  // `inert`-toggled background wrapper (see App.tsx's comment by
  // #registry-picker-root) instead of rendering in place, which is where
  // this component is otherwise invoked from (deep inside ToolsTab/
  // SkillsTab). Everything else about the component — props, state,
  // lifecycle — is unaffected; only where its JSX lands in the DOM changes.
  const portalTarget = document.getElementById('registry-picker-root');
  const dialog = (
    <div
      className="scrim open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <h3>{title}</h3>
        {hint && <div className="sub">{hint}</div>}
        <div className="field">
          <label className="lbl" htmlFor="registry-picker-filter">
            filter
          </label>
          <input id="registry-picker-filter" ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="id contains…" />
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {filtered.length === 0 && <p className="note">{emptyText}</p>}
          {filtered.map((it) => (
            <div className="toolrow" key={getId(it)}>
              {renderMeta(it)}
              <Btn style={{ padding: '2px 9px', fontSize: 11, flex: 'none' }} onClick={(e) => onAdd(it, e.currentTarget)}>
                add
              </Btn>
            </div>
          ))}
        </div>
        <div className="foot">
          <span />
          <Btn onClick={onClose}>Close</Btn>
        </div>
      </div>
    </div>
  );
  return portalTarget ? createPortal(dialog, portalTarget) : dialog;
}
