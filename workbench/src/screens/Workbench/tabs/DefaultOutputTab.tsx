// W4 — the node's DEFAULT OUTPUT.
//
// A stored value the conductor can write into a run in place of dispatching this node: no model call,
// no cost, no wait. It is what makes "push this node through" and a defaults-only run possible, and it
// is authored here, once per node, rather than re-pasted into an override modal every run.
//
// THE DISTINCTION THIS TAB MUST KEEP VISIBLE, because the two look identical on screen and are not the
// same act at all:
//   * a DEFAULT (this tab) belongs to the NODE and applies to every future run that asks for it;
//   * an OVERRIDE (the drive-mode override modal) belongs to ONE RUN and is gone with it.
// Both mark their run as having used a value no model produced, with the same consequences — never
// publishes live, never learned from — so the tab says that plainly rather than leaving an operator to
// discover it at a publish gate.
//
// Seeding from a real past output (adopt) is the usual path and is offered first: the value an
// operator wants is almost always something this node genuinely produced. Typing one by hand is the
// fallback, not the headline.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as verbs from '../../../api/verbs';
import { useRuns } from '../../../api/hooks';
import { ActionCancelledError } from '../../../api/confirmAction';
import { IS_READ_ONLY } from '../../../api/client';
import { setNextConfirmTrigger } from '../../../components/ConfirmDialog';
import { Btn, Card } from '../../../components/primitives';
import { toast } from '../../../components/Toasts';
import { useStore } from '../../../store';
import { normalizeValidationIssues } from '../../../components/drive/overrideStatus';
import {
  ErrorNote,
  LoadingNote,
  parseJsonWithPosition,
  READONLY_REASON,
  recordChange,
  SchemaIssueList,
  type SchemaIssue,
} from './Shared';

/** "validated 14 Sep 09:12", "never validated", or an honest "unknown". */
function schemaState(d: verbs.NodeDefaultOutput): { text: string; bad: boolean } {
  if (d.schemaValidAt === null) return { text: 'saved with force — it does NOT satisfy this node’s output schema', bad: true };
  if (typeof d.schemaValidAt === 'string') return { text: `validated against the output schema on ${new Date(d.schemaValidAt).toLocaleString('en-GB')}`, bad: false };
  // Absent is not the same as null: a row written before the stamp existed simply never recorded one.
  return { text: 'schema state unknown — this default predates schema stamping', bad: false };
}

export function DefaultOutputTab({ node, nodeId }: { node: { id: string; name: string }; nodeId: string }) {
  const qc = useQueryClient();
  const wfId = useStore((s) => s.wf);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [issues, setIssues] = useState<SchemaIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adoptRunId, setAdoptRunId] = useState('');

  // REVIEW FIX (high) — `placeholderData: keepPreviousData` is set app-wide (App.tsx), so on a node
  // switch this query kept the PREVIOUS node's default and stayed `success`. The effect below then
  // seeded node B's editor with node A's value, the header described A, and `isLoading` never fired to
  // hide it — so an operator who edited and saved inside the round-trip window (8-25s on this plane)
  // wrote A's output as B's default, silently. Turned off here: showing nothing for a moment is
  // strictly better than showing another node's data under this node's name.
  const defaultQ = useQuery({
    queryKey: ['nodeDefaultOutput', nodeId],
    queryFn: () => verbs.workspaceGetNodeDefaultOutput(nodeId),
    placeholderData: undefined,
    retry: false,
  });
  // The node the currently-loaded default actually belongs to. Every write below is guarded on this
  // matching `nodeId`, so even a future re-introduction of placeholder data cannot cross the streams.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // Shares the rail's ['runs', {workflowId, limit:5}] key exactly (W5), so this tab adds no request.
  const runsQ = useRuns({ workflowId: wfId, limit: 5 });

  // Seeded from the stored default when one exists, and re-seeded when the operator switches node —
  // never from a half-typed previous node's text.
  // Seeds once per node, on the FETCH SETTLING — not on every `defaultQ.data` identity change. The
  // earlier dependency list re-ran on any refetch and overwrote whatever the operator had typed since.
  useEffect(() => {
    if (defaultQ.isFetching || loadedFor === nodeId) return;
    setText(defaultQ.data ? JSON.stringify(defaultQ.data.value, null, 2) : '');
    setNote(defaultQ.data?.note ?? '');
    setIssues(null);
    setAdoptRunId('');
    setLoadedFor(nodeId);
  }, [nodeId, defaultQ.data, defaultQ.isFetching, loadedFor]);

  // Clear the moment the node changes, so nothing from the previous node is on screen (or savable)
  // while the new one loads.
  useEffect(() => {
    setLoadedFor((current) => (current === nodeId ? current : null));
    setText('');
    setNote('');
    setIssues(null);
    setAdoptRunId('');
  }, [nodeId]);

  const parsed = text.trim() ? parseJsonWithPosition(text) : null;
  const parseError = parsed && !parsed.ok ? parsed.message : null;

  const validate = async () => {
    if (!parsed?.ok) return;
    setBusy(true);
    try {
      const result = await verbs.nodeValidateOutput({ nodeId, output: parsed.value });
      const found = result.valid ? [] : normalizeValidationIssues(result.issues);
      setIssues(found);
      toast(result.valid ? 'Valid' : 'Schema issues', result.valid ? `${nodeId}'s output schema is satisfied.` : `${found.length} issue(s).`);
    } catch (err) {
      toast('Validation failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const save = async (triggerEl: HTMLElement | null, force: boolean) => {
    if (!parsed?.ok || busy) return;
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      const result = await verbs.workspaceUpdateNodeDefaultOutput({ nodeId, value: parsed.value, note: note.trim() || undefined, force });
      recordChange({
        nodeId,
        kind: 'defaultOutput',
        label: force ? 'default output saved (forced — unvalidated against the schema)' : 'default output saved',
        before: stored?.value ?? null,
        after: parsed.value,
      });
      for (const warning of result.warnings ?? []) toast('Saved with a warning', warning);
      toast('Default saved', `${nodeId} can now be pushed through without running.`);
      void qc.invalidateQueries({ queryKey: ['nodeDefaultOutput', nodeId] });
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      // REVIEW FIX — only a SCHEMA refusal sets issues. normalizeValidationIssues returns [] for
      // anything that is not an issue array, so the earlier `... || []` turned every network error,
      // 401 and 500 into `issues: []` — which the render below reads as "validates against the output
      // schema" and showed in green, after a save that stored nothing. `null` means "not checked",
      // which is the truth for a transport failure.
      const failing = normalizeValidationIssues((err as { issues?: unknown })?.issues);
      setIssues(failing.length ? failing : null);
      toast('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const clear = async (triggerEl: HTMLElement | null) => {
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      await verbs.workspaceUpdateNodeDefaultOutput({ nodeId, clear: true });
      recordChange({ nodeId, kind: 'defaultOutput', label: 'default output cleared', before: stored?.value ?? null, after: null });
      toast('Default cleared', `${nodeId} can no longer be pushed through.`);
      void qc.invalidateQueries({ queryKey: ['nodeDefaultOutput', nodeId] });
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      toast('Clear failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (triggerEl: HTMLElement | null) => {
    if (!adoptRunId) return;
    setNextConfirmTrigger(triggerEl);
    setBusy(true);
    try {
      const result = await verbs.workspaceAdoptOutputAsDefault({ nodeId, runId: adoptRunId });
      recordChange({
        nodeId,
        kind: 'defaultOutput',
        label: `default output adopted from run ${adoptRunId}`,
        before: stored?.value ?? null,
        after: result.defaultOutput?.value ?? null,
      });
      toast('Default adopted', `${nodeId}'s output from ${adoptRunId.slice(-10)} is now its default.`);
      if (result.defaultOutput) setText(JSON.stringify(result.defaultOutput.value, null, 2));
      void qc.invalidateQueries({ queryKey: ['nodeDefaultOutput', nodeId] });
    } catch (err) {
      if (err instanceof ActionCancelledError) return;
      // The honest refusals live here: a run in which this node was itself defaulted, or never
      // completed. Both are shown verbatim — they explain themselves better than a generic message.
      toast('Adopt failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  // Only runs in which this node genuinely completed can be adopted from; the server refuses the rest
  // anyway, and offering them here would invite a refusal instead of preventing one.
  const adoptable = (runsQ.data ?? []).filter((run) => run.nodes.some((n) => n.nodeId === nodeId && n.status === 'completed'));

  // Keyed on WHICH node the loaded answer belongs to, not on isLoading — a cached or placeholder
  // answer keeps isLoading false while describing a different node entirely.
  if (loadedFor !== nodeId) return <Card label="default output"><LoadingNote>Reading {nodeId}'s stored default…</LoadingNote></Card>;

  const stored = defaultQ.data;
  const state = stored ? schemaState(stored) : null;

  return (
    <Card label="default output">
      <p className="note" style={{ marginTop: 0 }}>
        A stored value the conductor writes into a run instead of running <span className="mono">{node.name}</span> — no
        model call, no cost. It belongs to the NODE, so every run that pushes this node through, and every run started in
        a defaults mode, uses it. A run that uses a default is permanently marked: it can never publish on a live run, and
        this node is excluded from that run's learning record.
      </p>

      {defaultQ.isError && <ErrorNote message="Could not read this node's stored default." />}

      {stored ? (
        <p className="note">
          Current default set by {stored.updatedBy} on {new Date(stored.updatedAt).toLocaleString('en-GB')} —{' '}
          <span style={state?.bad ? { color: 'var(--bad)' } : undefined}>{state?.text}</span>
          {stored.note ? <> · “{stored.note}”</> : null}
        </p>
      ) : (
        <p className="note">
          No default set. Pushing this node through is refused until there is one — it never falls back to running the
          node, so asking to push through can't quietly cost you a model turn.
        </p>
      )}

      <div className="field">
        <label className="lbl" htmlFor="dot-adopt-run">
          seed from a past run
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            id="dot-adopt-run"
            aria-label="run to adopt this node's output from"
            value={adoptRunId}
            onChange={(e) => setAdoptRunId(e.target.value)}
            disabled={busy || IS_READ_ONLY}
          >
            <option value="">Select a run…</option>
            {adoptable.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id.slice(-10)} · {run.status} · {run.started}
              </option>
            ))}
          </select>
          <Btn
            disabled={!adoptRunId || busy || IS_READ_ONLY}
            onClick={(e) => void adopt(e.currentTarget)}
            title={IS_READ_ONLY ? READONLY_REASON : 'Adopt this node’s real output from that run as its default.'}
          >
            Adopt as default
          </Btn>
          {!adoptable.length && !runsQ.isLoading && (
            <span className="note">No recent run of this workflow completed {nodeId}.</span>
          )}
        </div>
      </div>

      <div className="field">
        <label className="lbl" htmlFor="dot-json">
          default output (JSON)
        </label>
        <textarea
          id="dot-json"
          className="mono"
          rows={14}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setIssues(null);
          }}
          disabled={busy || IS_READ_ONLY}
          style={{ width: '100%' }}
        />
        {parseError && <p style={{ color: 'var(--bad)', fontSize: 12.5, margin: '4px 0 0' }}>{parseError}</p>}
        {issues !== null && issues.length === 0 && !parseError && (
          <p className="note" style={{ margin: '4px 0 0' }}>Validates against {nodeId}'s output schema.</p>
        )}
        <SchemaIssueList issues={issues ?? []} />
      </div>

      <div className="field">
        <label className="lbl" htmlFor="dot-note">
          note
        </label>
        <input
          id="dot-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy || IS_READ_ONLY}
          placeholder="where this value came from, what it stands in for"
        />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn disabled={!parsed?.ok || busy} onClick={() => void validate()}>
          Validate
        </Btn>
        <Btn
          disabled={!parsed?.ok || busy || IS_READ_ONLY}
          onClick={(e) => void save(e.currentTarget, false)}
          title={IS_READ_ONLY ? READONLY_REASON : undefined}
        >
          Save default
        </Btn>
        {/* Forcing is a SECOND, deliberate act, offered only once the schema has actually refused —
            the same discipline the override modal's second confirm follows. It is never the first
            button an operator reaches for. */}
        {issues !== null && issues.length > 0 && (
          <Btn
            disabled={!parsed?.ok || busy || IS_READ_ONLY}
            onClick={(e) => void save(e.currentTarget, true)}
            title="Store this value even though it does not satisfy the node's output schema. It will be marked as never validated."
          >
            Save anyway (unvalidated)
          </Btn>
        )}
        {stored && (
          <Btn disabled={busy || IS_READ_ONLY} onClick={(e) => void clear(e.currentTarget)}>
            Clear default
          </Btn>
        )}
      </div>
    </Card>
  );
}
